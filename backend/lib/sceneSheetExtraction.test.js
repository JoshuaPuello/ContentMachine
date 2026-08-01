import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { detectSceneSheetPanels } from './sceneSheetExtraction.js';
import { layoutForPanelCount } from './sceneSheets.js';

const syntheticSheet = async ({
  width,
  height,
  vertical = [],
  horizontal = [],
}) => {
  const composites = [];
  for (const x of vertical) {
    composites.push({
      input: Buffer.from(`<svg width="4" height="${height}"><rect width="4" height="${height}" fill="white"/></svg>`),
      left: x - 2,
      top: 0,
    });
  }
  for (const y of horizontal) {
    composites.push({
      input: Buffer.from(`<svg width="${width}" height="4"><rect width="${width}" height="4" fill="white"/></svg>`),
      left: 0,
      top: y - 2,
    });
  }
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 24, g: 31, b: 43 },
    },
  }).composite(composites).png().toBuffer();
};

test('divider-aware extraction snaps a two-panel crop to a shifted generated divider', async () => {
  const buffer = await syntheticSheet({ width: 1200, height: 700, vertical: [560] });
  const result = await detectSceneSheetPanels(buffer, layoutForPanelCount(2));
  assert.equal(result.strategy, 'divider-aware');
  assert.equal(result.detectedDividers, 1);
  assert.ok(Math.abs(result.xBoundaries[1] - 560) <= 4);
  assert.equal(result.geometries[0].width, result.xBoundaries[1] - result.xInsets[0]);
  assert.equal(result.geometries[1].left, result.xBoundaries[1] + result.xInsets[0]);
});

test('divider-aware extraction finds shifted rows and columns in a four-panel sheet', async () => {
  const buffer = await syntheticSheet({
    width: 1400,
    height: 900,
    vertical: [650],
    horizontal: [420],
  });
  const result = await detectSceneSheetPanels(buffer, layoutForPanelCount(4));
  assert.equal(result.detectedDividers, 2);
  assert.ok(Math.abs(result.xBoundaries[1] - 650) <= 4);
  assert.ok(Math.abs(result.yBoundaries[1] - 420) <= 4);
  assert.deepEqual(result.geometries[3], {
    left: result.xBoundaries[1] + result.xInsets[0],
    top: result.yBoundaries[1] + result.yInsets[0],
    width: 1400 - result.xBoundaries[1] - result.xInsets[0],
    height: 900 - result.yBoundaries[1] - result.yInsets[0],
  });
});

test('extraction safely falls back to proportional cells when no divider is detectable', async () => {
  const buffer = await sharp({
    create: {
      width: 1000,
      height: 600,
      channels: 3,
      background: { r: 48, g: 48, b: 48 },
    },
  }).png().toBuffer();
  const result = await detectSceneSheetPanels(buffer, layoutForPanelCount(2));
  assert.equal(result.strategy, 'proportional-fallback');
  assert.deepEqual(result.geometries[0], { left: 0, top: 0, width: 500, height: 600 });
  assert.deepEqual(result.geometries[1], { left: 500, top: 0, width: 500, height: 600 });
});
