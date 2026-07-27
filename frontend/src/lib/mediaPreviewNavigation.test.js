import test from 'node:test'
import assert from 'node:assert/strict'
import {
  adjacentPreviewItems,
  buildImagePreviewItems,
  buildVideoPreviewItems,
} from './mediaPreviewNavigation.js'

test('image preview order follows scenes, shots, then variations and skips missing media', () => {
  const scenes = [
    { scene_number: 1, segment_index: 0, prompts: [{}, {}] },
    { scene_number: 1, segment_index: 1, prompts: [{}] },
    { scene_number: 2, segment_index: 0, prompts: [{}] },
  ]
  const items = buildImagePreviewItems(scenes, {
    '1_0_0': { url: 'one.jpg' },
    '1_1_0': { url: 'three.jpg' },
  }, {
    '1_0_1': [{ url: 'two-old.jpg' }],
  })
  assert.deepEqual(items.map(item => item.id), ['1_0_0', '1_0_1', '1_1_0'])
  assert.equal(adjacentPreviewItems(items, '1_0_1', item => item.id).previous.id, '1_0_0')
  assert.equal(adjacentPreviewItems(items, '1_0_1', item => item.id).next.id, '1_1_0')
})

test('video preview order includes completed current or historical outputs', () => {
  const prompts = [
    { scene_number: 2, segment_index: 0 },
    { scene_number: 2, segment_index: 1 },
    { scene_number: 3, segment_index: 0 },
  ]
  assert.deepEqual(buildVideoPreviewItems(prompts, {
    '2_0': { url: 'first.mp4' },
  }, {
    '2_1': [{ url: 'second-old.mp4' }],
  }), ['2_0', '2_1'])
})
