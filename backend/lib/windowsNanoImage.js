import fs from 'fs/promises'
import path from 'path'
import { createHash, randomUUID } from 'crypto'
import sharp from 'sharp'
import { mediaBroker, isMediaBrokerConfigured } from './mediaBrokerClient.js'
import {
  readSessionSnapshot,
  sessionDirectory,
  validSessionId,
} from './sessionStore.js'

export const WINDOWS_NANO_IMAGE_PROVIDER = 'windows-nano-banana'
export const WINDOWS_NANO_IMAGE_MODEL = 'Nano Banana 2'
export const WINDOWS_NANO_IMAGE_ADAPTER = 'windows-nano-banana'
export const WINDOWS_NANO_IMAGE_MAX_TASKS = 80
export const WINDOWS_NANO_REFERENCE_MAX_BYTES = 1024 * 1024
export const WINDOWS_NANO_RESOLUTIONS = new Set(['1K', '2K', '4K'])
export const WINDOWS_NANO_ASPECT_RATIOS = new Set(['16:9', '9:16', '1:1'])

const ACTIVE = new Set(['queued', 'leased', 'generating', 'uploading', 'validating'])
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'superseded'])
const activeProjects = new Set()
const stateChains = new Map()
const itemChains = new Map()
let reconcileTimer = null
let reconciling = false

const stateFile = (sessionId) =>
  path.join(sessionDirectory(sessionId), 'windows-nano-image-state.json')

const emptyState = () => ({
  version: 1,
  jobs: {},
  control: { activeRunId: null, canceledAt: null, reason: null },
  updatedAt: new Date().toISOString(),
})

const readState = async (sessionId) => {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(sessionId), 'utf8'))
    if (parsed?.version !== 1 || !parsed.jobs) return emptyState()
    parsed.control ||= { activeRunId: null, canceledAt: null, reason: null }
    return parsed
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState()
    throw error
  }
}

const writeState = async (sessionId, state) => {
  await fs.mkdir(sessionDirectory(sessionId), { recursive: true })
  state.updatedAt = new Date().toISOString()
  const target = stateFile(sessionId)
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
  await fs.rename(temporary, target)
}

const withState = async (sessionId, operation) => {
  const previous = stateChains.get(sessionId) || Promise.resolve()
  const current = previous.then(async () => {
    const state = await readState(sessionId)
    const result = await operation(state)
    await writeState(sessionId, state)
    return result
  })
  const tail = current.catch(() => undefined)
  stateChains.set(sessionId, tail)
  try {
    return await current
  } finally {
    if (stateChains.get(sessionId) === tail) stateChains.delete(sessionId)
  }
}

const withItem = async (sessionId, itemId, operation) => {
  const key = `${sessionId}:${itemId}`
  const previous = itemChains.get(key) || Promise.resolve()
  const current = previous.then(operation)
  const tail = current.catch(() => undefined)
  itemChains.set(key, tail)
  try {
    return await current
  } finally {
    if (itemChains.get(key) === tail) itemChains.delete(key)
  }
}

const safeItemId = (value) => {
  const normalized = String(value || '').trim()
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(normalized)) {
    throw new Error('Nano image itemId must be a stable safe identifier')
  }
  return normalized
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

export const normalizeNanoReference = async (reference) => {
  if (!reference?.bytes?.length) return null
  let width = 1600
  let quality = 86
  let bytes
  while (true) {
    bytes = await sharp(reference.bytes, { failOn: 'warning' })
      .rotate()
      .resize({
        width,
        height: width,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer()
    if (bytes.length <= WINDOWS_NANO_REFERENCE_MAX_BYTES) break
    if (quality > 62) {
      quality -= 8
      continue
    }
    if (width > 768) {
      width = Math.max(768, Math.floor(width * 0.8))
      quality = 78
      continue
    }
    throw new Error('Nano Banana reference could not be normalized below 1 MiB')
  }
  return {
    bytes,
    contentType: 'image/jpeg',
    fileName: 'reference.jpg',
    sha256: sha256(bytes),
  }
}

const assertActiveRun = async (sessionId, runId) => {
  if (!runId) return
  const state = await readState(sessionId)
  if (state.control?.activeRunId !== runId || state.control?.canceledAt) {
    const error = new Error('Nano image generation was canceled')
    error.code = 'IMAGE_GENERATION_CANCELED'
    error.retryable = false
    throw error
  }
}

export const beginWindowsNanoImageRun = async (
  sessionId,
  { reuseActive = false } = {},
) => {
  if (!validSessionId(sessionId)) throw new Error('A valid sessionId is required')
  await readSessionSnapshot(sessionId)
  const runId = await withState(sessionId, async (state) => {
    if (reuseActive && state.control?.activeRunId && !state.control?.canceledAt) {
      return state.control.activeRunId
    }
    const nextRunId = randomUUID()
    state.control = {
      activeRunId: nextRunId,
      canceledAt: null,
      reason: null,
      startedAt: new Date().toISOString(),
    }
    return nextRunId
  })
  activeProjects.add(sessionId)
  return runId
}

const uploadReference = async (sessionId, itemId, reference) => {
  if (!reference) return null
  const request = {
    projectId: sessionId,
    itemId,
    fileName: reference.fileName,
    contentType: reference.contentType,
    sizeBytes: reference.bytes.length,
    sha256: reference.sha256,
  }
  let upload
  try {
    upload = await mediaBroker.createInputSession(request)
  } catch (error) {
    if (error.code !== 'TASK_CANCELED' || !/producer project was deleted/i.test(error.message)) {
      throw error
    }
    await mediaBroker.reactivateProject(sessionId)
    upload = await mediaBroker.createInputSession(request)
  }
  if (!upload.alreadyExists) await mediaBroker.uploadInput(upload, reference.bytes)
  return {
    objectKey: upload.objectKey,
    sha256: reference.sha256,
    contentType: reference.contentType,
  }
}

const taskRequest = ({ sessionId, itemId, prompt, referenceImage, settings, priority, revision }) => ({
  kind: 'media.text-to-image',
  owner: {
    domain: 'content-machine',
    projectId: sessionId,
    batchId: `content-machine:${sessionId}`,
    rowId: `${itemId}:r${revision}`,
    itemType: 'image',
    itemId,
  },
  groupId: `content-machine:${sessionId}`,
  referenceImage,
  prompt,
  settings,
  priority,
  maxAttempts: 4,
})

const queueUnlocked = async ({
  sessionId,
  itemId: rawItemId,
  prompt: rawPrompt,
  reference = null,
  aspectRatio = '16:9',
  resolution = '1K',
  priority = 0,
  revision = 1,
  runId = null,
  metadata = {},
  force = false,
}) => {
  if (!validSessionId(sessionId)) throw new Error('A valid sessionId is required')
  if (!isMediaBrokerConfigured()) throw new Error('Windows media broker is not configured')
  const itemId = safeItemId(rawItemId)
  const prompt = String(rawPrompt || '').trim()
  if (!prompt || prompt.length > 50_000) {
    throw new Error('Nano Banana prompts must contain 1-50,000 characters')
  }
  if (!WINDOWS_NANO_ASPECT_RATIOS.has(aspectRatio)) {
    throw new Error('Nano Banana aspect ratio must be 16:9, 9:16, or 1:1')
  }
  if (!WINDOWS_NANO_RESOLUTIONS.has(resolution)) {
    throw new Error('Nano Banana resolution must be 1K, 2K, or 4K')
  }
  await assertActiveRun(sessionId, runId)
  await readSessionSnapshot(sessionId)
  const normalizedReference = await normalizeNanoReference(reference)
  const referenceImage = await uploadReference(sessionId, itemId, normalizedReference)
  await assertActiveRun(sessionId, runId)
  const settings = {
    provider: 'nano-banana',
    promptModel: WINDOWS_NANO_IMAGE_MODEL,
    aspectRatio,
    resolution,
    adapter: WINDOWS_NANO_IMAGE_ADAPTER,
  }
  const existing = await readState(sessionId).then((state) => state.jobs[itemId])
  const sameInputs = existing
    && existing.promptSnapshot === prompt
    && existing.referenceSha256 === (referenceImage?.sha256 || null)
    && JSON.stringify(existing.settingsSnapshot) === JSON.stringify(settings)
  if (
    !force
    && sameInputs
    && !['failed', 'canceled', 'superseded'].includes(existing.status)
  ) {
    activeProjects.add(sessionId)
    return existing
  }
  const requestedRevision = Math.max(
    Number(revision) || 1,
    sameInputs ? Number(existing?.revision || 0) + 1 : 1,
  )
  const task = await mediaBroker.enqueue(taskRequest({
    sessionId,
    itemId,
    prompt,
    referenceImage,
    settings,
    priority: Math.max(-1000, Math.min(1000, Math.floor(Number(priority) || 0))),
    revision: requestedRevision,
  }))
  const job = {
    itemId,
    taskId: task.id,
    status: task.status,
    provider: WINDOWS_NANO_IMAGE_PROVIDER,
    model: WINDOWS_NANO_IMAGE_MODEL,
    adapter: WINDOWS_NANO_IMAGE_ADAPTER,
    generationFingerprint: task.generationFingerprint,
    revision: task.revision || requestedRevision,
    promptSnapshot: prompt,
    referenceSha256: referenceImage?.sha256 || null,
    referenceObjectKey: referenceImage?.objectKey || null,
    settingsSnapshot: settings,
    metadata,
    attempts: task.attempt || 0,
    maxAttempts: task.maxAttempts || 4,
    progress: task.progress || null,
    error: task.error || null,
    queuedAt: task.createdAt || new Date().toISOString(),
    updatedAt: task.updatedAt || new Date().toISOString(),
  }
  await withState(sessionId, async (state) => {
    state.jobs[itemId] = job
  })
  activeProjects.add(sessionId)
  return job
}

export const queueWindowsNanoImageTask = (input) =>
  withItem(String(input?.sessionId || ''), String(input?.itemId || ''), () => queueUnlocked(input))

const taskMatchesJob = (sessionId, itemId, task, job) =>
  task?.kind === 'media.text-to-image'
  && task.owner?.domain === 'content-machine'
  && task.owner?.projectId === sessionId
  && task.owner?.batchId === `content-machine:${sessionId}`
  && task.owner?.itemType === 'image'
  && task.owner?.itemId === itemId
  && task.groupId === `content-machine:${sessionId}`
  && task.generationFingerprint === job.generationFingerprint
  && task.input?.prompt === job.promptSnapshot
  && (task.input?.referenceImage?.sha256 || null) === job.referenceSha256
  && JSON.stringify(task.input?.settings) === JSON.stringify(job.settingsSnapshot)

const applyBrokerTask = async (sessionId, itemId, task) => {
  let appliedTaskId = null
  const result = await withState(sessionId, async (state) => {
    const job = state.jobs[itemId]
    if (!job || job.taskId !== task.id) return job || null
    if (!taskMatchesJob(sessionId, itemId, task, job)) {
      job.status = 'superseded'
      job.error = {
        code: 'BROKER_TASK_MISMATCH',
        message: 'Nano task ownership or immutable inputs do not match this project item',
        retryable: false,
      }
      job.updatedAt = new Date().toISOString()
      return structuredClone(job)
    }
    job.status = task.status
    job.attempts = task.attempt || job.attempts || 0
    job.progress = task.progress || null
    job.error = task.error || null
    job.updatedAt = task.updatedAt || new Date().toISOString()
    if (task.status === 'completed' && task.result?.publicUrl) {
      Object.assign(job, {
        url: task.result.publicUrl,
        objectKey: task.result.objectKey,
        etag: task.result.etag,
        sizeBytes: task.result.sizeBytes,
        sha256: task.result.sha256,
        width: task.result.width,
        height: task.result.height,
        format: task.result.format,
        mimeType: task.result.mimeType,
        completedAt: task.completedAt || task.updatedAt,
        appliedPending: true,
        appliedAt: null,
        appliedError: null,
        error: null,
      })
      appliedTaskId = task.id
    }
    return structuredClone(job)
  })
  if (appliedTaskId) {
    await acknowledgeAppliedResult(sessionId, itemId, appliedTaskId)
  }
  return result
}

const acknowledgeAppliedResult = async (sessionId, itemId, taskId) => {
  try {
    await mediaBroker.markApplied(taskId, sessionId)
  } catch (error) {
    await withState(sessionId, async (state) => {
      const job = state.jobs[itemId]
      if (job?.taskId !== taskId || job.status !== 'completed') return
      job.appliedPending = true
      job.appliedError = {
        code: error.code || 'APPLIED_RECEIPT_FAILED',
        message: error.message,
        retryable: error.retryable !== false,
      }
      job.updatedAt = new Date().toISOString()
    })
    activeProjects.add(sessionId)
    return false
  }
  await withState(sessionId, async (state) => {
    const job = state.jobs[itemId]
    if (job?.taskId !== taskId || job.status !== 'completed') return
    job.appliedPending = false
    job.appliedAt = new Date().toISOString()
    job.appliedError = null
    job.updatedAt = job.appliedAt
  })
  return true
}

export const reconcileWindowsNanoImageJob = async (sessionId, itemId) => {
  const job = await readState(sessionId).then((state) => state.jobs[itemId])
  if (!job?.taskId) return job || null
  if (job.status === 'completed' && job.appliedPending) {
    await acknowledgeAppliedResult(sessionId, itemId, job.taskId)
    return readState(sessionId).then((state) => state.jobs[itemId] || null)
  }
  if (TERMINAL.has(job.status)) return job
  try {
    const task = await mediaBroker.getTask(job.taskId, sessionId)
    return await applyBrokerTask(sessionId, itemId, task)
  } catch (error) {
    return withState(sessionId, async (state) => {
      const current = state.jobs[itemId]
      if (!current || current.taskId !== job.taskId) return current || null
      current.brokerError = {
        code: error.code || 'BROKER_UNAVAILABLE',
        message: error.message,
      }
      current.updatedAt = new Date().toISOString()
      return structuredClone(current)
    })
  }
}

export const getWindowsNanoImageJob = async (
  sessionId,
  itemId,
  { reconcile = true } = {},
) => {
  if (reconcile) await reconcileWindowsNanoImageJob(sessionId, itemId)
  return readState(sessionId).then((state) => state.jobs[itemId] || null)
}

export const retryWindowsNanoImageTask = async (sessionId, itemId, input) => {
  const existing = await getWindowsNanoImageJob(sessionId, itemId, { reconcile: true })
  if (existing && !TERMINAL.has(existing.status)) return existing
  return queueWindowsNanoImageTask({
    ...input,
    sessionId,
    itemId,
    revision: Math.max(1, Number(existing?.revision || 0) + 1),
    force: true,
  })
}

export const cancelWindowsNanoImageProject = async (
  sessionId,
  reason = 'Canceled by user',
) => {
  if (!validSessionId(sessionId)) throw new Error('A valid sessionId is required')
  const canceledAt = new Date().toISOString()
  const taskIds = await withState(sessionId, async (state) => {
    state.control = { activeRunId: null, canceledAt, reason }
    const activeTaskIds = []
    for (const job of Object.values(state.jobs)) {
      if (TERMINAL.has(job.status)) continue
      if (job.taskId) activeTaskIds.push(job.taskId)
      job.status = 'canceled'
      job.error = { code: 'TASK_CANCELED', message: reason, retryable: false }
      job.progress = null
      job.canceledAt = canceledAt
      job.updatedAt = canceledAt
    }
    return activeTaskIds
  })
  await Promise.allSettled(
    taskIds.map((taskId) => mediaBroker.cancelTask(taskId, sessionId, reason)),
  )
  activeProjects.delete(sessionId)
  return { canceledAt, canceled: taskIds.length }
}

const reconcileActiveProjects = async () => {
  if (reconciling) return
  reconciling = true
  try {
    for (const sessionId of [...activeProjects]) {
      const state = await readState(sessionId).catch(() => null)
      if (!state) {
        activeProjects.delete(sessionId)
        continue
      }
      const active = Object.entries(state.jobs).filter(
        ([, job]) => ACTIVE.has(job.status) || job.appliedPending,
      )
      await Promise.all(active.slice(0, WINDOWS_NANO_IMAGE_MAX_TASKS).map(
        ([itemId]) => reconcileWindowsNanoImageJob(sessionId, itemId),
      ))
      const refreshed = await readState(sessionId)
      if (Object.values(refreshed.jobs).every(
        (job) => TERMINAL.has(job.status) && !job.appliedPending,
      )) {
        activeProjects.delete(sessionId)
      }
    }
  } finally {
    reconciling = false
  }
}

export const startWindowsNanoImageReconciler = () => {
  if (reconcileTimer || !isMediaBrokerConfigured()) return
  reconcileTimer = setInterval(() => {
    void reconcileActiveProjects()
  }, Math.max(2_000, Number(process.env.MEDIA_BROKER_IMAGE_POLL_INTERVAL_MS) || 5_000))
  reconcileTimer.unref?.()
}

export const discoverWindowsNanoImageProjects = async (outputRoot) => {
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !validSessionId(entry.name)) continue
    const state = await readState(entry.name).catch(() => null)
    if (state && Object.values(state.jobs).some(
      (job) => !TERMINAL.has(job.status) || job.appliedPending,
    )) {
      activeProjects.add(entry.name)
    }
  }
}
