import fs from 'fs/promises';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import sharp from 'sharp';
import { mediaBroker, isMediaBrokerConfigured } from './mediaBrokerClient.js';
import {
  createProjectR2DownloadUrl,
  createProjectR2UploadUrl,
  projectR2AssetUrl,
  readProjectR2Object,
  uploadToR2,
} from './r2.js';
import {
  readSessionSnapshot,
  sessionDirectory,
  validSessionId,
} from './sessionStore.js';

export const WINDOWS_IMAGE_PROVIDER = 'windows-image';
export const WINDOWS_IMAGE_MODEL = 'extra-high';
export const WINDOWS_IMAGE_MAX_CONCURRENCY = 5;
export const WINDOWS_IMAGE_MAX_REFERENCES = 2;
export const WINDOWS_IMAGE_OUTPUT_COUNTS = new Set([1, 2, 3]);

const TERMINAL = new Set(['complete', 'failed']);
const activeProjects = new Set();
const stateMutationChains = new Map();
const taskQueueChains = new Map();
let reconcileTimer = null;
let reconciling = false;

const stateFile = (sessionId) =>
  path.join(sessionDirectory(sessionId), 'windows-image-state.json');

const emptyState = () => ({
  version: 1,
  jobs: {},
  updatedAt: new Date().toISOString(),
});

const readState = async (sessionId) => {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(sessionId), 'utf8'));
    return parsed?.version === 1 && parsed.jobs ? parsed : emptyState();
  } catch (error) {
    if (error.code === 'ENOENT') return emptyState();
    throw error;
  }
};

const writeState = async (sessionId, state) => {
  await fs.mkdir(sessionDirectory(sessionId), { recursive: true });
  state.updatedAt = new Date().toISOString();
  const target = stateFile(sessionId);
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporary, target);
};

const withStateMutation = async (sessionId, operation) => {
  const previous = stateMutationChains.get(sessionId) || Promise.resolve();
  const current = previous.then(async () => {
    const state = await readState(sessionId);
    const result = await operation(state);
    await writeState(sessionId, state);
    return result;
  });
  const tail = current.catch(() => undefined);
  stateMutationChains.set(sessionId, tail);
  try {
    return await current;
  } finally {
    if (stateMutationChains.get(sessionId) === tail) {
      stateMutationChains.delete(sessionId);
    }
  }
};

const withTaskQueue = async (sessionId, itemId, operation) => {
  const key = `${sessionId}:${itemId}`;
  const previous = taskQueueChains.get(key) || Promise.resolve();
  const current = previous.then(operation);
  const tail = current.catch(() => undefined);
  taskQueueChains.set(key, tail);
  try {
    return await current;
  } finally {
    if (taskQueueChains.get(key) === tail) taskQueueChains.delete(key);
  }
};

const extensionFor = (contentType) =>
  contentType === 'image/webp'
    ? 'webp'
    : contentType === 'image/jpeg'
      ? 'jpg'
      : 'png';

const safeItemPart = (value) =>
  String(value || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const buildNeutralImageReference = async (aspectRatio = '16:9') => {
  const [widthPart, heightPart] = String(aspectRatio).split(':').map(Number);
  const width = 1600;
  const height = Math.round(width * (heightPart / widthPart || 9 / 16));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <rect width="100%" height="100%" fill="#15171b"/>
    <rect x="2" y="2" width="${width - 4}" height="${height - 4}" fill="none" stroke="#343942" stroke-width="4"/>
  </svg>`;
  return {
    referenceId: 'composition-frame',
    contentType: 'image/png',
    bytes: await sharp(Buffer.from(svg)).png().toBuffer(),
  };
};

export const buildOrderedReferenceBoard = async (references) => {
  const usable = references.filter((reference) => reference?.bytes?.length);
  if (usable.length === 0) return null;
  const cardWidth = 512;
  const cardHeight = 768;
  const cards = await Promise.all(usable.map(async (reference, index) => {
    const image = await sharp(reference.bytes)
      .rotate()
      .resize(cardWidth, cardHeight, { fit: 'cover', position: 'attention' })
      .png()
      .toBuffer();
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cardWidth}" height="${cardHeight}">
      <rect x="0" y="${cardHeight - 72}" width="${cardWidth}" height="72" fill="rgba(0,0,0,.72)"/>
      <text x="24" y="${cardHeight - 25}" font-family="Arial, sans-serif" font-size="30" fill="white">REFERENCE ${index + 1}: ${String(reference.name || reference.referenceId || '').replace(/[<>&]/g, '')}</text>
    </svg>`);
    return sharp(image).composite([{ input: label }]).png().toBuffer();
  }));
  return {
    referenceId: 'ordered-character-board',
    contentType: 'image/png',
    bytes: await sharp({
      create: {
        width: cardWidth * cards.length,
        height: cardHeight,
        channels: 4,
        background: '#111318',
      },
    })
      .composite(cards.map((input, index) => ({
        input,
        left: index * cardWidth,
        top: 0,
      })))
      .png()
      .toBuffer(),
    names: usable.map((reference) => reference.name || reference.referenceId),
  };
};

const uploadReference = async ({ sessionId, itemId, reference, ordinal }) => {
  const digest = sha256(reference.bytes);
  const extension = extensionFor(reference.contentType);
  const relativePath = [
    'windows-images',
    'inputs',
    safeItemPart(itemId),
    `${ordinal}-${digest}.${extension}`,
  ].join('/');
  await uploadToR2(reference.bytes, reference.contentType, {
    sessionId,
    relativePath,
  });
  const signed = await createProjectR2DownloadUrl(
    sessionId,
    relativePath,
    reference.contentType,
  );
  return {
    ordinal,
    referenceId: reference.referenceId || `reference-${ordinal}`,
    downloadUrl: signed.url,
    sha256: digest,
    objectKey: signed.key,
  };
};

const generationFingerprint = ({ prompt, references, outputCount, model, revision }) =>
  createHash('sha256').update(JSON.stringify({
    prompt,
    references: references.map((reference) => ({
      ordinal: reference.ordinal,
      sha256: reference.sha256,
      referenceId: reference.referenceId,
    })),
    outputCount,
    model,
    revision,
  })).digest('hex');

const queueWindowsImageTaskUnlocked = async ({
  sessionId,
  itemId,
  prompt,
  references,
  outputCount = 1,
  priority = 50,
  metadata = {},
  revision = 1,
}) => {
  if (!validSessionId(sessionId)) throw new Error('A valid sessionId is required');
  if (!/^[a-zA-Z0-9._-]{1,160}$/.test(String(itemId || ''))) {
    throw new Error('Windows image itemId must be a stable safe identifier');
  }
  if (!String(prompt || '').trim()) throw new Error('An image task prompt is required');
  if (String(prompt).trim().length > 50_000) {
    throw new Error('Windows image prompts cannot exceed 50,000 characters');
  }
  if (!WINDOWS_IMAGE_OUTPUT_COUNTS.has(Number(outputCount))) {
    throw new Error('Windows image output count must be 1, 2, or 3');
  }
  if (!Array.isArray(references) || references.length < 1 || references.length > 2) {
    throw new Error('Windows image tasks require one or two ordered references');
  }
  if (!isMediaBrokerConfigured()) throw new Error('Windows image broker is not configured');
  await readSessionSnapshot(sessionId);
  const staged = [];
  for (const [index, reference] of references.entries()) {
    staged.push(await uploadReference({
      sessionId,
      itemId,
      reference,
      ordinal: index + 1,
    }));
  }
  const fingerprint = generationFingerprint({
    prompt: String(prompt).trim(),
    references: staged,
    outputCount: Number(outputCount),
    model: WINDOWS_IMAGE_MODEL,
    revision,
  });
  const taskId = randomUUID();
  const uploadTargets = [];
  const outputAssets = [];
  for (let ordinal = 1; ordinal <= Number(outputCount); ordinal += 1) {
    const relativePath = [
      'windows-images',
      'outputs',
      safeItemPart(itemId),
      taskId,
      `variation-${String(ordinal).padStart(2, '0')}.png`,
    ].join('/');
    const target = await createProjectR2UploadUrl(
      sessionId,
      relativePath,
      'image/png',
    );
    uploadTargets.push({ ordinal, uploadUrl: target.url, method: 'PUT' });
    outputAssets.push({
      ordinal,
      relativePath,
      objectKey: target.key,
      publicUrl: target.publicUrl,
    });
  }
  const idempotencyKey = [
    'contentmachine',
    sessionId,
    safeItemPart(itemId),
    fingerprint,
  ].join(':');
  const job = {
    taskId,
    idempotencyKey,
    itemId,
    status: 'queueing',
    provider: WINDOWS_IMAGE_PROVIDER,
    model: WINDOWS_IMAGE_MODEL,
    generationFingerprint: fingerprint,
    promptSnapshot: String(prompt).trim(),
    referenceSnapshots: staged.map(({ downloadUrl, ...reference }) => reference),
    outputCount: Number(outputCount),
    outputAssets,
    outputs: [],
    metadata,
    revision,
    attempts: 0,
    queuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const stored = await withStateMutation(sessionId, async (state) => {
    const existing = state.jobs[itemId];
    if (
      existing?.generationFingerprint === fingerprint &&
      existing.status !== 'failed'
    ) {
      return { job: existing, reused: true };
    }
    state.jobs[itemId] = job;
    return { job, reused: false };
  });
  if (stored.reused) {
    activeProjects.add(sessionId);
    return stored.job;
  }
  try {
    const submitted = await mediaBroker.submitImageTask({
      protocolVersion: 1,
      taskId,
      idempotencyKey,
      caller: { name: 'contentmachine', requestId: randomUUID() },
      projectId: sessionId,
      batchId: `${sessionId}-images`,
      priority: Math.max(0, Math.min(100, Math.floor(Number(priority) || 50))),
      prompt: job.promptSnapshot,
      inputImages: staged.map(({ objectKey, ...reference }) => reference),
      outputCount: Number(outputCount),
      model: WINDOWS_IMAGE_MODEL,
      maxAttempts: 3,
      uploadTargets,
      metadata: {
        ...metadata,
        itemId: String(itemId),
        generationFingerprint: fingerprint,
      },
    });
    await withStateMutation(sessionId, async (state) => {
      const current = state.jobs[itemId];
      if (current?.taskId !== taskId) return;
      current.status = submitted.status;
      current.attempts = submitted.attempts || 0;
      current.updatedAt = new Date().toISOString();
      Object.assign(job, current);
    });
    activeProjects.add(sessionId);
    return job;
  } catch (error) {
    await withStateMutation(sessionId, async (state) => {
      const current = state.jobs[itemId];
      if (current?.taskId !== taskId) return;
      current.status = 'failed';
      current.error = {
        code: error.code || 'IMAGE_TASK_SUBMIT_FAILED',
        message: error.message,
        retryable: error.retryable !== false,
      };
      current.updatedAt = new Date().toISOString();
      Object.assign(job, current);
    });
    throw error;
  }
};

export const queueWindowsImageTask = (input) =>
  withTaskQueue(
    String(input?.sessionId || ''),
    String(input?.itemId || ''),
    () => queueWindowsImageTaskUnlocked(input),
  );

const applyBrokerState = async (sessionId, itemId, brokerTask) => {
  const state = await readState(sessionId);
  const job = state.jobs[itemId];
  if (!job || job.taskId !== brokerTask.taskId) return null;
  let completedUpdate = null;
  if (brokerTask.status === 'complete') {
    if (
      !Array.isArray(brokerTask.outputs) ||
      brokerTask.outputs.length !== job.outputCount
    ) {
      throw new Error('Windows image task completed with an invalid output count');
    }
    const verified = [];
    for (const output of brokerTask.outputs) {
      const asset = job.outputAssets.find(
        (candidate) => candidate.ordinal === output.ordinal,
      );
      if (!asset) throw new Error(`Missing output target for ordinal ${output.ordinal}`);
      const object = await readProjectR2Object(
        sessionId,
        asset.relativePath,
        'image/png',
      );
      const digest = sha256(object.bytes);
      if (
        object.sizeBytes !== output.bytes ||
        digest.toLowerCase() !== String(output.sha256).toLowerCase()
      ) {
        throw new Error(`Windows image output ${output.ordinal} failed checksum validation`);
      }
      const metadata = await sharp(object.bytes, { failOn: 'warning' }).metadata();
      if (metadata.width !== output.width || metadata.height !== output.height) {
        throw new Error(`Windows image output ${output.ordinal} dimensions do not match`);
      }
      verified.push({
        ...output,
        objectKey: asset.objectKey,
        url: projectR2AssetUrl(sessionId, asset.relativePath, 'image/png'),
        relativePath: asset.relativePath,
        etag: object.etag,
      });
    }
    const outputs = verified.sort((left, right) => left.ordinal - right.ordinal);
    completedUpdate = {
      outputs,
      selectedOrdinal: job.selectedOrdinal || outputs[0]?.ordinal || 1,
      completedAt: brokerTask.completedAt || new Date().toISOString(),
    };
  }
  return withStateMutation(sessionId, async (currentState) => {
    const current = currentState.jobs[itemId];
    if (!current || current.taskId !== brokerTask.taskId) return null;
    current.status = brokerTask.status;
    current.attempts = brokerTask.attempts || current.attempts || 0;
    current.progress = brokerTask.progress || null;
    current.error = brokerTask.error || null;
    current.updatedAt = new Date().toISOString();
    if (completedUpdate) Object.assign(current, completedUpdate);
    return structuredClone(current);
  });
};

export const reconcileWindowsImageJob = async (sessionId, itemId) => {
  const state = await readState(sessionId);
  const job = state.jobs[itemId];
  if (!job?.taskId || TERMINAL.has(job.status)) return job || null;
  try {
    const brokerTask = await mediaBroker.getImageTask(job.taskId);
    return await applyBrokerState(sessionId, itemId, brokerTask);
  } catch (error) {
    return withStateMutation(sessionId, async (currentState) => {
      const current = currentState.jobs[itemId];
      if (!current || current.taskId !== job.taskId) return current || null;
      current.brokerError = {
        code: error.code || 'BROKER_UNAVAILABLE',
        message: error.message,
      };
      current.updatedAt = new Date().toISOString();
      return structuredClone(current);
    });
  }
};

export const getWindowsImageJob = async (sessionId, itemId, { reconcile = true } = {}) => {
  if (reconcile) await reconcileWindowsImageJob(sessionId, itemId);
  const state = await readState(sessionId);
  return state.jobs[itemId] || null;
};

export const retryWindowsImageTask = async (sessionId, itemId, taskInput) => {
  const existing = await getWindowsImageJob(sessionId, itemId, { reconcile: true });
  if (existing && !TERMINAL.has(existing.status)) return existing;
  return queueWindowsImageTask({
    ...taskInput,
    sessionId,
    itemId,
    revision: Math.max(1, Number(existing?.revision || 0) + 1),
  });
};

const reconcileActiveProjects = async () => {
  if (reconciling) return;
  reconciling = true;
  try {
    for (const sessionId of [...activeProjects]) {
      const state = await readState(sessionId).catch(() => null);
      if (!state) {
        activeProjects.delete(sessionId);
        continue;
      }
      const active = Object.entries(state.jobs)
        .filter(([, job]) => !TERMINAL.has(job.status));
      await Promise.all(active.slice(0, WINDOWS_IMAGE_MAX_CONCURRENCY).map(
        ([itemId]) => reconcileWindowsImageJob(sessionId, itemId),
      ));
      const refreshed = await readState(sessionId);
      if (Object.values(refreshed.jobs).every((job) => TERMINAL.has(job.status))) {
        activeProjects.delete(sessionId);
      }
    }
  } finally {
    reconciling = false;
  }
};

export const startWindowsImageReconciler = () => {
  if (reconcileTimer || !isMediaBrokerConfigured()) return;
  reconcileTimer = setInterval(() => {
    void reconcileActiveProjects();
  }, Math.max(2_000, Number(process.env.MEDIA_BROKER_IMAGE_POLL_INTERVAL_MS) || 5_000));
  reconcileTimer.unref?.();
};

export const discoverWindowsImageProjects = async (outputRoot) => {
  const entries = await fs.readdir(outputRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !validSessionId(entry.name)) continue;
    const state = await readState(entry.name).catch(() => null);
    if (state && Object.values(state.jobs).some((job) => !TERMINAL.has(job.status))) {
      activeProjects.add(entry.name);
    }
  }
};
