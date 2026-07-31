import express from 'express';
import { fal } from '@fal-ai/client';
import Replicate from 'replicate';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { isR2Configured, ensureProjectAssetInR2 } from '../lib/r2.js';
const router = express.Router();
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.resolve(MODULE_DIR, '..', '..', 'output');

const PRO_DURATIONS         = [6, 8, 10];
const KLING_TURBO_DURATIONS = [5, 10];
const GROK_DURATIONS        = [6, 10, 15];
const MOTION_PROMPT_VERSION = 'seedance-2-0-v1';
const MOTION_PROMPT_MAX_CHARS = 5000;
export const MAX_CONCURRENT_VIDEO_REQUESTS = 10;
const REQUIRED_PROTECTED_SECTIONS = [
  'SOURCE FRAME LOCK:',
  'CHARACTER / STYLE LOCK:',
  'WARDROBE LOCK:',
  'OBJECT LOCK:',
  'ENDING STATE:',
  'STABILITY / NEGATIVE CONSTRAINTS:',
];

export const validateVideoSubmission = (scene) => {
  const issues = [];
  const prompt = typeof scene?.video_prompt === 'string' ? scene.video_prompt.trim() : '';
  if (scene?.motion_prompt_version !== MOTION_PROMPT_VERSION) {
    issues.push(`motion_prompt_version must be ${MOTION_PROMPT_VERSION}`);
  }
  if (scene?.source_frame_locked !== true) issues.push('source_frame_locked must be true');
  if (!scene?.image_url || typeof scene.image_url !== 'string') issues.push('selected source image is required');
  if (!prompt) issues.push('video_prompt is required');
  if (prompt.length > MOTION_PROMPT_MAX_CHARS) {
    issues.push(`video_prompt exceeds the ${MOTION_PROMPT_MAX_CHARS}-character provider limit`);
  }
  for (const section of REQUIRED_PROTECTED_SECTIONS) {
    if (!prompt.includes(section)) issues.push(`video_prompt is missing protected section ${section}`);
  }
  if (prompt && !/immutable frame zero/i.test(prompt)) {
    issues.push('video_prompt is missing immutable frame-zero authority');
  }
  const providerDuration = Number(scene?.duration_seconds);
  const editorialDuration = [
    scene?.action_duration_seconds,
    scene?.usable_duration_seconds,
    scene?.editorial_duration_seconds,
    scene?.target_duration,
  ].map(Number).find(value => Number.isFinite(value) && value > 0);
  if (
    Number.isFinite(providerDuration)
    && providerDuration > 0
    && Number.isFinite(editorialDuration)
    && editorialDuration < providerDuration
  ) {
    if (!prompt.includes('EDITORIAL TIMING:')) {
      issues.push('video_prompt is missing protected EDITORIAL TIMING for its shorter usable action window');
    }
    if (!/\[CLEAN HOLD\]/i.test(prompt)) {
      issues.push('video_prompt is missing a CLEAN HOLD after its editorial trim boundary');
    }
    if (!/no new story action/i.test(prompt)) {
      issues.push('video_prompt clean tail must forbid new story action after its editorial trim boundary');
    }
  }
  const storyboard = prompt.match(/STORYBOARD \/ SHOT LIST[^\n]*:\s*\n([\s\S]*?)(?=\nENDING STATE:|$)/i)?.[1] || '';
  const firstShot = storyboard.match(/SHOT\s+1\s+[—-][^\n]*\n([\s\S]*?)(?=\nSHOT\s+\d+\s+[—-]|$)/i)?.[1]?.trim() || '';
  if (!firstShot) issues.push('video_prompt must contain a nonempty SHOT 1 storyboard beat');
  // Validate directions that can actually change the generated frame. Narration
  // and prior-frame references are documentary context, not motion commands.
  // Treating those lines as creative directions caused valid clips to be
  // rejected when (for example) a prior still-image prompt mentioned a smile.
  const sceneIntent = prompt.match(/SCENE INTENT:\s*([^\n]*)/i)?.[1] || '';
  const endingState = prompt.match(/ENDING STATE:\s*\n?([\s\S]*?)(?=\nCONTINUITY HANDOFF:|\nSTABILITY \/ NEGATIVE CONSTRAINTS:|$)/i)?.[1] || '';
  const creativeMotion = [sceneIntent, storyboard, endingState].filter(Boolean).join('\n');
  const unsafeCreative = creativeMotion.match(/\b(?:becomes?|turns? into|morphs? into)\s+(?:a\s+)?(?:realistic\s+)?human\b|\beyes?\s+(?:open|blink)|\bblinks?\b|\bsmiles?\b|\blips?\s+(?:move|part)|\b(?:skin|flesh)\s+(?:appears?|forms?)\b|\b(?:second|another|additional|extra)\s+(?:person|figure|character|subject|worker|soldier|vehicle|animal)\b.{0,32}\b(?:enters?|appears?|emerges?|joins?)\b/i);
  if (unsafeCreative) issues.push(`video_prompt contains unsafe identity/entity drift: ${unsafeCreative[0]}`);
  return issues;
};

export const buildRegenerationSubmittedScene = ({
  scene_number,
  video_prompt,
  image_url,
  negative_prompt,
  motion_prompt_version,
  source_frame_locked,
  duration_seconds,
  target_duration,
  action_duration_seconds,
  editorial_duration_seconds,
  clip_duration,
  playback_rate,
}) => ({
  scene_number,
  video_prompt,
  image_url,
  negative_prompt,
  motion_prompt_version,
  source_frame_locked,
  duration_seconds,
  target_duration,
  action_duration_seconds,
  editorial_duration_seconds,
  clip_duration,
  playback_rate,
});

const validSessionId = (value) => /^[a-zA-Z0-9_-]+$/.test(String(value || ''));

export const selectedImageReferenceFromProject = (project, unitId, sessionId) => {
  const selected = project?.selected_images?.[String(unitId)];
  const promptIndex = Number(selected?.promptIndex ?? selected?.prompt_index ?? 0);
  const variant = Number.isInteger(promptIndex) && promptIndex >= 0 ? promptIndex : 0;
  const stored = selected?.url || project?.images?.[`${unitId}_${variant}`]?.url || null;
  if (!stored || typeof stored !== 'string') return null;
  if (!stored.startsWith('__session_file__/')) return stored;
  const relativePath = stored.slice('__session_file__/'.length);
  if (!validSessionId(sessionId) || !relativePath || relativePath.includes('..')) return null;
  return `/api/session/${encodeURIComponent(sessionId)}/files/${relativePath}`;
};

const recoverSelectedImageReference = async (imageUrl, sessionId, unitId) => {
  if (typeof imageUrl === 'string' && imageUrl.trim()) return imageUrl;
  if (!validSessionId(sessionId) || !unitId) return null;
  try {
    const project = JSON.parse(
      await fs.readFile(path.join(OUTPUT_ROOT, String(sessionId), 'session.json'), 'utf8')
    );
    return selectedImageReferenceFromProject(project, unitId, sessionId);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`Could not restore selected image for ${unitId}: ${error.message}`);
    }
    return null;
  }
};

const hydrateSceneImageReferences = async (scenes, sessionId) =>
  Promise.all((scenes || []).map(async (scene) => ({
    ...scene,
    image_url: await recoverSelectedImageReference(
      scene?.image_url,
      sessionId,
      scene?.scene_number
    ),
  })));

export const requireHttpsImageUrl = (value, label = 'Selected source image') => {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error(`${label} must resolve to an absolute HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) {
    throw new Error(`${label} must resolve to an absolute HTTPS URL`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  const privateIpv4 = ipv4 && (
    ipv4[0] === 10
    || ipv4[0] === 127
    || (ipv4[0] === 169 && ipv4[1] === 254)
    || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
    || (ipv4[0] === 192 && ipv4[1] === 168)
  );
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname === '::1'
    || hostname === '0.0.0.0'
    || privateIpv4
  ) {
    throw new Error(`${label} must be publicly reachable by the video provider`);
  }
  return parsed.toString();
};

const addNegativePrompt = (input, scene) => {
  const negativePrompt = typeof scene?.negative_prompt === 'string'
    ? scene.negative_prompt.trim()
    : '';
  if (negativePrompt) input.negative_prompt = negativePrompt;
  return input;
};

// Kling v3 accepts any integer 3-15
const clampKling = (d) => Math.min(15, Math.max(3, Math.round(d || 5)));
// Kling 2.5 Turbo Pro accepts only 5 or 10
// Split at 7.5: d < 7.5 → 5, d >= 7.5 → 10 (correct nearest-neighbour)
const clampKlingTurbo = (d) => ((d || 5) < 7.5 ? 5 : 10);
// LTX-2 Fast accepts any even integer 6-20 (2s steps)
const clampFast = (d) => {
  const clamped = Math.min(20, Math.max(6, Math.round((d || 6) / 2) * 2));
  return clamped;
};

const clampDuration = (d, videoModel) => {
  if (videoModel === 'kwaivgi/kling-v3-video')       return clampKling(d);
  if (videoModel === 'kwaivgi/kling-v2.5-turbo-pro') return clampKlingTurbo(d);
  if (videoModel === 'lightricks/ltx-2-fast')        return clampFast(d);
  if (videoModel === 'veo-3.1-fast')                 return 8; // GeminiGen Veo/Omni is fixed 8s
  if (videoModel === 'grok-3') {
    // GeminiGen Grok accepts only 6, 10 or 15 — snap UP to the smallest clip
    // that covers the requested duration (segments must never come up short)
    const raw = d || 6;
    return GROK_DURATIONS.find(dur => dur >= raw) ?? 15;
  }
  // LTX-2 Pro
  const raw = d || 6;
  if (PRO_DURATIONS.includes(raw)) return raw;
  return PRO_DURATIONS.reduce((prev, curr) =>
    Math.abs(curr - raw) < Math.abs(prev - raw) ? curr : prev
  );
};

// Build model-specific fal.ai input
export const buildFalInput = (videoModel, scene, duration, resolution, aspectRatio) => {
  if (videoModel === 'kwaivgi/kling-v3-video') {
    const input = {
      prompt: scene.video_prompt,
      duration,
      mode: resolution === '720p' ? 'standard' : 'pro',
      aspect_ratio: aspectRatio,
      generate_audio: true,
    };
    if (scene.image_url) input.start_image = scene.image_url;
    return addNegativePrompt(input, scene);
  }
  if (videoModel === 'kwaivgi/kling-v2.5-turbo-pro') {
    const input = {
      prompt: scene.video_prompt,
      duration,
      aspect_ratio: aspectRatio,
      generate_audio: true,
    };
    if (scene.image_url) input.start_image = scene.image_url;
    return addNegativePrompt(input, scene);
  }
  // LTX-2 Pro / Fast
  const input = {
    prompt: scene.video_prompt,
    duration,
    resolution,
    aspect_ratio: aspectRatio,
    generate_audio: true,
  };
  if (scene.image_url) input.image_url = scene.image_url;
  return addNegativePrompt(input, scene);
};

// Build model-specific Replicate input
export const buildReplicateInput = (videoModel, scene, duration, resolution, aspectRatio) => {
  if (videoModel === 'kwaivgi/kling-v3-video') {
    const input = {
      prompt: scene.video_prompt,
      duration,
      mode: resolution === '720p' ? 'standard' : 'pro',
      aspect_ratio: aspectRatio,
      generate_audio: true,
    };
    if (scene.image_url) input.start_image = scene.image_url;
    return addNegativePrompt(input, scene);
  }
  if (videoModel === 'kwaivgi/kling-v2.5-turbo-pro') {
    const input = {
      prompt: scene.video_prompt,
      duration,
      aspect_ratio: aspectRatio,
      generate_audio: true,
    };
    if (scene.image_url) input.start_image = scene.image_url;
    return addNegativePrompt(input, scene);
  }
  // LTX-2 Pro / Fast
  const input = {
    prompt: scene.video_prompt,
    duration,
    resolution,
    aspect_ratio: aspectRatio,
    generate_audio: true,
  };
  if (scene.image_url) input.image = scene.image_url;
  return addNegativePrompt(input, scene);
};

const getFalClient = (req) => {
  const keys = req.app.get('apiKeys');
  if (!keys.fal) {
    throw new Error('fal.ai API key not configured');
  }
  fal.config({ credentials: keys.fal });
  return fal;
};

const getReplicateClient = (req) => {
  const keys = req.app.get('apiKeys');
  if (!keys.replicate) {
    throw new Error('Replicate API key not configured');
  }
  return new Replicate({ auth: keys.replicate });
};

// Parse a base64 data URI into { buffer, mimeType }
const parseDataUri = (dataUri) => {
  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('Invalid data URI');
  return { mimeType: match[1], buffer: Buffer.from(match[2], 'base64') };
};

const mimeForPath = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
};

// Project loading resolves durable assets to the backend's own session URL.
// Remote video providers cannot fetch localhost, so read that file directly
// and upload it just like a data URI. This also keeps old saved projects on
// the source-frame-locked path instead of silently degrading to text-to-video.
const readLocalSessionImage = async (imageUrl) => {
  const match = String(imageUrl || '').match(/\/api\/session\/([^/]+)\/files\/([^?#]+)/);
  if (!match) return null;
  const sessionId = decodeURIComponent(match[1]);
  const relativePath = decodeURIComponent(match[2]);
  if (!sessionId || sessionId.includes('..') || /[\\/]/.test(sessionId) || !relativePath || relativePath.includes('..')) {
    throw new Error('Invalid local session image path');
  }
  const sessionRoot = path.join(OUTPUT_ROOT, sessionId);
  const absolutePath = path.resolve(sessionRoot, relativePath);
  if (!absolutePath.startsWith(`${sessionRoot}${path.sep}`)) throw new Error('Local session image escaped its project directory');
  return {
    buffer: await fs.readFile(absolutePath),
    mimeType: mimeForPath(absolutePath),
    sessionId,
    relativePath,
  };
};

// If image_url is a base64 data URI, upload it to the provider's file store
// and return a stable HTTPS URL the model can actually fetch.
// Plain HTTPS URLs are returned unchanged.
const resolveImageUrl = async (imageUrl, provider, client) => {
  if (!imageUrl) {
    throw new Error('Selected source image is missing; refusing text-only generation because frame identity and mannequin continuity cannot be preserved');
  }
  try {
    const local = await readLocalSessionImage(imageUrl);
    if (!local && !imageUrl.startsWith('data:')) {
      return requireHttpsImageUrl(imageUrl);
    }
    const { mimeType, buffer } = local || parseDataUri(imageUrl);
    if (provider === 'replicate') {
      // Replicate file store — returns a stable r2 URL
      const blob = new Blob([buffer], { type: mimeType });
      const url = await client.files.create(blob, { filename: 'scene.jpg' });
      return requireHttpsImageUrl(url.urls?.get || url.url, 'Uploaded selected source image');
    } else {
      // fal storage upload — returns a CDN URL
      const blob = new Blob([buffer], { type: mimeType });
      const file = new File([blob], 'scene.jpg', { type: mimeType });
      const url = await client.storage.upload(file);
      return requireHttpsImageUrl(url, 'Uploaded selected source image');
    }
  } catch (err) {
    throw new Error(`Could not prepare the selected source image for ${provider}; video generation was stopped to prevent identity/style drift: ${err.message}`);
  }
};

// ─── GeminiGen (snapgen.ai) Veo/Omni + Grok provider — ported from Storyforge ─
const GEMINIGEN_BASE_URL = 'https://api.snapgen.ai/uapi/v1';
const GEMINIGEN_RESOLUTION = '720p';
const GEMINIGEN_MODE_IMAGE = 'frame';
// Models served through the GeminiGen provider and their fixed/allowed durations
const GEMINIGEN_MODELS = new Set(['veo-3.1-fast', 'grok-3']);
const submissionLedgerLoads = new Map();
const submissionLedgerWrites = new Map();
const activeBulkSubmissions = new Map();

export const applySubmissionLedgerEntry = (entries, entry) => {
  if (!entry?.fingerprint) return entries;
  if (entry.status === 'failed' || entry.invalidated === true) {
    const current = entries.get(entry.fingerprint);
    if (!entry.jobId || current?.jobId === entry.jobId) {
      entries.delete(entry.fingerprint);
    }
    return entries;
  }
  if (entry.jobId) entries.set(entry.fingerprint, entry);
  return entries;
};

// Grok uses named aspect ratios instead of W:H strings
const grokAspectRatio = (aspectRatio) => {
  if (aspectRatio === '9:16') return 'portrait';
  if (aspectRatio === '1:1')  return 'square';
  return 'landscape'; // 16:9 default
};

const getGeminigenKey = (req) => {
  const keys = req.app.get('apiKeys');
  if (!keys.geminigen) {
    throw new Error('GeminiGen API key not configured');
  }
  return keys.geminigen;
};

// GeminiGen requires a PUBLIC reference image URL — it cannot accept base64.
// Base64 images are uploaded to Cloudflare R2 (same mechanism Storyforge uses),
// falling back to fal storage or Replicate's file store if R2 isn't configured.
const resolvePublicImageUrl = async (req, imageUrl, requestedSessionId) => {
  if (!imageUrl) throw new Error('GeminiGen requires a reference image for every scene');
  const local = await readLocalSessionImage(imageUrl);
  if (!local && imageUrl.startsWith('https://')) return requireHttpsImageUrl(imageUrl);
  if (!local && !imageUrl.startsWith('data:')) throw new Error('Unsupported image URL format for GeminiGen');

  const { mimeType, buffer } = local || parseDataUri(imageUrl);
  const sessionId = local?.sessionId || String(requestedSessionId || '').trim();
  if (local?.sessionId && requestedSessionId && local.sessionId !== requestedSessionId) {
    throw new Error('Selected source image belongs to a different project session');
  }
  if (!isR2Configured()) {
    throw new Error('GeminiGen needs project-scoped R2 storage for local source images. Configure R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, and R2_PUBLIC_URL in backend/.env.');
  }

  const ext = mimeType.includes('png') ? 'png' : mimeType.includes('webp') ? 'webp' : 'jpg';
  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 24);
  const relativePath = local?.relativePath || `images/submissions/${digest}.${ext}`;
  try {
    const publicUrl = await ensureProjectAssetInR2(buffer, mimeType, { sessionId, relativePath });
    return requireHttpsImageUrl(publicUrl, 'R2 selected source image');
  } catch (error) {
    throw new Error(`Could not publish the selected source image to project-scoped R2 storage: ${error.message}`);
  }
};

const createGeminigenJob = async (apiKey, prompt, imageUrl, aspectRatio, videoModel = 'veo-3.1-fast', duration = 8) => {
  const isGrok = videoModel === 'grok-3';
  const formData = new FormData();
  formData.append('prompt', prompt);
  formData.append('model', videoModel);
  formData.append('resolution', GEMINIGEN_RESOLUTION);
  formData.append('duration', String(duration));
  if (isGrok) {
    // Grok endpoint: named aspect ratios, mode=custom, public URLs via file_urls
    formData.append('aspect_ratio', grokAspectRatio(aspectRatio));
    formData.append('mode', 'custom');
    formData.append('file_urls', imageUrl);
  } else {
    formData.append('aspect_ratio', aspectRatio === '9:16' ? '9:16' : '16:9');
    formData.append('mode_image', GEMINIGEN_MODE_IMAGE);
    formData.append('ref_images', imageUrl);
  }

  const endpoint = isGrok ? 'video-gen/grok' : 'video-gen/veo';
  const response = await fetch(`${GEMINIGEN_BASE_URL}/${endpoint}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });

  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { error_message: text || `HTTP ${response.status}` }; }

  if (!response.ok) {
    throw new Error(`GeminiGen create failed (${response.status}): ${payload.error_message || payload.status_desc || 'Unknown error'}`);
  }
  if (payload.status === 3) {
    throw new Error(payload.error_message || payload.status_desc || 'GeminiGen generation failed at submit');
  }
  if (!payload.uuid) {
    throw new Error('GeminiGen did not return a generation uuid');
  }
  return payload.uuid;
};

const submissionLedgerPath = (sessionId) =>
  path.join(OUTPUT_ROOT, sessionId, 'video-submissions.jsonl');

const loadSubmissionLedger = async (sessionId) => {
  if (!submissionLedgerLoads.has(sessionId)) {
    submissionLedgerLoads.set(sessionId, (async () => {
      const entries = new Map();
      try {
        const raw = await fs.readFile(submissionLedgerPath(sessionId), 'utf8');
        for (const line of raw.split('\n')) {
          if (!line.trim()) continue;
          try {
            const entry = JSON.parse(line);
            applySubmissionLedgerEntry(entries, entry);
          } catch {
            // Preserve later valid records even if one diagnostic line is damaged.
          }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      return entries;
    })());
  }
  return submissionLedgerLoads.get(sessionId);
};

const appendSubmissionLedger = async (sessionId, entry) => {
  const previous = submissionLedgerWrites.get(sessionId) || Promise.resolve();
  const next = previous.then(async () => {
    const filePath = submissionLedgerPath(sessionId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    const ledger = await loadSubmissionLedger(sessionId);
    applySubmissionLedgerEntry(ledger, entry);
  });
  submissionLedgerWrites.set(sessionId, next.catch(() => {}));
  await next;
};

const bulkSubmissionFingerprint = ({
  sessionId,
  scene,
  publicUrl,
  aspectRatio,
  videoModel,
  duration,
}) => createHash('sha256').update(JSON.stringify({
  sessionId,
  unitId: scene.scene_number,
  prompt: scene.video_prompt,
  publicUrl,
  aspectRatio,
  videoModel,
  duration,
})).digest('hex');

const markGeminigenSubmissionFailed = async (sessionId, jobId, error) => {
  if (!validSessionId(sessionId) || !jobId) return false;
  const ledger = await loadSubmissionLedger(String(sessionId));
  const match = [...ledger.entries()].find(([, entry]) => entry?.jobId === jobId);
  if (!match) return false;
  const [fingerprint, entry] = match;
  await appendSubmissionLedger(String(sessionId), {
    createdAt: new Date().toISOString(),
    fingerprint,
    unitId: entry.unitId,
    jobId,
    provider: 'geminigen',
    model: entry.model,
    duration: entry.duration,
    status: 'failed',
    invalidated: true,
    error: String(error || 'GeminiGen generation failed').slice(0, 1000),
  });
  return true;
};

const createFreshGeminigenAttempt = async ({
  apiKey,
  scene,
  publicUrl,
  aspectRatio,
  videoModel,
  duration,
  sessionId,
}) => {
  const fingerprint = bulkSubmissionFingerprint({
    sessionId,
    scene,
    publicUrl,
    aspectRatio,
    videoModel,
    duration,
  });
  // An explicit user Retry is intentional. It must never reuse a terminal
  // provider job, even when the prompt and source image are byte-identical.
  const uuid = await createGeminigenJob(
    apiKey,
    scene.video_prompt,
    publicUrl,
    aspectRatio,
    videoModel,
    duration
  );
  await appendSubmissionLedger(String(sessionId), {
    createdAt: new Date().toISOString(),
    fingerprint,
    unitId: scene.scene_number,
    jobId: uuid,
    provider: 'geminigen',
    model: videoModel,
    duration,
    status: 'submitted',
    explicitRetry: true,
  });
  return uuid;
};

const createGeminigenBulkJobOnce = async ({
  apiKey,
  scene,
  publicUrl,
  aspectRatio,
  videoModel,
  duration,
  sessionId,
}) => {
  const fingerprint = bulkSubmissionFingerprint({
    sessionId,
    scene,
    publicUrl,
    aspectRatio,
    videoModel,
    duration,
  });
  const ledger = await loadSubmissionLedger(sessionId);
  const durable = ledger.get(fingerprint);
  if (durable?.jobId) return { uuid: durable.jobId, reused: true };

  if (activeBulkSubmissions.has(fingerprint)) {
    return { uuid: await activeBulkSubmissions.get(fingerprint), reused: true };
  }

  const submission = createGeminigenJob(
    apiKey,
    scene.video_prompt,
    publicUrl,
    aspectRatio,
    videoModel,
    duration
  );
  activeBulkSubmissions.set(fingerprint, submission);
  try {
    const uuid = await submission;
    await appendSubmissionLedger(sessionId, {
      createdAt: new Date().toISOString(),
      fingerprint,
      unitId: scene.scene_number,
      jobId: uuid,
      provider: 'geminigen',
      model: videoModel,
      duration,
    });
    return { uuid, reused: false };
  } finally {
    activeBulkSubmissions.delete(fingerprint);
  }
};

const looksLikeVideoUrl = (value) => {
  if (!/^https?:\/\//i.test(value)) return false;
  return /\.(mp4|mov|webm)(?:[?#].*)?$/i.test(value) || /video/i.test(value);
};

// GeminiGen's history payload nests the output URL inconsistently — search it.
const findVideoUrl = (value) => {
  if (typeof value === 'string') return looksLikeVideoUrl(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideoUrl(item);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const key of ['video_url', 'videoUrl', 'file_url', 'fileUrl', 'output_url', 'outputUrl', 'url']) {
    const field = value[key];
    if (typeof field === 'string' && looksLikeVideoUrl(field)) return field;
  }
  for (const child of Object.values(value)) {
    const found = findVideoUrl(child);
    if (found) return found;
  }
  return undefined;
};

const getGeminigenStatus = async (apiKey, uuid) => {
  const response = await fetch(`${GEMINIGEN_BASE_URL}/history/${encodeURIComponent(uuid)}`, {
    method: 'GET',
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GeminiGen history check failed (${response.status}): ${text.slice(0, 200)}`);
  }
  let history;
  try { history = JSON.parse(text); } catch {
    throw new Error(`GeminiGen history returned invalid JSON: ${text.slice(0, 200)}`);
  }

  const status = String(history.status ?? '');
  const statusText = String(history.status_desc || '').toLowerCase();
  const videoUrl = findVideoUrl(history);

  if (status === '2' || statusText.includes('complete') || statusText.includes('success')) {
    return videoUrl
      ? { status: 'completed', url: videoUrl }
      : { status: 'pending' }; // completed but URL not surfaced yet — retry next poll
  }
  if (status === '3' || statusText.includes('fail') || statusText.includes('error')) {
    return { status: 'failed', error: history.error_message || history.status_desc || 'GeminiGen generation failed' };
  }
  return { status: 'pending' };
};

// Helper to process in batches of N, with per-item error isolation.
// A failed item returns { scene_number, error } instead of throwing, so one bad
// scene never prevents the rest of the batch from being submitted.
const processInBatches = async (items, batchSize, processor) => {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (item) => {
        try {
          return await processor(item);
        } catch (err) {
          console.error(`processInBatches: scene ${item.scene_number} failed:`, err.message);
          // Return a shape compatible with the frontend jobs array; no job_id means
          // startVideoGeneration will skip this entry (job_id guard in newEntries loop)
          return { scene_number: item.scene_number, job_id: null, status: 'failed', error: err.message };
        }
      })
    );
    results.push(...batchResults);
  }
  return results;
};

// Map fal model IDs to their fal.ai endpoint paths
const FAL_ENDPOINT = {
  'lightricks/ltx-2-fast': 'fal-ai/ltx-2-fast/image-to-video',
  'lightricks/ltx-2-pro':  'fal-ai/ltx-2/image-to-video',
};
const getFalEndpoint = (videoModel) =>
  FAL_ENDPOINT[videoModel] || 'fal-ai/ltx-2/image-to-video';

router.post('/generate', async (req, res) => {
  try {
    const { scenes, sessionId, provider = 'fal', resolution = '1080p', aspectRatio = '16:9', videoModel = 'lightricks/ltx-2-pro' } = req.body;

    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: true, message: 'scenes array is required and must be non-empty', code: 'MISSING_SCENES' });
    }
    if (scenes.length > MAX_CONCURRENT_VIDEO_REQUESTS) {
      return res.status(400).json({
        error: true,
        message: `Submit no more than ${MAX_CONCURRENT_VIDEO_REQUESTS} video requests at once.`,
        code: 'VIDEO_CONCURRENCY_LIMIT',
      });
    }
    const hydratedScenes = await hydrateSceneImageReferences(scenes, sessionId);
    const invalidScenes = hydratedScenes
      .map(scene => ({ scene_number: scene?.scene_number, issues: validateVideoSubmission(scene) }))
      .filter(result => result.issues.length > 0);
    if (invalidScenes.length > 0) {
      return res.status(400).json({
        error: true,
        message: 'Video submission failed the protected Seedance contract.',
        code: 'UNSAFE_VIDEO_SUBMISSION',
        scenes: invalidScenes,
      });
    }

    if (provider === 'geminigen') {
      const apiKey = getGeminigenKey(req);
      if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(String(sessionId))) {
        return res.status(400).json({
          error: true,
          message: 'A valid project session id is required for durable video submission.',
          code: 'MISSING_VIDEO_SESSION',
        });
      }

      const geminigenModel = GEMINIGEN_MODELS.has(videoModel) ? videoModel : 'veo-3.1-fast';
      const processScene = async (scene) => {
        const duration = clampDuration(scene.duration_seconds, geminigenModel);
        const publicUrl = await resolvePublicImageUrl(req, scene.image_url, sessionId);
        const { uuid, reused } = await createGeminigenBulkJobOnce({
          apiKey,
          scene,
          publicUrl,
          aspectRatio,
          videoModel: geminigenModel,
          duration,
          sessionId: String(sessionId),
        });
        return {
          scene_number: scene.scene_number,
          job_id: uuid,
          status: 'pending',
          reused,
        };
      };

      const jobs = await processInBatches(hydratedScenes, MAX_CONCURRENT_VIDEO_REQUESTS, processScene);
      return res.json(jobs);
    }

    if (provider === 'replicate') {
      const replicate = getReplicateClient(req);

      const processScene = async (scene) => {
        const duration = clampDuration(scene.duration_seconds, videoModel);
        // Upload base64 image to Replicate file store so the model gets an HTTPS URL
        const resolvedImageUrl = await resolveImageUrl(scene.image_url, 'replicate', replicate);
        const resolvedScene = { ...scene, image_url: resolvedImageUrl };
        const input = buildReplicateInput(videoModel, resolvedScene, duration, resolution, aspectRatio);
        
        const prediction = await replicate.predictions.create({
          model: videoModel,
          input
        });
        
        return {
          scene_number: scene.scene_number,
          job_id: prediction.id,
          status: 'pending'
        };
      };
      
      const jobs = await processInBatches(hydratedScenes, MAX_CONCURRENT_VIDEO_REQUESTS, processScene);
      res.json(jobs);
      
    } else {
      const fal = getFalClient(req);
      const falEndpoint = getFalEndpoint(videoModel);
      
      const processScene = async (scene) => {
        const duration = clampDuration(scene.duration_seconds, videoModel);
        // Upload base64 image to fal storage so the model gets an HTTPS URL
        const resolvedImageUrl = await resolveImageUrl(scene.image_url, 'fal', fal);
        const resolvedScene = { ...scene, image_url: resolvedImageUrl };
        const input = buildFalInput(videoModel, resolvedScene, duration, resolution, aspectRatio);
        const { request_id } = await fal.queue.submit(falEndpoint, { input });
        
        return {
          scene_number: scene.scene_number,
          job_id: request_id,
          status: 'pending',
          fal_endpoint: falEndpoint,
        };
      };
      
      const jobs = await processInBatches(hydratedScenes, MAX_CONCURRENT_VIDEO_REQUESTS, processScene);
      res.json(jobs);
    }
  } catch (error) {
    console.error('Video generation error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'VIDEO_GENERATION_ERROR' });
  }
});

router.get('/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const { provider = 'fal', falEndpoint, sessionId } = req.query;

    if (provider === 'geminigen') {
      const apiKey = getGeminigenKey(req);
      const result = await getGeminigenStatus(apiKey, jobId);
      if (result.status === 'failed') {
        await markGeminigenSubmissionFailed(sessionId, jobId, result.error);
      }
      return res.json(result);
    }

    if (provider === 'replicate') {
      const replicate = getReplicateClient(req);
      const prediction = await replicate.predictions.get(jobId);
      
      if (prediction.status === 'succeeded') {
        const out = prediction.output;
        const url = typeof out === 'string' ? out
          : Array.isArray(out) ? (out[0]?.url || out[0])
          : out?.url || null;
        res.json({ status: 'completed', url });
      } else if (prediction.status === 'failed') {
        res.json({ status: 'failed', error: prediction.error || 'Video generation failed' });
      } else {
        res.json({ status: 'pending' });
      }
    } else {
      const fal = getFalClient(req);
      // Use the endpoint that was used to submit the job (passed as query param)
      const endpoint = falEndpoint || 'fal-ai/ltx-2/image-to-video';
      
      const status = await fal.queue.status(endpoint, {
        requestId: jobId
      });
      
      if (status.status === 'COMPLETED') {
        // Wrap result fetch separately — status and result are two non-atomic calls
        try {
          const result = await fal.queue.result(endpoint, { requestId: jobId });
          const videoUrl = result.video?.url
            || result.media?.url
            || result.output?.url
            || (typeof result.url === 'string' ? result.url : null)
            || null;
          res.json({ status: 'completed', url: videoUrl });
        } catch (resultErr) {
          console.error('fal result fetch failed after COMPLETED status:', resultErr);
          // Return pending so the frontend retries next poll cycle
          res.json({ status: 'pending' });
        }
      } else if (status.status === 'FAILED') {
        const errorDetail = status.error || status.logs || 'Video generation failed';
        res.json({ status: 'failed', error: errorDetail });
      } else {
        res.json({ status: 'pending' });
      }
    }
  } catch (error) {
    console.error('Video status error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'VIDEO_STATUS_ERROR' });
  }
});

router.post('/regenerate', async (req, res) => {
  try {
    const {
      scene_number,
      video_prompt,
      duration_seconds,
      target_duration,
      action_duration_seconds,
      editorial_duration_seconds,
      clip_duration,
      playback_rate,
      image_url,
      negative_prompt,
      motion_prompt_version,
      source_frame_locked,
      provider = 'fal',
      resolution = '1080p',
      aspectRatio = '16:9',
      videoModel = 'lightricks/ltx-2-pro',
      sessionId,
    } = req.body;
    const restoredImageUrl = await recoverSelectedImageReference(image_url, sessionId, scene_number);
    const submittedScene = buildRegenerationSubmittedScene({
      scene_number,
      video_prompt,
      image_url: restoredImageUrl,
      negative_prompt,
      motion_prompt_version,
      source_frame_locked,
      duration_seconds,
      target_duration,
      action_duration_seconds,
      editorial_duration_seconds,
      clip_duration,
      playback_rate,
    });
    const validationIssues = validateVideoSubmission(submittedScene);
    if (validationIssues.length > 0) {
      return res.status(400).json({
        error: true,
        message: 'Video regeneration failed the protected Seedance contract.',
        code: 'UNSAFE_VIDEO_SUBMISSION',
        issues: validationIssues,
      });
    }
    
    const duration = clampDuration(duration_seconds, videoModel);

    if (provider === 'geminigen') {
      const apiKey = getGeminigenKey(req);
      const geminigenModel = GEMINIGEN_MODELS.has(videoModel) ? videoModel : 'veo-3.1-fast';
      const publicUrl = await resolvePublicImageUrl(req, restoredImageUrl, sessionId);
      const geminigenDuration = clampDuration(duration_seconds, geminigenModel);
      const uuid = await createFreshGeminigenAttempt({
        apiKey,
        scene: submittedScene,
        publicUrl,
        aspectRatio,
        videoModel: geminigenModel,
        duration: geminigenDuration,
        sessionId: String(sessionId),
      });
      return res.json({
        scene_number,
        job_id: uuid,
        status: 'pending',
        reused: false,
        fresh_attempt: true,
      });
    }

    if (provider === 'replicate') {
      const replicate = getReplicateClient(req);
      // Upload base64 image to Replicate file store so the model gets an HTTPS URL
      const resolvedImageUrl = await resolveImageUrl(restoredImageUrl, 'replicate', replicate);
      const sceneForBuilder = { ...submittedScene, image_url: resolvedImageUrl };
      const input = buildReplicateInput(videoModel, sceneForBuilder, duration, resolution, aspectRatio);
      
      const prediction = await replicate.predictions.create({
        model: videoModel,
        input
      });
      
      res.json({
        scene_number,
        job_id: prediction.id,
        status: 'pending'
      });
    } else {
      const fal = getFalClient(req);
      const falEndpoint = getFalEndpoint(videoModel);
      // Upload base64 image to fal storage so the model gets an HTTPS URL
      const resolvedImageUrl = await resolveImageUrl(restoredImageUrl, 'fal', fal);
      const sceneForBuilder = { ...submittedScene, image_url: resolvedImageUrl };
      const falInput = buildFalInput(videoModel, sceneForBuilder, duration, resolution, aspectRatio);
      const { request_id } = await fal.queue.submit(falEndpoint, { input: falInput });
      
      res.json({
        scene_number,
        job_id: request_id,
        status: 'pending',
        fal_endpoint: falEndpoint,
      });
    }
  } catch (error) {
    console.error('Video regeneration error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'VIDEO_REGENERATION_ERROR' });
  }
});

export default router;
