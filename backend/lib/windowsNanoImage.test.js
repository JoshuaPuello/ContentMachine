import assert from 'node:assert/strict'
import fs from 'fs/promises'
import test from 'node:test'
import sharp from 'sharp'
import { mediaBroker } from './mediaBrokerClient.js'
import {
  beginWindowsNanoImageRun,
  getWindowsNanoImageJob,
  normalizeNanoReference,
  queueWindowsNanoImageTask,
  WINDOWS_NANO_REFERENCE_MAX_BYTES,
} from './windowsNanoImage.js'
import { sessionDirectory, writeSessionSnapshot } from './sessionStore.js'

const originalBroker = {
  createInputSession: mediaBroker.createInputSession,
  uploadInput: mediaBroker.uploadInput,
  enqueue: mediaBroker.enqueue,
  getTask: mediaBroker.getTask,
  markApplied: mediaBroker.markApplied,
  submitImageTask: mediaBroker.submitImageTask,
}

const withBroker = async (operation) => {
  const previous = {
    url: process.env.MEDIA_BROKER_URL,
    producer: process.env.MEDIA_BROKER_PRODUCER_ID,
    token: process.env.MEDIA_BROKER_PRODUCER_TOKEN,
  }
  process.env.MEDIA_BROKER_URL = 'https://broker.example'
  process.env.MEDIA_BROKER_PRODUCER_ID = 'content-machine'
  process.env.MEDIA_BROKER_PRODUCER_TOKEN = 'test-only-token'
  try {
    return await operation()
  } finally {
    Object.assign(mediaBroker, originalBroker)
    if (previous.url === undefined) delete process.env.MEDIA_BROKER_URL
    else process.env.MEDIA_BROKER_URL = previous.url
    if (previous.producer === undefined) delete process.env.MEDIA_BROKER_PRODUCER_ID
    else process.env.MEDIA_BROKER_PRODUCER_ID = previous.producer
    if (previous.token === undefined) delete process.env.MEDIA_BROKER_PRODUCER_TOKEN
    else process.env.MEDIA_BROKER_PRODUCER_TOKEN = previous.token
  }
}

const taskView = (request, index = 1) => ({
  protocolVersion: 1,
  kind: request.kind,
  id: `task-${request.owner.itemId}-${index}`,
  groupId: request.groupId,
  owner: request.owner,
  generationFingerprint: `fingerprint-${request.owner.itemId}-${index}`,
  revision: index,
  status: 'queued',
  attempt: 0,
  maxAttempts: request.maxAttempts,
  input: {
    prompt: request.prompt,
    referenceImage: request.referenceImage,
    settings: request.settings,
  },
  priority: request.priority,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
})

test('Nano references are normalized to one JPEG below the 1 MiB limit', async () => {
  const noisy = await sharp({
    create: {
      width: 2600,
      height: 1800,
      channels: 3,
      background: '#7d674f',
    },
  }).png().toBuffer()
  const normalized = await normalizeNanoReference({ bytes: noisy })
  assert.equal(normalized.contentType, 'image/jpeg')
  assert.ok(normalized.bytes.length <= WINDOWS_NANO_REFERENCE_MAX_BYTES)
  assert.match(normalized.sha256, /^[a-f0-9]{64}$/)
})

test('prompt-only and referenced Nano jobs use the Veo producer abstraction', async () => {
  await withBroker(async () => {
    const sessionId = `session_nano_contract_${Date.now()}`
    await writeSessionSnapshot(sessionId, { settings: {} })
    const requests = []
    let inputSessionCount = 0
    mediaBroker.createInputSession = async (input) => {
      inputSessionCount += 1
      return {
        objectKey: `media-jobs/v1/producer-inputs/content-machine/${sessionId}/${input.itemId}/reference.jpg`,
        alreadyExists: true,
      }
    }
    mediaBroker.uploadInput = async () => {
      throw new Error('alreadyExists inputs must not upload again')
    }
    mediaBroker.submitImageTask = async () => {
      throw new Error('Nano must not use the Extra High image-task queue')
    }
    mediaBroker.enqueue = async (request) => {
      requests.push(request)
      return taskView(request, requests.length)
    }
    try {
      await queueWindowsNanoImageTask({
        sessionId,
        itemId: 'prompt-only',
        prompt: 'A prompt-only documentary frame',
        aspectRatio: '16:9',
        resolution: '1K',
      })
      const referenceBytes = await sharp({
        create: {
          width: 640,
          height: 960,
          channels: 3,
          background: '#345678',
        },
      }).png().toBuffer()
      await queueWindowsNanoImageTask({
        sessionId,
        itemId: 'with-reference',
        prompt: 'Preserve the reference identity',
        reference: { bytes: referenceBytes, contentType: 'image/png' },
        aspectRatio: '9:16',
        resolution: '2K',
      })
      assert.equal(requests.length, 2)
      assert.equal(inputSessionCount, 1)
      assert.equal(requests[0].kind, 'media.text-to-image')
      assert.equal(requests[0].referenceImage, null)
      assert.equal(requests[1].referenceImage.contentType, 'image/jpeg')
      assert.deepEqual(requests[1].settings, {
        provider: 'nano-banana',
        promptModel: 'Nano Banana 2',
        aspectRatio: '9:16',
        resolution: '2K',
        adapter: 'windows-nano-banana',
      })
    } finally {
      await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
    }
  })
})

test('ContentMachine can enqueue 80 independent Nano tasks without using Extra High', async () => {
  await withBroker(async () => {
    const sessionId = `session_nano_eighty_${Date.now()}`
    await writeSessionSnapshot(sessionId, { settings: {} })
    const requests = []
    mediaBroker.submitImageTask = async () => {
      throw new Error('Nano must not use the Extra High image-task queue')
    }
    mediaBroker.enqueue = async (request) => {
      requests.push(request)
      return taskView(request, requests.length)
    }
    try {
      const runIds = await Promise.all(
        Array.from({ length: 12 }, () =>
          beginWindowsNanoImageRun(sessionId, { reuseActive: true })),
      )
      assert.equal(new Set(runIds).size, 1)
      const runId = runIds[0]
      const jobs = await Promise.all(
        Array.from({ length: 80 }, (_, index) => queueWindowsNanoImageTask({
          sessionId,
          itemId: `image-${index + 1}`,
          prompt: `Documentary image ${index + 1}`,
          aspectRatio: '16:9',
          resolution: '1K',
          runId,
        })),
      )
      assert.equal(jobs.length, 80)
      assert.equal(requests.length, 80)
      assert.equal(new Set(requests.map((request) => request.owner.itemId)).size, 80)
      assert.ok(requests.every((request) => request.kind === 'media.text-to-image'))
      assert.ok(requests.every((request) => request.maxAttempts === 4))
    } finally {
      await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
    }
  })
})

test('a completed Nano result durably retries its applied receipt', async () => {
  await withBroker(async () => {
    const sessionId = `session_nano_applied_${Date.now()}`
    await writeSessionSnapshot(sessionId, { settings: {} })
    let brokerTask
    let receiptAttempts = 0
    mediaBroker.enqueue = async (request) => {
      brokerTask = taskView(request)
      return brokerTask
    }
    mediaBroker.getTask = async () => brokerTask
    mediaBroker.markApplied = async () => {
      receiptAttempts += 1
      if (receiptAttempts === 1) throw new Error('temporary receipt failure')
    }
    try {
      const queued = await queueWindowsNanoImageTask({
        sessionId,
        itemId: 'receipt-retry',
        prompt: 'A durable completion receipt',
      })
      brokerTask = {
        ...brokerTask,
        status: 'completed',
        updatedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        result: {
          publicUrl: 'https://cdn.example/result.png',
          objectKey: 'results/result.png',
          sha256: 'a'.repeat(64),
          sizeBytes: 123,
          width: 1024,
          height: 1024,
          format: 'png',
          mimeType: 'image/png',
        },
      }
      const pending = await getWindowsNanoImageJob(sessionId, queued.itemId)
      assert.equal(pending.appliedPending, true)
      assert.equal(pending.url, 'https://cdn.example/result.png')
      const applied = await getWindowsNanoImageJob(sessionId, queued.itemId)
      assert.equal(applied.appliedPending, false)
      assert.equal(receiptAttempts, 2)
    } finally {
      await fs.rm(sessionDirectory(sessionId), { recursive: true, force: true })
    }
  })
})
