import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_EDITORIAL_SHOT_SECONDS,
  MIN_SEGMENT_SECONDS,
  buildScenePacingContext,
  getClipOptions,
  inferEditorialPacing,
  planSceneSegments,
} from './segmentation.js'

const sumTargets = segments => Math.round(
  segments.reduce((sum, segment) => sum + segment.targetDuration, 0) * 100
) / 100

test('builds pacing context from plan, narration, and generated scene metadata', () => {
  const plan = { scene_id: 's01', pacing_profile: 'kinetic', visual_beat_count: 3 }
  const narration = { scene_id: 's01', lines: ['She turns, reaches, and falls.'] }
  const generated = { scene_description: 'Roadside arrest', full_scene_narration: 'fallback' }
  const context = buildScenePacingContext(plan, narration, generated)

  assert.equal(context.pacing_profile, 'kinetic')
  assert.equal(context.scene_description, 'Roadside arrest')
  assert.deepEqual(context.lines, narration.lines)
  assert.equal(context.narration, 'fallback')
  assert.deepEqual(plan, { scene_id: 's01', pacing_profile: 'kinetic', visual_beat_count: 3 })
})

test('retains legacy coverage planning when no scene context is supplied', () => {
  assert.deepEqual(planSceneSegments(8, [8]), [
    { segmentIndex: 0, targetDuration: 8, clipDuration: 8, playbackRate: 1 },
  ])
  assert.deepEqual(planSceneSegments(12, [8]), [
    { segmentIndex: 0, targetDuration: 6.72, clipDuration: 8, playbackRate: 1 },
    { segmentIndex: 1, targetDuration: 5.28, clipDuration: 8, playbackRate: 1 },
  ])
})

test('turns a fixed eight-second provider clip into varied editorial shots', () => {
  const segments = planSceneSegments(8, [8], 1, {
    narrative_beat: 'climax',
    visual_description: 'The officer grabs her arm; she turns, pulls away, and falls.',
    mannequin_details: { action: 'Officer reaches, restrains her, then reacts.' },
  })

  assert.equal(segments.length, 3)
  assert.equal(sumTargets(segments), 8)
  assert.deepEqual(segments.map(segment => segment.targetDuration), [2.72, 2.32, 2.96])
  assert.ok(segments.every(segment => segment.clipDuration === 8))
  assert.ok(segments.every(segment => segment.playbackRate === 1))
  assert.equal(new Set(segments.map(segment => segment.targetDuration)).size, 3)
})

test('authored visual beats set a floor on shot count and influence their rhythm', () => {
  const segments = planSceneSegments(10, [8], 1, {
    editorial_beats: [
      { type: 'wide establishing', action: 'Police car arrives' },
      { type: 'detail insert', action: 'Her flowers fall' },
      { type: 'reaction', action: 'She looks down' },
      { type: 'payoff reveal', action: 'The officer reaches for the cuffs' },
    ],
  })

  assert.equal(segments.length, 4)
  assert.equal(sumTargets(segments), 10)
  assert.ok(segments.every(segment => segment.targetDuration >= MIN_SEGMENT_SECONDS))
  assert.ok(segments.every(segment => segment.targetDuration <= MAX_EDITORIAL_SHOT_SECONDS))
  assert.ok(new Set(segments.map(segment => segment.targetDuration)).size > 1)
})

test('scene-plan pacing profile and declared beat count are consumed directly', () => {
  const pacing = inferEditorialPacing({
    pacing_profile: 'kinetic',
    visual_beat_count: 3,
    visual_beats: [
      { beat: 'approach', shot_type: 'wide' },
      { beat: 'contact', shot_type: 'detail' },
      { beat: 'reaction', shot_type: 'close-up' },
    ],
  })
  const segments = planSceneSegments(8, [8], 1, {
    pacing_profile: 'kinetic',
    visual_beat_count: 3,
    visual_beats: ['approach', 'contact', 'reaction'],
  })

  assert.equal(pacing.pace, 'fast')
  assert.equal(pacing.authoredShotCount, 3)
  assert.equal(segments.length, 3)
})

test('explicit standard profile is not accelerated by incidental action words', () => {
  const pacing = inferEditorialPacing({
    pacing_profile: 'standard',
    narrative_beat: 'arrest',
    visual_description: 'An officer makes an arrest beside the road.',
  })
  const segments = planSceneSegments(8, [8], 1, {
    pacing_profile: 'standard',
    narrative_beat: 'arrest',
  })

  assert.equal(pacing.pace, 'standard')
  assert.equal(pacing.idealShotDuration, 4.75)
  assert.equal(segments.length, 2)
})

test('explicit deliberate profile stays slow despite action vocabulary', () => {
  const pacing = inferEditorialPacing({
    pacing_profile: 'deliberate',
    narrative_beat: 'arrest climax',
    visual_description: 'She turns as the officer grabs her arm and makes the arrest.',
  })
  const segments = planSceneSegments(8, [8], 1, {
    pacing_profile: 'deliberate',
    narrative_beat: 'arrest climax',
  })

  assert.equal(pacing.pace, 'slow')
  assert.equal(pacing.idealShotDuration, 7.5)
  assert.equal(segments.length, 1)
})

test('slow atmospheric material is allowed to breathe', () => {
  const pacing = inferEditorialPacing({
    editorial_pace: 'contemplative',
    shot_type: 'wide establishing',
    visual_description: 'A quiet landscape holds still beneath the dawn sky.',
  })
  const segments = planSceneSegments(8, [8], 1, {
    editorial_pace: 'contemplative',
    shot_type: 'wide establishing',
    visual_description: 'A quiet landscape holds still beneath the dawn sky.',
  })

  assert.equal(pacing.pace, 'slow')
  assert.equal(segments.length, 1)
  assert.equal(segments[0].targetDuration, 8)
})

test('standard scenes no longer inherit the provider duration as editorial pace', () => {
  const segments = planSceneSegments(8, [8], 1, {
    visual_description: 'Two people speak beside a parked police car.',
  })

  assert.equal(segments.length, 2)
  assert.equal(sumTargets(segments), 8)
  assert.deepEqual(segments.map(segment => segment.targetDuration), [4.48, 3.52])
})

test('long narration stays fully covered with every editorial target at most eight seconds', () => {
  const segments = planSceneSegments(25, [15], 1, {
    editorial_pace: 'slow-paced',
    visual_description: 'A solemn memorial landscape.',
  })

  assert.equal(sumTargets(segments), 25)
  assert.ok(segments.length >= 4)
  assert.ok(segments.every(segment => segment.targetDuration <= 8))
  assert.ok(segments.every(segment => segment.targetDuration >= 2))
  assert.ok(segments.every(segment => [15].includes(segment.clipDuration)))
})

test('very short audio never creates an impossible sub-two-second split', () => {
  const segments = planSceneSegments(3.5, [8], 1, {
    editorial_pace: 'frenetic',
    action_beats: ['turn', 'impact', 'reaction'],
  })

  assert.equal(segments.length, 1)
  assert.equal(segments[0].targetDuration, 3.5)
})

test('provider coverage wins when no all-in-bounds editorial split exists', () => {
  const segments = planSceneSegments(3.1, [3], 1)

  assert.equal(segments.length, 2)
  assert.equal(sumTargets(segments), 3.1)
  assert.ok(segments.every(segment => segment.targetDuration <= 3))
  assert.ok(segments.some(segment => segment.targetDuration < MIN_SEGMENT_SECONDS))
})

test('slowing remains available for coverage while short targets are trimmed normally', () => {
  const segments = planSceneSegments(9, [8], 0.8, {
    editorial_pace: 'standard',
    visual_description: 'A witness opens the door and points outside.',
  })

  assert.equal(sumTargets(segments), 9)
  assert.ok(segments.every(segment => segment.targetDuration >= 2))
  assert.ok(segments.every(segment => segment.clipDuration === 8))
  assert.ok(segments.every(segment => segment.playbackRate === 1))
})

test('clip option filtering remains provider-specific', () => {
  assert.deepEqual(getClipOptions('veo-3.1-fast'), [8])
  assert.deepEqual(getClipOptions('kwaivgi/kling-v3-video', 5), [3, 4, 5])
})
