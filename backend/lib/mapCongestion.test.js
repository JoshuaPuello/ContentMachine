import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateAndFix } from './mapAgent.js';
import { repairPlan } from './mapRepair.js';
import { analyzeCongestion, applyCongestionStrategy } from './mapCongestion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) =>
  JSON.parse(readFileSync(path.join(__dirname, '__fixtures__', name), 'utf8'));

const DURATION_SECONDS = 16;

test('analyzeCongestion detects the 10-route Sagan spray hub and spares the chained hero routes', () => {
  const plan = fixture('map2-run2-attempt2.json');
  const report = analyzeCongestion(plan);
  assert.equal(report.hubs.length, 1);
  const hub = report.hubs[0];
  assert.ok(Math.abs(hub.origin[0] - 15.3) < 0.2 && Math.abs(hub.origin[1] - 51.6) < 0.2);
  // The 10 neutral filaments are the spray; the teal chained legs (which
  // continue to Stettin/France and end at markers) are narrative hero routes.
  assert.deepEqual([...hub.sprayIndices].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a theater with 4 or fewer concurrent routes is not congested', () => {
  const plan = fixture('map2-run2-attempt2.json');
  plan.props.arrows = plan.props.arrows.slice(6); // 4 spray + hero chains
  const report = analyzeCongestion(plan);
  assert.equal(report.hubs.length, 0);
});

test('applyCongestionStrategy sequences the spray into waves with retracts and endpoint dots', () => {
  const plan = fixture('map2-run2-attempt2.json');
  const original = fixture('map2-run2-attempt2.json');
  const { plan: staged, log } = applyCongestionStrategy(plan);
  assert.ok(log.length >= 1);

  const spray = staged.props.arrows.slice(0, 10);
  const heroes = staged.props.arrows.slice(10);

  // Every spray route now draws, settles, then retracts into its endpoint.
  for (const arrow of spray) {
    assert.ok(Array.isArray(arrow.retract), 'spray arrow gains retract');
    assert.ok(arrow.retract[0] >= arrow.grow[1], 'retract starts after the draw completes');
    assert.ok(arrow.retract[1] <= 460, 'progression finishes before the resolution phase');
    assert.equal(arrow.fade, undefined, 'retract replaces opacity fade');
  }
  // Hero routes are untouched: their geometry and timing carry the story.
  for (let i = 0; i < heroes.length; i += 1) {
    assert.deepEqual(heroes[i].grow, original.props.arrows[i + 10].grow);
    assert.equal(heroes[i].retract, undefined);
  }

  // At most 3 routes drawing at once; at most 6 visible including retractions.
  for (let frame = 100; frame <= 470; frame += 1) {
    const growing = spray.filter((a) => frame >= a.grow[0] && frame <= a.grow[1]).length;
    const visible = spray.filter((a) => frame >= a.grow[0] && frame <= a.retract[1]).length;
    assert.ok(growing <= 3, `${growing} spray arrows drawing at frame ${frame}`);
    assert.ok(visible <= 6, `${visible} spray arrows visible at frame ${frame}`);
  }

  // Each retracted route leaves a pulsing dot at its endpoint.
  assert.equal(staged.props.dots.length, 10);
  for (let i = 0; i < 10; i += 1) {
    const dot = staged.props.dots[i];
    const arrow = spray[i];
    assert.deepEqual([dot.lon, dot.lat], arrow.points[2]);
    assert.equal(dot.color, 'neutral');
    assert.ok(Math.abs(dot.appear[0] - arrow.grow[1]) <= 8, 'dot appears as its route completes');
  }

  // Map-plane labels under the hub recede during the action; labels whose
  // hero moment falls inside the action window keep full presence.
  const byText = (text) => staged.props.labels.find((l) => l.lines.join(' ') === text);
  assert.ok(byText('German Reich').dim, 'German Reich dims under the spray');
  assert.equal(byText('Baltic Sea').dim, undefined);
  assert.equal(byText('Sweden').dim, undefined);
  assert.equal(byText('France').dim, undefined);
});

test('applyCongestionStrategy is idempotent', () => {
  const once = applyCongestionStrategy(fixture('map2-run2-attempt2.json')).plan;
  const { plan: twice, log } = applyCongestionStrategy(once);
  assert.equal(log.length, 0);
  assert.equal(JSON.stringify(twice), JSON.stringify(once));
});

test('repair + congestion staging yields a fully valid plan', () => {
  const repaired = repairPlan({ plan: fixture('map2-run2-attempt2.json'), durationSeconds: DURATION_SECONDS });
  assert.deepEqual(repaired.errors, [], `repair residue: ${repaired.errors.join('; ')}`);
  const staged = applyCongestionStrategy(repaired.plan).plan;
  const { errors } = validateAndFix(staged, DURATION_SECONDS);
  assert.deepEqual(errors, [], `staged plan invalid: ${errors.join('; ')}`);
});

test('validateAndFix validates dots and rejects out-of-region points', () => {
  const plan = fixture('map2-run2-attempt2.json');
  plan.props.dots = [
    { lon: 12, lat: 50, appear: [200, 220] },
    { lon: 200, lat: 50, appear: [200, 220] },
  ];
  const { errors, plan: fixed } = validateAndFix(plan, DURATION_SECONDS);
  assert.ok(errors.some((e) => /dot outside map region/.test(e)), errors.join('; '));
  assert.equal(fixed.props.dots[0].color, 'neutral');
  assert.equal(fixed.props.dots[0].radius, 7);
});

test('label collisions are exempt while one label is dimmed to near-invisibility', () => {
  const plan = fixture('map2-run2-attempt3.json');
  // Recreate the classic irreparable pair: two big labels on top of each
  // other at a shared frame, but the context label is dimmed there.
  plan.props.labels = [
    { lines: ['Alpha'], lon: 11.5, lat: 51.0, size: 40, tracking: 0.7, heroFrame: 300 },
    { lines: ['Beta'], lon: 11.8, lat: 51.2, size: 38, tracking: 0.7, heroFrame: 300, dim: { window: [250, 360], to: 0.2 } },
    { lines: ['Gamma'], lon: 19, lat: 54, size: 24, tracking: 0.6, heroFrame: 60 },
  ];
  const { errors } = validateAndFix(plan, DURATION_SECONDS);
  assert.ok(!errors.some((e) => /overlap at frame 300/.test(e)), errors.join('; '));
});
