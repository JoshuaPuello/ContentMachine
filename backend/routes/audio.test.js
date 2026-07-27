import test from 'node:test'
import assert from 'node:assert/strict'
import { alignScenesToTranscript, computeSceneCutSegments } from './audio.js'

const scenes = [
  { sceneId: 's03', speechText: 'No hesitation', expectedSeconds: 10 },
  { sceneId: 's04', speechText: 'Camp Esperanza', expectedSeconds: 10 },
]

test('zero-confidence hallucinations do not anchor a scene boundary', () => {
  const aligned = alignScenesToTranscript(scenes, [
    { word: 'No', startTime: 44.7, endTime: 44.98, probability: 0.99 },
    { word: 'hesitation', startTime: 44.98, endTime: 45.44, probability: 0.995 },
    { word: 'Camp', startTime: 45.44, endTime: 45.84, probability: 0.0002 },
    { word: 'Esperanza', startTime: 45.84, endTime: 48.26, probability: 0.974 },
  ])

  assert.equal(aligned[0].lastWordEnd, 45.44)
  assert.equal(aligned[1].firstWordStart, 45.84)
  assert.deepEqual(aligned[0].words, [
    { wordIndex: 0, start: 44.7, end: 44.98 },
    { wordIndex: 1, start: 44.98, end: 45.44 },
  ])
})

test('scene cut never follows detected silence past the next spoken word', () => {
  const alignments = [
    { sceneId: 's03', matchRatio: 1, lastWordEnd: 45.44 },
    { sceneId: 's04', matchRatio: 1, firstWordStart: 45.84 },
  ]
  const segments = computeSceneCutSegments(
    scenes,
    alignments,
    60,
    [{ start: 45.811, end: 47.28 }],
  )

  assert.equal(segments[0].endSeconds, 45.64)
  assert.equal(segments[1].startSeconds, 45.64)
})

test('word-gap midpoint is the safe fallback when waveform analysis is unavailable', () => {
  const alignments = [
    { sceneId: 's03', matchRatio: 1, lastWordEnd: 45.44 },
    { sceneId: 's04', matchRatio: 1, firstWordStart: 45.84 },
  ]
  const segments = computeSceneCutSegments(scenes, alignments, 60)

  assert.equal(segments[0].endSeconds, 45.64)
  assert.equal(segments[1].startSeconds, 45.64)
})
