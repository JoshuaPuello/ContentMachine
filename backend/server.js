import express from 'express';
import cors from 'cors';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';

config();

// ── Crash resilience ─────────────────────────────────────────────────────────
// Node kills the process on any unhandled rejection or uncaught exception,
// which took the whole backend down mid-generation (node --watch then sits in
// "waiting for file changes" and every request fails with ECONNREFUSED).
// A single bad request/provider hiccup must never kill the server — log loud
// and keep serving.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  UNHANDLED REJECTION (server kept alive):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  UNCAUGHT EXCEPTION (server kept alive):', err);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: 'http://localhost:5173' }));
app.use(express.json({ limit: '200mb' }));

// ── Request logging ──────────────────────────────────────────────────────────
// One line per API request: method, path, status, duration, response size.
// Keeps the terminal readable while making every stage of the pipeline visible.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const size = res.getHeader('content-length') || '-';
    const tag = res.statusCode >= 500 ? '✗' : res.statusCode >= 400 ? '!' : '·';
    console.log(`${tag} ${req.method} ${req.originalUrl.split('?')[0]} → ${res.statusCode} (${ms}ms, ${size}b)`);
  });
  res.on('close', () => {
    if (!res.writableFinished) {
      console.error(`✗ ${req.method} ${req.originalUrl.split('?')[0]} → CONNECTION ABORTED after ${Date.now() - start}ms`);
    }
  });
  next();
});

const apiKeys = {
  fal: process.env.FAL_API_KEY || '',
  replicate: process.env.REPLICATE_API_KEY || '',
  gemini: process.env.GEMINI_API_KEY || '',
  elevenlabs: process.env.ELEVENLABS_API_KEY || '',
  geminigen: process.env.GEMINIGEN_API_KEY || '',
};

export const getApiKey = (provider) => apiKeys[provider];
export const setApiKey = (provider, key) => {
  apiKeys[provider] = key;
};

const envPath = join(__dirname, '.env');
// Rewrite only the managed key lines; preserve everything else in .env
// (Vertex account config, USE_VERTEX_AI, custom vars) untouched.
const MANAGED_ENV_KEYS = ['FAL_API_KEY', 'REPLICATE_API_KEY', 'GEMINI_API_KEY', 'ELEVENLABS_API_KEY', 'GEMINIGEN_API_KEY', 'PORT'];
const saveKeysToEnv = () => {
  const managed = {
    FAL_API_KEY: apiKeys.fal,
    REPLICATE_API_KEY: apiKeys.replicate,
    GEMINI_API_KEY: apiKeys.gemini,
    ELEVENLABS_API_KEY: apiKeys.elevenlabs,
    GEMINIGEN_API_KEY: apiKeys.geminigen,
    PORT: String(PORT),
  };
  let lines = [];
  if (fs.existsSync(envPath)) {
    lines = fs.readFileSync(envPath, 'utf8').split('\n')
      .filter(line => !MANAGED_ENV_KEYS.some(k => line.startsWith(`${k}=`)));
    // Drop trailing blank lines so managed keys append cleanly
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  }
  const managedLines = Object.entries(managed).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(envPath, [...lines, ...managedLines, ''].join('\n'));
};

app.set('apiKeys', apiKeys);
app.set('saveKeysToEnv', saveKeysToEnv);

import settingsRoutes from './routes/settings.js';
import claudeRoutes from './routes/claude.js';
import imagesRoutes from './routes/images.js';
import videosRoutes from './routes/videos.js';
import thumbnailRoutes from './routes/thumbnail.js';
import exportRoutes from './routes/export.js';
import elevenlabsRoutes from './routes/elevenlabs.js';
import sessionRoutes from './routes/session.js';
import audioRoutes from './routes/audio.js';
import renderRoutes from './routes/render.js';
import directorRoutes from './routes/director.js';
import sceneSheetsRoutes from './routes/sceneSheets.js';
import windowsVideosRoutes, { manualWindowsVideoRouter } from './routes/windowsVideos.js';
import { startWindowsReconciler } from './lib/windowsVideo.js';
import {
  discoverWindowsImageProjects,
  startWindowsImageReconciler,
} from './lib/windowsImage.js';
import { OUTPUT_ROOT } from './lib/sessionStore.js';

app.use('/api/settings', settingsRoutes);
app.use('/api/claude', claudeRoutes);
app.use('/api/images', imagesRoutes);
app.use('/api/videos', videosRoutes);
app.use('/api/thumbnail', thumbnailRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/elevenlabs', elevenlabsRoutes);
app.use('/api/session', sessionRoutes);
app.use('/api/audio', audioRoutes);
app.use('/api/render', renderRoutes);
app.use('/api/director', directorRoutes);
app.use('/api/scene-sheets', sceneSheetsRoutes);
app.use('/api/videos/windows', windowsVideosRoutes);
app.use('/api/videos', manualWindowsVideoRouter);

app.use((err, _req, res, _next) => {
  console.error('Error:', err);
  res.status(500).json({ error: true, message: err.message || 'Internal server error', code: 'INTERNAL_ERROR' });
});

app.listen(PORT, () => {
  console.log(`Backend server running on http://localhost:${PORT}`);
  startWindowsReconciler().catch((error) => {
    console.warn(`[windows-video] reconciler could not start: ${error.message}`);
  });
  discoverWindowsImageProjects(OUTPUT_ROOT)
    .then(() => startWindowsImageReconciler())
    .catch((error) => {
      console.warn(`[windows-image] reconciler could not start: ${error.message}`);
    });
});
