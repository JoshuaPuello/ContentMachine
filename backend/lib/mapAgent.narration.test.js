import assert from 'node:assert/strict';
import test from 'node:test';
import { validateAndFix } from './mapAgent.js';

const basePlan = () => ({
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

const arrowTo = (end, start = [16, 50]) => ({
  points: [start, [(start[0] + end[0]) / 2 + 1, (start[1] + end[1]) / 2], end],
  grow: [40, 100],
  color: 'red',
});

test('an arrow ending in empty space is flagged as unexplained', () => {
  const plan = basePlan();
  plan.props.arrows = [arrowTo([27, 43.5])];
  const { errors } = validateAndFix(plan, 16);
  assert.ok(
    errors.some((e) => /ends unexplained/.test(e)),
    errors.join('; ')
  );
});

test('arrow endpoints are explained by markers, dots, labels, or continuations', () => {
  const withMarker = basePlan();
  withMarker.props.arrows = [arrowTo([20.5, 47.5])];
  withMarker.props.markers = [
    { lon: 20.5, lat: 47.5, appear: [90, 130], color: 'red', label: 'Beta City', heroFrame: 200 },
  ];
  assert.ok(
    !validateAndFix(withMarker, 16).errors.some((e) => /ends unexplained/.test(e))
  );

  const withDot = basePlan();
  withDot.props.arrows = [arrowTo([27, 43.5])];
  withDot.props.dots = [{ lon: 27, lat: 43.5, appear: [96, 110], color: 'red' }];
  assert.ok(
    !validateAndFix(withDot, 16).errors.some((e) => /ends unexplained/.test(e))
  );

  const withLabel = basePlan();
  withLabel.props.arrows = [arrowTo([19, 46.5])]; // within label reach of Beta (20,47)
  assert.ok(
    !validateAndFix(withLabel, 16).errors.some((e) => /ends unexplained/.test(e))
  );

  const chained = basePlan();
  chained.props.arrows = [arrowTo([27, 43.5]), arrowTo([30, 41], [27, 43.5])];
  chained.props.dots = [{ lon: 30, lat: 41, appear: [96, 110], color: 'red' }];
  assert.ok(
    !validateAndFix(chained, 16).errors.some((e) => /ends unexplained/.test(e))
  );
});

test('absurd route counts are rejected outright', () => {
  const plan = basePlan();
  plan.props.arrows = Array.from({ length: 13 }, (_, i) => arrowTo([20 + i * 0.5, 47]));
  const { errors } = validateAndFix(plan, 16);
  assert.ok(errors.some((e) => /too many routes/.test(e)), errors.join('; '));
});

test('marker detail duplicating a reserved overlay text is stripped silently', () => {
  const plan = basePlan();
  plan.props.markers = [
    {
      lon: 16.5,
      lat: 50.2,
      appear: [90, 130],
      color: 'red',
      label: 'Sagan',
      detail: 'Stalag Luft III — 24 March 1944',
      heroFrame: 200,
    },
  ];
  const { errors, plan: fixed } = validateAndFix(plan, 16, {
    reservedTexts: ['24 MARCH 1944'],
  });
  assert.equal(fixed.props.markers[0].detail, undefined);
  assert.ok(!errors.some((e) => /duplicates/.test(e)), errors.join('; '));
});

test('marker label duplicating a reserved overlay text is an error', () => {
  const plan = basePlan();
  plan.props.markers = [
    {
      lon: 16.5,
      lat: 50.2,
      appear: [90, 130],
      color: 'red',
      label: 'Roger Bushell',
      heroFrame: 200,
    },
  ];
  const { errors } = validateAndFix(plan, 16, { reservedTexts: ['Roger Bushell'] });
  assert.ok(errors.some((e) => /duplicates an on-screen overlay/.test(e)), errors.join('; '));
});

test('map-plane label lines duplicating a reserved overlay text is an error', () => {
  const plan = basePlan();
  plan.props.labels[0].lines = ['24 March 1944'];
  const { errors } = validateAndFix(plan, 16, { reservedTexts: ['24 MARCH 1944'] });
  assert.ok(errors.some((e) => /duplicates an on-screen overlay/.test(e)), errors.join('; '));
});
