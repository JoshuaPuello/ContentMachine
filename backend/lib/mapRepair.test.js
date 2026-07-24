import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateAndFix } from './mapAgent.js';
import { repairPlan } from './mapRepair.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'));

const DURATION_SECONDS = 16;

// The 2026-07-21 crowding/endpoint laws legitimately fire on these
// historical fixtures — their 14–16 arrow sprays end in unlabeled emptiness,
// which is exactly what the laws exist to catch. The reproduction tests
// therefore assert on the pre-existing (non-law) errors.
const withoutEndpointErrors = (errors) =>
  errors.filter((e) => !/ends unexplained/.test(e) && !/too many routes/.test(e));

test('attempt-2 fixture still reproduces the exact 31% focus near-miss', () => {
  const { errors } = validateAndFix(fixture('map2-attempt2.json'), DURATION_SECONDS);
  const core = withoutEndpointErrors(errors);
  assert.equal(core.length, 1);
  assert.match(core[0], /focus 1 .*occupies only 31% .*requires at least 32%/);
});

test('crowded sprays become outcome-dot fields and every route ends readable', () => {
  const plan = fixture('map2-attempt2.json');
  const before = validateAndFix(fixture('map2-attempt2.json'), DURATION_SECONDS).errors;
  assert.ok(before.some((e) => /too many routes/.test(e)), before.join('; '));
  assert.ok(before.some((e) => /ends unexplained/.test(e)), before.join('; '));

  const result = repairPlan({ plan, durationSeconds: DURATION_SECONDS });
  assert.deepEqual(result.errors, [], `unrepaired: ${result.errors.join('; ')}`);
  assert.ok(result.log.some((e) => e.op === 'spray-to-dots'), 'spray-to-dots must run');
  assert.ok(result.plan.props.arrows.length <= 12, `still ${result.plan.props.arrows.length} arrows`);
  assert.ok((result.plan.props.dots ?? []).length >= 5, 'the dispersal must survive as dots');
  // Narrative hero legs (chained or marker-terminated) are preserved.
  assert.ok(result.plan.props.arrows.length >= 2, 'hero routes must not be deleted');
});

test('repairPlan fixes the attempt-2 focus miss with a bounded phase-scoped zoom scale', () => {
  const plan = fixture('map2-attempt2.json');
  const result = repairPlan({ plan, durationSeconds: DURATION_SECONDS });

  assert.deepEqual(result.errors, [], `unrepaired: ${result.errors.join('; ')}`);
  assert.ok(result.log.length >= 1);
  assert.ok(result.log.some((entry) => entry.op === 'focus-zoom'));

  // Only the keyframes of the phase containing focus frame 90 (frames 0, 90,
  // 145 — delimited by the inOut arrival at 265) may change, by a small factor.
  const repaired = result.plan.props.camera;
  const original = fixture('map2-attempt2.json').props.camera;
  for (let i = 0; i < original.length; i += 1) {
    if (original[i].frame <= 145) {
      const factor = repaired[i].zoom / original[i].zoom;
      assert.ok(factor > 1.0 && factor < 1.12, `keyframe ${original[i].frame} scaled by ${factor}`);
    } else {
      assert.equal(repaired[i].zoom, original[i].zoom, `keyframe ${original[i].frame} must not change`);
    }
    assert.equal(repaired[i].lon, original[i].lon);
    assert.equal(repaired[i].lat, original[i].lat);
  }
  // Labels are untouched by a camera-only repair.
  assert.deepEqual(
    result.plan.props.labels.map((l) => [l.lines.join(' '), l.lon, l.lat]),
    original && fixture('map2-attempt2.json').props.labels.map((l) => [l.lines.join(' '), l.lon, l.lat])
  );
});

test('attempt-3 fixture still reproduces the Baltic clip and Sagan/Germany overlap', () => {
  const { errors } = validateAndFix(fixture('map2-attempt3.json'), DURATION_SECONDS);
  const core = withoutEndpointErrors(errors);
  assert.equal(core.length, 2);
  assert.ok(core.some((e) => /Baltic Sea.*clipped at heroFrame 420/.test(e)));
  assert.ok(core.some((e) => /overlap at frame 70: 'Sagan' and 'Germany'/.test(e)));
});

test('repairPlan fixes attempt-3 by retiming Germany into its phase and nudging Baltic Sea', () => {
  const plan = fixture('map2-attempt3.json');
  const result = repairPlan({ plan, durationSeconds: DURATION_SECONDS });

  assert.deepEqual(result.errors, [], `unrepaired: ${result.errors.join('; ')}`);

  const labels = result.plan.props.labels;
  const germany = labels.find((l) => l.lines.join(' ') === 'Germany');
  const baltic = labels.find((l) => l.lines.join(' ') === 'Baltic Sea');
  const sagan = labels.find((l) => l.lines.join(' ') === 'Sagan');

  // Germany's hero moment is frame 250 (phase 2); the collision was at frame
  // 70 (phase 1). The repair delays its entrance instead of moving anything.
  assert.ok(Array.isArray(germany.appear), 'Germany gains an appear window');
  assert.ok(germany.appear[0] >= 170 && germany.appear[0] <= 250);
  assert.equal(germany.lon, 11.5);

  // Baltic Sea slides west along the sea, bounded, still east of Denmark.
  assert.ok(baltic.lon < 16 && baltic.lon > 13.5, `Baltic Sea moved to ${baltic.lon}`);
  assert.equal(baltic.lat, 55.6);

  // The label that owned the hero moment at the collision frame is untouched.
  assert.equal(sagan.lon, 15.3);
  assert.equal(sagan.appear?.[0], 10);
});

test('repairPlan does not mutate its input plan', () => {
  const plan = fixture('map2-attempt2.json');
  const snapshot = JSON.stringify(plan);
  repairPlan({ plan, durationSeconds: DURATION_SECONDS });
  assert.equal(JSON.stringify(plan), snapshot);
});

test('repairPlan is a no-op on an already-valid plan', () => {
  const first = repairPlan({ plan: fixture('map2-attempt2.json'), durationSeconds: DURATION_SECONDS });
  assert.deepEqual(first.errors, []);
  const second = repairPlan({ plan: first.plan, durationSeconds: DURATION_SECONDS });
  assert.deepEqual(second.errors, []);
  assert.equal(second.log.length, 0);
  assert.equal(JSON.stringify(second.plan), JSON.stringify(first.plan));
});

test('repairPlan refuses to cheat past the 3.4 zoom ceiling', () => {
  const plan = fixture('map2-attempt2.json');
  // Make focus 1 a sliver that no legal zoom can bring to 32% occupancy.
  plan.focus[0].bounds = [15.2, 51.4, 15.7, 51.8];
  const result = repairPlan({ plan, durationSeconds: DURATION_SECONDS });
  assert.ok(result.errors.length >= 1, 'impossible occupancy must survive as an error');
  for (const keyframe of result.plan.props.camera) {
    assert.ok(keyframe.zoom <= 3.4);
  }
});

// --- Run-2 fixtures: the three gaps found on 2026-07-21 (run mrv4t10d) ---

test('camera-solve repairs the Gibraltar dot that no heroFrame rescan can reach (run-2 attempt 2)', () => {
  const plan = fixture('map2-run2-attempt2.json');
  const before = withoutEndpointErrors(
    validateAndFix(fixture('map2-run2-attempt2.json'), DURATION_SECONDS).errors
  );
  assert.equal(before.length, 1);
  assert.match(before[0], /marker 'Gibraltar' dot is outside the safe frame/);

  const result = repairPlan({ plan, durationSeconds: DURATION_SECONDS });
  assert.deepEqual(result.errors, [], `unrepaired: ${result.errors.join('; ')}`);
  assert.ok(result.log.some((entry) => entry.op === 'camera-solve'));
  // The marker's geography is truth — only the camera may move.
  const gibraltar = result.plan.props.markers.find((m) => m.label === 'Gibraltar');
  assert.equal(gibraltar.lon, -5.35);
  assert.equal(gibraltar.lat, 36.14);
});

test('camera-solve escapes the zoom-out/coverage trap on over-occupancy (run-2 attempt 3)', () => {
  const plan = fixture('map2-run2-attempt3.json');
  const before = validateAndFix(fixture('map2-run2-attempt3.json'), DURATION_SECONDS).errors;
  assert.ok(before.some((e) => /occupies 1\d\d% of the view/.test(e)), before.join('; '));

  const result = repairPlan({ plan, durationSeconds: DURATION_SECONDS });
  assert.deepEqual(result.errors, [], `unrepaired: ${result.errors.join('; ')}`);
  for (const keyframe of result.plan.props.camera) {
    assert.ok(keyframe.zoom >= 0.5 && keyframe.zoom <= 3.4);
  }
});

test('an over-wide single-line label is stacked into two lines (run-2 attempt 1)', () => {
  const plan = fixture('map2-run2-attempt1.json');
  const result = repairPlan({ plan, durationSeconds: DURATION_SECONDS });
  assert.deepEqual(result.errors, [], `unrepaired: ${result.errors.join('; ')}`);
  const reich = result.plan.props.labels.find((l) => l.lines.join(' ').replace('\n', ' ') === 'German Reich');
  assert.equal(reich.lines.length, 2, `expected stacked lines, got ${JSON.stringify(reich.lines)}`);
});
