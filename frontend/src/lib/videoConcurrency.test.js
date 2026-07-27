import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_CONCURRENT_VIDEO_REQUESTS,
  activeVideoRequestCount,
  availableVideoRequestSlots,
  queuedVideoUnitIds,
  takeVideoSubmissionSlots,
} from './videoConcurrency.js'

test('never allocates more than ten active provider requests', () => {
  const jobs = Object.fromEntries(
    Array.from({ length: 8 }, (_, index) => [
      `${index + 1}_0`,
      { jobId: `job-${index + 1}`, status: 'pending' },
    ])
  )
  const queued = Array.from({ length: 20 }, (_, index) => ({ scene_number: `${index + 9}_0` }))

  assert.equal(MAX_CONCURRENT_VIDEO_REQUESTS, 10)
  assert.equal(activeVideoRequestCount(jobs), 8)
  assert.equal(availableVideoRequestSlots(jobs), 2)
  assert.deepEqual(takeVideoSubmissionSlots(queued, jobs), queued.slice(0, 2))
})

test('completed and failed jobs free slots while queued units remain discoverable', () => {
  const jobs = {
    '1_0': { jobId: 'a', status: 'completed' },
    '2_0': { jobId: 'b', status: 'failed' },
    '3_0': { jobId: 'c', status: 'pending' },
  }
  const progress = {
    pending: ['3_0', '4_0', '5_0'],
  }

  assert.equal(activeVideoRequestCount(jobs), 1)
  assert.equal(availableVideoRequestSlots(jobs), 9)
  assert.deepEqual(queuedVideoUnitIds(progress, jobs), ['4_0', '5_0'])
})

test('submission reservations occupy slots and cannot be queued twice', () => {
  const jobs = Object.fromEntries(
    Array.from({ length: 10 }, (_, index) => [
      `${index + 1}_0`,
      { status: 'submitting', submissionToken: `submission-${index + 1}` },
    ])
  )
  const progress = {
    pending: [...Object.keys(jobs), '11_0'],
  }

  assert.equal(activeVideoRequestCount(jobs), 10)
  assert.equal(availableVideoRequestSlots(jobs), 0)
  assert.deepEqual(queuedVideoUnitIds(progress, jobs), ['11_0'])
  assert.deepEqual(takeVideoSubmissionSlots([{ scene_number: '11_0' }], jobs), [])
})
