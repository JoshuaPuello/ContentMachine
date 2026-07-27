import test from 'node:test'
import assert from 'node:assert/strict'
import { reconcileTimelineVideoSelections } from './videoSelectionTimeline.js'

test('replaces a stale timeline clip with the current selected video', () => {
  const items = [
    { id: 'clip-1', kind: 'clip', payload: { sceneNumber: 36, segmentIndex: 0, src: 'old.mp4', volume: 0 } },
    { id: 'audio-1', kind: 'narration', payload: { src: 'voice.mp3' } },
  ]

  const result = reconcileTimelineVideoSelections(items, {
    '36_0': { url: 'new.mp4' },
  })

  assert.equal(result[0].payload.src, 'new.mp4')
  assert.equal(result[0].payload.volume, 0)
  assert.strictEqual(result[1], items[1])
})

test('updates every selected shot but preserves clips without a selection', () => {
  const items = [
    { kind: 'clip', payload: { sceneNumber: 1, segmentIndex: 0, src: 'old-a.mp4' } },
    { kind: 'clip', payload: { sceneNumber: 1, segmentIndex: 1, src: 'old-b.mp4' } },
    { kind: 'clip', payload: { sceneNumber: 2, segmentIndex: 0, src: 'keep.mp4' } },
  ]

  const result = reconcileTimelineVideoSelections(items, {
    '1_0': { url: 'new-a.mp4' },
    '1_1': { url: 'new-b.mp4' },
  })

  assert.deepEqual(result.map(item => item.payload.src), ['new-a.mp4', 'new-b.mp4', 'keep.mp4'])
})

test('returns the original array when the timeline is already current', () => {
  const items = [
    { kind: 'clip', payload: { sceneNumber: 7, segmentIndex: 0, src: 'current.mp4' } },
  ]

  assert.strictEqual(
    reconcileTimelineVideoSelections(items, { '7_0': { url: 'current.mp4' } }),
    items,
  )
})
