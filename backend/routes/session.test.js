import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  hasPopulatedProjectCore,
  hasStaleWriteToken,
  mergeDurableAssetReferences,
  resetProjectToImages,
  restoreImageReferencesFromDisk,
  withSessionMutationLock,
  wouldErasePopulatedProject,
  wouldMixDifferentProjects,
  wouldRestoreResetDownstream,
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

test('a stale browser autosave cannot remove a server-owned video regeneration revision', () => {
  const incoming = {
    video_prompts: [{ scene_number: 4, segment_index: 1, full_prompt_string: 'Older prompt' }],
  }
  const durable = {
    video_prompts: [{
      scene_number: 4,
      segment_index: 1,
      full_prompt_string: 'Edited server prompt',
      generation_revision: 3,
    }],
  }
  mergeDurableAssetReferences(incoming, durable)
  assert.equal(incoming.video_prompts[0].generation_revision, 3)
  assert.equal(incoming.video_prompts[0].full_prompt_string, 'Edited server prompt')
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

test('reset to Images preserves canonical story, audio, cast, images, and scene-sheet workflow', () => {
  const preserved = {
    story: { title: 'The Thief' },
    scene_plan: { scenes: [{ scene_number: 1 }] },
    scenes: [{ scene_number: 1, prompts: ['frame'] }],
    scene_segments: { 1: [{ segmentIndex: 0 }] },
    tts_script: 'Narration',
    audio: {
      fullAudio: { url: 'audio.mp3' },
      sceneAudio: { s01: { durationSeconds: 8 } },
      sfxAudio: { door: { url: '__session_file__/sfx/door.mp3' } },
    },
    characters: [{ id: 'leonardo', image: 'portrait.jpg' }],
    character_scene_links: { 1: ['leonardo'] },
    images: { '1_0_0': { url: 'frame.jpg' } },
    image_history: { '1_0_0': [{ url: 'older.jpg' }] },
    selected_images: { '1_0': { url: 'frame.jpg' } },
    image_progress: { total: 1, completed: ['1_0'], pending: [] },
    scene_sheet_workflow: { enabled: true, groups: [{ id: 'vault' }] },
    settings: { scene_sheet_enabled: true },
  }
  const project = {
    version: 1,
    ...preserved,
    video_prompts: [{ scene_number: 1, segment_index: 0 }],
    video_jobs: { '1_0': { status: 'completed', url: 'clip.mp4' } },
    video_history: { '1_0': [{ url: 'older.mp4' }] },
    selected_videos: { '1_0': { url: 'clip.mp4' } },
    videoGenerationControl: { paused: true },
    video_progress: { total: 1, completed: ['1_0'], pending: [] },
    timeline: { built: true, items: [{ id: 'clip-1' }] },
    metadata: { selected_title: 'Title' },
    all_thumbnails: [{ url: 'thumb.jpg' }],
    thumbnail_history: { 0: [{ url: 'old-thumb.jpg' }] },
    thumbnail: { selected_url: 'thumb.jpg' },
    render_job: { status: 'completed' },
    render_history: [{ url: 'final.mp4' }],
    _session: { id: 'session_safe', write_token: 'old-token' },
  }

  const reset = resetProjectToImages(project, {
    resetAt: '2026-07-28T12:00:00.000Z',
    resetRevision: 'reset-revision',
    writeToken: 'new-token',
  })

  for (const [key, value] of Object.entries(preserved)) assert.deepEqual(reset[key], value)
  assert.deepEqual(reset.video_prompts, [])
  assert.deepEqual(reset.video_jobs, {})
  assert.deepEqual(reset.video_history, {})
  assert.deepEqual(reset.selected_videos, {})
  assert.equal(reset.timeline, null)
  assert.equal(reset.metadata, null)
  assert.deepEqual(reset.all_thumbnails, [])
  assert.deepEqual(reset.thumbnail_history, {})
  assert.equal(reset.thumbnail, null)
  assert.equal('videoGenerationControl' in reset, false)
  assert.equal('video_progress' in reset, false)
  assert.equal('render_job' in reset, false)
  assert.equal('render_history' in reset, false)
  assert.equal(reset.downstream_reset_revision, 'reset-revision')
  assert.equal(reset.session_write_token, 'new-token')
  assert.equal(reset._session.write_token, 'new-token')
  assert.equal(reset._session.downstream_reset_revision, 'reset-revision')
  assert.equal(reset._session.downstream_reset_pending, undefined)
  assert.equal(project.video_jobs['1_0'].url, 'clip.mp4', 'input project is not mutated')
})

test('reset revision rejects stale downstream resurrection but permits acknowledged or image-only saves', () => {
  const existing = {
    _session: { downstream_reset_revision: 'reset-2' },
    video_prompts: [],
    video_jobs: {},
  }
  assert.equal(wouldRestoreResetDownstream({
    video_jobs: { '1_0': { url: 'stale.mp4' } },
  }, existing), true)
  assert.equal(wouldRestoreResetDownstream({
    downstream_reset_revision: 'reset-2',
    video_jobs: { '1_0': { url: 'new.mp4' } },
  }, existing), false)
  assert.equal(wouldRestoreResetDownstream({
    images: { '1_0_0': { url: 'frame.jpg' } },
    selected_images: { '1_0': { url: 'frame.jpg' } },
  }, existing), false)
})
