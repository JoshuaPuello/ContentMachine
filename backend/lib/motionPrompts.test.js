import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMotionPromptSystem,
  buildShotGrid,
  composeMotionPromptBatch,
  createFallbackMotionPromptBatch,
  loadSeedanceMotionSkill,
  validateMotionPromptBatch,
} from './motionPrompts.js';

const scene = {
  scene_id: 's03',
  scene_number: 3,
  segment_index: 0,
  segment_count: 1,
  duration_seconds: 6,
  narration: 'The driller raises the wrench. The engine finally catches.',
  visual_description: 'A porcelain driller stands beside the damaged engine.',
  selected_prompt: 'One featureless off-white porcelain mannequin in orange coveralls and black work boots, holding a steel wrench beside a diesel engine.',
  camera_intent: 'slow push in',
  mannequin_details: {
    count: 1,
    clothing: 'orange canvas coveralls, black leather work boots, yellow hard hat',
    porcelain_tone: 'off-white',
  },
  environment: { key_props: ['steel wrench', 'diesel engine'] },
};

const authored = {
  scene_id: 's03',
  scene_number: 3,
  segment_index: 0,
  duration_seconds: 6,
  video_prompt: {
    scene_intent: 'The driller braces the wrench and the stalled engine catches.',
    primary_camera_move: 'slow 12% push toward the engine housing',
    storyboard: [
      { shot: 1, time: '00:00–00:02', subject_action: 'He begins exactly in the source pose and tightens his grip.', camera_progression: 'The push begins almost imperceptibly.', environment_motion: 'A cable trembles.' },
      { shot: 2, time: '00:02–00:04', subject_action: 'He turns the wrench once while keeping both boots planted.', camera_progression: 'The same push continues.', environment_motion: 'The engine shudders.' },
      { shot: 3, time: '00:04–00:06', subject_action: 'He stops turning and holds the wrench against the housing.', camera_progression: 'The push settles.', environment_motion: 'A faint exhaust plume steadies.' },
    ],
    ending_state: 'The mannequin holds the wrench against the running engine in a stable frame.',
  },
};

test('15-second shot grid uses seven beats and absorbs the remainder', () => {
  const grid = buildShotGrid(15);
  assert.equal(grid.length, 7);
  assert.equal(grid.at(-1).label, 'SHOT 7 — 00:12–00:15');
});

test('runtime system prompt inlines the project skill and mannequin contract', () => {
  assert.match(loadSeedanceMotionSkill(), /immutable frame zero/i);
  const prompt = buildMotionPromptSystem('Keep the pace tense.');
  assert.match(prompt, /SEEDANCE 2\.0 SKILL/);
  assert.match(prompt, /must never become a realistic human/i);
  assert.match(prompt, /Keep the pace tense/);
});

test('validator requires complete exact storyboard coverage', () => {
  assert.deepEqual(validateMotionPromptBatch([authored], [scene]), []);
  const broken = structuredClone(authored);
  broken.video_prompt.storyboard.pop();
  assert.match(validateMotionPromptBatch([broken], [scene]).join(' '), /exactly 3 storyboard beats/i);
});

test('protected local fallback produces complete valid prompts for every requested unit', () => {
  const second = { ...scene, scene_id: 's04', scene_number: 4, segment_index: 1, duration_seconds: 15 };
  const fallback = createFallbackMotionPromptBatch([scene, second], 'provider unavailable');
  assert.equal(fallback.length, 2);
  assert.deepEqual(validateMotionPromptBatch(fallback, [scene, second]), []);
  assert.equal(fallback[0].authoring_source, 'protected-local-fallback');
  assert.match(fallback[0].authoring_warning, /provider unavailable/i);
  const composed = composeMotionPromptBatch(fallback, [scene, second]);
  assert.match(composed[0].full_prompt_string, /immutable frame zero/i);
  assert.match(composed[1].full_prompt_string, /SHOT 7 — 00:12–00:15/);
});

test('validator rejects compound or violent camera choreography', () => {
  const broken = structuredClone(authored);
  broken.video_prompt.primary_camera_move = 'Whip pan, then push in and tilt up';
  const issues = validateMotionPromptBatch([broken], [scene]).join(' ');
  assert.match(issues, /forbidden camera\/action language/i);
  assert.match(issues, /combines 3 primary camera moves/i);
});

test('validator rejects style drift and invented entities anywhere in storyboard fields', () => {
  const broken = structuredClone(authored);
  broken.video_prompt.storyboard[1].subject_action = 'The mannequin morphs into a realistic human while a new weapon appears beside him.';
  broken.video_prompt.storyboard[1].camera_progression = 'A whip pan becomes an orbit before a snap zoom.';
  const issues = validateMotionPromptBatch([broken], [scene]).join(' ');
  assert.match(issues, /morphs into/i);
  assert.match(issues, /invents a source-frame entity/i);
});

test('validator rejects adversarial entity, anatomy, wardrobe, removal, and cut phrasing', () => {
  const cases = [
    ['A second character steps into frame holding a rifle.', /invents a source-frame entity/i],
    ['The mannequin gains eyes and skin.', /changes locked mannequin anatomy/i],
    ['The orange coveralls turn blue.', /changes locked wardrobe color/i],
    ['The wrench disappears.', /removes a source-frame entity/i],
    ['The camera cuts to another angle.', /internal cut or angle change/i],
  ];

  for (const [subjectAction, expectedIssue] of cases) {
    const broken = structuredClone(authored);
    broken.video_prompt.storyboard[1].subject_action = subjectAction;
    const issues = validateMotionPromptBatch([broken], [scene]).join(' ');
    assert.match(issues, expectedIssue, `Expected rejection for: ${subjectAction}`);
  }
});

test('validator permits physically plausible atmospheric dissipation', () => {
  const atmospheric = structuredClone(authored);
  atmospheric.video_prompt.storyboard[2].environment_motion = 'The existing exhaust smoke gradually disappears into the wind.';
  assert.deepEqual(validateMotionPromptBatch([atmospheric], [scene]), []);
});

test('validator rejects facialization and entities entering the frame', () => {
  const cases = [
    'The mannequin eyes open and blink.',
    'The mannequin smiles as its lips move.',
    'Human skin and flesh appear across the porcelain face.',
    'The face becomes lifelike.',
    'A worker enters the frame.',
    'Another vehicle emerges into the scene.',
  ];
  for (const subjectAction of cases) {
    const broken = structuredClone(authored);
    broken.video_prompt.storyboard[0].subject_action = subjectAction;
    assert.notDeepEqual(validateMotionPromptBatch([broken], [scene]), [], `Expected rejection for: ${subjectAction}`);
  }
});

test('composer protects mannequin, count, wardrobe, props and stable ending', () => {
  const [result] = composeMotionPromptBatch([authored], [scene]);
  assert.equal(result.motion_prompt_version, 'seedance-2-0-v1');
  assert.equal(result.source_frame_locked, true);
  assert.ok(result.full_prompt_string.length <= 5000);
  assert.match(result.full_prompt_string, /immutable frame zero/i);
  assert.match(result.full_prompt_string, /Scene-plan reference count: 1/i);
  assert.match(result.full_prompt_string, /authoritative in both directions/i);
  assert.match(result.full_prompt_string, /never become a realistic human/i);
  assert.match(result.full_prompt_string, /orange canvas coveralls/i);
  assert.match(result.full_prompt_string, /steel wrench; diesel engine/i);
  assert.match(result.full_prompt_string, /Narration covered by this clip/i);
  assert.match(result.full_prompt_string, /One continuous unbroken take/i);
});

test('selected frame remains authoritative when scene-plan wardrobe prose conflicts', () => {
  const drillerScene = {
    ...scene,
    selected_prompt: 'The porcelain driller visibly wears scuffed tan steel-toe work boots on both feet.',
    mannequin_details: {
      ...scene.mannequin_details,
      clothing: 'grey work shirt, jeans, tan steel-toe work boots set aside on the deck',
    },
  };
  const [result] = composeMotionPromptBatch([authored], [drillerScene]);
  assert.match(result.full_prompt_string, /selected source image alone controls which items are worn, held, or set aside/i);
  assert.match(result.full_prompt_string, /overrides any conflicting wardrobe prose/i);
});

test('selected frame remains authoritative when the scene plan expects zero figures', () => {
  const zeroCountScene = {
    ...scene,
    mannequin_details: { ...scene.mannequin_details, count: 0 },
  };
  const [result] = composeMotionPromptBatch([authored], [zeroCountScene]);
  assert.match(result.full_prompt_string, /Scene-plan reference count: 0/i);
  assert.match(result.full_prompt_string, /selected source image is authoritative if it visibly contains any figure/i);
});

test('long 15-second prompts preserve every shot and protected tail under provider cap', () => {
  const longScene = {
    ...scene,
    duration_seconds: 15,
    narration: 'A long narration sentence '.repeat(80),
    selected_prompt: 'Highly detailed selected source frame description '.repeat(80),
    continuity_context: 'Previous action and environment state '.repeat(50),
  };
  const longAuthored = {
    ...authored,
    duration_seconds: 15,
    video_prompt: {
      ...authored.video_prompt,
      scene_intent: 'A precise documentary action unfolds without invention. '.repeat(30),
      storyboard: buildShotGrid(15).map(({ shot, start, end }) => ({
        shot,
        time: `00:${String(start).padStart(2, '0')}–00:${String(end).padStart(2, '0')}`,
        subject_action: 'The same mannequin performs one physically plausible continuation of the documented action while every locked attribute remains unchanged. '.repeat(8),
        camera_progression: 'The same restrained push advances continuously. '.repeat(8),
        environment_motion: 'One subtle existing environmental element moves. '.repeat(8),
      })),
    },
  };
  const [result] = composeMotionPromptBatch([longAuthored], [longScene]);
  assert.ok(result.full_prompt_string.length <= 5000);
  assert.match(result.full_prompt_string, /SHOT 7 — 00:12–00:15/);
  assert.match(result.full_prompt_string, /STABILITY \/ NEGATIVE CONSTRAINTS/);
  assert.match(result.full_prompt_string, /One continuous unbroken take/);
});

test('composer chains the freshly authored ending and source frame into the next unit', () => {
  const nextScene = {
    ...scene,
    scene_id: 's04',
    scene_number: 4,
    selected_prompt: 'The same porcelain driller stands at the runway edge beside the idling aircraft.',
  };
  const nextAuthored = {
    ...structuredClone(authored),
    scene_id: 's04',
    scene_number: 4,
  };
  const results = composeMotionPromptBatch([authored, nextAuthored], [scene, nextScene]);
  assert.equal(results[1].continuity_handoff.previous_unit_key, '3:0');
  assert.equal(results[1].continuity_handoff.previous_selected_frame, scene.selected_prompt);
  assert.equal(results[1].continuity_handoff.previous_ending_state, authored.video_prompt.ending_state);
  assert.match(results[1].full_prompt_string, /CONTINUITY HANDOFF/);
  assert.match(results[1].full_prompt_string, /holds the wrench against the running engine/i);
  assert.match(results[1].full_prompt_string, /current selected image as immutable frame zero/i);
});

test('continuity handoff survives the provider character cap', () => {
  const longScene = {
    ...scene,
    previous_selected_prompt: 'Previous porcelain subject beside the yellow aircraft.',
    previous_ending_state: 'The wrench stops and the subject settles into a stable hold.',
    narration: 'Long narration '.repeat(400),
    selected_prompt: 'Long selected frame '.repeat(400),
  };
  const [result] = composeMotionPromptBatch([authored], [longScene]);
  assert.ok(result.full_prompt_string.length <= 5000);
  assert.match(result.full_prompt_string, /Previous porcelain subject beside the yellow aircraft/i);
  assert.match(result.full_prompt_string, /wrench stops and the subject settles/i);
});
