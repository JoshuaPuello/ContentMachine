import assert from 'node:assert/strict'
import test from 'node:test'

import {
  enrichedVideoPromptTiming,
  selectedVideoTargetDuration,
  videoRequestTimingFields,
} from './videoEditorialTiming.js'

test('motion-authoring units carry separate provider and editorial durations', () => {
  assert.deepEqual(videoRequestTimingFields({
    clip_duration: 8,
    target_duration: 2.72,
    playback_rate: 1,
  }), {
    duration_seconds: 8,
    target_duration: 2.72,
    action_duration_seconds: 2.72,
    editorial_duration_seconds: 2.72,
    clip_duration: 8,
    playback_rate: 1,
  })
})

test('slow playback converts timeline duration to a source-time action boundary', () => {
  assert.deepEqual(videoRequestTimingFields({
    clip_duration: 8,
    target_duration: 5,
    playback_rate: 0.8,
  }), {
    duration_seconds: 8,
    target_duration: 5,
    action_duration_seconds: 4,
    editorial_duration_seconds: 5,
    clip_duration: 8,
    playback_rate: 0.8,
  })
})

test('normal playback keeps source action and timeline editorial durations aligned', () => {
  const fields = videoRequestTimingFields({
    clip_duration: 8,
    target_duration: 5,
    playback_rate: 1,
  })

  assert.equal(fields.action_duration_seconds, 5)
  assert.equal(fields.editorial_duration_seconds, 5)
})

test('enrichment retains backend editorial timing instead of flattening it away', () => {
  const editorialTiming = {
    provider_duration_seconds: 8,
    action_duration_seconds: 3.52,
    clean_hold_duration_seconds: 4.48,
    backend_note: 'payoff by boundary',
  }
  const result = enrichedVideoPromptTiming(
    { editorial_timing: editorialTiming },
    { duration_seconds: 8, target_duration: 3.52, playback_rate: 1 }
  )

  assert.equal(result.editorial_timing, editorialTiming)
  assert.equal(result.target_duration, 3.52)
  assert.equal(result.duration_seconds, 8)
})

test('selected video target can recover from the backend timing contract', () => {
  assert.equal(selectedVideoTargetDuration({
    editorial_timing: { action_duration_seconds: 2.96 },
  }), 2.96)
  assert.equal(selectedVideoTargetDuration({ duration_seconds: 8 }), null)
})
