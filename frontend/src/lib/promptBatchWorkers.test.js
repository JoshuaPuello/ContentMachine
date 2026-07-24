import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROMPT_AUTHOR_BATCH_SIZE,
  PROMPT_AUTHOR_CONCURRENCY,
  PROMPT_AUTHOR_MODEL,
  PROMPT_AUTHOR_PROVIDER,
  runPromptBatchWorkers,
} from './promptBatchWorkers.js'

test('prompt authoring is pinned to three Claude CLI Sonnet workers', () => {
  assert.equal(PROMPT_AUTHOR_PROVIDER, 'claude-cli')
  assert.equal(PROMPT_AUTHOR_MODEL, 'sonnet')
  assert.equal(PROMPT_AUTHOR_CONCURRENCY, 3)
  assert.equal(PROMPT_AUTHOR_BATCH_SIZE, 10)
})

test('runs no more than three batches concurrently and preserves result order', async () => {
  let active = 0
  let maximumActive = 0
  const batches = [0, 1, 2, 3, 4, 5]
  const { results, workerCount } = await runPromptBatchWorkers({
    batches,
    processBatch: async (value) => {
      active++
      maximumActive = Math.max(maximumActive, active)
      await new Promise(resolve => setTimeout(resolve, (6 - value) * 2))
      active--
      return value * 10
    },
  })

  assert.equal(workerCount, 3)
  assert.equal(maximumActive, 3)
  assert.deepEqual(results.map(result => result.value), [0, 10, 20, 30, 40, 50])
})
