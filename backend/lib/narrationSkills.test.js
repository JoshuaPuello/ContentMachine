import test from 'node:test';
import assert from 'node:assert/strict';
import {
  auditNarrationContinuity,
  buildNarrationSkillPrompt,
  routeNarrationSkills,
} from './narrationSkills.js';

test('routes an Alcatraz escape documentary through true-crime guidance', () => {
  const route = routeNarrationSkills({
    title: 'The Man Left Behind',
    summary: 'Four prisoners attempt to escape Alcatraz.',
  }, { trailerEnabled: true });
  assert.equal(route.format, 'true-crime');
  assert.ok(route.references.includes('true-crime-skill.md'));
  assert.ok(route.references.includes('REAL-FACELESS-HOOK-SWIPE.md'));
});

test('runtime prompt inlines the selected documentary and niche guidance', () => {
  const profile = buildNarrationSkillPrompt({
    title: 'The Man Left Behind',
    summary: 'A prison escape from Alcatraz.',
  }, { trailerEnabled: true });
  assert.match(profile.prompt, /Compose first, partition second/i);
  assert.match(profile.prompt, /True Crime Faceless Scripts/i);
  assert.match(profile.prompt, /Selected format: true-crime/i);
});

test('continuity audit rejects the original fragment-heavy narration', () => {
  const audit = auditNarrationContinuity([
    { unit_id: 'cinema:trailer', lines: ['Four men. One tunnel. One hole that refuses to open. And a man who hears his own escape leaving without him.'] },
    { unit_id: 's01', lines: ['The Rock. Twelve acres of concrete. Nobody leaves.'] },
  ]);
  assert.equal(audit.pass, false);
  assert.ok(audit.violations.some((issue) => /H17/.test(issue)));
});

test('continuity audit accepts fluent scene-partitioned narration', () => {
  const audit = auditNarrationContinuity([
    { unit_id: 'cinema:trailer', duration: 10, lines: ["Four men shared one tunnel and one hole that wouldn't open in time, while one of them heard his own escape leaving without him."] },
    { unit_id: 'cinema:overview:1', duration: 5, lines: ['The Rock was a prison the sea itself was built to guard.'] },
    { unit_id: 'cinema:transition:1', duration: 5, lines: ['That night, four men intend to prove the sea wrong.'] },
    { unit_id: 's01', duration: 10, lines: ["On June eleventh, 1962, four men inside B-Block count down to the final headcount because they're planning to walk out of Alcatraz."] },
    { unit_id: 's02', duration: 6, lines: ["Only three will reach the water, and Allen West is about to learn why."] },
  ]);
  assert.equal(audit.pass, true, audit.violations.join(' | '));
});

test('continuity audit rejects fluent prose that overruns the production budget', () => {
  const audit = auditNarrationContinuity([
    {
      unit_id: 's01',
      duration: 5,
      lines: ['Although the corridor is empty, Allen keeps moving because every careful measurement now depends on reaching the roof before the guards return to the block.'],
    },
  ]);
  assert.equal(audit.pass, false);
  assert.ok(audit.violations.some((issue) => /Production pacing/.test(issue)));
});
