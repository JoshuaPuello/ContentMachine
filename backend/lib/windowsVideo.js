import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import { lookup } from 'dns/promises'
import { isIP } from 'net'
import { mediaBroker, isMediaBrokerConfigured } from './mediaBrokerClient.js'
import {
  OUTPUT_ROOT,
  readSessionSnapshot,
  sessionDirectory,
  validSessionId,
  withSessionMutationLock,
  writeSessionSnapshot,
} from './sessionStore.js'

export const WINDOWS_PROVIDER = 'windows-worker'
export const WINDOWS_ADAPTER = 'windows-default'
export const WINDOWS_SETTINGS = Object.freeze({
  durationSeconds: 8,
  aspectRatio: '16:9',
  generateAudio: false,
  adapter: WINDOWS_ADAPTER,
})

const ACTIVE_STATUSES = new Set(['queued', 'leased', 'generating', 'uploading', 'validating'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'superseded'])
const MAX_INPUT_IMAGE_BYTES = 50 * 1024 * 1024
const stateFile = (sessionId) => path.join(sessionDirectory(sessionId), 'media-worker-state.json')
const activeProjects = new Set()
let reconcileTimer = null
let reconciling = false

const emptyState = () => ({
  version: 1,
  jobs: {},
  videoGenerationControl: { paused: false, updatedAt: new Date().toISOString() },
  pendingTaskCancellations: [],
  projectCancelPending: null,
  brokerAvailable: isMediaBrokerConfigured(),
  lastBrokerError: null,
  repairPasses: 0,
  updatedAt: new Date().toISOString(),
})

export const readWindowsState = async (sessionId) => {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(sessionId), 'utf8'))
    return parsed?.version === 1 && parsed.jobs ? normalizeState(parsed) : emptyState()
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState()
    throw error
  }
}

const writeWindowsState = async (sessionId, state) => {
  await fs.mkdir(sessionDirectory(sessionId), { recursive: true })
  state.updatedAt = new Date().toISOString()
  const target = stateFile(sessionId)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(temporary, target)
}

const normalizeState = (state) => {
  state.pendingTaskCancellations ||= []
  state.projectCancelPending ||= null
  if (typeof state.brokerAvailable !== 'boolean') state.brokerAvailable = isMediaBrokerConfigured()
  return state
}

const resolvedJob = (job) => ({
  ...job,
  jobId: job.taskId || job.jobId || null,
  provider: job.provider || WINDOWS_PROVIDER,
  falEndpoint: null,
})

export const mergeWindowsStateIntoProject = async (project, sessionId) => {
  if (!project || !sessionId) return project
  const state = await readWindowsState(sessionId)
  project.video_jobs ||= {}
  for (const [unitId, workerJob] of Object.entries(state.jobs || {})) {
    project.video_jobs[unitId] = resolvedJob(workerJob)
  }
  project.videoGenerationControl = state.videoGenerationControl
  return project
}

const decodeDataUri = (value) => {
  const match = String(value || '').match(/^data:([^;,]+);base64,(.+)$/s)
  return match ? { bytes: Buffer.from(match[2], 'base64'), contentType: match[1] } : null
}

const contentTypeFromPath = (value) => {
  const clean = String(value || '').split('?')[0].toLowerCase()
  if (clean.endsWith('.png')) return 'image/png'
  if (clean.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

const containedSessionPath = (sessionId, relativePath) => {
  const root = path.resolve(sessionDirectory(sessionId))
  const candidate = path.resolve(root, String(relativePath || ''))
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw new Error('Selected image path escapes the project session directory')
  }
  return candidate
}

const localSessionPath = (reference, sessionId) => {
  const value = String(reference || '')
  if (value.startsWith('__session_file__/')) return containedSessionPath(sessionId, value.slice(17))
  const match = value.match(/\/api\/session\/([^/]+)\/files\/([^?#]+)/)
  if (match && decodeURIComponent(match[1]) === sessionId) {
    const relative = decodeURIComponent(match[2])
    return containedSessionPath(sessionId, relative)
  }
  return null
}

const ipv4Number = (address) => address
  .split('.')
  .reduce((value, part) => ((value << 8) | Number(part)) >>> 0, 0)

const inIpv4Range = (address, network, prefix) => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipv4Number(address) & mask) === (ipv4Number(network) & mask)
}

const ipv6Number = (address) => {
  const [left = '', right = ''] = String(address).split('::')
  const leftGroups = left ? left.split(':') : []
  const rightGroups = right ? right.split(':') : []
  const missing = 8 - leftGroups.length - rightGroups.length
  const groups = String(address).includes('::')
    ? [...leftGroups, ...Array(Math.max(0, missing)).fill('0'), ...rightGroups]
    : leftGroups
  if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/i.test(group))) return null
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n)
}

const inIpv6Range = (address, network, prefix) => {
  const value = ipv6Number(address)
  const start = ipv6Number(network)
  if (value === null || start === null) return false
  const shift = BigInt(128 - prefix)
  return (value >> shift) === (start >> shift)
}

const isBlockedNetworkAddress = (address) => {
  if (isIP(address) === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([network, prefix]) => inIpv4Range(address, network, prefix))
  }
  if (isIP(address) !== 6) return true
  const normalized = address.toLowerCase()
  if (inIpv6Range(normalized, '::ffff:0:0', 96)) {
    const value = ipv6Number(normalized)
    const mapped = value === null
      ? null
      : [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 0xffn)).join('.')
    return !mapped || isBlockedNetworkAddress(mapped)
  }
  return inIpv6Range(normalized, '::', 128)
    || inIpv6Range(normalized, '::1', 128)
    || inIpv6Range(normalized, 'fc00::', 7)
    || inIpv6Range(normalized, 'fe80::', 10)
    || inIpv6Range(normalized, 'ff00::', 8)
    || inIpv6Range(normalized, '2001:db8::', 32)
}

const assertPublicImageHost = async (hostname) => {
  const normalized = String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.localhost')) {
    throw new Error('Selected image URL cannot target localhost or a private network')
  }
  const addresses = isIP(normalized)
    ? [{ address: normalized }]
    : await lookup(normalized, { all: true, verbatim: true })
  if (addresses.length === 0 || addresses.some(({ address }) => isBlockedNetworkAddress(address))) {
    throw new Error('Selected image URL cannot target localhost or a private network')
  }
}

const readBoundedResponse = async (response, maxBytes) => {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error('Selected image exceeds the 50 MiB limit')
  }
  if (!response.body) throw new Error('Selected image download returned an empty response')
  const reader = response.body.getReader()
  const chunks = []
  let received = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > maxBytes) {
        await reader.cancel('Selected image exceeds the 50 MiB limit').catch(() => {})
        throw new Error('Selected image exceeds the 50 MiB limit')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, received)
}

const loadImageBytes = async (reference, sessionId) => {
  const data = decodeDataUri(reference)
  if (data) return data
  const local = localSessionPath(reference, sessionId)
  if (local) return { bytes: await fs.readFile(local), contentType: contentTypeFromPath(local) }
  const parsed = new URL(String(reference || ''))
  if (parsed.protocol !== 'https:') throw new Error('Remote selected images must use HTTPS')
  await assertPublicImageHost(parsed.hostname)
  const response = await fetch(parsed, { redirect: 'error', signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`Selected image download returned HTTP ${response.status}`)
  const bytes = await readBoundedResponse(response, MAX_INPUT_IMAGE_BYTES)
  return { bytes, contentType: response.headers.get('content-type')?.split(';')[0] || contentTypeFromPath(parsed.pathname) }
}

export const unitIdForPrompt = (prompt) => `${prompt.scene_number}_${prompt.segment_index ?? 0}`

const findPrompt = (project, unitId) => (project.video_prompts || []).find((prompt) => unitIdForPrompt(prompt) === String(unitId))

export const assertWindowsUnit = async (sessionId, unitId) => {
  if (!validSessionId(sessionId)) throw new Error('A valid sessionId is required')
  if (!/^\d+_\d+$/.test(String(unitId || ''))) throw new Error('A valid unitId is required')
  const project = await readSessionSnapshot(sessionId)
  if (!findPrompt(project, unitId)) throw new Error(`Unknown video unit ${unitId}`)
  return true
}

export const buildWindowsPrompt = (prompt) => {
  const full = String(prompt?.full_prompt_string || prompt?.video_prompt || prompt?.prompt || '').trim()
  if (!full) throw new Error('The shot has no complete motion prompt')
  const negative = String(prompt?.negative_prompt || '').trim()
  const combined = negative ? `${full}\n\nAvoid: ${negative}` : full
  if (combined.length > 5000) throw new Error(`Windows/Veo prompt is ${combined.length} characters; maximum is 5000`)
  return combined
}

const selectedImageReference = (project, unitId) => {
  const selected = project.selected_images?.[unitId]
  const promptIndex = Math.max(0, Number(selected?.promptIndex ?? selected?.prompt_index ?? 0) || 0)
  return selected?.url || project.images?.[`${unitId}_${promptIndex}`]?.url || null
}

export const snapshotWindowsInput = async (project, sessionId, unitId) => {
  const promptRecord = findPrompt(project, unitId)
  if (!promptRecord) throw new Error(`Video prompt not found for ${unitId}`)
  const reference = selectedImageReference(project, unitId)
  if (!reference) throw new Error(`Selected image not found for ${unitId}`)
  const { bytes, contentType } = await loadImageBytes(reference, sessionId)
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType)) throw new Error(`Unsupported image type ${contentType}`)
  if (bytes.length <= 0 || bytes.length > MAX_INPUT_IMAGE_BYTES) throw new Error('Selected image must contain 1 byte to 50 MiB')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return {
    bytes,
    contentType,
    sizeBytes: bytes.length,
    sha256,
    prompt: buildWindowsPrompt(promptRecord),
    settings: { ...WINDOWS_SETTINGS },
  }
}

const extensionFor = (contentType) => contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg'

const uploadSnapshot = async (sessionId, unitId, snapshot) => {
  const session = await mediaBroker.createInputSession({
    projectId: sessionId,
    itemId: unitId,
    fileName: `source.${extensionFor(snapshot.contentType)}`,
    contentType: snapshot.contentType,
    sizeBytes: snapshot.sizeBytes,
    sha256: snapshot.sha256,
  })
  if (!session.alreadyExists) await mediaBroker.uploadInput(session, snapshot.bytes)
  return session.objectKey
}

const taskRequest = (sessionId, unitId, snapshot, objectKey) => ({
  owner: {
    domain: 'content-machine',
    projectId: sessionId,
    batchId: `content-machine:${sessionId}`,
    rowId: sessionId,
    itemType: 'shot',
    itemId: unitId,
  },
  groupId: `content-machine:${sessionId}`,
  image: { objectKey, sha256: snapshot.sha256, contentType: snapshot.contentType },
  prompt: snapshot.prompt,
  settings: snapshot.settings,
  priority: 0,
  maxAttempts: 3,
  projectConcurrency: Math.min(4, Math.max(1, Number(process.env.MEDIA_BROKER_PROJECT_CONCURRENCY) || 4)),
})

const producerTaskMapsToProject = (sessionId, unitId, task, snapshot) => {
  const owner = task?.owner || {}
  return owner.domain === 'content-machine'
    && owner.projectId === sessionId
    && owner.batchId === `content-machine:${sessionId}`
    && owner.rowId === sessionId
    && owner.itemType === 'shot'
    && owner.itemId === unitId
    && task.groupId === `content-machine:${sessionId}`
    && task.input?.prompt === snapshot.prompt
    && task.input?.image?.sha256 === snapshot.sha256
    && JSON.stringify(task.input?.settings) === JSON.stringify(snapshot.settings)
    && !task.cancelRequestedAt
}

const persistQueued = async (sessionId, unitId, task, snapshot, objectKey) => {
  await withSessionMutationLock(sessionId, async () => {
    const state = await readWindowsState(sessionId)
    state.jobs[unitId] = {
      unitId,
      taskId: task.id,
      status: task.status,
      provider: WINDOWS_PROVIDER,
      adapter: WINDOWS_ADAPTER,
      generationFingerprint: task.generationFingerprint,
      revision: task.revision,
      attempt: task.attempt || 0,
      maxAttempts: task.maxAttempts || 3,
      inputObjectKey: objectKey,
      imageSha256: snapshot.sha256,
      promptSnapshot: snapshot.prompt,
      settingsSnapshot: snapshot.settings,
      progress: task.progress || null,
      error: task.error || null,
      queuedAt: task.createdAt || new Date().toISOString(),
      updatedAt: task.updatedAt || new Date().toISOString(),
    }
    await writeWindowsState(sessionId, state)
    const project = await readSessionSnapshot(sessionId)
    project.video_jobs ||= {}
    project.video_jobs[unitId] = resolvedJob(state.jobs[unitId])
    project.videoGenerationControl = state.videoGenerationControl
    await writeSessionSnapshot(sessionId, project)
  })
  activeProjects.add(sessionId)
}

export const recoverBrokerProjectTasks = async (sessionId) => {
  if (!isMediaBrokerConfigured()) return 0
  const project = await readSessionSnapshot(sessionId)
  const brokerTasks = await mediaBroker.listProject(sessionId)
  let recovered = 0
  for (const task of brokerTasks) {
    const unitId = String(task.owner?.itemId || '')
    if (!findPrompt(project, unitId)) continue
    const currentState = await readWindowsState(sessionId)
    if (currentState.jobs[unitId]?.taskId) continue
    let snapshot
    try { snapshot = await snapshotWindowsInput(project, sessionId, unitId) } catch { continue }
    if (!producerTaskMapsToProject(sessionId, unitId, task, snapshot)) continue
    if (!ACTIVE_STATUSES.has(task.status) && task.status !== 'completed') continue
    await persistQueued(sessionId, unitId, task, snapshot, task.input.image.objectKey)
    recovered += 1
    if (task.status === 'completed') await applyBrokerTask(sessionId, unitId, task)
  }
  return recovered
}

export const queueWindowsUnits = async (sessionId, requestedUnitIds) => {
  if (!validSessionId(sessionId)) throw new Error('A valid sessionId is required')
  if (!isMediaBrokerConfigured()) throw new Error('Windows media broker is not configured')
  const project = await readSessionSnapshot(sessionId)
  const state = await readWindowsState(sessionId)
  if (state.videoGenerationControl?.paused) throw new Error('Windows video generation is paused for this project')
  const required = new Set((project.video_prompts || []).map(unitIdForPrompt))
  const unitIds = [...new Set(requestedUnitIds || [])]
  if (unitIds.length === 0 || unitIds.length > 100) throw new Error('unitIds must contain 1-100 shots')
  const results = []
  for (const unitId of unitIds) {
    try {
      if (!required.has(unitId)) throw new Error(`Unknown video unit ${unitId}`)
      const existing = state.jobs?.[unitId]
      const snapshot = await snapshotWindowsInput(project, sessionId, unitId)
      const sameInputs = existing
        && snapshot.sha256 === existing.imageSha256
        && snapshot.prompt === existing.promptSnapshot
        && JSON.stringify(snapshot.settings) === JSON.stringify(existing.settingsSnapshot)
      if (sameInputs && (existing.status === 'completed' || (ACTIVE_STATUSES.has(existing.status) && !existing.cancelRequestedAt))) {
        results.push({ unitId, reused: true, task: resolvedJob(existing) })
        continue
      }
      const objectKey = await uploadSnapshot(sessionId, unitId, snapshot)
      const task = await mediaBroker.enqueue(taskRequest(sessionId, unitId, snapshot, objectKey))
      await persistQueued(sessionId, unitId, task, snapshot, objectKey)
      results.push({ unitId, reused: Boolean(task.reused), task })
    } catch (error) {
      results.push({ unitId, error: { code: error.code || 'QUEUE_FAILED', message: error.message, retryable: error.retryable !== false } })
    }
  }
  return results
}

const currentSnapshotMatches = async (project, sessionId, unitId, job) => {
  try {
    const current = await snapshotWindowsInput(project, sessionId, unitId)
    return current.sha256 === job.imageSha256
      && current.prompt === job.promptSnapshot
      && JSON.stringify(current.settings) === JSON.stringify(job.settingsSnapshot)
  } catch {
    return false
  }
}

const brokerTaskMatchesPersistedJob = (sessionId, unitId, job, task) => {
  const owner = task?.owner || {}
  const input = task?.input || {}
  return owner.domain === 'content-machine'
    && owner.projectId === sessionId
    && owner.batchId === `content-machine:${sessionId}`
    && owner.rowId === sessionId
    && owner.itemType === 'shot'
    && owner.itemId === unitId
    && task.groupId === `content-machine:${sessionId}`
    && task.generationFingerprint === job.generationFingerprint
    && task.revision === job.revision
    && input.prompt === job.promptSnapshot
    && input.image?.sha256 === job.imageSha256
    && JSON.stringify(input.settings) === JSON.stringify(job.settingsSnapshot)
}

const applyBrokerTask = async (sessionId, unitId, brokerTask) => {
  let appliedTaskId = null
  await withSessionMutationLock(sessionId, async () => {
    const state = await readWindowsState(sessionId)
    const job = state.jobs[unitId]
    if (!job || job.taskId !== brokerTask.id) return
    let project
    try { project = await readSessionSnapshot(sessionId) } catch { return }
    if (!brokerTaskMatchesPersistedJob(sessionId, unitId, job, brokerTask)) {
      job.status = 'superseded'
      job.error = {
        code: 'BROKER_TASK_MISMATCH',
        message: 'Broker task ownership or immutable inputs do not match this project item',
        retryable: false,
      }
      job.updatedAt = new Date().toISOString()
      state.jobs[unitId] = job
      await writeWindowsState(sessionId, state)
      project.video_jobs ||= {}
      project.video_jobs[unitId] = resolvedJob(job)
      await writeSessionSnapshot(sessionId, project)
      return
    }
    const common = {
      status: brokerTask.status,
      attempt: brokerTask.attempt,
      maxAttempts: brokerTask.maxAttempts,
      progress: brokerTask.progress || null,
      error: brokerTask.error || null,
      updatedAt: brokerTask.updatedAt || new Date().toISOString(),
    }
    if (brokerTask.status === 'completed' && brokerTask.result) {
      if (state.videoGenerationControl?.paused || job.cancelRequestedAt || !(await currentSnapshotMatches(project, sessionId, unitId, job))) {
        Object.assign(job, common, { status: 'superseded', error: { code: 'STALE_INPUT', message: 'Completed output no longer matches the current image, prompt, or settings', retryable: false } })
      } else {
        Object.assign(job, common, {
          status: 'completed',
          url: brokerTask.result.publicUrl,
          objectKey: brokerTask.result.objectKey,
          etag: brokerTask.result.etag,
          sizeBytes: brokerTask.result.sizeBytes,
          sha256: brokerTask.result.sha256,
          durationSeconds: brokerTask.result.durationSeconds,
          width: brokerTask.result.width,
          height: brokerTask.result.height,
          fps: brokerTask.result.fps,
          videoCodec: brokerTask.result.videoCodec,
          hasAudio: brokerTask.result.hasAudio,
          completedAt: brokerTask.completedAt || brokerTask.updatedAt,
          appliedPending: true,
          appliedAt: null,
          error: null,
        })
        appliedTaskId = brokerTask.id
      }
    } else {
      Object.assign(job, common)
    }
    state.jobs[unitId] = job
    await writeWindowsState(sessionId, state)
    project.video_jobs ||= {}
    project.video_jobs[unitId] = resolvedJob(job)
    project.videoGenerationControl = state.videoGenerationControl
    await writeSessionSnapshot(sessionId, project)
  })
  if (appliedTaskId) await acknowledgeAppliedResult(sessionId, unitId, appliedTaskId)
}

const acknowledgeAppliedResult = async (sessionId, unitId, taskId) => {
  try {
    await mediaBroker.markApplied(taskId, sessionId)
  } catch (error) {
    await withSessionMutationLock(sessionId, async () => {
      const state = await readWindowsState(sessionId)
      const job = state.jobs[unitId]
      if (job?.taskId !== taskId || job.status !== 'completed') return
      job.appliedPending = true
      job.appliedError = { code: error.code || 'APPLIED_RECEIPT_FAILED', message: error.message, retryable: error.retryable !== false }
      await writeWindowsState(sessionId, state)
    })
    return false
  }
  await withSessionMutationLock(sessionId, async () => {
    const state = await readWindowsState(sessionId)
    const job = state.jobs[unitId]
    if (job?.taskId !== taskId || job.status !== 'completed') return
    job.appliedPending = false
    job.appliedAt = new Date().toISOString()
    job.appliedError = null
    await writeWindowsState(sessionId, state)
    try {
      const project = await readSessionSnapshot(sessionId)
      project.video_jobs ||= {}
      project.video_jobs[unitId] = resolvedJob(job)
      await writeSessionSnapshot(sessionId, project)
    } catch { /* the project may have been deleted after attachment */ }
  })
  return true
}

const retryControlOperations = async (sessionId) => {
  const state = await readWindowsState(sessionId)
  for (const [unitId, job] of Object.entries(state.jobs)) {
    if (job.status === 'completed' && job.appliedPending && job.taskId) {
      await acknowledgeAppliedResult(sessionId, unitId, job.taskId)
    }
  }
  const latest = await readWindowsState(sessionId)
  for (const pending of [...latest.pendingTaskCancellations]) {
    try {
      await mediaBroker.cancelTask(pending.taskId, sessionId, pending.reason)
      await withSessionMutationLock(sessionId, async () => {
        const current = await readWindowsState(sessionId)
        current.pendingTaskCancellations = current.pendingTaskCancellations.filter((item) => item.taskId !== pending.taskId)
        await writeWindowsState(sessionId, current)
      })
    } catch { /* retry during the next reconciliation pass */ }
  }
  const afterTasks = await readWindowsState(sessionId)
  if (afterTasks.projectCancelPending) {
    try {
      await mediaBroker.cancelProject(sessionId, afterTasks.projectCancelPending)
      await withSessionMutationLock(sessionId, async () => {
        const current = await readWindowsState(sessionId)
        current.projectCancelPending = null
        current.brokerAvailable = true
        current.lastBrokerError = null
        await writeWindowsState(sessionId, current)
      })
    } catch (error) {
      await withSessionMutationLock(sessionId, async () => {
        const current = await readWindowsState(sessionId)
        current.brokerAvailable = false
        current.lastBrokerError = { code: error.code || 'BROKER_CANCEL_FAILED', message: error.message, retryable: error.retryable !== false }
        await writeWindowsState(sessionId, current)
      })
    }
  }
}

export const reconcileWindowsProject = async (sessionId) => {
  await retryControlOperations(sessionId)
  const state = await readWindowsState(sessionId)
  const tasks = Object.entries(state.jobs || {}).filter(([, job]) => job.taskId && !TERMINAL_STATUSES.has(job.status))
  for (const [unitId, job] of tasks) {
    try {
      const task = await mediaBroker.getTask(job.taskId, sessionId)
      await applyBrokerTask(sessionId, unitId, task)
      await withSessionMutationLock(sessionId, async () => {
        const current = await readWindowsState(sessionId)
        current.brokerAvailable = true
        current.lastBrokerError = null
        await writeWindowsState(sessionId, current)
      })
    } catch (error) {
      if (!error.retryable && error.status === 404) {
        await applyBrokerTask(sessionId, unitId, { id: job.taskId, status: 'failed', attempt: job.attempt, maxAttempts: job.maxAttempts, error: { code: 'BROKER_TASK_MISSING', message: 'Broker task no longer exists', retryable: false }, updatedAt: new Date().toISOString() })
      } else {
        await withSessionMutationLock(sessionId, async () => {
          const current = await readWindowsState(sessionId)
          current.brokerAvailable = false
          current.lastBrokerError = { code: error.code || 'BROKER_UNAVAILABLE', message: error.message, retryable: error.retryable !== false }
          await writeWindowsState(sessionId, current)
        })
      }
    }
  }
  const updated = await readWindowsState(sessionId)
  const needsWork = Object.values(updated.jobs).some((job) => ACTIVE_STATUSES.has(job.status) || job.appliedPending)
    || updated.pendingTaskCancellations.length > 0 || Boolean(updated.projectCancelPending)
  if (!needsWork) activeProjects.delete(sessionId)
  return aggregateWindowsState(sessionId, updated)
}

export const aggregateWindowsState = (sessionId, state) => {
  const jobs = Object.values(state.jobs || {})
  const count = (statuses) => jobs.filter((job) => statuses.has(job.status)).length
  return {
    sessionId,
    paused: Boolean(state.videoGenerationControl?.paused),
    jobs: Object.fromEntries(Object.entries(state.jobs || {}).map(([key, job]) => [key, resolvedJob(job)])),
    tasks: Object.values(state.jobs || {}).map(resolvedJob),
    brokerAvailable: Boolean(state.brokerAvailable && isMediaBrokerConfigured()),
    brokerError: state.lastBrokerError || null,
    updatedAt: state.updatedAt,
    counts: {
      required: jobs.length,
      queued: count(new Set(['queued'])),
      active: count(new Set(['leased', 'generating', 'uploading', 'validating'])),
      completed: count(new Set(['completed'])),
      failed: count(new Set(['failed'])),
      canceled: count(new Set(['canceled'])),
      superseded: count(new Set(['superseded'])),
    },
  }
}

const invalidateStaleCompletedJobs = async (sessionId) => {
  await withSessionMutationLock(sessionId, async () => {
    const state = await readWindowsState(sessionId)
    const completed = Object.entries(state.jobs).filter(([, job]) => job.status === 'completed' && job.provider === WINDOWS_PROVIDER)
    if (completed.length === 0) return
    const project = await readSessionSnapshot(sessionId)
    let changed = false
    for (const [unitId, job] of completed) {
      if (await currentSnapshotMatches(project, sessionId, unitId, job)) continue
      job.status = 'superseded'
      job.error = { code: 'STALE_INPUT', message: 'The selected image, prompt, or Windows settings changed after this video completed', retryable: false }
      job.updatedAt = new Date().toISOString()
      project.video_jobs ||= {}
      project.video_jobs[unitId] = resolvedJob(job)
      changed = true
    }
    if (changed) {
      await writeWindowsState(sessionId, state)
      await writeSessionSnapshot(sessionId, project)
    }
  })
}

export const windowsStatus = async (sessionId, reconcile = true) => {
  if (reconcile && isMediaBrokerConfigured()) await reconcileWindowsProject(sessionId)
  await invalidateStaleCompletedJobs(sessionId)
  const status = aggregateWindowsState(sessionId, await readWindowsState(sessionId))
  try {
    const project = await readSessionSnapshot(sessionId)
    const required = (project.video_prompts || []).map(unitIdForPrompt)
    status.counts.required = required.length
    status.counts.selected = required.filter((unitId) => project.selected_videos?.[unitId]?.url).length
    status.counts.missing = required.filter((unitId) => {
      const job = status.jobs[unitId]
      return !job || ['failed', 'canceled', 'superseded'].includes(job.status)
    }).length
  } catch { /* session deletion may race a final poll */ }
  return status
}

export const cancelWindowsProject = async (sessionId, options = {}) => {
  if (!validSessionId(sessionId)) throw new Error('A valid session id is required')
  const state = await readWindowsState(sessionId)
  const brokerJobs = Object.values(state.jobs).filter((job) => job.taskId)
  if (!isMediaBrokerConfigured()) {
    if (brokerJobs.length > 0) throw new Error('Windows media broker is not configured; project tasks cannot be canceled safely')
    return
  }
  await withSessionMutationLock(sessionId, async () => {
    const current = await readWindowsState(sessionId)
    const now = new Date().toISOString()
    current.projectCancelPending = { ...options, requestedAt: now }
    for (const job of Object.values(current.jobs)) {
      if (job.taskId && ACTIVE_STATUSES.has(job.status)) job.cancelRequestedAt = now
    }
    await writeWindowsState(sessionId, current)
  })
  activeProjects.add(sessionId)
  try {
    await mediaBroker.cancelProject(sessionId, options)
    await withSessionMutationLock(sessionId, async () => {
      const current = await readWindowsState(sessionId)
      current.projectCancelPending = null
      current.brokerAvailable = true
      current.lastBrokerError = null
      await writeWindowsState(sessionId, current)
    })
  } catch (error) {
    await withSessionMutationLock(sessionId, async () => {
      const current = await readWindowsState(sessionId)
      const now = new Date().toISOString()
      for (const job of Object.values(current.jobs)) {
        if (!job.taskId || !job.cancelRequestedAt) continue
        if (!current.pendingTaskCancellations.some((item) => item.taskId === job.taskId)) {
          current.pendingTaskCancellations.push({
            taskId: job.taskId,
            unitId: job.unitId,
            reason: options.reason || 'Project cancellation requested',
            requestedAt: now,
          })
        }
      }
      // Exact task cancellation is safe to retry after resume; a delayed
      // project-wide cancellation could otherwise cancel freshly queued work.
      current.projectCancelPending = null
      current.brokerAvailable = false
      current.lastBrokerError = { code: error.code || 'BROKER_CANCEL_FAILED', message: error.message, retryable: error.retryable !== false }
      await writeWindowsState(sessionId, current)
    })
    throw error
  }
}

export const pauseWindowsProject = async (sessionId, reason = 'Paused by user') => {
  await withSessionMutationLock(sessionId, async () => {
    const state = await readWindowsState(sessionId)
    state.videoGenerationControl = { paused: true, updatedAt: new Date().toISOString(), reason }
    for (const job of Object.values(state.jobs)) {
      if (ACTIVE_STATUSES.has(job.status)) job.cancelRequestedAt = new Date().toISOString()
    }
    await writeWindowsState(sessionId, state)
    const project = await readSessionSnapshot(sessionId)
    project.videoGenerationControl = state.videoGenerationControl
    project.video_jobs = { ...(project.video_jobs || {}), ...Object.fromEntries(Object.entries(state.jobs).map(([key, job]) => [key, resolvedJob(job)])) }
    await writeSessionSnapshot(sessionId, project)
  })
  await cancelWindowsProject(sessionId, { reason })
  return windowsStatus(sessionId, false)
}

export const missingWindowsUnits = async (sessionId) => {
  await invalidateStaleCompletedJobs(sessionId)
  const project = await readSessionSnapshot(sessionId)
  const state = await readWindowsState(sessionId)
  const required = (project.video_prompts || []).map(unitIdForPrompt)
  return required.filter((unitId) => {
    const job = state.jobs[unitId]
    return !job || Boolean(job.cancelRequestedAt) || (!ACTIVE_STATUSES.has(job.status) && job.status !== 'completed')
  })
}

export const resetWindowsRepairBudget = async (sessionId) => {
  await withSessionMutationLock(sessionId, async () => {
    const state = await readWindowsState(sessionId)
    state.repairPasses = 0
    await writeWindowsState(sessionId, state)
  })
}

export const resumeWindowsProject = async (sessionId, manual = false) => {
  await withSessionMutationLock(sessionId, async () => {
    const state = await readWindowsState(sessionId)
    state.videoGenerationControl = { paused: false, updatedAt: new Date().toISOString() }
    if (manual) state.repairPasses = 0
    await writeWindowsState(sessionId, state)
  })
  const missing = await missingWindowsUnits(sessionId)
  return {
    queued: missing.length ? await queueWindowsUnits(sessionId, missing) : [],
    status: await windowsStatus(sessionId, false),
  }
}

export const attachManualWindowsVideo = async (sessionId, unitId, result) => {
  let taskToCancel = null
  await withSessionMutationLock(sessionId, async () => {
    const project = await readSessionSnapshot(sessionId)
    if (!findPrompt(project, unitId)) throw new Error(`Unknown video unit ${unitId}`)
    const state = await readWindowsState(sessionId)
    const previous = state.jobs[unitId]
    if (previous?.taskId && ACTIVE_STATUSES.has(previous.status)) {
      taskToCancel = previous.taskId
      state.pendingTaskCancellations.push({
        taskId: previous.taskId,
        unitId,
        reason: 'Superseded by manual video attachment',
        requestedAt: new Date().toISOString(),
      })
    }
    const job = {
      unitId,
      taskId: null,
      status: 'completed',
      provider: 'manual',
      adapter: 'manual-upload',
      ...result,
      error: null,
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    state.jobs[unitId] = job
    await writeWindowsState(sessionId, state)
    project.video_jobs ||= {}
    project.video_jobs[unitId] = resolvedJob(job)
    await writeSessionSnapshot(sessionId, project)
  })
  if (taskToCancel && isMediaBrokerConfigured()) {
    try {
      await mediaBroker.cancelTask(taskToCancel, sessionId, 'Superseded by manual video attachment')
      await withSessionMutationLock(sessionId, async () => {
        const state = await readWindowsState(sessionId)
        state.pendingTaskCancellations = state.pendingTaskCancellations.filter((item) => item.taskId !== taskToCancel)
        await writeWindowsState(sessionId, state)
      })
    } catch { activeProjects.add(sessionId) }
  }
  return windowsStatus(sessionId, false)
}

const discoverActiveProjects = async () => {
  let entries = []
  try { entries = await fs.readdir(OUTPUT_ROOT, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.isDirectory() || !validSessionId(entry.name)) continue
    try {
      await invalidateStaleCompletedJobs(entry.name)
      const state = await readWindowsState(entry.name)
      const projectNeedsWork = Object.values(state.jobs).some((job) => ACTIVE_STATUSES.has(job.status) || job.appliedPending)
        || state.pendingTaskCancellations.length > 0 || Boolean(state.projectCancelPending)
        || (!state.videoGenerationControl?.paused && Object.values(state.jobs).some((job) => ['failed', 'canceled', 'superseded'].includes(job.status)))
      if (projectNeedsWork) activeProjects.add(entry.name)
      if (!projectNeedsWork) {
        const recovered = await recoverBrokerProjectTasks(entry.name)
        if (recovered > 0) activeProjects.add(entry.name)
        else if (!state.videoGenerationControl?.paused && (await missingWindowsUnits(entry.name)).length > 0) activeProjects.add(entry.name)
      }
    } catch { /* corrupt projects remain visible for manual repair */ }
  }
}

export const startWindowsReconciler = async () => {
  if (reconcileTimer) return
  if (!isMediaBrokerConfigured()) return
  await discoverActiveProjects()
  const baseInterval = Math.max(5_000, Number(process.env.MEDIA_BROKER_POLL_INTERVAL_MS) || 5_000)
  const tick = async () => {
    if (reconciling) return
    reconciling = true
    try {
      for (const sessionId of [...activeProjects]) {
        try {
          await recoverBrokerProjectTasks(sessionId)
          await reconcileWindowsProject(sessionId)
          const state = await readWindowsState(sessionId)
          if (state.videoGenerationControl?.paused || state.projectCancelPending) continue
          const missing = await missingWindowsUnits(sessionId)
          const hasActive = Object.values(state.jobs).some((job) => ACTIVE_STATUSES.has(job.status) && !job.cancelRequestedAt)
          if (!hasActive && missing.length > 0 && (state.repairPasses || 0) < 2) {
            let mayRepair = false
            await withSessionMutationLock(sessionId, async () => {
              const current = await readWindowsState(sessionId)
              if (!current.videoGenerationControl?.paused && !current.projectCancelPending && (current.repairPasses || 0) < 2) {
                current.repairPasses = (current.repairPasses || 0) + 1
                await writeWindowsState(sessionId, current)
                mayRepair = true
              }
            })
            if (mayRepair) await queueWindowsUnits(sessionId, missing)
          }
        } catch (error) {
          console.warn(`[windows-video] ${sessionId} reconciliation delayed: ${error.message}`)
        }
      }
    } catch (error) {
      console.warn(`[windows-video] broker reconciliation delayed: ${error.message}`)
    } finally {
      reconciling = false
    }
  }
  reconcileTimer = setInterval(tick, baseInterval)
  reconcileTimer.unref?.()
  tick()
}
