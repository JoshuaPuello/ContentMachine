// Minimal Cloudflare R2 uploader — ported from Storyforge's R2StorageProvider.
// Used to mint public HTTPS URLs for images that providers like GeminiGen
// require (they cannot accept base64 payloads).
//
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';

const R2_REQUEST_TIMEOUT_MS = 30_000;
const R2_PUBLIC_CHECK_TIMEOUT_MS = 10_000;

let clientState = null;
const getClient = () => {
  if (!clientState) {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;

    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
      clientState = {
        client: null,
        publicUrl: publicUrl
          ? (publicUrl.endsWith('/') ? publicUrl.slice(0, -1) : publicUrl)
          : null,
      };
    } else {
      clientState = {
        client: new S3Client({
          region: 'auto',
          endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
          credentials: { accessKeyId, secretAccessKey },
        }),
        bucketName,
        publicUrl: publicUrl.endsWith('/') ? publicUrl.slice(0, -1) : publicUrl,
      };
    }
  }
  return clientState;
};

export const isR2Configured = () => !!getClient().client;

const extForMime = (mimeType) => {
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  return 'jpg';
};

const requireSafeSessionId = (sessionId) => {
  const value = String(sessionId || '').trim();
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    throw new Error('A valid project session id is required for R2 storage');
  }
  return value;
};

const normalizeRelativePath = (relativePath, mimeType) => {
  const fallback = `${randomUUID()}.${extForMime(mimeType)}`;
  const normalized = String(relativePath || fallback)
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .join('/');
  if (!normalized) throw new Error('A valid project asset path is required for R2 storage');
  return normalized;
};

export const projectR2Prefix = (sessionId) =>
  `contentmachine/projects/${requireSafeSessionId(sessionId)}/`;

export const projectR2AssetKey = (sessionId, relativePath, mimeType = 'image/jpeg') =>
  `${projectR2Prefix(sessionId)}assets/${normalizeRelativePath(relativePath, mimeType)}`;

export const projectR2AssetUrl = (sessionId, relativePath, mimeType = 'image/jpeg') => {
  const { publicUrl } = getClient();
  if (!publicUrl) throw new Error('R2 storage is not configured in backend/.env');
  return `${publicUrl}/${projectR2AssetKey(sessionId, relativePath, mimeType)}`;
};

export const createProjectR2DownloadUrl = async (
  sessionId,
  relativePath,
  mimeType = 'image/png',
  expiresInSeconds = 4 * 60 * 60,
) => {
  const { client, bucketName } = getClient();
  if (!client) throw new Error('R2 storage is not configured in backend/.env');
  const key = projectR2AssetKey(sessionId, relativePath, mimeType);
  const url = await getSignedUrl(client, new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  }), { expiresIn: expiresInSeconds });
  return { key, url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
};

export const createProjectR2UploadUrl = async (
  sessionId,
  relativePath,
  mimeType = 'image/png',
  expiresInSeconds = 4 * 60 * 60,
) => {
  const { client, bucketName, publicUrl } = getClient();
  if (!client) throw new Error('R2 storage is not configured in backend/.env');
  const key = projectR2AssetKey(sessionId, relativePath, mimeType);
  // The image worker discovers the actual PNG/JPEG/WebP result only after
  // generation. Do not sign a Content-Type header the native upload cannot
  // know at task submission time.
  const url = await getSignedUrl(client, new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
  }), { expiresIn: expiresInSeconds });
  return {
    key,
    url,
    publicUrl: `${publicUrl}/${key}`,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
  };
};

export const readProjectR2Object = async (
  sessionId,
  relativePath,
  mimeType = 'image/png',
) => {
  const { client, bucketName } = getClient();
  if (!client) throw new Error('R2 storage is not configured in backend/.env');
  const key = projectR2AssetKey(sessionId, relativePath, mimeType);
  const head = await sendR2Command(client, new HeadObjectCommand({
    Bucket: bucketName,
    Key: key,
  }), 'R2 object validation');
  const response = await sendR2Command(client, new GetObjectCommand({
    Bucket: bucketName,
    Key: key,
  }), 'R2 object download');
  const bytes = Buffer.from(await response.Body.transformToByteArray());
  return {
    key,
    bytes,
    sizeBytes: bytes.length,
    contentType: response.ContentType || head.ContentType || mimeType,
    etag: String(response.ETag || head.ETag || '').replace(/^"|"$/g, ''),
  };
};

const sendR2Command = async (client, command, label) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), R2_REQUEST_TIMEOUT_MS);
  try {
    return await client.send(command, { abortSignal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${R2_REQUEST_TIMEOUT_MS / 1000} seconds`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
};

// Upload a buffer under a deterministic project prefix and return its public URL.
// Project scoping makes every remote object discoverable and deletable when the
// corresponding local project is deleted.
export const uploadToR2 = async (buffer, mimeType, { sessionId, relativePath } = {}) => {
  const { client, bucketName, publicUrl } = getClient();
  if (!client) throw new Error('R2 storage is not configured in backend/.env');
  const key = projectR2AssetKey(sessionId, relativePath, mimeType);
  await sendR2Command(client, new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }), 'R2 upload');
  return `${publicUrl}/${key}`;
};

// Stream a large local artifact directly to R2 without retaining it in server memory.
export const uploadFileToR2 = async (filePath, sizeBytes, mimeType, { sessionId, relativePath } = {}) => {
  const { client, bucketName, publicUrl } = getClient();
  if (!client) throw new Error('R2 storage is not configured in backend/.env');
  const key = projectR2AssetKey(sessionId, relativePath, mimeType);
  await sendR2Command(client, new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: createReadStream(filePath),
    ContentLength: sizeBytes,
    ContentType: mimeType,
  }), 'R2 upload');
  return `${publicUrl}/${key}`;
};

export const deleteProjectAssetFromR2 = async (sessionId, relativePath, mimeType = 'video/mp4') => {
  const { client, bucketName } = getClient();
  if (!client) return false;
  await sendR2Command(client, new DeleteObjectCommand({
    Bucket: bucketName,
    Key: projectR2AssetKey(sessionId, relativePath, mimeType),
  }), 'R2 asset cleanup');
  return true;
};

// Delete one exact, project-owned asset subtree without touching the rest of
// the project. This is intentionally limited to downstream video assets: an
// "Images" workflow reset must never remove source frames, character
// references, narration, or thumbnails belonging to another project.
export const deleteProjectVideoAssetsFromR2 = async (sessionId) => {
  const { client, bucketName } = getClient();
  if (!client) return { configured: false, deleted: 0 };

  const prefix = `${projectR2Prefix(sessionId)}assets/videos/`;
  let deleted = 0;
  while (true) {
    const listed = await sendR2Command(client, new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
    }), 'R2 video asset listing');
    const keys = (listed.Contents || []).map(object => object.Key).filter(Boolean);
    if (keys.length === 0) break;
    const result = await sendR2Command(client, new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: keys.map(Key => ({ Key })),
        Quiet: true,
      },
    }), 'R2 video asset cleanup');
    if (result.Errors?.length) {
      throw new Error(`R2 rejected deletion of ${result.Errors.length} project video asset(s)`);
    }
    deleted += keys.length;
  }

  return { configured: true, deleted, prefix };
};

// Return the existing project object when it has already been synchronized;
// otherwise upload it once. This makes video retries idempotent and avoids
// re-uploading every selected source frame before each provider submission.
export const ensureProjectAssetInR2 = async (buffer, mimeType, { sessionId, relativePath } = {}) => {
  const { client, bucketName, publicUrl } = getClient();
  if (!client) throw new Error('R2 storage is not configured in backend/.env');
  const key = projectR2AssetKey(sessionId, relativePath, mimeType);
  const assetUrl = `${publicUrl}/${key}`;

  // The video provider only cares whether the public object is reachable.
  // Prefer that inexpensive, bounded check over a signed S3 HeadObject call:
  // Cloudflare can occasionally leave a signed HEAD socket open even while the
  // same object is healthy on the public domain, blocking an entire video batch.
  let response;
  try {
    response = await fetch(assetUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(R2_PUBLIC_CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new Error(timedOut
      ? `R2 public asset check timed out after ${R2_PUBLIC_CHECK_TIMEOUT_MS / 1000} seconds`
      : `R2 public asset check failed: ${error.message}`);
  }
  if (response.ok) return assetUrl;
  if (response.status !== 404) {
    throw new Error(`R2 public asset check returned HTTP ${response.status}`);
  }

  await sendR2Command(client, new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }), 'R2 upload');
  return assetUrl;
};

// Delete every object owned by a ContentMachine project. R2 returns at most
// 1,000 objects per page and DeleteObjects accepts at most 1,000 keys, so each
// page can be removed safely before continuing to the next one.
export const deleteProjectAssetsFromR2 = async (sessionId) => {
  const { client, bucketName } = getClient();
  if (!client) return { configured: false, deleted: 0 };

  const prefix = projectR2Prefix(sessionId);
  let deleted = 0;
  while (true) {
    const listed = await client.send(new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
    }));
    const keys = (listed.Contents || []).map(object => object.Key).filter(Boolean);
    if (keys.length === 0) break;
    const result = await client.send(new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: keys.map(Key => ({ Key })),
        Quiet: true,
      },
    }));
    if (result.Errors?.length) {
      throw new Error(`R2 rejected deletion of ${result.Errors.length} project asset(s)`);
    }
    deleted += keys.length;
  }

  return { configured: true, deleted, prefix };
};
