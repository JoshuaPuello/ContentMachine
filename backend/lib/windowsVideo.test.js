import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'fs/promises'
import { randomUUID } from 'crypto'
import {
  buildWindowsPrompt,
  cancelWindowsProject,
  mergeWindowsStateIntoProject,
  missingWindowsUnits,
  queueWindowsUnits,
  readWindowsState,
  regenerateWindowsUnit,
  recoverBrokerProjectTasks,
  reconcileWindowsProject,
  resumeWindowsProject,
  snapshotWindowsInput,
  WINDOWS_SETTINGS,
  windowsStatus,
} from './windowsVideo.js'
import { readSessionSnapshot, sessionDirectory, writeSessionSnapshot } from './sessionStore.js'

const onePixelPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test('Windows prompt preserves the full prompt and negative constraints without silent truncation', () => {
  assert.equal(
    buildWindowsPrompt({ full_prompt_string: 'A precise human movement.', negative_prompt: 'extra people, style drift' }),
    'A precise human movement.\n\nAvoid: extra people, style drift',
  )
  assert.throws(() => buildWindowsPrompt({ full_prompt_string: 'x'.repeat(5001) }), /maximum is 5000/)
})

test('Windows prompt does not duplicate an already embedded negative block', () => {
  const negative = 'extra figures, human skin, unstable edges'
  const full = `One continuous documentary shot.\n\nAvoid: ${negative}.`
  assert.equal(buildWindowsPrompt({ full_prompt_string: full, negative_prompt: negative }), full)
})

test('explicit regeneration revision produces a fresh broker fingerprint prompt', () => {
  const original = buildWindowsPrompt({ full_prompt_string: 'Locked action.' })
  const regenerated = buildWindowsPrompt({
    full_prompt_string: 'Locked action.',
    generation_revision: 2,
  })
  assert.equal(original, 'Locked action.')
  assert.equal(regenerated, 'Locked action.\n\nTAKE REVISION: 2.')
})

test('regeneration revision preserves near-limit quality prompts', () => {
  const regenerated = buildWindowsPrompt({
    full_prompt_string: 'x'.repeat(4975),
    generation_revision: 12,
  })
  assert.equal(regenerated.length, 4995)
})

test('Windows snapshot uses the exact selected bytes, fixed adapter contract, and stable unit mapping', async () => {
  const project = {
    selected_images: { '12_1': { url: `data:image/png;base64,${onePixelPng}` } },
    video_prompts: [{ scene_number: 12, segment_index: 1, full_prompt_string: 'Locked prompt' }],
  }
  const snapshot = await snapshotWindowsInput(project, 'session_test', '12_1')
  assert.equal(snapshot.contentType, 'image/png')
  assert.equal(snapshot.bytes.toString('base64'), onePixelPng)
  assert.match(snapshot.sha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(snapshot.settings, WINDOWS_SETTINGS)
})

test('Windows snapshot rejects project path traversal and private remote image targets', async () => {
  const prompt = [{ scene_number: 1, segment_index: 0, full_prompt_string: 'Locked prompt' }]
  await assert.rejects(
    snapshotWindowsInput({
      selected_images: { '1_0': { url: '__session_file__/../../package.json' } },
      video_prompts: prompt,
    }, 'session_test', '1_0'),
    /escapes the project session directory/,
  )
  await assert.rejects(
    snapshotWindowsInput({
      selected_images: { '1_0': { url: 'https://127.0.0.1/private.png' } },
      video_prompts: prompt,
    }, 'session_test', '1_0'),
    /localhost or a private network/,
  )
  await assert.rejects(
    snapshotWindowsInput({
      selected_images: { '1_0': { url: 'https://[::ffff:127.0.0.1]/private.png' } },
      video_prompts: prompt,
    }, 'session_test', '1_0'),
    /localhost or a private network/,
  )
})

test('Windows snapshot rejects oversized remote images before buffering the response body', async (t) => {
  const originalFetch = globalThis.fetch
  let bodyRead = false
  const project = {
    selected_images: { '1_0': { url: 'https://8.8.8.8/oversized.png' } },
    video_prompts: [{ scene_number: 1, segment_index: 0, full_prompt_string: 'Locked prompt' }],
  }
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({
      'content-type': 'image/png',
      'content-length': String(50 * 1024 * 1024 + 1),
    }),
    body: {
      getReader: () => {
        bodyRead = true
        throw new Error('body must not be read')
      },
    },
  })
  t.after(() => { globalThis.fetch = originalFetch })
  await assert.rejects(
    snapshotWindowsInput(project, 'session_test', '1_0'),
    /exceeds the 50 MiB limit/,
  )
  assert.equal(bodyRead, false)

  let canceled = false
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/png' }),
    body: {
      getReader: () => ({
        read: async () => ({ done: false, value: { byteLength: 50 * 1024 * 1024 + 1 } }),
        cancel: async () => { canceled = true },
        releaseLock: () => {},
      }),
    },
  })
  await assert.rejects(
    snapshotWindowsInput(project, 'session_test', '1_0'),
    /exceeds the 50 MiB limit/,
  )
  assert.equal(canceled, true)
})

const startFakeBroker = async ({ appliedFailures = 0, inputDelayMs = 0, projectDeleted = false } = {}) => {
  const seen = {
    headers: [],
    uploads: 0,
    tasks: new Map(),
    taskRequests: [],
    projectCancellations: [],
    activeInputSessions: 0,
    maxActiveInputSessions: 0,
    applied: 0,
    appliedFailures,
    projectDeleted,
    reactivations: 0,
  }
  const server = http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length && request.headers['content-type'] === 'application/json'
      ? JSON.parse(Buffer.concat(chunks).toString())
      : {}
    seen.headers.push(request.headers)
    const send = (data, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ requestId: randomUUID(), data, error: null }))
    }
    if (pathname === '/upload' && request.method === 'PUT') {
      seen.uploads += 1
      response.writeHead(200); response.end(); return
    }
    if (pathname === '/api/media-producers/v1/inputs/session') {
      if (seen.projectDeleted) {
        response.writeHead(409, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ requestId: randomUUID(), data: null, error: { code: 'TASK_CANCELED', message: 'Producer project was deleted', retryable: false } }))
        return
      }
      seen.activeInputSessions += 1
      seen.maxActiveInputSessions = Math.max(
        seen.maxActiveInputSessions,
        seen.activeInputSessions,
      )
      if (inputDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, inputDelayMs))
      }
      seen.activeInputSessions -= 1
      send({ method: 'PUT', objectKey: `media-jobs/v1/producer-inputs/content-machine/${body.projectId}/${body.itemId}/${body.sha256}.png`, uploadUrl: `http://127.0.0.1:${server.address().port}/upload`, requiredHeaders: { 'Content-Type': body.contentType, 'Content-Length': String(body.sizeBytes), 'x-amz-meta-sha256': body.sha256 }, expiresAt: new Date(Date.now() + 60_000).toISOString(), alreadyExists: false }); return
    }
    const projectReactivateMatch = pathname.match(/^\/api\/media-producers\/v1\/projects\/([^/]+)\/reactivate$/)
    if (projectReactivateMatch && request.method === 'POST') {
      seen.projectDeleted = false
      seen.reactivations += 1
      send({ accepted: true, projectId: decodeURIComponent(projectReactivateMatch[1]), reactivated: true }); return
    }
    if (pathname === '/api/media-producers/v1/tasks' && request.method === 'POST') {
      const id = randomUUID()
      const task = {
        id, status: 'queued', owner: body.owner, groupId: body.groupId,
        generationFingerprint: 'f'.repeat(64), revision: 42,
        input: { prompt: body.prompt, image: { sha256: body.image.sha256, contentType: body.image.contentType }, settings: body.settings },
        attempt: 0, maxAttempts: 3, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      seen.taskRequests.push(body)
      seen.tasks.set(id, task); send(task, 202); return
    }
    const projectCancelMatch = pathname.match(/^\/api\/media-producers\/v1\/projects\/([^/]+)\/cancel$/)
    if (projectCancelMatch && request.method === 'POST') {
      seen.projectCancellations.push({
        projectId: decodeURIComponent(projectCancelMatch[1]),
        body,
      })
      for (const task of seen.tasks.values()) {
        if (task.owner.projectId !== decodeURIComponent(projectCancelMatch[1])) continue
        task.cancelRequestedAt = new Date().toISOString()
        if (task.status === 'queued') task.status = 'canceled'
      }
      send({ accepted: true }); return
    }
    if (pathname === '/api/media-producers/v1/tasks' && request.method === 'GET') {
      send({ tasks: [...seen.tasks.values()], pagination: { limit: 500, returned: seen.tasks.size, nextCursor: null } }); return
    }
    const taskMatch = pathname.match(/^\/api\/media-producers\/v1\/tasks\/([^/]+)$/)
    if (taskMatch && request.method === 'GET') {
      const original = seen.tasks.get(taskMatch[1])
      send({ ...original, status: 'completed', result: { objectKey: `media-jobs/v1/out/${original.id}.mp4`, publicUrl: `https://cdn.example/${original.id}.mp4`, etag: 'etag', sizeBytes: 1234, sha256: 'a'.repeat(64), durationSeconds: 8, width: 1280, height: 720, fps: 30, videoCodec: 'h264', hasAudio: false }, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); return
    }
    if (/\/applied$/.test(pathname)) {
      seen.applied += 1
      if (seen.appliedFailures > 0) {
        seen.appliedFailures -= 1
        response.writeHead(503, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ requestId: randomUUID(), data: null, error: { code: 'TEMPORARY', message: 'temporary receipt failure', retryable: true } }))
        return
      }
      send({ accepted: true }); return
    }
    send({ message: 'not found' }, 404)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` }
}

test('fake broker E2E survives browser closure and completion updates evidence without selecting it', async (t) => {
  const sessionId = `session_worker_test_${randomUUID().replaceAll('-', '')}`
  const broker = await startFakeBroker()
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve))
    await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
  })
  process.env.MEDIA_BROKER_URL = broker.url
  process.env.MEDIA_BROKER_PRODUCER_ID = 'content-machine'
  process.env.MEDIA_BROKER_PRODUCER_TOKEN = 'test-producer-secret'
  process.env.MEDIA_BROKER_PROTOCOL_VERSION = '1'
  const project = {
    selected_images: { '1_0': { url: `data:image/png;base64,${onePixelPng}` } },
    video_prompts: [{ scene_number: 1, segment_index: 0, full_prompt_string: 'A deliberate camera move.' }],
    video_jobs: {},
    selected_videos: {},
  }
  await writeSessionSnapshot(sessionId, project)
  const queued = await queueWindowsUnits(sessionId, ['1_0'])
  assert.equal(queued[0].error, undefined)
  assert.equal(broker.seen.uploads, 1)
  assert.equal(broker.seen.headers.some((headers) => headers['x-media-producer-id'] === 'content-machine'), true)

  await reconcileWindowsProject(sessionId)
  const completed = await readSessionSnapshot(sessionId)
  assert.equal(completed.video_jobs['1_0'].status, 'completed')
  assert.match(completed.video_jobs['1_0'].url, /^https:\/\/cdn\.example\//)
  assert.deepEqual(completed.selected_videos, {})

  const staleBrowser = { ...project, video_jobs: { '1_0': { status: 'pending' } } }
  await mergeWindowsStateIntoProject(staleBrowser, sessionId)
  assert.equal(staleBrowser.video_jobs['1_0'].status, 'completed')
})

test('queueing recovers a still-live project from an obsolete broker deletion tombstone', async (t) => {
  const sessionId = `session_worker_reactivate_${randomUUID().replaceAll('-', '')}`
  const broker = await startFakeBroker({ projectDeleted: true })
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve))
    await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
  })
  process.env.MEDIA_BROKER_URL = broker.url
  process.env.MEDIA_BROKER_PRODUCER_ID = 'content-machine'
  process.env.MEDIA_BROKER_PRODUCER_TOKEN = 'test-producer-secret'
  process.env.MEDIA_BROKER_PROTOCOL_VERSION = '1'
  await writeSessionSnapshot(sessionId, {
    selected_images: { '1_0': { url: `data:image/png;base64,${onePixelPng}` } },
    video_prompts: [{ scene_number: 1, segment_index: 0, full_prompt_string: 'A deliberate camera move.' }],
    video_jobs: {},
    selected_videos: {},
  })

  const queued = await queueWindowsUnits(sessionId, ['1_0'])

  assert.equal(queued[0].error, undefined)
  assert.equal(broker.seen.reactivations, 1)
  assert.equal(broker.seen.uploads, 1)
})

test('individual regeneration replaces a completed job with a genuinely fresh queued task', async (t) => {
  const sessionId = `session_worker_regenerate_${randomUUID().replaceAll('-', '')}`
  const broker = await startFakeBroker()
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve))
    await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
  })
  process.env.MEDIA_BROKER_URL = broker.url
  process.env.MEDIA_BROKER_PRODUCER_ID = 'content-machine'
  process.env.MEDIA_BROKER_PRODUCER_TOKEN = 'test-producer-secret'
  process.env.MEDIA_BROKER_PROTOCOL_VERSION = '1'
  await writeSessionSnapshot(sessionId, {
    selected_images: { '1_0': { url: `data:image/png;base64,${onePixelPng}` } },
    video_prompts: [{ scene_number: 1, segment_index: 0, full_prompt_string: 'Locked action.' }],
    video_jobs: {},
    video_history: {},
    selected_videos: {},
  })
  await queueWindowsUnits(sessionId, ['1_0'])
  await reconcileWindowsProject(sessionId)

  const regenerated = await regenerateWindowsUnit(sessionId, '1_0')
  const project = await readSessionSnapshot(sessionId)

  assert.equal(regenerated.error, undefined)
  assert.equal(project.video_jobs['1_0'].status, 'queued')
  assert.equal(project.video_prompts[0].generation_revision, 1)
  assert.equal(project.video_history['1_0'].length, 1)
  assert.equal(broker.seen.taskRequests.length, 2)
  assert.match(broker.seen.taskRequests[1].prompt, /TAKE REVISION: 1/)
})

test('late broker completion is superseded when the current prompt changed', async (t) => {
  const sessionId = `session_worker_stale_${randomUUID().replaceAll('-', '')}`
  const broker = await startFakeBroker()
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve))
    await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
  })
  process.env.MEDIA_BROKER_URL = broker.url
  process.env.MEDIA_BROKER_PRODUCER_TOKEN = 'test-producer-secret'
  const project = {
    selected_images: { '2_0': { url: `data:image/png;base64,${onePixelPng}` } },
    video_prompts: [{ scene_number: 2, segment_index: 0, full_prompt_string: 'Original prompt.' }],
    video_jobs: {}, selected_videos: {},
  }
  await writeSessionSnapshot(sessionId, project)
  await queueWindowsUnits(sessionId, ['2_0'])
  const changed = await readSessionSnapshot(sessionId)
  changed.video_prompts[0].full_prompt_string = 'New prompt after queue.'
  await writeSessionSnapshot(sessionId, changed)
  await reconcileWindowsProject(sessionId)
  const final = await readSessionSnapshot(sessionId)
  assert.equal(final.video_jobs['2_0'].status, 'superseded')
  assert.equal(final.selected_videos['2_0'], undefined)
})

test('a completed selected video is cleared when its selected source image changes', async (t) => {
  const sessionId = `session_worker_completed_stale_${randomUUID().replaceAll('-', '')}`
  const broker = await startFakeBroker()
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve))
    await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
  })
  process.env.MEDIA_BROKER_URL = broker.url
  process.env.MEDIA_BROKER_PRODUCER_TOKEN = 'test-producer-secret'
  await writeSessionSnapshot(sessionId, {
    selected_images: { '2_0': { url: `data:image/png;base64,${onePixelPng}` } },
    video_prompts: [{ scene_number: 2, segment_index: 0, full_prompt_string: 'Original prompt.' }],
    video_jobs: {},
    selected_videos: {},
  })
  await queueWindowsUnits(sessionId, ['2_0'])
  await reconcileWindowsProject(sessionId)

  const changed = await readSessionSnapshot(sessionId)
  changed.selected_videos['2_0'] = { url: changed.video_jobs['2_0'].url }
  const changedBytes = Buffer.concat([
    Buffer.from(onePixelPng, 'base64'),
    Buffer.from([0]),
  ]).toString('base64')
  changed.selected_images['2_0'] = { url: `data:image/png;base64,${changedBytes}` }
  await writeSessionSnapshot(sessionId, changed)

  await windowsStatus(sessionId)
  const final = await readSessionSnapshot(sessionId)
  assert.equal(final.video_jobs['2_0'].status, 'superseded')
  assert.equal(final.video_jobs['2_0'].url, undefined)
  assert.equal(final.selected_videos['2_0'], undefined)
})

test('an applied receipt survives a temporary broker failure and is retried durably', async (t) => {
  const sessionId = `session_worker_receipt_${randomUUID().replaceAll('-', '')}`
  const broker = await startFakeBroker({ appliedFailures: 1 })
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve))
    await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
  })
  process.env.MEDIA_BROKER_URL = broker.url
  process.env.MEDIA_BROKER_PRODUCER_TOKEN = 'test-producer-secret'
  await writeSessionSnapshot(sessionId, {
    selected_images: { '3_0': { url: `data:image/png;base64,${onePixelPng}` } },
    video_prompts: [{ scene_number: 3, segment_index: 0, full_prompt_string: 'Receipt retry.' }],
    video_jobs: {}, selected_videos: {},
  })
  await queueWindowsUnits(sessionId, ['3_0'])
  await reconcileWindowsProject(sessionId)
  assert.equal((await readWindowsState(sessionId)).jobs['3_0'].appliedPending, true)
  await reconcileWindowsProject(sessionId)
  const state = await readWindowsState(sessionId)
  assert.equal(state.jobs['3_0'].appliedPending, false)
  assert.match(state.jobs['3_0'].appliedAt, /^\d{4}-/)
  assert.equal(broker.seen.applied, 2)
})

test('resuming a complete project is a clean no-op', async (t) => {
  const sessionId = `session_worker_resume_${randomUUID().replaceAll('-', '')}`
  t.after(() => fs.rm(sessionDirectory(sessionId), { recursive: true, force: true }))
  await writeSessionSnapshot(sessionId, { video_prompts: [], video_jobs: {}, selected_videos: {} })
  const result = await resumeWindowsProject(sessionId, true)
  assert.deepEqual(result.queued, [])
  assert.equal(result.status.paused, false)
})

test('orphan repair preserves completed canonical videos from hosted providers', async (t) => {
  const sessionId = `session_worker_hosted_${randomUUID().replaceAll('-', '')}`
  t.after(() => fs.rm(sessionDirectory(sessionId), { recursive: true, force: true }))
  await writeSessionSnapshot(sessionId, {
    video_prompts: [
      { scene_number: 1, segment_index: 0, full_prompt_string: 'Already complete' },
      { scene_number: 2, segment_index: 0, full_prompt_string: 'Still missing' },
    ],
    video_jobs: {
      '1_0': { status: 'completed', provider: 'geminigen', url: 'https://cdn.example/hosted.mp4' },
      '2_0': { status: 'failed', provider: 'geminigen', error: 'Provider failed' },
    },
  })

  assert.deepEqual(await missingWindowsUnits(sessionId), ['2_0'])
})

test('Content Machine queues four shots with project concurrency four and deletion cancels only that project', async (t) => {
  const sessionId = `session_worker_parallel_${randomUUID().replaceAll('-', '')}`
  const broker = await startFakeBroker({ inputDelayMs: 25 })
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve))
    await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
  })
  process.env.MEDIA_BROKER_URL = broker.url
  process.env.MEDIA_BROKER_PRODUCER_TOKEN = 'test-producer-secret'
  process.env.MEDIA_BROKER_PROJECT_CONCURRENCY = '4'
  const unitIds = ['1_0', '2_0', '3_0', '4_0']
  await writeSessionSnapshot(sessionId, {
    selected_images: Object.fromEntries(unitIds.map((unitId) => [
      unitId,
      { url: `data:image/png;base64,${onePixelPng}` },
    ])),
    video_prompts: unitIds.map((unitId) => ({
      scene_number: Number(unitId.split('_')[0]),
      segment_index: 0,
      full_prompt_string: `Motion for ${unitId}`,
    })),
    video_jobs: {},
    selected_videos: {},
  })

  const queued = await queueWindowsUnits(sessionId, unitIds)
  assert.equal(queued.filter((result) => !result.error).length, 4)
  assert.equal(broker.seen.maxActiveInputSessions, 4)
  assert.equal(broker.seen.taskRequests.length, 4)
  assert.equal(
    broker.seen.taskRequests.every((request) =>
      request.projectConcurrency === 4
      && request.owner.batchId === `content-machine:${sessionId}`
    ),
    true,
  )

  await cancelWindowsProject(sessionId, {
    deleteAssets: true,
    reason: 'Content Machine project deleted',
  })
  assert.deepEqual(broker.seen.projectCancellations, [{
    projectId: sessionId,
    body: {
      deleteAssets: true,
      reason: 'Content Machine project deleted',
    },
  }])
  assert.equal(
    [...broker.seen.tasks.values()].every((task) =>
      task.owner.projectId === sessionId
      && task.status === 'canceled'
      && Boolean(task.cancelRequestedAt)
    ),
    true,
  )
})

test('restart recovery adopts a broker task created before local persistence', async (t) => {
  const sessionId = `session_worker_orphan_${randomUUID().replaceAll('-', '')}`
  const broker = await startFakeBroker()
  t.after(async () => {
    await new Promise((resolve) => broker.server.close(resolve))
    await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
  })
  process.env.MEDIA_BROKER_URL = broker.url
  process.env.MEDIA_BROKER_PRODUCER_TOKEN = 'test-producer-secret'
  const project = {
    selected_images: { '4_0': { url: `data:image/png;base64,${onePixelPng}` } },
    video_prompts: [{ scene_number: 4, segment_index: 0, full_prompt_string: 'Recover me.' }],
    video_jobs: {}, selected_videos: {},
  }
  await writeSessionSnapshot(sessionId, project)
  const snapshot = await snapshotWindowsInput(project, sessionId, '4_0')
  const id = randomUUID()
  broker.seen.tasks.set(id, {
    id, status: 'queued', groupId: `content-machine:${sessionId}`,
    owner: { domain: 'content-machine', projectId: sessionId, batchId: `content-machine:${sessionId}`, rowId: sessionId, itemType: 'shot', itemId: '4_0' },
    generationFingerprint: 'e'.repeat(64), revision: 73, attempt: 0, maxAttempts: 3,
    input: { prompt: snapshot.prompt, image: { sha256: snapshot.sha256, contentType: snapshot.contentType }, settings: snapshot.settings },
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  })
  assert.equal(await recoverBrokerProjectTasks(sessionId), 1)
  assert.equal((await readWindowsState(sessionId)).jobs['4_0'].taskId, id)
})
