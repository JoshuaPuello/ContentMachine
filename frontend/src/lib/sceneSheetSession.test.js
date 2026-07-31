import assert from 'node:assert/strict'
import test from 'node:test'
import { runSceneSheetMutationWithTokenRecovery } from './sceneSheetSession.js'

test('scene-sheet mutation retries once with the canonical token after an autosave race', async () => {
  const tokens = []
  const result = await runSceneSheetMutationWithTokenRecovery({
    getToken: () => 'stale-token',
    refresh: async () => ({ writeToken: 'canonical-token' }),
    operation: async token => {
      tokens.push(token)
      if (token === 'stale-token') {
        const error = new Error('stale')
        error.response = { data: { code: 'STALE_SESSION' } }
        throw error
      }
      return { ok: true }
    },
  })
  assert.deepEqual(tokens, ['stale-token', 'canonical-token'])
  assert.deepEqual(result, { ok: true })
})

test('scene-sheet mutation never retries unrelated failures', async () => {
  let refreshes = 0
  let attempts = 0
  await assert.rejects(
    runSceneSheetMutationWithTokenRecovery({
      getToken: () => 'token',
      refresh: async () => { refreshes += 1 },
      operation: async () => {
        attempts += 1
        throw new Error('provider failed')
      },
    }),
    /provider failed/,
  )
  assert.equal(attempts, 1)
  assert.equal(refreshes, 0)
})
