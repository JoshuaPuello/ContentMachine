import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCharacterReferencePrompt,
  buildCharacterSceneContext,
  buildCharacterStoryContext,
  normalizeExtractedCharacters,
} from './characterContinuity.js';

test('uses finalized narration when scene-plan narration is absent', () => {
  const context = buildCharacterSceneContext({
    scenes: [{ scene_id: 's02', scene_number: 2, visual_description: 'A roadside arrest.' }],
  }, {
    narration_sequence: [
      { scene_id: 'cinema:trailer', cinema_type: 'trailer', lines: ['Ignore me'] },
      { scene_id: 's02', cinema_type: 'scene', lines: ['[BGM:TENSION_LOW]', 'Karen drops the wildflowers.'] },
    ],
  });

  assert.equal(context[0].narration, 'Karen drops the wildflowers.');
});

test('character story context excludes duplicated research payloads', () => {
  const context = buildCharacterStoryContext({
    id: 'story-1',
    title: 'A complete documentary',
    summary: 'The identity-bearing story spine.',
    historical_sources: [{ url: 'https://example.test/source', transcript: 'very large' }],
    research_notes: 'duplicated long-form research',
    source_context: 'raw user material',
  });

  assert.deepEqual(context, {
    id: 'story-1',
    title: 'A complete documentary',
    summary: 'The identity-bearing story spine.',
  });
  assert.equal(JSON.stringify(context).includes('very large'), false);
});

test('mechanically enforces the mannequin contract even when Sonnet returns a weak prompt', () => {
  const result = normalizeExtractedCharacters({
    characters: [{
      name: 'Karen Garner',
      role: 'Primary subject',
      description: 'Elderly, frail, short silver hair, stooped posture.',
      visual_prompt: 'This character should be a manikin style',
      scene_numbers: [3, 1, 3, 999],
      importance: 'primary',
    }],
  }, 60);

  assert.deepEqual(result.characters[0].scene_numbers, [1, 3]);
  assert.match(result.characters[0].visual_prompt, /seamless, featureless glossy porcelain mannequin/i);
  assert.match(result.characters[0].visual_prompt, /no eyes, eyebrows, nose, mouth/i);
  assert.doesNotMatch(result.characters[0].visual_prompt, /This character should be a manikin style/i);
});

test('reference prompt preserves identity through silhouette without realistic skin', () => {
  const prompt = buildCharacterReferencePrompt({
    name: 'Karen Garner',
    role: '73-year-old primary subject',
    description: 'Frail build, stooped posture, short silver hair.',
  });

  assert.match(prompt, /Frail build, stooped posture, short silver hair/);
  assert.match(prompt, /Never use exposed realistic human skin/i);
  assert.match(prompt, /head to toe/i);
});

test('returns an explicit inclusion and exclusion audit', () => {
  const result = normalizeExtractedCharacters({
    characters: [{ name: 'Recurring Officer', scene_numbers: [2, 4] }],
    candidate_audit: {
      candidate_count: 3,
      excluded: [
        { name: 'Judge', reason: 'Appears in one closing scene.' },
        { name: 'Attorney', reason: 'Appears in one explanatory scene.' },
      ],
      coverage_notes: 'All finalized narration units checked.',
    },
  }, 5);

  assert.equal(result.audit.included_count, 1);
  assert.equal(result.audit.candidate_count, 3);
  assert.equal(result.audit.excluded.length, 2);
});
