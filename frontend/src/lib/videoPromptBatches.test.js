import test from 'node:test'
import assert from 'node:assert/strict'
import {
  missingAuthoredPromptUnits,
  missingSelectedImageUnits,
  videoPromptFailureMessage,
} from './videoPromptBatches.js'

const units = [
  { scene_number: 1, segment_index: 0 },
  { scene_number: 1, segment_index: 1 },
  { scene_number: 2, segment_index: 0 },
]

test('reports the exact shot missing a selected image prompt', () => {
  assert.deepEqual(missingSelectedImageUnits(units, {
    '1_0': { prompt: 'first' },
    '2_0': { prompt: 'third' },
  }), ['1_1'])
})

test('reports incomplete authored prompt coverage', () => {
  assert.deepEqual(missingAuthoredPromptUnits(units, [
    { scene_number: 1, segment_index: 0 },
    { scene_number: 2, segment_index: 0 },
  ]), ['1_1'])
})

test('surfaces batch errors instead of describing an empty response as success', () => {
  const message = videoPromptFailureMessage([
    { batchIndex: 0, status: 'failed', error: 'invalid response' },
  ], ['1_0'])
  assert.match(message, /batch 1: invalid response/i)
  assert.match(message, /Missing shot: 1_0/i)
})
