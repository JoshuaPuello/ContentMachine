import test from 'node:test'
import assert from 'node:assert/strict'
import {
  WINDOWS_VIDEO_PROVIDER,
  WINDOWS_VIDEO_API_ROUTES,
  isWindowsVideoActive,
  mergeWindowsTasksIntoJobs,
  normalizeWindowsVideoStatus,
  normalizeWindowsVideoTask,
  windowsVideoDisplayLabel,
  windowsVideoStateLabel,
} from './windowsVideoWorker.js'

test('publishes the ContentMachine backend API contract', () => {
  assert.equal(WINDOWS_VIDEO_API_ROUTES.generate, '/videos/windows/generate')
  assert.equal(
    WINDOWS_VIDEO_API_ROUTES.status('session_2026-07-27_a b'),
    '/videos/windows/status/session_2026-07-27_a%20b'
  )
  assert.equal(WINDOWS_VIDEO_API_ROUTES.manualAttach, '/videos/manual-attach')
})

test('normalizes the exact shared-broker task states and wire aliases', () => {
  assert.equal(normalizeWindowsVideoTask({ status: 'processing' }).status, 'generating')
  assert.equal(normalizeWindowsVideoTask({ status: 'cancelled' }).status, 'canceled')
  assert.equal(isWindowsVideoActive('uploading'), true)
  assert.equal(isWindowsVideoActive('completed'), false)
  assert.equal(windowsVideoStateLabel('leased'), 'Claimed')
  assert.equal(
    normalizeWindowsVideoTask({ status: 'generating', progress: { phase: 'waiting_veo' } }).displayState,
    'waiting-for-veo'
  )
  assert.equal(windowsVideoDisplayLabel('server-validating'), 'Server validating')
})

test('accepts snake-case broker snapshots without selecting completed videos', () => {
  const snapshot = normalizeWindowsVideoStatus({
    is_paused: true,
    worker_status: { connected: true, occupied_slots: 1, max_slots: 2 },
    tasks: [{
      task_id: 'task-1',
      scene_number: '4_0',
      status: 'completed',
      video_url: 'https://cdn.example/4.mp4',
      progress: { phase: 'validating', percent: 100 },
    }],
  })

  assert.equal(snapshot.paused, true)
  assert.equal(snapshot.workerConnected, true)
  assert.equal(snapshot.occupiedSlots, 1)
  assert.equal(snapshot.tasks[0].unitId, '4_0')

  const selectedVideos = { '2_0': { url: 'https://cdn.example/selected.mp4' } }
  const jobs = mergeWindowsTasksIntoJobs({
    '9_0': { provider: 'fal', status: 'completed', url: 'https://fal.example/9.mp4' },
  }, snapshot)

  assert.equal(jobs['4_0'].provider, WINDOWS_VIDEO_PROVIDER)
  assert.equal(jobs['4_0'].url, 'https://cdn.example/4.mp4')
  assert.equal(jobs['9_0'].provider, 'fal')
  assert.deepEqual(selectedVideos, { '2_0': { url: 'https://cdn.example/selected.mp4' } })
})

test('unwraps action responses that return the current project status', () => {
  const snapshot = normalizeWindowsVideoStatus({
    results: [{ taskId: 'ignored-envelope-entry' }],
    status: {
      paused: false,
      brokerAvailable: true,
      tasks: [{
        unitId: '8_1',
        jobId: 'task-8',
        status: 'uploading',
        progress: { percent: 82, message: 'Uploading MP4' },
      }],
    },
  })

  assert.equal(snapshot.brokerAvailable, true)
  assert.equal(snapshot.tasks[0].jobId, 'task-8')
  assert.equal(snapshot.tasks[0].percent, 82)
  assert.equal(snapshot.tasks[0].displayState, 'uploading')
})

test('surfaces broker outages without mutating canonical task status', () => {
  const snapshot = normalizeWindowsVideoStatus({
    brokerAvailable: false,
    tasks: [{ unitId: '1_0', status: 'queued' }],
  })
  assert.equal(snapshot.tasks[0].status, 'queued')
  assert.equal(snapshot.tasks[0].displayState, 'broker-unavailable')
})
