import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  hasPopulatedProjectCore,
  hasStaleWriteToken,
  mergeDurableAssetReferences,
  restoreImageReferencesFromDisk,
  withSessionMutationLock,
  wouldErasePopulatedProject,
  wouldMixDifferentProjects,
} from './session.js'

test('rejects an empty browser shell replacing a populated project core', () => {
  const existing = { story: { title: 'The Driller' }, scenes: [{ scene_number: 1 }] }
  const incoming = { story: null, scene_plan: null, scenes: [], tts_script: null, video_prompts: [] }
  assert.equal(hasPopulatedProjectCore(existing), true)
  assert.equal(hasPopulatedProjectCore(incoming), false)
  assert.equal(wouldErasePopulatedProject(incoming, existing), true)
})

test('allows empty first saves and populated updates', () => {
  const empty = { story: null, scenes: [] }
  const populated = { tts_script: 'Narration' }
  assert.equal(wouldErasePopulatedProject(empty, null), false)
  assert.equal(wouldErasePopulatedProject(populated, { story: { title: 'Old' } }), false)
})

test('rejects a different story carrying inherited generated assets', () => {
  const existing = { story: { title: 'The Driller' }, images: { old: { url: 'old.jpg' } } }
  const contaminated = { story: { title: 'The Factory' }, images: { old: { url: 'old.jpg' } } }
  const cleanReplacement = { story: { title: 'The Factory' }, images: {}, video_jobs: {}, timeline: null }
  assert.equal(wouldMixDifferentProjects(contaminated, existing), true)
  assert.equal(wouldMixDifferentProjects(cleanReplacement, existing), false)
})

test('rejects stale revisions while allowing first and current revisions', () => {
  assert.equal(hasStaleWriteToken(undefined, null), false)
  assert.equal(hasStaleWriteToken('revision-1', 'revision-1'), false)
  assert.equal(hasStaleWriteToken(undefined, 'revision-1'), true)
  assert.equal(hasStaleWriteToken('revision-0', 'revision-1'), true)
})

test('serializes mutations for the same session in arrival order', async () => {
  const order = []
  const sessionId = `lock-test-${Date.now()}-${Math.random()}`
  const first = withSessionMutationLock(sessionId, async () => {
    order.push('first:start')
    await new Promise(resolve => setTimeout(resolve, 15))
    order.push('first:end')
  })
  const second = withSessionMutationLock(sessionId, async () => {
    order.push('second:start')
    order.push('second:end')
  })
  await Promise.all([first, second])
  assert.deepEqual(order, ['first:start', 'first:end', 'second:start', 'second:end'])
})

test('durable image URLs survive a stripped frontend autosave', () => {
  const incoming = { images: {}, selected_images: { '1_0': { prompt: 'kept prompt', url: null } } }
  const durable = {
    images: { '1_0_0': { prompt: 'variant', url: '__session_file__/images/all/scene_01_v1.jpg' } },
    selected_images: { '1_0': { prompt: 'old prompt', url: '__session_file__/images/selected/scene_01.jpg' } },
  }
  mergeDurableAssetReferences(incoming, durable)
  assert.equal(incoming.images['1_0_0'].url, durable.images['1_0_0'].url)
  assert.equal(incoming.selected_images['1_0'].url, durable.selected_images['1_0'].url)
  assert.equal(incoming.selected_images['1_0'].prompt, 'kept prompt')
})

test('missing image references reconstruct from intact session files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cm-session-test-'))
  try {
    await fs.mkdir(path.join(dir, 'images', 'all'), { recursive: true })
    await fs.mkdir(path.join(dir, 'images', 'selected'), { recursive: true })
    await fs.writeFile(path.join(dir, 'images', 'all', 'scene_03_shot2_v2.jpg'), 'image')
    await fs.writeFile(path.join(dir, 'images', 'selected', 'scene_03_shot2.jpg'), 'image')
    const snapshot = { images: {}, selected_images: { '3_1': { prompt: 'prompt' } } }
    assert.equal(await restoreImageReferencesFromDisk(snapshot, dir), true)
    assert.equal(snapshot.images['3_1_1'].url, '__session_file__/images/all/scene_03_shot2_v2.jpg')
    assert.equal(snapshot.selected_images['3_1'].url, '__session_file__/images/selected/scene_03_shot2.jpg')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
