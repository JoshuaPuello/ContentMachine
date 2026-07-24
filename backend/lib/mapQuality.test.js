import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cameraAt,
  coverageErrors,
  focusErrors,
  geoToScreen,
  labelScreenBox,
  minimumCoverageZoom,
  screenToGeo,
} from './mapQuality.js';

test('projection round-trips geographic coordinates', () => {
  const camera = { lon: 14, lat: 43, zoom: 1.4 };
  const screen = geoToScreen(5.2, 45.6, camera);
  const geo = screenToGeo(screen.x, screen.y, camera);
  assert.ok(Math.abs(geo.lon - 5.2) < 1e-8);
  assert.ok(Math.abs(geo.lat - 45.6) < 1e-8);
});

test('detects the exposed western edge in the original Rhone framing', () => {
  const camera = { lon: 6.4, lat: 46.6, zoom: 0.72 };
  assert.match(coverageErrors(camera).join(' '), /west edge/);
  assert.ok(minimumCoverageZoom(camera) > 1.3);
});

test('accepts a fully covered regional frame', () => {
  assert.deepEqual(coverageErrors({ lon: 20, lat: 44, zoom: 1.15 }), []);
});

test('camera interpolation follows in-out easing', () => {
  const camera = cameraAt([
    { frame: 0, lon: 10, lat: 40, zoom: 1 },
    { frame: 100, lon: 20, lat: 50, zoom: 2, ease: 'inOut' },
  ], 50);
  assert.equal(camera.lon, 15);
  assert.equal(camera.zoom, 1.5);
});

test('rejects imperceptible detail framing', () => {
  const errors = focusErrors(
    { bounds: [4.5, 43.5, 6.5, 45.5], kind: 'detail' },
    { lon: 10, lat: 45, zoom: 0.7 }
  );
  assert.match(errors.join(' '), /occupies only/);
});

test('accepts a readable detail focus', () => {
  const errors = focusErrors(
    { bounds: [1, 41, 10, 48], kind: 'detail' },
    { lon: 8, lat: 46, zoom: 2 }
  );
  assert.deepEqual(errors, []);
});

test('requires a closer camera for a local campaign phase', () => {
  const focus = { bounds: [1.5, 41.5, 8.5, 46.5], kind: 'detail' };
  assert.match(focusErrors(focus, { lon: 6.2, lat: 45, zoom: 1.8 }).join(' '), /occupies only/);
  assert.deepEqual(focusErrors(focus, { lon: 6.2, lat: 45, zoom: 3.05 }), []);
});

test('computes a label box that grows with zoom', () => {
  const label = { lines: ['IBERIA'], lon: -3, lat: 40, size: 34, tracking: 0.68 };
  const wide = labelScreenBox(label, { lon: 10, lat: 43, zoom: 1 });
  const close = labelScreenBox(label, { lon: 10, lat: 43, zoom: 2 });
  assert.ok(close.width > wide.width * 1.8);
});
