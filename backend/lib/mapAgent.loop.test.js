import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRetryFeedback, ideationReusable, validateAndFix } from './mapAgent.js';

const minimalValidPlan = () => ({
  bakes: [],
  focus: [
    { frame: 200, subject: 'Test subject', kind: 'establishing', bounds: [10, 45, 24, 55] },
  ],
  props: {
    variant: 'archival',
    durationInFrames: 480,
    camera: [
      { frame: 0, lon: 16, lat: 50, zoom: 1.1 },
      { frame: 479, lon: 17, lat: 50.5, zoom: 1.15 },
    ],
    fills: [],
    labels: [
      { lines: ['Alpha'], lon: 16, lat: 50, size: 30, tracking: 0.6, heroFrame: 100 },
      { lines: ['Beta'], lon: 20, lat: 47, size: 30, tracking: 0.6, heroFrame: 200 },
      { lines: ['Gamma'], lon: 12, lat: 53, size: 30, tracking: 0.6, heroFrame: 300 },
    ],
    arrows: [],
    markers: [],
    grade: [],
    pitch: 34,
    rotateZ: 0,
    perspective: 1650,
  },
});

test('retry feedback anchors the previous plan and carries cumulative violations', () => {
  const plan = minimalValidPlan();
  const feedback = buildRetryFeedback({
    attemptNumber: 2,
    plan,
    errors: ['focus 1 (X): subject occupies only 31% of the view; detail focus requires at least 32%'],
    history: [
      { attempt: 1, errors: ["labels overlap at frame 90: 'Sagan' and 'Germany'", 'marker out of frame'] },
      { attempt: 2, errors: ['focus 1 (X): subject occupies only 31% of the view; detail focus requires at least 32%'] },
    ],
  });

  assert.match(feedback, /Previous attempt 2 produced this plan/);
  assert.ok(feedback.includes('"durationInFrames": 480') || feedback.includes('"durationInFrames":480'));
  assert.match(feedback, /Unresolved issues in that plan/);
  assert.match(feedback, /occupies only 31%/);
  assert.match(feedback, /do not reintroduce/);
  assert.match(feedback, /'Sagan' and 'Germany'/);
  assert.match(feedback, /keep every other field of the plan identical/);
  assert.doesNotMatch(feedback, /smallest complete/);
  // cumulative list is deduplicated
  assert.equal(feedback.split('occupies only 31%').length - 1, 2); // once in unresolved, once in cumulative
});

test('ideation is reusable only from runs that produced at least one valid plan', () => {
  assert.equal(ideationReusable({ status: 'completed' }), true);
  assert.equal(ideationReusable({ status: 'failed', options: [{ id: 'x' }] }), true);
  assert.equal(
    ideationReusable({
      status: 'failed',
      phases: { execution: [{ status: 'completed', validationErrors: [] }] },
    }),
    true
  );
  assert.equal(
    ideationReusable({
      status: 'failed',
      phases: { execution: [{ status: 'completed', validationErrors: ['label clipped'] }] },
    }),
    false
  );
  assert.equal(ideationReusable(null), false);
});

test('fewer than 3 labels is rejected with an accurate message', () => {
  const plan = minimalValidPlan();
  plan.props.labels = plan.props.labels.slice(0, 2);
  const { errors } = validateAndFix(plan, 16);
  assert.ok(errors.some((e) => /at least 3 labels required \(found 2\)/.test(e)), errors.join('; '));

  const enough = minimalValidPlan();
  const result = validateAndFix(enough, 16);
  assert.ok(!result.errors.some((e) => /at least 3 labels/.test(e)), result.errors.join('; '));
});

test('marker safety error names the dot, not the callout', () => {
  const plan = minimalValidPlan();
  plan.props.markers = [
    {
      lon: 60,
      lat: 20,
      appear: [10, 40],
      color: 'red',
      label: 'Far Away',
      heroFrame: 100,
    },
  ];
  const { errors } = validateAndFix(plan, 16);
  const markerError = errors.find((e) => e.startsWith("marker 'Far Away'"));
  assert.ok(markerError, errors.join('; '));
  assert.match(markerError, /dot is outside the safe frame/);
});

test('coverage failures across a whole move aggregate into few actionable errors', () => {
  const plan = minimalValidPlan();
  // Both keyframes hug the west edge: the finite plane is exposed for the
  // entire 480-frame duration. That must not produce hundreds of errors.
  plan.props.camera = [
    { frame: 0, lon: -12, lat: 50, zoom: 1.0 },
    { frame: 479, lon: -11, lat: 51, zoom: 1.0 },
  ];
  const { errors } = validateAndFix(plan, 16);
  const coverage = errors.filter((e) => /exposes the finite map plane/.test(e));
  assert.ok(coverage.length >= 1);
  assert.ok(coverage.length <= 3, `expected aggregated coverage errors, got ${coverage.length}`);
  assert.match(coverage[0], /camera at frame \d+ exposes/);
  assert.match(coverage[0], /frames \d+–\d+/);
});

test('frame rescaling never produces equal camera frames', () => {
  const plan = minimalValidPlan();
  // Authored against the wrong duration with keyframes so close together
  // that naive rescaling would round them onto the same frame.
  plan.props.camera = [
    { frame: 0, lon: 16, lat: 50, zoom: 1.1 },
    { frame: 898, lon: 16.2, lat: 50.1, zoom: 1.12 },
    { frame: 899, lon: 16.4, lat: 50.2, zoom: 1.14 },
    { frame: 1438, lon: 17, lat: 50.5, zoom: 1.15 },
  ];
  const { errors, plan: fixed } = validateAndFix(plan, 16);
  assert.ok(!errors.some((e) => /strictly ascending/.test(e)), errors.join('; '));
  const frames = fixed.props.camera.map((k) => k.frame);
  for (let i = 1; i < frames.length; i += 1) {
    assert.ok(frames[i] > frames[i - 1], `frames not ascending: ${frames.join(',')}`);
  }
  assert.equal(frames[0], 0);
  assert.equal(frames.at(-1), 479);
});
