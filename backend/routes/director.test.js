import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizePlan } from './director.js';

const maps = [1, 2, 3, 4].map((after_scene) => ({
  after_scene,
  duration_seconds: 18,
  request: { subject: `Map ${after_scene}` },
}));

test('Director mechanically limits maps to one per full program minute', () => {
  const short = sanitizePlan({ maps }, 12, {
    audioDurations: { 1: 30, 2: 29 },
  });
  assert.equal(short.maps.length, 1);

  const twoMinute = sanitizePlan({ maps }, 12, {
    audioDurations: { 1: 61, 2: 61 },
  });
  assert.equal(twoMinute.maps.length, 2);
});

test('Director sanitizes sparse transition choices and rejects invalid boundaries', () => {
  const plan = sanitizePlan({
    transitions: [
      { before_scene: 1, type: 'cross-dissolve', duration_seconds: 0.6 },
      { before_scene: 2, type: 'blur-dissolve', duration_seconds: 9, reason: 'Time moves forward.' },
      { before_scene: 2, type: 'dip', duration_seconds: 0.4, reason: 'Duplicate target.' },
      { before_scene: 3, type: 'unknown-transition' },
    ],
  }, 3, { audioDurations: { 1: 30, 2: 30, 3: 30 } });
  assert.deepEqual(plan.transitions.map(item => item.type), ['soft-blur']);
  assert.equal(plan.transitions[0].duration_seconds, 1.2);
  assert.equal(plan.transitions[0].before_segment_index, 0);
});

test('Director gives every real chrome element a deliberate sound policy', () => {
  const plan = sanitizePlan({
    lower_thirds: [{ scene_number: 1, text: 'Allen West', subtitle: 'The architect' }],
    date_chips: [{ scene_number: 1, text: '11 JUNE 1962' }],
    title_cards: [{ after_scene: 1, text: 'LEFT BEHIND' }],
    maps: [{ after_scene: 1, request: { subject: 'Alcatraz Island' } }],
    transitions: [{ before_scene: 2, type: 'soft-blur', duration_seconds: 0.65 }],
    trailer: {
      shots: [{ scene_number: 1 }, { scene_number: 2 }, { scene_number: 3 }],
      title: 'THE MAN LEFT BEHIND',
    },
    chapters: [
      { title: 'The Rock', start_scene: 1, portrait_prompt: 'Alcatraz' },
      { title: 'Left Behind', start_scene: 3, portrait_prompt: 'Allen West' },
    ],
  }, 3, {
    audioDurations: { 1: 30, 2: 30, 3: 30 },
    trailerEnabled: true,
    chaptersEnabled: true,
  });

  assert.equal(plan.date_chips[0].sound_design.cues[0].role, 'reveal');
  assert.equal(plan.transitions[0].sound_design.cues[0].role, 'transition');
  assert.match(plan.transitions[0].sound_design.cues[0].description, /soft-blur/i);
  assert.equal(plan.lower_thirds[0].sound_design.cues[0].role, 'reveal');
  assert.equal(plan.title_cards[0].sound_design.cues[0].role, 'reveal');
  assert.equal(plan.trailer.sound_design.cues[0].role, 'reveal');
  assert.equal(plan.chapter_overview_sound_design.cues[0].role, 'reveal');
  assert.equal(plan.chapters[1].sound_design.cues[0].role, 'resolve');
  assert.deepEqual(plan.maps[0].sound_design.cues, []);
  assert.match(plan.maps[0].sound_design.strategy, /intentionally silent/i);
});

test('Director accepts invented motion graphics but mechanically preserves restraint', () => {
  const candidates = [1, 2, 3, 4, 5].map((scene_number, index) => ({
    id: `graphic-${index + 1}`,
    scene_number,
    at_seconds_into_scene: 1,
    duration_seconds: 8,
    reason: 'Clarifies a relationship that footage cannot show.',
    narration_excerpt: `Narration ${index + 1}`,
    category: index === 0 ? 'original-category' : 'data',
    intent: index === 0 ? 'an original visual explanation' : 'measured comparison',
    source: {
      mode: index === 0 ? 'invent' : 'adapt',
      invention_notes: 'A new but restrained visual arrangement.',
    },
    presentation: 'overlay',
    composition: {
      layout: { archetype: 'custom-grid', focus_side: 'right' },
      background: { mode: 'soft-atmosphere', opacity: 0.7 },
      content: {
        title: `Graphic ${index + 1}`,
        elements: [{ value: String(index + 1), label: 'facts' }],
      },
      animation: { tempo: 'measured' },
    },
    sound_design: {
      enabled: true,
      cues: [{ at_seconds: 1, role: 'impact', asset: 'should-not-play.wav' }],
    },
  }));

  const plan = sanitizePlan({ maps: [maps[0]], motion_graphics: candidates }, 5, {
    audioDurations: { 1: 40, 2: 40, 3: 40, 4: 40, 5: 40 },
  });

  // Scene 1 is protected by the map; remaining candidates must still obey
  // program cap, coverage, and eight-second breathing-room rules.
  assert.equal(plan.motion_graphics.some((graphic) => graphic.scene_number === 1), false);
  assert.ok(plan.motion_graphics.length <= 5);
  assert.equal(plan.motion_graphics_audit.rule, 'semantic compression, never decoration');
  assert.equal(
    plan.motion_graphics.every((graphic) =>
      graphic.sound_design.enabled === false
      && graphic.sound_design.cues.every((cue) => cue.asset === null)
    ),
    true
  );
});

test('Director collapses semantically duplicated two-sided data into one minimal card', () => {
  const plan = sanitizePlan({
    motion_graphics: [{
      id: 'john-age',
      scene_number: 1,
      at_seconds_into_scene: 10,
      duration_seconds: 8,
      reason: 'Introduce the subject and his circumstances.',
      narration_excerpt: 'Twenty-seven years old, and out of options.',
      category: 'entities',
      intent: 'subject introduction',
      source: { mode: 'adapt', reference_preset: 'director-entities-portrait-legend' },
      presentation: 'overlay',
      composition: {
        layout: { archetype: 'hero', focus_side: 'right' },
        background: { mode: 'footage-dim', opacity: 0.62 },
        animation: { tempo: 'measured' },
      },
      content: {
        eyebrow: 'GRAVESEND, BROOKLYN',
        title: 'John Wojtowicz',
        body: 'Twenty-seven years old, and out of options.',
        primary_value: '27',
        primary_label: 'years old',
        elements: [],
      },
      sound_design: { enabled: false, cues: [] },
    }],
  }, 1, { audioDurations: { 1: 40 } });

  const graphic = plan.motion_graphics[0];
  assert.equal(graphic.composition.layout.archetype, 'minimal');
  assert.equal(graphic.composition.content.body, '');
  assert.match(graphic.editorial_adjustments.join(' '), /duplicated primary fact/i);
});

test('Map duration is capped by the narration it plays under, with a 6s floor', () => {
  // Scene 4 narration is 6.8s: a director-requested 12s map anchored to
  // scene 4 must not bleed into scene 5 (observed failure: map hid three
  // shots across two scenes). after_scene names the map's anchor scene.
  const capped = sanitizePlan({
    maps: [{ after_scene: 4, duration_seconds: 12, request: { subject: 'Antwerp' } }],
  }, 12, { audioDurations: { 1: 30, 2: 30, 3: 30, 4: 6.8, 5: 9.2 } });
  assert.equal(capped.maps.length, 1);
  assert.equal(capped.maps[0].duration_seconds, 6.8);
  assert.equal(capped.maps[0].request.duration_seconds, 6.8);

  // Even with long narration, the hard ceiling is 7s.
  const ceiling = sanitizePlan({
    maps: [{ after_scene: 1, duration_seconds: 18, request: { subject: 'Europe' } }],
  }, 12, { audioDurations: { 1: 60, 2: 40 } });
  assert.equal(ceiling.maps[0].duration_seconds, 7);

  // Short but sufficient narration keeps its own length; the old 10s floor
  // must not inflate it.
  const short = sanitizePlan({
    maps: [{ after_scene: 1, duration_seconds: 7, request: { subject: 'Belgium' } }],
  }, 12, { audioDurations: { 1: 60, 2: 20 } });
  assert.equal(short.maps[0].duration_seconds, 7);

  // A narration under 6s cannot earn a full-frame takeover: the map is dropped.
  const dropped = sanitizePlan({
    maps: [{ after_scene: 3, duration_seconds: 18, request: { subject: 'Vault' } }],
  }, 12, { audioDurations: { 1: 60, 2: 60, 3: 4.5 } });
  assert.equal(dropped.maps.length, 0);

  // Without audio data the clamp still applies but nothing is invented.
  const unknown = sanitizePlan({
    maps: [{ after_scene: 1, duration_seconds: 40, request: { subject: 'Europe' } }],
  }, 12, { audioDurations: { 1: 61, 2: 61 } });
  assert.equal(unknown.maps[0].duration_seconds, 7);
});
