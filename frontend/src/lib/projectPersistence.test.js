import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compactPipelineState,
  createQuotaResilientStorage,
} from './projectPersistence.js'

test('browser checkpoint excludes canonical project payloads', () => {
  const state = {
    settings: { videoProvider: 'windows-worker' },
    activeSessionId: 'session_1',
    sessionWriteToken: 'revision',
    projectName: 'Project',
    topic: 'topic',
    maxMinutes: 10,
    storyInputMode: 'context',
    storyTitle: 'Title',
    storyContext: 'Context',
    suppliedVoiceover: 'Voiceover',
    customPrompts: { story: 'custom' },
    includeThumbnail: true,
    includeMetadata: true,
    scenes: [{ prompt: 'x'.repeat(2_000_000) }],
    videoPrompts: [{ full_prompt_string: 'x'.repeat(2_000_000) }],
    selectedImages: { '1_0': { prompt: 'x'.repeat(2_000_000) } },
    timeline: { items: [{ payload: 'x'.repeat(2_000_000) }] },
    audio: { sceneAudio: { 1: { text: 'x'.repeat(2_000_000) } } },
  }
  const checkpoint = compactPipelineState(state)
  assert.equal(checkpoint.activeSessionId, 'session_1')
  assert.equal('scenes' in checkpoint, false)
  assert.equal('videoPrompts' in checkpoint, false)
  assert.equal('selectedImages' in checkpoint, false)
  assert.equal('timeline' in checkpoint, false)
  assert.equal('audio' in checkpoint, false)
  assert.ok(JSON.stringify(checkpoint).length < 10_000)
})

test('quota recovery removes only the pipeline key and retries once', () => {
  const calls = []
  let first = true
  const storage = createQuotaResilientStorage({
    getItem: () => null,
    removeItem: (name) => calls.push(['remove', name]),
    setItem: (name, value) => {
      calls.push(['set', name, value])
      if (first) {
        first = false
        throw new DOMException('full', 'QuotaExceededError')
      }
    },
  })
  storage.setItem('content-pipeline-state-v6', 'compact')
  assert.deepEqual(calls, [
    ['set', 'content-pipeline-state-v6', 'compact'],
    ['remove', 'content-pipeline-state-v6'],
    ['set', 'content-pipeline-state-v6', 'compact'],
  ])
})
