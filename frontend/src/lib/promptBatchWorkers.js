export const PROMPT_AUTHOR_PROVIDER = 'claude-cli'
export const PROMPT_AUTHOR_MODEL = 'sonnet'
export const PROMPT_AUTHOR_CONCURRENCY = 3
export const PROMPT_AUTHOR_BATCH_SIZE = 10

/**
 * Run independent prompt-authoring batches with a bounded worker pool.
 * Results retain input order even when Sonnet sessions finish out of order.
 */
export const runPromptBatchWorkers = async ({
  batches = [],
  concurrency = PROMPT_AUTHOR_CONCURRENCY,
  shouldStop = () => false,
  onStart = () => {},
  onSuccess = () => {},
  onError = () => {},
  processBatch,
}) => {
  const results = Array(batches.length)
  let cursor = 0
  let interrupted = false
  const workerCount = Math.min(
    batches.length,
    Math.max(1, Math.min(PROMPT_AUTHOR_CONCURRENCY, Number(concurrency) || 1))
  )

  const worker = async () => {
    while (true) {
      if (shouldStop()) {
        interrupted = true
        return
      }
      const batchIndex = cursor++
      if (batchIndex >= batches.length) return
      const batch = batches[batchIndex]
      onStart(batch, batchIndex)
      try {
        const value = await processBatch(batch, batchIndex)
        results[batchIndex] = { status: 'fulfilled', value }
        onSuccess(value, batch, batchIndex)
      } catch (error) {
        results[batchIndex] = { status: 'rejected', reason: error }
        onError(error, batch, batchIndex)
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker))
  return { results, interrupted, workerCount }
}
