import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildImagePromptScenesData,
  buildScenePlanningPrompt,
  buildSegmentAddendum,
  parseClaudeStreamEvent,
} from './claude.js';

test('normalizes partial Claude stream text without duplicating final output', () => {
  assert.deepEqual(parseClaudeStreamEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: '{"camera"' },
    },
  }), { delta: '{"camera"', result: '' });

  assert.deepEqual(parseClaudeStreamEvent({
    type: 'result',
    subtype: 'success',
    result: '{"camera":[]}',
  }), { delta: '', result: '{"camera":[]}' });
});

test('ignores non-text Claude transport events', () => {
  assert.deepEqual(parseClaudeStreamEvent({ type: 'system', subtype: 'init' }), {
    delta: '',
    result: '',
  });
});

test('Veo scene planning separates fixed source duration from editorial pacing', () => {
  const prompt = buildScenePlanningPrompt('veo-3.1-fast');
  assert.match(prompt, /SOURCE CLIP generation length/i);
  assert.match(prompt, /kinetic scenes normally contain 3 genuinely different visual beats/i);
  assert.match(prompt, /visual_beat_count MUST equal visual_beats\.length/i);
  assert.match(prompt, /Narration remains fluent continuous documentary speech/i);
});

test('Windows worker receives the same fixed-duration editorial guidance as Veo', () => {
  const prompt = buildScenePlanningPrompt('windows-default');
  assert.match(prompt, /8 seconds is the SOURCE CLIP generation length/i);
  assert.match(prompt, /kinetic scenes normally contain 3 genuinely different visual beats/i);
});

test('scene planning groups non-adjacent scenes by semantic scenario identity', () => {
  const prompt = buildScenePlanningPrompt('veo-3.1-fast');
  assert.match(prompt, /Reuse the exact same scenario_id.*even after unrelated scenes/i);
  assert.match(prompt, /scenario_continuity must name the fixed environment anchors/i);
  assert.match(prompt, /environment_family_id is the broader connected continuity world/i);
  assert.match(prompt, /Never use it merely because two places share a mood/i);
});

test('image prompt payload preserves authored pacing and scenario continuity', () => {
  const [scene] = buildImagePromptScenesData([{
    scene_id: 's24',
    scene_number: 24,
    pacing_profile: 'kinetic',
    visual_beat_count: 3,
    visual_beats: [
      { beat: 'obstacle', action: 'officer signals stop', shot_type: 'wide' },
      { beat: 'reaction', action: 'woman turns toward him', shot_type: 'medium' },
      { beat: 'evidence', action: 'flowers fall from her hand', shot_type: 'detail' },
    ],
    scenario_id: 'rural-roadside-arrest-day',
    scenario_continuity: 'same patrol car, meadow, road shoulder, and morning light',
    environment_family_id: 'rural-roadside-arrest-sequence-day',
    environment_family_continuity: 'road shoulder connects to the meadow edge under the same morning light',
    segments: [{ segment_index: 0 }, { segment_index: 1 }, { segment_index: 2 }],
  }], true);

  assert.equal(scene.pacing_profile, 'kinetic');
  assert.equal(scene.visual_beat_count, 3);
  assert.equal(scene.visual_beats.length, 3);
  assert.equal(scene.scenario_id, 'rural-roadside-arrest-day');
  assert.equal(scene.environment_family_id, 'rural-roadside-arrest-sequence-day');
  assert.match(scene.environment_family_continuity, /meadow edge/);
  assert.equal(scene.segments.length, 3);
});

test('segment image prompt maps authored beats to segments without duplicate reframes', () => {
  const addendum = buildSegmentAddendum(2);
  assert.match(addendum, /segment_index N MUST execute visual_beats\[N\] exactly/i);
  assert.match(addendum, /different crop of the same unchanged pose is a duplicate and is forbidden/i);
  assert.match(addendum, /never force a mechanical wide → medium → close pattern/i);
});
