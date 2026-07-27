import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hardenDocumentaryImagePrompt,
  hardenImagePromptScenes,
  normalizeProjectImagePrompts,
} from './imagePromptQuality.js';

test('applies mannequin style to figures inside monitors and bodycam footage', () => {
  const result = hardenDocumentaryImagePrompt(
    'Close-up of a monitor replaying bodycam footage of an arrest.',
    {
      shot_type: 'close-up',
      visual_description: 'A monitor replays the takedown while officers watch.',
      mannequin_details: { count: 0 },
    }
  );

  assert.match(result, /figures shown inside televisions, phones, projections, monitors, bodycam footage/i);
  assert.match(result, /nested media is never an exception/i);
  assert.match(result, /No realistic human skin/i);
});

test('tight object inserts explicitly keep the rest of the body outside frame', () => {
  const result = hardenDocumentaryImagePrompt(
    '135mm extreme close-up of a judge bringing a gavel down.',
    {
      shot_type: 'extreme close-up',
      visual_description: 'A judge’s gavel strikes the sound block.',
      mannequin_details: { count: 1, action: 'brings the gavel down' },
    }
  );

  assert.match(result, /hand, wrist, and forearm entering naturally from outside the frame/i);
  assert.match(result, /Do not invent a second hand, arm, limb, or background body/i);
  assert.match(result, /head, face, torso, pelvis, legs, and footwear remain outside/i);
  assert.match(result, /Never squeeze a complete head-to-toe body into a close-up/i);
});

test('every visible mannequin receives realistic human proportion constraints', () => {
  const result = hardenDocumentaryImagePrompt('A mannequin officer crosses the road.');
  assert.match(result, /life-size, age-appropriate realistic human anatomy and proportions/i);
  assert.match(result, /No chibi, toy, figurine, doll, bobblehead/i);
  assert.match(result, /exactly five proportional fingers/i);
  assert.match(result, /no articulated doll joints, ball joints, hinges, panel lines/i);
  assert.match(result, /without visible articulation lines/i);
  assert.match(result, /porcelain applies only to human figures/i);
  assert.match(result, /wood remains natural wood with visible grain/i);
});

test('hardens segmented and flat authored prompt responses', () => {
  const [segmented, flat] = hardenImagePromptScenes([
    {
      scene_number: 1,
      segments: [{ segment_index: 0, variations: [{ prompt: 'Monitor footage.' }] }],
    },
    {
      scene_number: 2,
      variations: [{ prompt: 'A wide courtroom.' }],
    },
  ], [
    { scene_number: 1, shot_type: 'close-up', visual_description: 'Monitor footage.' },
    { scene_number: 2, shot_type: 'wide', visual_description: 'A courtroom.' },
  ]);

  assert.match(segmented.segments[0].variations[0].prompt, /UNIVERSAL FIGURE CONTRACT/);
  assert.match(flat.variations[0].prompt, /ANATOMY CONTRACT/);
});

test('removes impossible full-body requirements from legacy tight inserts', () => {
  const result = hardenDocumentaryImagePrompt(
    '135mm extreme close-up, mannequin arm in black robe sleeve with black trousers visible at hem and black leather dress shoes, gavel striking the block, featureless smooth porcelain face, warm tan porcelain skin tone, with wood splinters and dust particles frozen mid-air.',
    {
      shot_type: 'extreme close-up',
      visual_description: 'A judge’s gavel strikes its sound block.',
    }
  );

  assert.doesNotMatch(result, /trousers visible at hem/i);
  assert.doesNotMatch(result, /featureless smooth porcelain face/i);
  assert.doesNotMatch(result, /wood splinters/i);
  assert.match(result, /porcelain surface tone/i);
  assert.match(result, /head, face, torso, pelvis, legs, and footwear remain outside/i);
});

test('normalizes stale project scene, image, selection, and history prompts', () => {
  const project = {
    scene_plan: {
      scenes: [{
        scene_number: 58,
        shot_type: 'extreme close-up',
        visual_description: 'A judge’s gavel strikes its sound block.',
      }],
    },
    scenes: [{ scene_number: 58, prompts: ['Extreme close-up of a mannequin hand holding a gavel.'] }],
    images: { '58_0_0': { prompt: 'Extreme close-up of a mannequin hand holding a gavel.' } },
    selected_images: { '58_0': { prompt: 'Extreme close-up of a mannequin hand holding a gavel.' } },
    image_history: { '58_0_0': [{ prompt: 'Extreme close-up of a mannequin hand holding a gavel.' }] },
  };

  const result = normalizeProjectImagePrompts(project);
  assert.equal(result.changed, true);
  assert.equal(result.promptCount, 4);
  assert.match(project.scenes[0].prompts[0], /TIGHT-DETAIL OVERRIDE/);
  assert.match(project.images['58_0_0'].prompt, /ANATOMY CONTRACT/);
  assert.match(project.selected_images['58_0'].prompt, /FRAMING CONTRACT/);
  assert.match(project.image_history['58_0_0'][0].prompt, /UNIVERSAL FIGURE CONTRACT/);
});
