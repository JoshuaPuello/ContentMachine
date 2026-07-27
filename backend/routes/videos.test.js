import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applySubmissionLedgerEntry,
  buildFalInput,
  buildReplicateInput,
  requireHttpsImageUrl,
  selectedImageReferenceFromProject,
  validateVideoSubmission,
} from './videos.js'

const protectedPrompt = `SOURCE FRAME LOCK:
The supplied selected image is immutable frame zero.

CHARACTER / STYLE LOCK:
Preserve the featureless porcelain mannequin.

WARDROBE LOCK:
Preserve every visible garment.

OBJECT LOCK:
Only visible objects may move.

SCENE INTENT:
The subject turns the wrench.

STORYBOARD / SHOT LIST — 00:00–00:02:
SHOT 1 — 00:00–00:02
The source-frame subject settles naturally while the camera remains restrained.

ENDING STATE:
The subject reaches a stable hold.

STABILITY / NEGATIVE CONSTRAINTS:
One continuous unbroken take.`

const validScene = {
  scene_number: '1_0',
  video_prompt: protectedPrompt,
  negative_prompt: 'human skin, realistic human faces, duplicate subjects',
  motion_prompt_version: 'seedance-2-0-v1',
  source_frame_locked: true,
  image_url: 'https://cdn.example.com/selected-frame.jpg',
}

test('accepts a complete protected Seedance video submission', () => {
  assert.deepEqual(validateVideoSubmission(validScene), [])
})

test('rejects legacy, unlocked, imageless, and empty-storyboard submissions', () => {
  const unsafePrompt = protectedPrompt.replace(
    'The source-frame subject settles naturally while the camera remains restrained.',
    ''
  )
  const issues = validateVideoSubmission({
    ...validScene,
    video_prompt: unsafePrompt,
    motion_prompt_version: 'legacy-v0',
    source_frame_locked: false,
    image_url: '',
  }).join(' ')
  assert.match(issues, /motion_prompt_version/i)
  assert.match(issues, /source_frame_locked/i)
  assert.match(issues, /selected source image/i)
  assert.match(issues, /nonempty SHOT 1/i)
})

test('rejects prompts with a removed protected section', () => {
  const issues = validateVideoSubmission({
    ...validScene,
    video_prompt: protectedPrompt.replace('OBJECT LOCK:', 'OBJECTS:'),
  }).join(' ')
  assert.match(issues, /missing protected section OBJECT LOCK:/i)
})

test('rejects facialization and invented entities in an edited creative section', () => {
  for (const unsafe of [
    'The mannequin smiles and its lips move.',
    'A second worker enters the frame.',
    'The porcelain subject becomes a realistic human.',
  ]) {
    const issues = validateVideoSubmission({
      ...validScene,
      video_prompt: protectedPrompt.replace('The subject turns the wrench.', unsafe),
    }).join(' ')
    assert.match(issues, /unsafe identity\/entity drift/i, `Expected rejection for: ${unsafe}`)
  }
})

test('does not treat narration or prior-frame context as a new motion instruction', () => {
  const contextualPrompt = protectedPrompt
    .replace(
      'The subject turns the wrench.',
      'The subject turns the wrench.\nNarration covered by this clip: Earlier, she smiled for the camera.\nPrevious selected-frame reference: a faint smile suggested by the pose.'
    )
  assert.deepEqual(validateVideoSubmission({
    ...validScene,
    video_prompt: contextualPrompt,
  }), [])
})

test('restores a durable selected image reference from the project session', () => {
  const project = {
    selected_images: {
      '34_0': {
        promptIndex: 0,
        url: '__session_file__/images/selected/scene_34.jpg',
      },
    },
  }
  assert.equal(
    selectedImageReferenceFromProject(project, '34_0', 'session_safe'),
    '/api/session/session_safe/files/images/selected/scene_34.jpg'
  )
})

test('terminal GeminiGen failures invalidate only their matching durable job', () => {
  const entries = new Map()
  applySubmissionLedgerEntry(entries, {
    fingerprint: 'same-request',
    jobId: 'old-failed-job',
    status: 'submitted',
  })
  assert.equal(entries.get('same-request').jobId, 'old-failed-job')

  applySubmissionLedgerEntry(entries, {
    fingerprint: 'same-request',
    jobId: 'old-failed-job',
    status: 'failed',
    invalidated: true,
  })
  assert.equal(entries.has('same-request'), false)

  applySubmissionLedgerEntry(entries, {
    fingerprint: 'same-request',
    jobId: 'fresh-job',
    status: 'submitted',
  })
  applySubmissionLedgerEntry(entries, {
    fingerprint: 'same-request',
    jobId: 'old-failed-job',
    status: 'failed',
    invalidated: true,
  })
  assert.equal(entries.get('same-request').jobId, 'fresh-job')
})

test('requires a provider-accessible HTTPS selected image URL', () => {
  assert.equal(
    requireHttpsImageUrl('https://cdn.example.com/frame.jpg'),
    'https://cdn.example.com/frame.jpg'
  )
  for (const inaccessible of [
    'http://localhost/frame.jpg',
    'blob:http://localhost/frame-id',
    '/api/session/id/files/frame.jpg',
    '__session_file__/images/selected/frame.jpg',
  ]) {
    assert.throws(() => requireHttpsImageUrl(inaccessible), /absolute HTTPS URL/i)
  }
  for (const privateUrl of [
    'https://localhost/frame.jpg',
    'https://127.0.0.1/frame.jpg',
    'https://192.168.1.8/frame.jpg',
    'https://contentmachine.local/frame.jpg',
  ]) {
    assert.throws(() => requireHttpsImageUrl(privateUrl), /publicly reachable/i)
  }
})

test('carries protected negative constraints into FAL and Replicate inputs', () => {
  const falInput = buildFalInput('lightricks/ltx-2-pro', validScene, 6, '1080p', '16:9')
  const replicateInput = buildReplicateInput('lightricks/ltx-2-pro', validScene, 6, '1080p', '16:9')
  assert.equal(falInput.negative_prompt, validScene.negative_prompt)
  assert.equal(replicateInput.negative_prompt, validScene.negative_prompt)
  assert.equal(falInput.image_url, validScene.image_url)
  assert.equal(replicateInput.image, validScene.image_url)
})
