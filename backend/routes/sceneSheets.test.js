import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decorateWindowsJobForGroup,
  invalidatedSheetSelections,
  resolveSceneSheetExpansionModel,
  sceneSheetGroupStatus,
} from './sceneSheets.js';

test('completed flexible-canvas Windows sheets are reusable without regeneration', () => {
  const decorated = decorateWindowsJobForGroup({
    taskId: 'task-existing',
    status: 'complete',
    selectedOrdinal: null,
    outputs: [{
      ordinal: 1,
      width: 2172,
      height: 724,
      bytes: 1_667_808,
    }],
  }, {
    layout: { columns: 2, rows: 1 },
  });
  assert.equal(decorated.outputs[0].layoutValidation.valid, true);
  assert.match(decorated.outputs[0].layoutValidation.message, /detected and expanded/i);
});

test('scene-sheet expansion uses the project Vertex model when supported', () => {
  assert.equal(
    resolveSceneSheetExpansionModel('gemini-3.1-flash-lite-image'),
    'gemini-3.1-flash-lite-image',
  );
});

test('scene-sheet expansion safely falls back from a non-Vertex model', () => {
  assert.equal(resolveSceneSheetExpansionModel('fal-ai/flux-pro'), 'gemini-2.5-flash-image');
});

test('a partially expanded group stays partial until every panel is complete', () => {
  assert.equal(sceneSheetGroupStatus([
    { expandedUrl: '__session_file__/expanded/01.png', status: 'expanded', cropUrl: 'crop-1' },
    { status: 'ready-to-expand', cropUrl: 'crop-2' },
  ]), 'partial');
  assert.equal(sceneSheetGroupStatus([
    { expandedUrl: '__session_file__/expanded/01.png', status: 'expanded', cropUrl: 'crop-1' },
    { expandedUrl: '__session_file__/expanded/02.png', status: 'expanded', cropUrl: 'crop-2' },
  ]), 'expanded');
});

test('a replacement scene sheet invalidates older individual-image selections', () => {
  const snapshot = {
    selected_images: {
      '1_0': { url: '__session_file__/images/selected/scene_01.jpg', source: 'generated' },
      '2_0': { url: '__session_file__/images/scene-sheets/group-b/expanded/01.png', source: 'scene-sheet', sceneSheetGroupId: 'group-b' },
      '3_0': { url: '__session_file__/images/selected/scene_03.jpg', source: 'generated' },
    },
  };

  const invalidated = invalidatedSheetSelections(
    snapshot,
    ['1_0', '2_0'],
    'group-a',
    { includePriorSources: true },
  );

  assert.deepEqual(invalidated, ['1_0', '2_0']);
  assert.equal(snapshot.selected_images['1_0'], undefined);
  assert.equal(snapshot.selected_images['2_0'], undefined);
  assert.ok(snapshot.selected_images['3_0']);
});
