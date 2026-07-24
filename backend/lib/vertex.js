// Vertex AI Gemini image generation — ported from Storyforge's GeminiProvider.
// Supports multiple GCP service accounts (VERTEX_IMAGE_ACCOUNTS=main,alt1,...)
// with per-account RPM rate limiting, 429 cooldown, and auth-failure disabling.
//
// Env contract (same as Storyforge):
//   USE_VERTEX_AI=true
//   VERTEX_LOCATION=global            (default location)
//   VERTEX_IMAGE_RPM=2                (default per-account requests/min)
//   VERTEX_IMAGE_ACCOUNTS=main,alt1   (optional; omit for single-account mode)
//   VERTEX_<ID>_PROJECT / VERTEX_<ID>_CREDENTIALS / VERTEX_<ID>_CREDENTIALS_JSON
//   VERTEX_<ID>_LOCATION / VERTEX_<ID>_IMAGE_RPM
//   Single-account fallback: GOOGLE_CLOUD_PROJECT + GOOGLE_APPLICATION_CREDENTIALS

import { existsSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';
import { GoogleAuth } from 'google-auth-library';

const VERTEX_AUTH_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];
const BACKEND_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vertexEnv = (name) => process.env[name];

// Vertex image models (mirrors Storyforge's AI_MODELS gemini entries)
export const VERTEX_IMAGE_MODELS = [
  { id: 'gemini-2.5-flash-image',          name: 'Gemini 2.5 Flash Image',      supportsImageSize: false },
  { id: 'gemini-3.1-flash-lite-image',     name: 'Gemini 3.1 Flash Lite Image', supportsImageSize: false },
  { id: 'gemini-3-pro-image-preview',      name: 'Gemini 3 Pro Image',          supportsImageSize: true },
  { id: 'gemini-3.1-flash-image-preview',  name: 'Gemini 3.1 Flash Image',      supportsImageSize: true },
];
const MODEL_IDS = new Set(VERTEX_IMAGE_MODELS.map(m => m.id));
const modelSupportsImageSize = (id) =>
  VERTEX_IMAGE_MODELS.find(m => m.id === id)?.supportsImageSize ?? false;

const SAFETY_FINISH_REASONS = new Set([
  'SAFETY', 'IMAGE_SAFETY', 'IMAGE_OTHER', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION',
]);

class VertexHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = 'VertexHttpError';
  }
}

class RateLimiter {
  constructor(rpm) {
    this.rpm = rpm;
    this.timestamps = [];
    this.chain = Promise.resolve();
  }

  getDelayMs(now = Date.now()) {
    this.timestamps = this.timestamps.filter(t => now - t < 60_000);
    if (this.timestamps.length < this.rpm) return 0;
    return Math.max(0, 60_000 - (now - this.timestamps[0]) + 50);
  }

  async acquire(logLabel) {
    const prev = this.chain;
    let release;
    this.chain = new Promise(resolve => { release = resolve; });
    await prev;
    try {
      while (true) {
        const now = Date.now();
        const waitMs = this.getDelayMs(now);
        if (waitMs === 0) {
          this.timestamps.push(now);
          return;
        }
        console.log(`${logLabel} RPM cap (${this.rpm}/min) reached — waiting ${(waitMs / 1000).toFixed(1)}s`);
        await new Promise(r => setTimeout(r, waitMs));
      }
    } finally {
      release();
    }
  }
}

const readPositiveInt = (name, fallback) => {
  const parsed = Number(vertexEnv(name));
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
};

const toEnvToken = (id) => id.trim().toUpperCase().replace(/[^A-Z0-9]/g, '_');

const resolveCredentialsPath = (credentialsPath) => {
  if (!credentialsPath) return undefined;
  return isAbsolute(credentialsPath)
    ? credentialsPath
    : resolve(BACKEND_DIR, credentialsPath);
};

const parseInlineCredentials = (value, envName) => {
  if (!value) return undefined;
  try {
    const trimmed = value.trim();
    const json = trimmed.startsWith('{')
      ? trimmed
      : Buffer.from(trimmed, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    throw new Error(`${envName} must contain valid Google credential JSON or base64-encoded JSON.`);
  }
};

const createAuth = (projectId, credentialsPath, credentialsJson, credentialsJsonEnvName) => {
  if (credentialsJson) {
    const credentials = parseInlineCredentials(credentialsJson, credentialsJsonEnvName);
    return new GoogleAuth({ projectId, credentials, scopes: VERTEX_AUTH_SCOPES });
  }
  return credentialsPath
    ? new GoogleAuth({ projectId, keyFilename: credentialsPath, scopes: VERTEX_AUTH_SCOPES })
    : new GoogleAuth({ projectId, scopes: VERTEX_AUTH_SCOPES });
};

const parseVertexAccounts = () => {
  const defaultLocation = vertexEnv('VERTEX_LOCATION') || 'global';
  const defaultRpm = readPositiveInt('VERTEX_IMAGE_RPM', 2);
  const accountIds = (vertexEnv('VERTEX_IMAGE_ACCOUNTS') || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  if (accountIds.length === 0) {
    const projectId = vertexEnv('GOOGLE_CLOUD_PROJECT') || '';
    const credentialsPath = resolveCredentialsPath(vertexEnv('GOOGLE_APPLICATION_CREDENTIALS'));
    const credentialsJson = vertexEnv('GOOGLE_APPLICATION_CREDENTIALS_JSON') || '';
    if (!projectId) {
      return { accounts: [], error: 'USE_VERTEX_AI=true but GOOGLE_CLOUD_PROJECT is not set.' };
    }
    if (!credentialsJson && credentialsPath && !existsSync(credentialsPath)) {
      return { accounts: [], error: `GOOGLE_APPLICATION_CREDENTIALS points to a missing file: ${credentialsPath}` };
    }
    let auth;
    try {
      auth = createAuth(projectId, credentialsPath, credentialsJson, 'GOOGLE_APPLICATION_CREDENTIALS_JSON');
    } catch (error) {
      return { accounts: [], error: error.message };
    }
    return {
      accounts: [{
        id: 'default', projectId, location: defaultLocation, credentialsPath,
        auth,
        limiter: new RateLimiter(defaultRpm), rpm: defaultRpm, cooldownUntil: 0,
      }],
    };
  }

  const accounts = [];
  const errors = [];
  const seen = new Set();
  for (const accountId of accountIds) {
    const id = accountId.toLowerCase();
    if (seen.has(id)) { errors.push(`Duplicate Vertex account id "${accountId}".`); continue; }
    seen.add(id);
    const prefix = `VERTEX_${toEnvToken(accountId)}`;
    const projectId = vertexEnv(`${prefix}_PROJECT`) || '';
    const credentialsPath = resolveCredentialsPath(vertexEnv(`${prefix}_CREDENTIALS`));
    const credentialsJson = vertexEnv(`${prefix}_CREDENTIALS_JSON`) || '';
    const location = vertexEnv(`${prefix}_LOCATION`) || defaultLocation;
    const rpm = readPositiveInt(`${prefix}_IMAGE_RPM`, defaultRpm);
    if (!projectId) { errors.push(`${prefix}_PROJECT is required.`); continue; }
    if (!credentialsPath && !credentialsJson) {
      errors.push(`${prefix}_CREDENTIALS or ${prefix}_CREDENTIALS_JSON is required for multi-account mode.`);
      continue;
    }
    if (!credentialsJson && !existsSync(credentialsPath)) {
      errors.push(`${prefix}_CREDENTIALS points to a missing file: ${credentialsPath}`);
      continue;
    }
    let auth;
    try {
      auth = createAuth(projectId, credentialsPath, credentialsJson, `${prefix}_CREDENTIALS_JSON`);
    } catch (error) {
      errors.push(error.message);
      continue;
    }
    accounts.push({
      id, projectId, location, credentialsPath,
      auth,
      limiter: new RateLimiter(rpm), rpm, cooldownUntil: 0,
    });
  }
  return { accounts, error: errors.length ? errors.join(' ') : undefined };
};

class AccountPool {
  constructor(accounts) {
    this.accounts = accounts;
    this.chain = Promise.resolve();
  }

  get size() { return this.accounts.length; }

  describe() {
    return this.accounts.map(a => `${a.id}:${a.projectId}@${a.location}:${a.rpm}rpm`).join(', ');
  }

  coolDown(accountId, durationMs, reason) {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) return;
    account.cooldownUntil = Math.max(account.cooldownUntil, Date.now() + durationMs);
    console.warn(`[Vertex] account "${account.id}" cooled down ${Math.round(durationMs / 1000)}s: ${reason}`);
  }

  disable(accountId, reason) {
    const account = this.accounts.find(a => a.id === accountId);
    if (!account) return;
    account.disabledReason = reason;
    console.error(`[Vertex] account "${account.id}" disabled: ${reason}`);
  }

  async acquire(excluded = new Set()) {
    const prev = this.chain;
    let release;
    this.chain = new Promise(resolve => { release = resolve; });
    await prev;
    try {
      while (true) {
        const now = Date.now();
        const candidates = this.accounts.filter(a => !a.disabledReason && !excluded.has(a.id));
        if (candidates.length === 0) {
          const disabled = this.accounts.filter(a => a.disabledReason)
            .map(a => `${a.id}: ${a.disabledReason}`).join('; ');
          throw new Error(`No valid Vertex AI accounts available${disabled ? ` (${disabled})` : ''}.`);
        }
        const [next] = candidates
          .map(account => ({
            account,
            waitMs: Math.max(account.limiter.getDelayMs(now), Math.max(0, account.cooldownUntil - now)),
          }))
          .sort((a, b) => a.waitMs - b.waitMs);
        if (next.waitMs > 0) {
          console.log(`[Vertex] waiting ${(next.waitMs / 1000).toFixed(1)}s for account "${next.account.id}"`);
          await new Promise(r => setTimeout(r, next.waitMs));
          continue;
        }
        await next.account.limiter.acquire(`[Vertex:${next.account.id}]`);
        return next.account;
      }
    } finally {
      release();
    }
  }
}

// Lazy singleton — parsed once on first use so dotenv has run
let poolState = null;
const getPoolState = () => {
  if (!poolState) {
    const useVertex = vertexEnv('USE_VERTEX_AI') === 'true';
    if (!useVertex) {
      poolState = { pool: null, error: 'USE_VERTEX_AI is not enabled in backend/.env' };
    } else {
      const parsed = parseVertexAccounts();
      poolState = {
        pool: parsed.accounts.length > 0 ? new AccountPool(parsed.accounts) : null,
        error: parsed.error,
      };
      if (poolState.pool) console.log(`[Vertex] account pool loaded: ${poolState.pool.describe()}`);
      if (parsed.error) console.warn(`[Vertex] config warning: ${parsed.error}`);
    }
  }
  return poolState;
};

export const isVertexConfigured = () => {
  const state = getPoolState();
  return !!state.pool && !state.error;
};
export const vertexConfigError = () => getPoolState().error || null;
export const vertexAccountCount = () => getPoolState().pool?.size || 0;

const buildVertexUrl = (model, account) => {
  const host = account.location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${account.location}-aiplatform.googleapis.com`;
  return `${host}/v1/projects/${account.projectId}/locations/${account.location}/publishers/google/models/${model}:generateContent`;
};

const getAuthHeader = async (account) => {
  try {
    const client = await account.auth.getClient();
    const token = await client.getAccessToken();
    if (!token.token) throw new Error('Failed to obtain Vertex access token');
    return `Bearer ${token.token}`;
  } catch (error) {
    throw new VertexHttpError(403, `Vertex account "${account.id}" could not mint an access token: ${error.message}`);
  }
};

const formatSafetyRatings = (ratings) => {
  if (!ratings?.length) return '';
  const flagged = ratings.filter(r => r.blocked || (r.probability && !['NEGLIGIBLE', 'LOW'].includes(r.probability)));
  return flagged.map(r => `${(r.category || 'UNKNOWN').replace('HARM_CATEGORY_', '')}=${r.probability || '?'}`).join(', ');
};

const sendRequest = async (url, headers, request, account) => {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const detail = errorData.error?.message || '';
    if (response.status === 429) {
      throw new VertexHttpError(429, `Rate limit exceeded: ${detail || 'try again later'}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new VertexHttpError(response.status, `Vertex account "${account.id}" is invalid or lacks permissions. ${detail}`);
    }
    throw new VertexHttpError(response.status, detail || `Vertex API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || 'Vertex API returned an error');

  if (data.promptFeedback?.blockReason) {
    const reason = data.promptFeedback.blockReason;
    const detail = data.promptFeedback.blockReasonMessage || formatSafetyRatings(data.promptFeedback.safetyRatings);
    throw new Error(`Prompt blocked by Gemini safety filter (${reason})${detail ? `: ${detail}` : ''}. Try softening the scene description.`);
  }

  const candidate = data.candidates?.[0];
  const finishReason = candidate?.finishReason;
  const ratings = formatSafetyRatings(candidate?.safetyRatings);

  if (!candidate?.content?.parts) {
    if (finishReason && SAFETY_FINISH_REASONS.has(finishReason)) {
      throw new Error(`Image blocked by Gemini safety filter (${finishReason})${ratings ? ` — ${ratings}` : ''}. Try softening the scene description.`);
    }
    throw new Error(`No content in Vertex response${finishReason ? ` (finishReason: ${finishReason})` : ''}.`);
  }

  let imageData, mimeType, textResponse;
  for (const part of candidate.content.parts) {
    if (part.inlineData) {
      imageData = part.inlineData.data;
      mimeType = part.inlineData.mimeType;
    }
    if (part.text) textResponse = part.text;
  }

  if (!imageData || !mimeType) {
    const safetyHint = finishReason && SAFETY_FINISH_REASONS.has(finishReason)
      ? ` Blocked by safety filter (${finishReason}${ratings ? `, ${ratings}` : ''}).`
      : finishReason ? ` (finishReason: ${finishReason})` : '';
    throw new Error((textResponse || 'No image was generated.') + safetyHint);
  }

  return `data:${mimeType};base64,${imageData}`;
};

// Generate one image via Vertex. `images` is an array of { mimeType, data } (raw base64).
// Returns a data URI string. Rotates through accounts on 429/auth failures.
export const generateVertexImage = async ({ model, prompt, aspectRatio, imageSize, images = [] }) => {
  const { pool, error } = getPoolState();
  if (error) throw new Error(`Vertex AI configuration is incomplete: ${error}`);
  if (!pool) throw new Error('Vertex AI is not configured');

  const selectedModel = MODEL_IDS.has(model) ? model : 'gemini-2.5-flash-image';

  const parts = [
    { text: prompt },
    ...images.map(img => ({ inline_data: { mime_type: img.mimeType, data: img.data } })),
  ];

  const imageConfig = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize && modelSupportsImageSize(selectedModel)) imageConfig.imageSize = imageSize;

  const request = {
    // Vertex requires an explicit `role` on each content entry.
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['Text', 'Image'],
      ...(Object.keys(imageConfig).length > 0 && { imageConfig }),
    },
    // Most permissive general-content thresholds the API exposes. Gemini's
    // separate IMAGE_SAFETY filter still applies regardless of these.
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_ONLY_HIGH' },
    ],
  };

  const attempted = new Set();
  let lastError;
  const maxAttempts = Math.max(1, pool.size);

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let account;
    try {
      account = await pool.acquire(attempted);
    } catch (acquireErr) {
      // Preserve the provider error that exhausted the pool rather than
      // masking a 429 as "no valid accounts".
      throw lastError || acquireErr;
    }
    attempted.add(account.id);
    try {
      const headers = {
        'Content-Type': 'application/json',
        Authorization: await getAuthHeader(account),
      };
      return await sendRequest(buildVertexUrl(selectedModel, account), headers, request, account);
    } catch (err) {
      lastError = err;
      if (err instanceof VertexHttpError && err.status === 429) {
        pool.coolDown(account.id, 60_000, err.message);
        continue;
      }
      if (err instanceof VertexHttpError && (err.status === 401 || err.status === 403)) {
        pool.disable(account.id, err.message);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error('All Vertex AI accounts failed.');
};
