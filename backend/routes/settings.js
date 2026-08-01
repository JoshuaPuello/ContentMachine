import express from 'express';
import { execFile } from 'child_process';
import * as fal from '@fal-ai/client';
import Replicate from 'replicate';
import { GoogleGenAI } from '@google/genai';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { isVertexConfigured, vertexConfigError, vertexAccountCount } from '../lib/vertex.js';
import { isR2Configured } from '../lib/r2.js';
import { isMediaBrokerConfigured } from '../lib/mediaBrokerClient.js';
const router = express.Router();

// Detect the local Claude Code CLI once and cache the result.
let claudeCliAvailable = null;
const checkClaudeCli = () => new Promise((resolve) => {
  if (claudeCliAvailable !== null) return resolve(claudeCliAvailable);
  execFile('claude', ['--version'], { timeout: 10_000 }, (err) => {
    claudeCliAvailable = !err;
    resolve(claudeCliAvailable);
  });
});

// Detect local Whisper + ffmpeg (needed for full-audio auto-split) once.
let whisperAvailable = null;
const checkWhisper = () => new Promise((resolve) => {
  if (whisperAvailable !== null) return resolve(whisperAvailable);
  execFile('whisper', ['--help'], { timeout: 15_000 }, (whisperErr) => {
    if (whisperErr) {
      whisperAvailable = false;
      return resolve(false);
    }
    execFile('ffmpeg', ['-version'], { timeout: 10_000 }, (ffmpegErr) => {
      whisperAvailable = !ffmpegErr;
      resolve(whisperAvailable);
    });
  });
});

router.get('/', async (req, res) => {
  const keys = req.app.get('apiKeys');
  const [claudeCli, whisper] = await Promise.all([checkClaudeCli(), checkWhisper()]);
  const vertex = isVertexConfigured();
  res.json({
    whisper,
    fal: !!(keys.fal && keys.fal.trim()),
    replicate: !!(keys.replicate && keys.replicate.trim()),
    gemini: !!(keys.gemini && keys.gemini.trim()),
    elevenlabs: !!(keys.elevenlabs && keys.elevenlabs.trim()),
    geminigen: !!(keys.geminigen && keys.geminigen.trim()),
    r2: isR2Configured(),
    windowsWorker: isMediaBrokerConfigured(),
    windowsImage: isMediaBrokerConfigured() && isR2Configured(),
    windowsNano: isMediaBrokerConfigured(),
    // Environment-based capabilities (configured in backend/.env, not via UI keys)
    vertex,
    vertexAccounts: vertexAccountCount(),
    vertexError: vertex ? undefined : vertexConfigError(),
    claudeCli,
  });
});

router.post('/', (req, res) => {
  const { falKey, replicateKey, geminiKey, elevenlabsKey, geminigenKey } = req.body;
  const keys = req.app.get('apiKeys');
  const saveKeysToEnv = req.app.get('saveKeysToEnv');

  if (falKey !== undefined) keys.fal = falKey.trim();
  if (replicateKey !== undefined) keys.replicate = replicateKey.trim();
  if (geminiKey !== undefined) keys.gemini = geminiKey.trim();
  if (elevenlabsKey !== undefined) keys.elevenlabs = elevenlabsKey.trim();
  if (geminigenKey !== undefined) keys.geminigen = geminigenKey.trim();

  saveKeysToEnv();
  res.json({ success: true });
});

router.post('/validate', async (req, res) => {
  const { provider, key } = req.body;

  if (!key || !key.trim()) {
    return res.json({ valid: false, error: 'API key is required' });
  }

  try {
    switch (provider) {
      case 'fal': {
        fal.config({ credentials: key.trim() });
        await fal.subscribe('fal-ai/fast-sdxl', {
          input: { prompt: 'test', image_size: 'square' },
          pollInterval: 1000
        });
        return res.json({ valid: true });
      }

      case 'replicate': {
        const replicate = new Replicate({ auth: key.trim() });
        await replicate.models.get('black-forest-labs', 'flux-1.1-pro');
        return res.json({ valid: true });
      }

      case 'gemini': {
        const ai = new GoogleGenAI({ apiKey: key.trim() });
        await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: 'Say "ok" in one word.'
        });
        return res.json({ valid: true });
      }

      case 'elevenlabs': {
        const client = new ElevenLabsClient({ apiKey: key.trim() });
        await client.voices.getAll();
        return res.json({ valid: true });
      }

      case 'geminigen': {
        // No dedicated auth-check endpoint — probe the history API with a
        // dummy uuid. Auth failures return 401/403; anything else (404, 422,
        // 200) means the key was accepted.
        const response = await fetch(
          'https://api.snapgen.ai/uapi/v1/history/00000000-0000-0000-0000-000000000000',
          { headers: { 'x-api-key': key.trim() }, signal: AbortSignal.timeout(15_000) }
        );
        if (response.status === 401 || response.status === 403) {
          return res.json({ valid: false, error: 'Invalid API key' });
        }
        return res.json({ valid: true });
      }

      default:
        return res.json({ valid: false, error: 'Unknown provider' });
    }
  } catch (error) {
    console.error(`Validation error for ${provider}:`, error.message);

    let errorMessage = error.message;
    if (error.status === 401 || error.code === 401) {
      errorMessage = 'Invalid API key';
    } else if (error.status === 403 || error.code === 403) {
      errorMessage = 'API key does not have required permissions';
    } else if (error.status === 429 || error.code === 429) {
      errorMessage = 'Rate limited - key appears valid';
      return res.json({ valid: true, warning: errorMessage });
    }

    return res.json({ valid: false, error: errorMessage });
  }
});

export default router;
