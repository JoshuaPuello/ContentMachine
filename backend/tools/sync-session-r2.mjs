import { config } from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(TOOL_DIR, '..');
const PROJECT_DIR = path.resolve(BACKEND_DIR, '..');
config({ path: path.join(BACKEND_DIR, '.env') });

const { isR2Configured, uploadToR2, projectR2Prefix } = await import('../lib/r2.js');

const sessionId = String(process.argv[2] || '').trim();
if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
  console.error('Usage: node tools/sync-session-r2.mjs <session_id>');
  process.exit(1);
}
if (!isR2Configured()) {
  console.error('R2 is not fully configured in backend/.env');
  process.exit(1);
}

const sessionDir = path.join(PROJECT_DIR, 'output', sessionId);
await fs.access(path.join(sessionDir, 'session.json'));

const mimeForPath = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
};

const collectFiles = async (directory) => {
  let entries = [];
  try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(entries.map(async entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(absolute);
    if (!entry.isFile()) return [];
    return [absolute];
  }));
  return nested.flat();
};

const roots = ['images', 'chapters', 'thumbnails'];
const files = (await Promise.all(roots.map(root => collectFiles(path.join(sessionDir, root)))))
  .flat()
  .filter(file => /\.(?:jpe?g|png|webp|gif)$/i.test(file));

const assets = [];
const queue = [...files];
const worker = async () => {
  while (queue.length > 0) {
    const absolutePath = queue.shift();
    const relativePath = path.relative(sessionDir, absolutePath).split(path.sep).join('/');
    const buffer = await fs.readFile(absolutePath);
    const url = await uploadToR2(buffer, mimeForPath(absolutePath), { sessionId, relativePath });
    assets.push({ relativePath, url, size: buffer.length });
  }
};
await Promise.all(Array.from({ length: Math.min(5, Math.max(1, files.length)) }, worker));
assets.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

const manifest = {
  version: 1,
  sessionId,
  prefix: projectR2Prefix(sessionId),
  syncedAt: new Date().toISOString(),
  assetCount: assets.length,
  assets,
};
await fs.writeFile(
  path.join(sessionDir, 'r2-manifest.json'),
  `${JSON.stringify(manifest, null, 2)}\n`,
  'utf8'
);

console.log(`Synced ${assets.length} project image assets to R2 for ${sessionId}`);
