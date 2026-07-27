import test from 'node:test'
import assert from 'node:assert/strict'
import {
  areAllSelectableImageUnitsSelected,
  buildBulkImageSelection,
  selectableImageUnitCount,
} from './imageSelection.js'

const scenes = [
  { scene_number: 1, segment_index: 0, prompts: ['one-a', 'one-b'] },
  { scene_number: 1, segment_index: 1, prompts: ['two-a', 'two-b'] },
  { scene_number: 2, segment_index: 0, prompts: ['three-a'] },
]

test('selects the first completed image for every available shot', () => {
  const images = {
    '1_0_0': { error: 'failed' },
    '1_0_1': { url: 'one-b.png', prompt: 'one-b' },
    '1_1_0': { url: 'two-a.png', prompt: 'two-a' },
  }

  assert.deepEqual(buildBulkImageSelection(scenes, images), {
    '1_0': { url: 'one-b.png', prompt: 'one-b', promptIndex: 1 },
    '1_1': { url: 'two-a.png', prompt: 'two-a', promptIndex: 0 },
  })
  assert.equal(selectableImageUnitCount(scenes, images), 2)
})

test('preserves an existing manual choice while filling missing shots', () => {
  const images = {
    '1_0_0': { url: 'one-a.png', prompt: 'one-a' },
    '1_0_1': { url: 'one-b.png', prompt: 'one-b' },
    '1_1_0': { url: 'two-a.png', prompt: 'two-a' },
  }
  const current = {
    '1_0': { url: 'one-b.png', prompt: 'one-b', promptIndex: 1 },
  }

  assert.deepEqual(buildBulkImageSelection(scenes, images, current), {
    '1_0': current['1_0'],
    '1_1': { url: 'two-a.png', prompt: 'two-a', promptIndex: 0 },
  })
})

test('the toggle only reports selected when every available shot is selected', () => {
  const images = {
    '1_0_0': { url: 'one-a.png' },
    '1_1_0': { url: 'two-a.png' },
  }

  assert.equal(areAllSelectableImageUnitsSelected(scenes, images, {
    '2_0': { url: 'stale.png' },
  }), false)
  assert.equal(areAllSelectableImageUnitsSelected(scenes, images, {
    '1_0': { url: 'one-a.png' },
    '1_1': { url: 'two-a.png' },
  }), true)
})
