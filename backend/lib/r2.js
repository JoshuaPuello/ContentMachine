// Minimal Cloudflare R2 uploader — ported from Storyforge's R2StorageProvider.
// Used to mint public HTTPS URLs for images that providers like GeminiGen
// require (they cannot accept base64 payloads).
//
// Env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME, R2_PUBLIC_URL

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';

let clientState = null;
const getClient = () => {
  if (!clientState) {
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucketName = process.env.R2_BUCKET_NAME;
    const publicUrl = process.env.R2_PUBLIC_URL;

    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !publicUrl) {
      clientState = { client: null };
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

// Upload a buffer under a deterministic project prefix and return its public URL.
// Project scoping makes every remote object discoverable and deletable when the
// corresponding local project is deleted.
export const uploadToR2 = async (buffer, mimeType, { sessionId, relativePath } = {}) => {
  const { client, bucketName, publicUrl } = getClient();
  if (!client) throw new Error('R2 storage is not configured in backend/.env');
  const key = projectR2AssetKey(sessionId, relativePath, mimeType);
  await client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
  }));
  return `${publicUrl}/${key}`;
};

// Return the existing project object when it has already been synchronized;
// otherwise upload it once. This makes video retries idempotent and avoids
// re-uploading every selected source frame before each provider submission.
export const ensureProjectAssetInR2 = async (buffer, mimeType, { sessionId, relativePath } = {}) => {
  const { client, bucketName, publicUrl } = getClient();
  if (!client) throw new Error('R2 storage is not configured in backend/.env');
  const key = projectR2AssetKey(sessionId, relativePath, mimeType);
  try {
    await client.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
  } catch (error) {
    const notFound = error?.name === 'NotFound'
      || error?.name === 'NoSuchKey'
      || error?.$metadata?.httpStatusCode === 404;
    if (!notFound) throw error;
    await client.send(new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    }));
  }
  return `${publicUrl}/${key}`;
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
