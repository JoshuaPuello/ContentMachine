import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const router = express.Router();

// Audio files are stored on disk under the session output folder and the
// frontend only ever holds small URLs — base64 audio blobs must NEVER ride
// through JSON state saves (they exceed body limits and fail silently).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.join(__dirname, '..', '..', 'output');

const safeSegment = (value, fallback) => {
  const cleaned = String(value || '').replace(/[^a-zA-Z0-9._-]/g, '-').replace(/^\.+/, '');
  return cleaned || fallback;
};

const sessionAudioDir = async (sessionId) => {
  const dir = path.join(OUTPUT_ROOT, safeSegment(sessionId, 'session'), 'audio');
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

// URL the browser can use (relative — the Vite proxy forwards /api to us)
const sessionAudioUrl = (sessionId, filename) =>
  `/api/session/${safeSegment(sessionId, 'session')}/files/audio/${filename}`;

// ─── Whisper transcription (ported from Storyforge core/lib/services/whisper.ts)
// Requires the `whisper` CLI on PATH (openai-whisper). Runs fully locally.

const MIME_EXT = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'audio/webm': 'webm',
};

const parseAudioDataUri = (dataUri) => {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUri || '');
  if (!match) throw new Error('audio must be a base64 data URI');
  const mimeType = match[1];
  const ext = MIME_EXT[mimeType] || 'mp3';
  return { buffer: Buffer.from(match[2], 'base64'), ext, mimeType };
};

const transcribeWithWhisper = async (audioPath) => {
  const outDir = path.join(os.tmpdir(), `whisper_${Date.now()}_${randomUUID().slice(0, 8)}`);
  await fs.mkdir(outDir, { recursive: true });
  try {
    await execFileAsync('whisper', [
      audioPath,
      '--model', 'small',
      '--language', 'en',
      '--output_format', 'json',
      '--output_dir', outDir,
      '--word_timestamps', 'True',
      '--verbose', 'False',
      '--fp16', 'False',
    ], { timeout: 25 * 60_000, maxBuffer: 64 * 1024 * 1024 });

    const files = await fs.readdir(outDir);
    const jsonFile = files.find(f => f.endsWith('.json'));
    if (!jsonFile) throw new Error('Whisper produced no JSON output');
    const data = JSON.parse(await fs.readFile(path.join(outDir, jsonFile), 'utf-8'));

    const words = [];
    for (const seg of data.segments || []) {
      for (const w of seg.words || []) {
        words.push({
          word: (w.word || '').trim(),
          startTime: w.start,
          endTime: w.end,
          probability: Number.isFinite(w.probability) ? w.probability : undefined,
        });
      }
    }
    return words;
  } finally {
    await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
};

// ─── Scene alignment + cut-point placement ──────────────────────────────────
// Ported from Storyforge's POV audio importer (audio-import-align.ts): global
// Needleman-Wunsch alignment of the known script words against Whisper's
// word-timestamped transcript (fuzzy token matching tolerates recognition
// errors), then cut points placed in the VOICE-FREE gaps between one scene's
// last word and the next scene's first word — never mid-word, and each clip
// keeps a short bed lead before the next voice starts.

const normalizeToken = (raw) => raw.toLowerCase().replace(/[^a-z0-9]/g, '');

const editDistanceAtMostOne = (a, b) => {
  if (a === b) return true;
  const lenDiff = Math.abs(a.length - b.length);
  if (lenDiff > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    edits++;
    if (edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};

const tokenSimilarity = (a, b) => {
  if (!a || !b) return -1;
  if (a === b) return 2;
  if (a.length >= 3 && b.length >= 3) {
    if (editDistanceAtMostOne(a, b)) return 1.25;
    if (a.startsWith(b) || b.startsWith(a)) return 0.75;
  }
  return -1;
};

const GAP_PENALTY = -0.8;

// scenes: [{ sceneId, speechText, expectedSeconds }]
// transcriptWords: [{ word, startTime, endTime }]
export const alignScenesToTranscript = (scenes, transcriptWords) => {
  const refs = [];
  scenes.forEach((scene, sceneIndex) => {
    let wordIndex = 0;
    for (const raw of scene.speechText.split(/\s+/)) {
      const token = normalizeToken(raw);
      if (token) refs.push({ sceneIndex, wordIndex: wordIndex++, token });
    }
  });
  const hyps = transcriptWords
    // Whisper occasionally hallucinates a boundary word with effectively
    // zero confidence. Keeping it can move a cut into the preceding word.
    .filter(w => w.probability === undefined || w.probability >= 0.05)
    .map(w => ({ token: normalizeToken(w.word), start: w.startTime, end: w.endTime }))
    .filter(w => w.token);

  const n = refs.length;
  const m = hyps.length;
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) score[i][0] = i * GAP_PENALTY;
  for (let j = 1; j <= m; j++) score[0][j] = j * GAP_PENALTY;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = score[i - 1][j - 1] + tokenSimilarity(refs[i - 1].token, hyps[j - 1].token);
      const up = score[i - 1][j] + GAP_PENALTY;
      const left = score[i][j - 1] + GAP_PENALTY;
      score[i][j] = Math.max(diag, up, left);
    }
  }

  const matched = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const sim = tokenSimilarity(refs[i - 1].token, hyps[j - 1].token);
    if (Math.abs(score[i][j] - (score[i - 1][j - 1] + sim)) < 1e-9) {
      if (sim > 0) {
        matched.push({
          sceneIndex: refs[i - 1].sceneIndex,
          wordIndex: refs[i - 1].wordIndex,
          start: hyps[j - 1].start,
          end: hyps[j - 1].end,
        });
      }
      i--; j--;
    } else if (Math.abs(score[i][j] - (score[i - 1][j] + GAP_PENALTY)) < 1e-9) {
      i--;
    } else {
      j--;
    }
  }

  return scenes.map((scene, sceneIndex) => {
    const sceneMatches = matched.filter(e => e.sceneIndex === sceneIndex);
    const refWordCount = refs.filter(r => r.sceneIndex === sceneIndex).length;
    return {
      sceneId: scene.sceneId,
      refWordCount,
      matchedWordCount: sceneMatches.length,
      matchRatio: refWordCount > 0 ? sceneMatches.length / refWordCount : 0,
      firstWordStart: sceneMatches.length > 0 ? Math.min(...sceneMatches.map(e => e.start)) : undefined,
      lastWordEnd: sceneMatches.length > 0 ? Math.max(...sceneMatches.map(e => e.end)) : undefined,
      words: sceneMatches
        .sort((a, b) => a.wordIndex - b.wordIndex)
        .map(({ wordIndex, start, end }) => ({ wordIndex, start, end })),
    };
  });
};

const findBestSilenceMidpoint = (silenceIntervals, previousWordEnd, nextWordStart) => {
  const semanticMidpoint = (previousWordEnd + nextWordStart) / 2;
  const candidates = silenceIntervals
    .filter(interval => (
      interval.end - interval.start >= 0.06
      && interval.start >= previousWordEnd - 0.25
      && interval.end <= nextWordStart + 2.5
    ))
    .map(interval => ({
      midpoint: (interval.start + interval.end) / 2,
      distance: Math.abs(((interval.start + interval.end) / 2) - semanticMidpoint),
    }))
    .sort((a, b) => a.distance - b.distance);
  return candidates[0]?.midpoint;
};

// Boundaries land at the midpoint of measured silence between scenes. This
// leaves equal breathing room on both sides and cannot clip a final phoneme.
// If waveform silence is unavailable, use the midpoint between the aligned
// last and first words. Unmatched scenes still interpolate proportionally.
export const computeSceneCutSegments = (scenes, alignments, totalDurationSeconds, silenceIntervals = []) => {
  const count = scenes.length;
  const boundaries = new Array(count + 1);
  boundaries[0] = 0;
  boundaries[count] = totalDurationSeconds;

  const expectedTotal = scenes.reduce((sum, s) => sum + s.expectedSeconds, 0);
  const scale = expectedTotal > 0 ? totalDurationSeconds / expectedTotal : 1;
  let cumulative = 0;
  const expectedBoundaries = [];
  for (const scene of scenes) {
    cumulative += scene.expectedSeconds * scale;
    expectedBoundaries.push(cumulative);
  }

  for (let b = 1; b < count; b++) {
    const prev = alignments[b - 1];
    const next = alignments[b];
    const windowStart = prev.lastWordEnd;
    const windowEnd = next.firstWordStart;
    if (windowStart !== undefined && windowEnd !== undefined && windowEnd > windowStart + 0.1) {
      boundaries[b] = findBestSilenceMidpoint(silenceIntervals, windowStart, windowEnd)
        ?? (windowStart + windowEnd) / 2;
    } else if (windowStart !== undefined && windowEnd !== undefined) {
      boundaries[b] = (windowStart + windowEnd) / 2;
    } else {
      boundaries[b] = Number.NaN;
    }
  }

  for (let b = 1; b < count; b++) {
    if (!Number.isNaN(boundaries[b])) continue;
    let lo = b - 1;
    while (Number.isNaN(boundaries[lo])) lo--;
    let hi = b + 1;
    while (Number.isNaN(boundaries[hi])) hi++;
    const spanSeconds = boundaries[hi] - boundaries[lo];
    const expectedSpan = scenes.slice(lo, hi).reduce((sum, s) => sum + s.expectedSeconds, 0);
    let cursor = boundaries[lo];
    for (let k = lo; k < hi - 1; k++) {
      cursor += (scenes[k].expectedSeconds / Math.max(0.1, expectedSpan)) * spanSeconds;
      if (Number.isNaN(boundaries[k + 1])) boundaries[k + 1] = cursor;
    }
  }

  for (let b = 1; b <= count; b++) {
    if (boundaries[b] < boundaries[b - 1] + 0.1) {
      boundaries[b] = Math.min(totalDurationSeconds, boundaries[b - 1] + 0.1);
    }
  }
  boundaries[count] = totalDurationSeconds;

  return scenes.map((scene, index) => ({
    index,
    sceneId: scene.sceneId,
    startSeconds: Math.round(boundaries[index] * 100) / 100,
    endSeconds: Math.round(boundaries[index + 1] * 100) / 100,
    speechStartSeconds: alignments[index].firstWordStart === undefined
      ? null
      : Math.round(Math.max(0, alignments[index].firstWordStart - boundaries[index]) * 100) / 100,
    speechEndSeconds: alignments[index].lastWordEnd === undefined
      ? null
      : Math.round(Math.max(0, alignments[index].lastWordEnd - boundaries[index]) * 100) / 100,
    matchRatio: Math.round(alignments[index].matchRatio * 100) / 100,
  }));
};

// ─── ffmpeg slicing ──────────────────────────────────────────────────────────

const probeDuration = async (audioPath) => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath,
  ], { timeout: 60_000 });
  const d = parseFloat(stdout.trim());
  return Number.isFinite(d) ? d : null;
};

const detectSilenceIntervals = async (audioPath) => {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-hide_banner',
    '-nostats',
    '-i', audioPath,
    '-af', 'silencedetect=noise=-38dB:d=0.06',
    '-f', 'null',
    '-',
  ], { timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });

  const intervals = [];
  let pendingStart;
  for (const line of String(stderr || '').split(/\r?\n/)) {
    const start = line.match(/silence_start:\s*([0-9.]+)/);
    if (start) pendingStart = Number(start[1]);
    const end = line.match(/silence_end:\s*([0-9.]+)/);
    if (end && Number.isFinite(pendingStart)) {
      const endSeconds = Number(end[1]);
      if (Number.isFinite(endSeconds) && endSeconds > pendingStart) {
        intervals.push({ start: pendingStart, end: endSeconds });
      }
      pendingStart = undefined;
    }
  }
  return intervals;
};

const sliceAudio = async (inputPath, start, end, outputPath) => {
  await execFileAsync('ffmpeg', [
    '-y',
    '-ss', String(Math.max(0, start)),
    '-to', String(end),
    '-i', inputPath,
    '-acodec', 'libmp3lame',
    '-b:a', '128k',
    outputPath,
  ], { timeout: 5 * 60_000 });
};

// POST /api/audio/store
// { sessionId, sceneId (or name), audio: dataUri }
// Writes the audio to the session's output folder and returns a small URL —
// call this the moment any audio exists so it can never be lost to a reload.
router.post('/store', async (req, res) => {
  try {
    const { sessionId, sceneId, name, audio } = req.body;
    if (!sessionId) {
      return res.status(400).json({ error: true, message: 'sessionId is required', code: 'MISSING_SESSION' });
    }
    if (!audio) {
      return res.status(400).json({ error: true, message: 'audio (data URI) is required', code: 'MISSING_AUDIO' });
    }
    const { buffer, ext } = parseAudioDataUri(audio);
    const base = safeSegment(sceneId || name || 'audio', 'audio');
    const filename = `${base}_${Date.now().toString(36)}.${ext}`;
    const dir = await sessionAudioDir(sessionId);
    await fs.writeFile(path.join(dir, filename), buffer);
    res.json({ url: sessionAudioUrl(sessionId, filename) });
  } catch (error) {
    console.error('Audio store error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'AUDIO_STORE_ERROR' });
  }
});

// POST /api/audio/split
// { sessionId, audio: dataUri, scenes: [{ scene_id, text }] }
// → { scenes: [{ scene_id, url, durationSeconds, startSeconds, endSeconds,
//     matchRatio, lowConfidence }], fullAudioUrl, totalDuration }
// Slices are written to the session folder and returned as URLs — never base64.
router.post('/split', async (req, res) => {
  const workDir = path.join(os.tmpdir(), `cm_audio_split_${Date.now()}_${randomUUID().slice(0, 8)}`);
  try {
    const { audio, scenes, sessionId } = req.body;
    if (!audio) {
      return res.status(400).json({ error: true, message: 'audio (data URI) is required', code: 'MISSING_AUDIO' });
    }
    if (!sessionId) {
      return res.status(400).json({ error: true, message: 'sessionId is required', code: 'MISSING_SESSION' });
    }
    if (!Array.isArray(scenes) || scenes.length === 0) {
      return res.status(400).json({ error: true, message: 'scenes array is required', code: 'MISSING_SCENES' });
    }

    await fs.mkdir(workDir, { recursive: true });
    const { buffer, ext } = parseAudioDataUri(audio);
    const inputPath = path.join(workDir, `full.${ext}`);
    await fs.writeFile(inputPath, buffer);

    // Persist the full recording immediately — whatever happens after this
    // point, the source audio is safe on disk.
    const audioDir = await sessionAudioDir(sessionId);
    const fullName = `full_${Date.now().toString(36)}.${ext}`;
    await fs.writeFile(path.join(audioDir, fullName), buffer);
    const fullAudioUrl = sessionAudioUrl(sessionId, fullName);

    // 1. Transcribe locally with word timestamps
    let words;
    try {
      words = await transcribeWithWhisper(inputPath);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error('Whisper CLI not found — install it with `pip install openai-whisper`');
      }
      throw err;
    }
    if (words.length === 0) {
      throw new Error('Whisper found no speech in the uploaded audio');
    }

    // 2. Fuzzy-align scene scripts to word timestamps (Needleman-Wunsch).
    // expectedSeconds (proportional prior for unmatched scenes) is estimated
    // from word count at a typical ~2.5 words/second narration rate.
    const alignScenes = scenes.map(s => {
      const text = s.text || '';
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      return {
        sceneId: s.scene_id,
        speechText: text,
        expectedSeconds: Math.max(1, wordCount / 2.5),
      };
    });
    const alignments = alignScenesToTranscript(alignScenes, words);

    const totalDuration = await probeDuration(inputPath)
      ?? (words[words.length - 1]?.endTime || 0);
    if (!totalDuration) {
      throw new Error('Could not determine the uploaded audio duration');
    }

    const silenceIntervals = await detectSilenceIntervals(inputPath).catch(err => {
      console.warn('[audio/split] waveform silence detection failed; using word-gap midpoints:', err.message);
      return [];
    });

    // 3. Cut points at the midpoint of the silent gaps between scenes — the full file is
    // covered contiguously, nothing dropped, no cut lands mid-word.
    const segments = computeSceneCutSegments(alignScenes, alignments, totalDuration, silenceIntervals);

    const overallMatched = alignments.reduce((sum, a) => sum + a.matchedWordCount, 0);
    const overallRef = alignments.reduce((sum, a) => sum + a.refWordCount, 0);
    console.log(`[audio/split] aligned ${overallMatched}/${overallRef} words (${overallRef ? Math.round(overallMatched / overallRef * 100) : 0}%) across ${segments.length} scenes`);

    // 4. Slice with ffmpeg straight into the session folder, return URLs
    const sliceStamp = Date.now().toString(36);
    const out = [];
    for (const seg of segments) {
      const sliceName = `${safeSegment(seg.sceneId, 'scene')}_${sliceStamp}.mp3`;
      const outPath = path.join(audioDir, sliceName);
      await sliceAudio(inputPath, seg.startSeconds, seg.endSeconds, outPath);
      out.push({
        scene_id: seg.sceneId,
        url: sessionAudioUrl(sessionId, sliceName),
        durationSeconds: Math.round((seg.endSeconds - seg.startSeconds) * 100) / 100,
        startSeconds: seg.startSeconds,
        endSeconds: seg.endSeconds,
        speechStartSeconds: seg.speechStartSeconds,
        speechEndSeconds: seg.speechEndSeconds,
        matchRatio: seg.matchRatio,
        lowConfidence: seg.matchRatio < 0.5,
        wordTimings: (alignments[seg.index]?.words || []).map(word => ({
          wordIndex: word.wordIndex,
          startSeconds: Math.max(0, Math.round((word.start - seg.startSeconds) * 1000) / 1000),
          endSeconds: Math.max(0, Math.round((word.end - seg.startSeconds) * 1000) / 1000),
        })),
      });
    }

    res.json({ scenes: out, fullAudioUrl, totalDuration });
  } catch (error) {
    console.error('Audio split error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'AUDIO_SPLIT_ERROR' });
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
});

export default router;
