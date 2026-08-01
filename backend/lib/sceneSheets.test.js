import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPanelExpansionPrompt,
  buildSceneSheetPlanningChunks,
  buildSheetMasterPrompt,
  compactSceneSheetShotPrompt,
  fallbackSceneSheetGroups,
  layoutForPanelCount,
  panelCropGeometry,
  runSceneSheetPlanningPool,
  sceneSheetPlanningProgress,
  validatePlannedGroups,
  validateSheetDimensions,
} from './sceneSheets.js';

test('scene-sheet planning chunks keep recurring scenarios intact and bounded', () => {
  const units = [
    ...Array.from({ length: 12 }, (_, index) => ({
      unitId: `${index + 1}_0`,
      sceneNumber: index + 1,
      scenarioId: index % 2 === 0 ? 'recurring-road' : `place-${index}`,
    })),
    ...Array.from({ length: 8 }, (_, index) => ({
      unitId: `${index + 20}_0`,
      sceneNumber: index + 20,
      scenarioId: `late-place-${index}`,
    })),
  ];
  const chunks = buildSceneSheetPlanningChunks(units, 8);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.units.length <= 8));
  const recurringChunks = chunks.filter(chunk =>
    chunk.units.some(unit => unit.scenarioId === 'recurring-road'),
  );
  assert.equal(recurringChunks.length, 1);
  assert.equal(
    recurringChunks[0].units.filter(unit => unit.scenarioId === 'recurring-road').length,
    6,
  );
  assert.deepEqual(
    chunks.flatMap(chunk => chunk.unitIds).sort(),
    units.map(unit => unit.unitId).sort(),
  );
});

test('scene-sheet planning progress reports incremental completed work', () => {
  const progress = sceneSheetPlanningProgress([
    { status: 'completed', unitCount: 20, usedFallback: false },
    { status: 'completed', unitCount: 10, usedFallback: true },
    { status: 'running', unitCount: 20 },
    { status: 'queued', unitCount: 10 },
  ]);
  assert.deepEqual(progress, {
    totalChunks: 4,
    completedChunks: 2,
    activeChunks: 1,
    failedChunks: 0,
    fallbackChunks: 1,
    processedUnits: 30,
    totalUnits: 60,
    percent: 50,
  });
});

test('scene-sheet planning splits an exceptionally large scenario into bounded requests', () => {
  const units = Array.from({ length: 19 }, (_, index) => ({
    unitId: `${index + 1}_0`,
    sceneNumber: index + 1,
    scenarioId: 'same-large-location',
  }));
  const chunks = buildSceneSheetPlanningChunks(units, 8);
  assert.deepEqual(chunks.map(chunk => chunk.units.length), [8, 8, 3]);
});

test('scene-sheet planning bounds verbose prompt payloads without truncating them', () => {
  const units = Array.from({ length: 12 }, (_, index) => ({
    unitId: `${index + 1}_0`,
    sceneNumber: index + 1,
    scenarioId: 'same-verbose-location',
    prompt: `Shot ${index + 1}: ${'preserve every authored visual detail '.repeat(160)}`,
  }));
  const chunks = buildSceneSheetPlanningChunks(units, 30, 20_000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.payloadCharacters <= 20_000));
  assert.deepEqual(
    chunks.flatMap(chunk => chunk.units.map(unit => unit.prompt)),
    units.map(unit => unit.prompt),
  );
});

test('scene-sheet planning pool processes every chunk with at most three active sessions', async () => {
  let active = 0;
  let peak = 0;
  const completed = [];
  const chunks = Array.from({ length: 8 }, (_, index) => ({ index }));
  const results = await runSceneSheetPlanningPool(chunks, async chunk => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    completed.push(chunk.index);
    active -= 1;
    return `chunk-${chunk.index}`;
  }, 3);

  assert.equal(peak, 3);
  assert.equal(active, 0);
  assert.deepEqual(completed.sort((left, right) => left - right), chunks.map(chunk => chunk.index));
  assert.deepEqual(results, chunks.map(chunk => `chunk-${chunk.index}`));
});

test('panel expansion prompt makes sheet numbering removal a delivery requirement', () => {
  const prompt = buildPanelExpansionPrompt(
    { ordinal: 3, prompt: 'A mannequin opens the vault.' },
    { scenarioContinuity: 'The same underground vault.' },
  );
  assert.match(prompt, /ZERO readable text and ZERO panel numbering/);
  assert.match(prompt, /lower-left corner.*only naturally reconstructed scene pixels/i);
  assert.match(prompt, /inspect all four corners/i);
});

test('scene-sheet prompts collapse accidental consecutive contract duplication', () => {
  const prompt = compactSceneSheetShotPrompt(
    'A cinematic vault frame. NESTED CHECK: every screen uses mannequins. NESTED CHECK: every screen uses mannequins. Keep the frame clean.',
  );
  assert.equal(
    prompt,
    'A cinematic vault frame. NESTED CHECK: every screen uses mannequins. Keep the frame clean.',
  );
});

test('five-panel prompts reserve the unused sixth cell', () => {
  const layout = layoutForPanelCount(5);
  const panels = Array.from({ length: 5 }, (_, index) => ({
    ordinal: index + 1,
    label: `Scene ${index + 1}`,
    prompt: `Shot ${index + 1}`,
  }));
  const prompt = buildSheetMasterPrompt({ layout, scenarioContinuity: 'same room' }, panels, []);
  assert.match(prompt, /final 1 unused grid cell empty/i);
  assert.match(prompt, /GRID TEMPLATE CONTRACT/);
  assert.match(prompt, /FIRST reference image/i);
});

test('scene sheet layouts cover two through six panels', () => {
  assert.deepEqual(layoutForPanelCount(2), {
    columns: 2, rows: 1, panelAspectRatio: '16:9', tileAspectRatio: '16:9',
  });
  assert.deepEqual(layoutForPanelCount(4), {
    columns: 2, rows: 2, panelAspectRatio: '16:9', tileAspectRatio: '16:9',
  });
  assert.deepEqual(layoutForPanelCount(6), {
    columns: 3, rows: 2, panelAspectRatio: '16:9', tileAspectRatio: '16:9',
  });
  assert.throws(() => layoutForPanelCount(1), /between 2 and 6/);
});

test('crop geometry covers non-divisible dimensions without gaps', () => {
  const layout = layoutForPanelCount(6);
  const first = panelCropGeometry(2048, 768, layout, 1);
  const third = panelCropGeometry(2048, 768, layout, 3);
  const sixth = panelCropGeometry(2048, 768, layout, 6);
  assert.deepEqual(first, { left: 0, top: 0, width: 682, height: 384 });
  assert.equal(third.left + third.width, 2048);
  assert.equal(sixth.top + sixth.height, 768);
});

test('dimension validation accepts any usable grid canvas and delegates shape repair to expansion', () => {
  const layout = layoutForPanelCount(6);
  const native = validateSheetDimensions({ width: 2048, height: 768 }, layout);
  assert.equal(native.layoutMode, 'native-16:9-panels');
  assert.equal(native.needsOutpaint, false);
  const generated = validateSheetDimensions({ width: 1672, height: 941 }, layout);
  assert.equal(generated.layoutMode, 'flexible-source-canvas');
  assert.equal(generated.needsOutpaint, true);
  assert.ok(generated.actualPanelAspectRatio > 1.18 && generated.actualPanelAspectRatio < 1.19);
  const tall = validateSheetDimensions({ width: 1200, height: 1000 }, layout);
  assert.equal(tall.layoutMode, 'flexible-source-canvas');
  assert.equal(tall.needsOutpaint, true);
  const wideTwoPanel = validateSheetDimensions(
    { width: 2172, height: 724 },
    layoutForPanelCount(2),
  );
  assert.equal(wideTwoPanel.layoutMode, 'flexible-source-canvas');
  assert.equal(wideTwoPanel.needsOutpaint, true);
});

test('planned groups reject duplicate ownership and preserve isolated units', () => {
  const units = ['1_0', '1_1', '2_0', '3_0'].map((unitId, index) => ({
    unitId,
    sceneNumber: index + 1,
  }));
  const result = validatePlannedGroups([
    { id: 'vault', unitIds: ['1_1', '1_0'] },
    { id: 'duplicate', unitIds: ['1_1', '2_0'] },
  ], units);
  assert.deepEqual(result.groups.map(group => group.id), ['vault']);
  assert.deepEqual(result.groups[0].unitIds, ['1_0', '1_1']);
  assert.deepEqual(result.isolatedUnitIds, ['2_0', '3_0']);
});

test('fallback groups non-adjacent units and balances chunks without a singleton', () => {
  const units = Array.from({ length: 8 }, (_, index) => ({
    unitId: `${index + 1}_0`,
    sceneNumber: index + 1,
    scenarioId: index === 3 ? 'other' : 'same-place',
    scenarioContinuity: 'fixed room',
  }));
  const result = fallbackSceneSheetGroups(units);
  assert.deepEqual(result.groups.map(group => group.unitIds.length), [4, 3]);
  assert.deepEqual(result.isolatedUnitIds, ['4_0']);
});
