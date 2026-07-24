import test from 'node:test'
import assert from 'node:assert/strict'
import { replanPendingImageVariations } from './imageVariationQueue.js'

const shot = (scene, prompts = ['a', 'b']) => ({
  scene_number: scene,
  segment_index: 0,
  prompts,
})

test('reduces only untouched pending shots and preserves generated variations', () => {
  const result = replanPendingImageVariations({
    scenes: [shot(1), shot(2), shot(3)],
    images: {
      '1_0_0': { url: '/one-a.jpg' },
      '1_0_1': { url: '/one-b.jpg' },
    },
    imageProgress: {
      total: 6,
      completed: ['1_0_0', '1_0_1'],
      pending: ['2_0_0', '2_0_1', '3_0_0', '3_0_1'],
    },
    requestedCount: 1,
  })

  assert.deepEqual(result.scenes[0].prompts, ['a', 'b'])
  assert.deepEqual(result.scenes[1].prompts, ['a'])
  assert.deepEqual(result.scenes[2].prompts, ['a'])
  assert.deepEqual(result.imageProgress.completed, ['1_0_0', '1_0_1'])
  assert.deepEqual(result.imageProgress.pending, ['2_0_0', '3_0_0'])
  assert.equal(result.imageProgress.total, 4)
})

test('preserves an in-flight shot and can restore prompts from the authored pool', () => {
  const lowered = replanPendingImageVariations({
    scenes: [shot(1), shot(2)],
    imagesLoading: { '1_0_0': true, '1_0_1': true },
    imageProgress: {
      total: 4,
      completed: [],
      pending: ['1_0_0', '1_0_1', '2_0_0', '2_0_1'],
    },
    requestedCount: 1,
  })

  assert.deepEqual(lowered.scenes[0].prompts, ['a', 'b'])
  assert.deepEqual(lowered.scenes[1].prompts, ['a'])
  assert.deepEqual(lowered.imageProgress.pending, ['1_0_0', '1_0_1', '2_0_0'])

  const restored = replanPendingImageVariations({
    scenes: lowered.scenes,
    imageProgress: lowered.imageProgress,
    requestedCount: 2,
  })

  assert.deepEqual(restored.scenes[1].prompts, ['a', 'b'])
  assert.deepEqual(restored.imageProgress.pending, ['1_0_0', '1_0_1', '2_0_0', '2_0_1'])
})
