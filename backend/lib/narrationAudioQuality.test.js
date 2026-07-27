import test from 'node:test'
import assert from 'node:assert/strict'
import {
  analyzeNarrationBoundaries,
  analyzePcmSignal,
  mergeSilenceIntervals,
  pauseAtBoundary,
} from './narrationAudioQuality.js'

const units = [
  { unit_id: 's02', text: 'The second thought ends here.' },
  { unit_id: 's03', text: 'The third thought begins.' },
  { unit_id: 's04', text: 'The fourth thought follows.' },
]

test('merges breath-sized waveform interruptions into one effective pause', () => {
  assert.deepEqual(mergeSilenceIntervals([
    { start: 65.619, end: 65.688 },
    { start: 65.734, end: 65.91 },
  ]), [{ start: 65.619, end: 65.91 }])
})

test('waveform evidence overrides a false zero-gap Whisper boundary', () => {
  const pause = pauseAtBoundary([{ start: 25.9, end: 27.1 }], 26, 26)
  assert.equal(pause.durationSeconds, 1.2)
})

test('flags the real 260ms transition and passes the natural control gap', () => {
  const result = analyzeNarrationBoundaries({
    units,
    alignments: [
      { lastWordEnd: 65.62, matchRatio: 1 },
      { firstWordStart: 65.88, lastWordEnd: 73.88, matchRatio: 1 },
      { firstWordStart: 74.92, matchRatio: 1 },
    ],
    silenceIntervals: [
      { start: 65.619, end: 65.688 },
      { start: 65.734, end: 65.91 },
      { start: 74.0195, end: 75.4687 },
    ],
  })

  assert.equal(result.boundaries[0].pauseSeconds, 0.291)
  assert.equal(result.boundaries[1].pauseSeconds, 1.449)
  assert.deepEqual(result.issues.map(issue => `${issue.fromUnitId}->${issue.toUnitId}`), ['s02->s03'])
  assert.ok(result.issues[0].operation.durationSeconds > 0.3)
})

test('PCM audit reports clipping and DC offset without changing samples', () => {
  const samples = new Float32Array(3200).fill(0.02)
  for (let index = 100; index < 112; index++) samples[index] = 1
  const result = analyzePcmSignal(samples, 16000, { peakBuckets: 32 })
  assert.equal(result.waveform.peaks.length, 32)
  assert.ok(result.issues.some(issue => issue.type === 'clipping'))
  assert.ok(result.issues.some(issue => issue.type === 'dc_offset'))
})
