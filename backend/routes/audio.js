import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  analyzeNarrationBoundaries,
  analyzePcmSignal,
  publicAudit,
  summarizeAudit,
} from '../lib/narrationAudioQuality.js';

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

const sessionAuditDir = async (sessionId) => {
  const dir = path.join(await sessionAudioDir(sessionId), 'audits');
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
    .map(interval => ({
      start: Math.max(interval.start, previousWordEnd),
      end: Math.min(interval.end, nextWordStart),
    }))
    .filter(interval => interval.end - interval.start >= 0.04)
    .map(interval => {
      const midpoint = (interval.start + interval.end) / 2;
      return {
        midpoint,
        distance: Math.abs(midpoint - semanticMidpoint),
      };
    })
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

const normalizeScenes = (scenes) => scenes.map(scene => {
  const text = scene.text || '';
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  return {
    sceneId: scene.scene_id,
    unit_id: scene.scene_id,
    kind: scene.kind || 'scene',
    text,
    speechText: text,
    expectedSeconds: Math.max(1, wordCount / 2.5),
  };
});

const decodeMonoPcm = async (audioPath) => {
  const { stdout } = await execFileAsync('ffmpeg', [
    '-v', 'error',
    '-i', audioPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 'f32le',
    'pipe:1',
  ], {
    timeout: 10 * 60_000,
    maxBuffer: 128 * 1024 * 1024,
    encoding: 'buffer',
  });
  const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
};

const measureLoudness = async (audioPath) => {
  try {
    const { stderr } = await execFileAsync('ffmpeg', [
      '-hide_banner',
      '-nostats',
      '-i', audioPath,
      '-af', 'loudnorm=I=-16:LRA=7:TP=-1.5:print_format=json',
      '-f', 'null',
      '-',
    ], { timeout: 10 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    const match = String(stderr || '').match(/\{\s*"input_i"[\s\S]*?\}/g)?.at(-1);
    if (!match) return {};
    const parsed = JSON.parse(match);
    return {
      integratedLufs: Number(parsed.input_i),
      truePeakDb: Number(parsed.input_tp),
      loudnessRangeLu: Number(parsed.input_lra),
      thresholdLufs: Number(parsed.input_thresh),
    };
  } catch (error) {
    console.warn('[audio/audit] loudness measurement unavailable:', error.message);
    return {};
  }
};

const auditFilePath = async (sessionId, auditId) =>
  path.join(await sessionAuditDir(sessionId), `${safeSegment(auditId, 'audit')}.json`);

const writeAudit = async (sessionId, audit) => {
  await fs.writeFile(await auditFilePath(sessionId, audit.auditId), JSON.stringify(audit, null, 2));
};

const readAudit = async (sessionId, auditId) => {
  const raw = await fs.readFile(await auditFilePath(sessionId, auditId), 'utf8');
  return JSON.parse(raw);
};

const sessionOwnedAudioPath = async (sessionId, filename) => {
  const safeName = path.basename(filename || '');
  if (!safeName || safeName !== filename) throw new Error('Invalid session audio filename');
  const audioDir = await sessionAudioDir(sessionId);
  const absolute = path.join(audioDir, safeName);
  await fs.access(absolute);
  return absolute;
};

const analyzeNarrationFile = async ({
  audioPath,
  sessionId,
  auditId,
  sourceFilename,
  sourceUrl,
  originalName,
  scenes,
  transcriptWords,
  parentAuditId = null,
  version = 'source',
}) => {
  const units = normalizeScenes(scenes);
  const words = transcriptWords || await transcribeWithWhisper(audioPath);
  if (!words.length) throw new Error('Whisper found no speech in the uploaded audio');

  const alignments = alignScenesToTranscript(units, words);
  const totalDuration = await probeDuration(audioPath) ?? words.at(-1)?.endTime;
  if (!totalDuration) throw new Error('Could not determine the uploaded audio duration');
  const silenceIntervals = await detectSilenceIntervals(audioPath).catch(error => {
    console.warn('[audio/audit] waveform silence detection failed:', error.message);
    return [];
  });
  const boundaryAudit = analyzeNarrationBoundaries({ units, alignments, silenceIntervals });
  const pcm = await decodeMonoPcm(audioPath);
  const signalAudit = analyzePcmSignal(pcm, 16000, {
    boundaryTimes: boundaryAudit.boundaries.map(boundary => boundary.timeSeconds),
    wordTimes: words,
  });
  const loudness = await measureLoudness(audioPath);
  const issues = [...boundaryAudit.issues, ...signalAudit.issues];
  const audit = {
    schemaVersion: 1,
    auditId,
    parentAuditId,
    version,
    status: issues.length ? 'review-required' : 'clean',
    analyzedAt: new Date().toISOString(),
    sourceFilename,
    sourceUrl,
    originalName,
    durationSeconds: Math.round(totalDuration * 1000) / 1000,
    waveform: signalAudit.waveform,
    boundaries: boundaryAudit.boundaries,
    gapProfile: boundaryAudit.profile,
    issues,
    stats: signalAudit.stats,
    loudness,
    summary: summarizeAudit(issues, loudness),
    cache: {
      scenes,
      words,
      alignments,
      silenceIntervals,
    },
  };
  await writeAudit(sessionId, audit);
  return audit;
};

const shiftTranscriptWords = (words, insertions) => {
  const shiftAt = (time) => insertions.reduce(
    (sum, insertion) => sum + (insertion.atSeconds <= time ? insertion.durationSeconds : 0),
    0,
  );
  return words.map(word => ({
    ...word,
    startTime: word.startTime + shiftAt(word.startTime),
    endTime: word.endTime + shiftAt(word.endTime),
  }));
};

const probeAudioFormat = async (audioPath) => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'a:0',
    '-show_entries', 'stream=sample_rate,channels,channel_layout',
    '-of', 'json',
    audioPath,
  ], { timeout: 60_000 });
  const stream = JSON.parse(stdout).streams?.[0] || {};
  const channels = Number(stream.channels) || 1;
  return {
    sampleRate: Number(stream.sample_rate) || 44100,
    channelLayout: stream.channel_layout || (channels === 1 ? 'mono' : 'stereo'),
  };
};

const createRepairedMaster = async ({ inputPath, outputPath, durationSeconds, issues }) => {
  const insertions = issues
    .filter(issue => issue.autoFix && issue.operation?.type === 'insert_silence')
    .map(issue => ({
      issueId: issue.id,
      atSeconds: Math.max(0, Math.min(durationSeconds, Number(issue.operation.atSeconds) || 0)),
      durationSeconds: Math.max(0, Number(issue.operation.durationSeconds) || 0),
    }))
    .filter(insertion => insertion.durationSeconds >= 0.03)
    .sort((a, b) => a.atSeconds - b.atSeconds);
  const wantsDeclick = issues.some(issue => issue.autoFix && issue.operation?.type === 'declick');
  const wantsDeclip = issues.some(issue => issue.autoFix && issue.operation?.type === 'declip');
  const wantsDcRemoval = issues.some(issue => issue.autoFix && issue.operation?.type === 'remove_dc');
  if (!insertions.length && !wantsDeclick && !wantsDeclip && !wantsDcRemoval) {
    throw new Error('None of the selected findings has a safe automatic repair');
  }

  const { sampleRate, channelLayout } = await probeAudioFormat(inputPath);
  const filters = [];
  const concatInputs = [];
  let cursor = 0;
  let partIndex = 0;
  for (const insertion of insertions) {
    if (insertion.atSeconds > cursor + 0.001) {
      filters.push(
        `[0:a]atrim=start=${cursor}:end=${insertion.atSeconds},asetpts=PTS-STARTPTS,`
        + `aformat=sample_rates=${sampleRate}:channel_layouts=${channelLayout}[part${partIndex}]`,
      );
      concatInputs.push(`[part${partIndex}]`);
      partIndex++;
    }
    filters.push(
      `anullsrc=r=${sampleRate}:cl=${channelLayout}:d=${insertion.durationSeconds}[part${partIndex}]`,
    );
    concatInputs.push(`[part${partIndex}]`);
    partIndex++;
    cursor = insertion.atSeconds;
  }
  if (cursor < durationSeconds) {
    filters.push(
      `[0:a]atrim=start=${cursor}:end=${durationSeconds},asetpts=PTS-STARTPTS,`
      + `aformat=sample_rates=${sampleRate}:channel_layouts=${channelLayout}[part${partIndex}]`,
    );
    concatInputs.push(`[part${partIndex}]`);
  }
  if (concatInputs.length > 1) {
    filters.push(`${concatInputs.join('')}concat=n=${concatInputs.length}:v=0:a=1[assembled]`);
  } else if (concatInputs.length === 1) {
    filters.push(`${concatInputs[0]}anull[assembled]`);
  } else {
    filters.push('[0:a]anull[assembled]');
  }

  const polish = [];
  if (wantsDcRemoval) polish.push('highpass=f=20')
  if (wantsDeclick) polish.push('adeclick=t=2:w=55:o=75:a=2')
  if (wantsDeclip) polish.push('adeclip=w=55:o=75:a=8:t=10')
  polish.push('alimiter=limit=0.891251:level=false')
  filters.push(`[assembled]${polish.join(',')}[out]`);

  await execFileAsync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-i', inputPath,
    '-filter_complex', filters.join(';'),
    '-map', '[out]',
    '-c:a', 'flac',
    outputPath,
  ], { timeout: 15 * 60_000, maxBuffer: 32 * 1024 * 1024 });
  return insertions;
};

const splitAudioFile = async ({ inputPath, scenes, sessionId }) => {
  const units = normalizeScenes(scenes);
  const words = await transcribeWithWhisper(inputPath);
  if (!words.length) throw new Error('Whisper found no speech in the approved audio');
  const alignments = alignScenesToTranscript(units, words);
  const totalDuration = await probeDuration(inputPath) ?? words.at(-1)?.endTime;
  const silenceIntervals = await detectSilenceIntervals(inputPath).catch(() => []);
  const segments = computeSceneCutSegments(units, alignments, totalDuration, silenceIntervals);
  const audioDir = await sessionAudioDir(sessionId);
  const sliceStamp = Date.now().toString(36);
  const out = [];
  for (const seg of segments) {
    const sliceName = `${safeSegment(seg.sceneId, 'scene')}_${sliceStamp}.mp3`;
    await sliceAudio(inputPath, seg.startSeconds, seg.endSeconds, path.join(audioDir, sliceName));
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
  return { scenes: out, totalDuration };
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

// POST /api/audio/audit
// Persists the immutable source and performs transcription + signal analysis.
// It intentionally creates no scene slices: the user reviews/repairs the
// master first, then explicitly approves a version through /audit/approve.
router.post('/audit', async (req, res) => {
  try {
    const { audio, scenes, sessionId, name } = req.body;
    if (!audio) {
      return res.status(400).json({ error: true, message: 'audio (data URI) is required', code: 'MISSING_AUDIO' });
    }
    if (!sessionId) {
      return res.status(400).json({ error: true, message: 'sessionId is required', code: 'MISSING_SESSION' });
    }
    if (!Array.isArray(scenes) || !scenes.length) {
      return res.status(400).json({ error: true, message: 'scenes array is required', code: 'MISSING_SCENES' });
    }

    const { buffer, ext } = parseAudioDataUri(audio);
    const auditId = `audit_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const sourceFilename = `full_source_${auditId}.${ext}`;
    const audioDir = await sessionAudioDir(sessionId);
    const sourcePath = path.join(audioDir, sourceFilename);
    await fs.writeFile(sourcePath, buffer);
    const sourceUrl = sessionAudioUrl(sessionId, sourceFilename);

    const audit = await analyzeNarrationFile({
      audioPath: sourcePath,
      sessionId,
      auditId,
      sourceFilename,
      sourceUrl,
      originalName: safeSegment(name, `full-audio.${ext}`),
      scenes,
      version: 'source',
    });
    res.json({ audit: publicAudit(audit) });
  } catch (error) {
    console.error('Audio audit error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'AUDIO_AUDIT_ERROR' });
  }
});

// POST /api/audio/audit/validate-marker
// A waveform click becomes a measured finding, not an unverified annotation.
router.post('/audit/validate-marker', async (req, res) => {
  try {
    const { sessionId, auditId, timeSeconds, type = 'other', note = '' } = req.body;
    if (!sessionId || !auditId || !Number.isFinite(Number(timeSeconds))) {
      return res.status(400).json({ error: true, message: 'sessionId, auditId, and timeSeconds are required' });
    }
    const audit = await readAudit(sessionId, auditId);
    const time = Math.max(0, Math.min(audit.durationSeconds, Number(timeSeconds)));
    const existing = audit.issues
      .filter(issue => type === 'short_gap' ? issue.type === 'short_gap' : issue.type !== 'short_gap')
      .sort((a, b) => Math.abs(a.timeSeconds - time) - Math.abs(b.timeSeconds - time))[0];
    if (existing && Math.abs(existing.timeSeconds - time) <= 1.25) {
      existing.userConfirmed = true;
      existing.note = String(note || '').slice(0, 500);
      await writeAudit(sessionId, audit);
      return res.json({
        issue: existing,
        validation: { confirmed: true, message: 'The measured waveform confirms a nearby finding.' },
        audit: publicAudit(audit),
      });
    }

    let issue;
    if (type === 'short_gap') {
      const boundary = (audit.boundaries || [])
        .slice()
        .sort((a, b) => Math.abs(a.timeSeconds - time) - Math.abs(b.timeSeconds - time))[0];
      if (boundary && Math.abs(boundary.timeSeconds - time) <= 3) {
        const target = boundary.targetGapSeconds || audit.gapProfile?.medianPauseSeconds || 0.8;
        const measured = boundary.pauseSeconds || 0;
        const insert = Math.max(0, target - measured);
        issue = {
          id: `manual-gap-${Date.now().toString(36)}`,
          type: 'short_gap',
          severity: measured < 0.25 ? 'high' : 'medium',
          confidence: measured < target ? 0.9 : 0.56,
          timeSeconds: (boundary.pauseStartSeconds + boundary.pauseEndSeconds) / 2,
          startSeconds: boundary.pauseStartSeconds,
          endSeconds: boundary.pauseEndSeconds,
          fromUnitId: boundary.fromUnitId,
          toUnitId: boundary.toUnitId,
          title: `Reviewed transition · ${boundary.fromUnitId} → ${boundary.toUnitId}`,
          description: `Measured breathing room is ${measured.toFixed(2)}s; the project baseline is ${target.toFixed(2)}s.`,
          suggestion: insert > 0.04
            ? `Insert ${insert.toFixed(2)}s at this semantic boundary.`
            : 'The measured pause is already within the project’s natural range.',
          operation: { type: 'insert_silence', atSeconds: boundary.timeSeconds, durationSeconds: insert },
          autoFix: insert > 0.04,
          defaultSelected: insert > 0.04,
          status: 'open',
          userConfirmed: true,
          note: String(note || '').slice(0, 500),
        };
      } else {
        issue = {
          id: `manual-gap-${Date.now().toString(36)}`,
          type: 'short_gap',
          severity: 'medium',
          confidence: 0.45,
          timeSeconds: time,
          title: 'User-marked pause issue',
          description: 'No script boundary was close enough to verify this automatically.',
          suggestion: 'Preview the marked point before applying a conservative 0.65s pause.',
          operation: { type: 'insert_silence', atSeconds: time, durationSeconds: 0.65 },
          autoFix: true,
          defaultSelected: false,
          status: 'open',
          userConfirmed: true,
          note: String(note || '').slice(0, 500),
        };
      }
    } else {
      const isClick = type === 'click';
      issue = {
        id: `manual-${safeSegment(type, 'issue')}-${Date.now().toString(36)}`,
        type,
        severity: 'medium',
        confidence: 0.5,
        timeSeconds: time,
        startSeconds: Math.max(0, time - 0.08),
        endSeconds: Math.min(audit.durationSeconds, time + 0.08),
        title: type === 'level_jump' ? 'User-marked level or voice jump'
          : isClick ? 'User-marked click or pop'
            : 'User-marked audio concern',
        description: 'The marker is saved for A/B review. The automatic scan did not independently reproduce it with high confidence.',
        suggestion: isClick
          ? 'A conservative de-click pass is available; compare it carefully before approval.'
          : 'Review or regenerate this phrase rather than applying a destructive automatic pitch correction.',
        operation: { type: isClick ? 'declick' : 'review_only' },
        autoFix: isClick,
        defaultSelected: false,
        status: 'open',
        userConfirmed: true,
        note: String(note || '').slice(0, 500),
      };
    }
    audit.issues.push(issue);
    audit.status = 'review-required';
    audit.summary = summarizeAudit(audit.issues, audit.loudness);
    await writeAudit(sessionId, audit);
    res.json({
      issue,
      validation: {
        confirmed: issue.confidence >= 0.7,
        message: issue.confidence >= 0.7
          ? 'The marker aligns with measured evidence.'
          : 'Marker saved for review; the automatic scan could not confirm it confidently.',
      },
      audit: publicAudit(audit),
    });
  } catch (error) {
    console.error('Audio marker validation error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'AUDIO_MARKER_ERROR' });
  }
});

// POST /api/audio/audit/repair
// Builds a new lossless master. The source file is never overwritten.
router.post('/audit/repair', async (req, res) => {
  try {
    const { sessionId, auditId, issueIds } = req.body;
    if (!sessionId || !auditId) {
      return res.status(400).json({ error: true, message: 'sessionId and auditId are required' });
    }
    const audit = await readAudit(sessionId, auditId);
    const requested = new Set(Array.isArray(issueIds) ? issueIds : []);
    const selected = audit.issues.filter(issue => (
      requested.size ? requested.has(issue.id) : issue.autoFix && issue.defaultSelected
    ));
    if (!selected.length) {
      return res.status(400).json({ error: true, message: 'Select at least one safely repairable finding' });
    }

    const sourcePath = await sessionOwnedAudioPath(sessionId, audit.sourceFilename);
    const repairId = `${audit.auditId}_repair_${Date.now().toString(36)}`;
    const repairedFilename = `full_repaired_${repairId}.flac`;
    const repairedPath = path.join(await sessionAudioDir(sessionId), repairedFilename);
    const insertions = await createRepairedMaster({
      inputPath: sourcePath,
      outputPath: repairedPath,
      durationSeconds: audit.durationSeconds,
      issues: selected,
    });
    const shiftedWords = shiftTranscriptWords(audit.cache.words || [], insertions);
    const repairedUrl = sessionAudioUrl(sessionId, repairedFilename);
    const verificationAudit = await analyzeNarrationFile({
      audioPath: repairedPath,
      sessionId,
      auditId: repairId,
      sourceFilename: repairedFilename,
      sourceUrl: repairedUrl,
      originalName: audit.originalName,
      scenes: audit.cache.scenes,
      transcriptWords: shiftedWords,
      parentAuditId: audit.auditId,
      version: 'repaired',
    });
    audit.versions = [
      ...(audit.versions || []),
      {
        auditId: repairId,
        url: repairedUrl,
        filename: repairedFilename,
        createdAt: new Date().toISOString(),
        issueIds: selected.map(issue => issue.id),
        insertions,
      },
    ];
    await writeAudit(sessionId, audit);
    res.json({
      repairedUrl,
      repairAuditId: repairId,
      appliedFixes: selected.map(issue => issue.id),
      audit: publicAudit(verificationAudit),
    });
  } catch (error) {
    console.error('Audio repair error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'AUDIO_REPAIR_ERROR' });
  }
});

// POST /api/audio/audit/approve
// Re-transcribes the approved version, then atomically returns all scene slices.
router.post('/audit/approve', async (req, res) => {
  try {
    const { sessionId, auditId } = req.body;
    if (!sessionId || !auditId) {
      return res.status(400).json({ error: true, message: 'sessionId and auditId are required' });
    }
    const audit = await readAudit(sessionId, auditId);
    const inputPath = await sessionOwnedAudioPath(sessionId, audit.sourceFilename);
    const result = await splitAudioFile({
      inputPath,
      scenes: audit.cache.scenes,
      sessionId,
    });
    audit.status = 'approved';
    audit.approvedAt = new Date().toISOString();
    await writeAudit(sessionId, audit);
    res.json({
      ...result,
      approvedUrl: audit.sourceUrl,
      approvedAuditId: audit.auditId,
      audit: publicAudit(audit),
    });
  } catch (error) {
    console.error('Audio approval error:', error);
    res.status(500).json({ error: true, message: error.message, code: 'AUDIO_APPROVAL_ERROR' });
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
