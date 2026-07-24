import assert from 'node:assert/strict';
import test from 'node:test';
import { compactIdeationDirection, compactMapAuthorSystemPrompt } from './mapAgent.js';

test('ideation handoff preserves structure while enforcing a compact executor prompt', () => {
  const verbose = {
    summary: 'S'.repeat(4_000),
    narrative_phases: Array.from({ length: 7 }, (_, index) => ({
      purpose: `phase ${index} ${'p'.repeat(1_500)}`,
      locations: Array.from({ length: 12 }, () => 'location '.repeat(100)),
      movement: 'movement '.repeat(500),
      labels: Array.from({ length: 15 }, () => 'label '.repeat(100)),
    })),
    critical_facts: Array.from({ length: 20 }, () => 'fact '.repeat(200)),
    execution_notes: { camera: 'camera '.repeat(1_000), arrows: 'arrows '.repeat(1_000) },
  };
  const compact = compactIdeationDirection(verbose);
  assert.equal(compact.narrative_phases.length, 4);
  assert.ok(compact.critical_facts.length <= 10);
  assert.ok(JSON.stringify(compact).length <= 8_000);
  assert.match(compact.narrative_phases[0].purpose, /phase 0/);
});

test('retry prompt removes the long worked example but keeps quality gates', () => {
  const prompt = `---\nname: map-author\n---\n# Rules\n## Hard constraints\nTruth\n## Worked example\n${'example '.repeat(1_000)}\n## Self-check\nVerify`;
  const compact = compactMapAuthorSystemPrompt(prompt);
  assert.doesNotMatch(compact, /Worked example/);
  assert.match(compact, /Hard constraints/);
  assert.match(compact, /Self-check/);
  assert.ok(compact.length < prompt.length / 2);
});
