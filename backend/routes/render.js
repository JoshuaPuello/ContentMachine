/**
 * Final-film render bridge.
 *
 * Translates the studio timeline (seconds-based, URLs/session files) into
 * the DocumentaryMaster timeline JSON (frames, staged files), stages every
 * media asset into StoryForge's public/docmaster-work/<job>/, spawns the
 * Remotion render inside the StoryForge repo, tracks progress, and delivers
 * the finished MP4 into the session's final/ folder.
 *
 * Endpoints:
 *   POST /api/render/start   { sessionId, timeline, style, slug }
 *   GET  /api/render/status/:jobId
 *   POST /api/render/cancel/:jobId
 */
import express from 'express';
import { spawn } from 'child_process';
import { promises as fs, createWriteStream } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { normalizeMasterTimeline } from '../lib/timelineNormalize.js';
import { findDirectorMusicTrack } from '../lib/directorMusicCatalog.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.resolve(__dirname, '..', '..', 'output');

const STORYFORGE_PATH =
  process.env.STORYFORGE_PATH ||
  path.join(os.homedir(), 'IdeaProjects', 'Personal', 'storyforge');

const FPS = 30;
const jobs = new Map(); // jobId -> { status, progress, stage, log, output, error, proc }

const safeSessionLabel = (sessionId) => String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
const safeRenderFileName = (fileName) => {
  const value = path.basename(String(fileName || ''));
  return value === fileName && /^[a-zA-Z0-9_.-]+\.mp4$/i.test(value) ? value : null;
};
const renderWorkRoot = () => path.join(STORYFORGE_PATH, 'public', 'docmaster-work');

function newJobId(sessionId) {
  return `render_${safeSessionLabel(sessionId)}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function soundCueTiming(itemStartSeconds, cue, fallbackDurationSeconds, fps = FPS) {
  const visualBeatSeconds = itemStartSeconds + Math.max(0, Number(cue?.at_seconds) || 0);
  const anchorSeconds = Math.max(0, Number(cue?.anchor_seconds) || 0);
  const startSeconds = Math.max(0, visualBeatSeconds - anchorSeconds);
  const durationSeconds = Math.max(
    0.08,
    Number(cue?.duration_seconds) || fallbackDurationSeconds
  );
  const requestedGainDb = Number(cue?.gain_db);
  const gainDb = Math.max(
    -36,
    Math.min(0, Number.isFinite(requestedGainDb) ? requestedGainDb : -14)
  );
  return {
    visualBeatSeconds,
    anchorSeconds,
    startFrame: Math.round(startSeconds * fps),
    durationInFrames: Math.max(1, Math.round(durationSeconds * fps)),
    volume: 10 ** (gainDb / 20),
  };
}

export function normalizeSoundEffectsVolume(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1.5, parsed)) : 1;
}

export function mixSoundEffectVolume(cueVolume, masterVolume) {
  const cue = Number(cueVolume);
  return Math.max(
    0,
    Math.min(1, (Number.isFinite(cue) ? cue : 0) * normalizeSoundEffectsVolume(masterVolume))
  );
}

export function normalizeBackgroundMusicVolume(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1.5, parsed)) : 1;
}

export function mixBackgroundMusicVolume(authoredVolume, masterVolume) {
  const authored = Number(authoredVolume);
  return Math.max(
    0,
    Math.min(
      1,
      (Number.isFinite(authored) ? authored : 0.5)
        * normalizeBackgroundMusicVolume(masterVolume)
    )
  );
}

const clamp01 = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
};

export function normalizeFilmTreatment(value) {
  if (!value || typeof value !== 'object') return undefined;
  return {
    grain: clamp01(value.grain),
    atmosphere: clamp01(value.atmosphere),
    vignette: clamp01(value.vignette),
  };
}

export function applyStudioTransitions(clips, items, fps = FPS, onLog = () => {}) {
  const typeOf = (value) => ({
    'cross-dissolve': 'crossfade', crossfade: 'crossfade',
    'dip-to-black': 'dip', dip: 'dip',
    'soft-blur': 'blur-dissolve', 'blur-dissolve': 'blur-dissolve',
    'film-dissolve': 'film-dissolve',
  })[String(value || '').toLowerCase()] || null;
  const toFrames = seconds => Math.round(seconds * fps);
  for (const item of items.filter(candidate => candidate.kind === 'transition')) {
    const type = typeOf(item.payload?.type);
    if (!type) continue;
    const toClip = clips.find(clip => clip.studioItemId === item.payload?.toClipId)
      || clips.find(clip => Math.abs(clip.startFrame - toFrames(item.startTime)) <= 1);
    if (!toClip) {
      onLog(`transition ${item.id} skipped: incoming clip no longer exists`);
      continue;
    }
    const fromClip = clips.find(clip => clip.studioItemId === item.payload?.fromClipId)
      || [...clips]
        .filter(clip => clip.startFrame < toClip.startFrame)
        .sort((a, b) => b.startFrame - a.startFrame)[0];
    const transitionFrames = Math.max(6, toFrames(item.endTime - item.startTime));
    toClip.transitionIn = type;
    toClip.transitionDurationInFrames = transitionFrames;
    if (fromClip && type !== 'dip') {
      fromClip.durationInFrames = Math.max(
        fromClip.durationInFrames,
        toClip.startFrame - fromClip.startFrame + transitionFrames
      );
    }
    onLog(`transition ${item.id}: ${type} · ${transitionFrames} frames`);
  }
  for (const clip of clips) delete clip.studioItemId;
  return clips;
}

// Remove transient Remotion staging owned by a deleted ContentMachine project.
// Job ids include the session id, so cleanup remains possible after a backend
// restart even though the in-memory jobs map has been lost.
export async function deleteRenderWorkspacesForSession(sessionId) {
  const safeId = safeSessionLabel(sessionId);
  if (!safeId || safeId !== sessionId) throw new Error('Invalid project session id');

  for (const [jobId, job] of jobs.entries()) {
    if (job.sessionId !== sessionId) continue;
    job.status = 'canceled';
    job.stage = 'canceled';
    try { job.proc?.kill('SIGKILL'); } catch { /* already gone */ }
    jobs.delete(jobId);
  }

  const root = renderWorkRoot();
  let entries;
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
  const prefix = `render_${safeId}_`;
  const owned = entries.filter(entry => entry.isDirectory() && entry.name.startsWith(prefix));
  await Promise.all(owned.map(entry => fs.rm(path.join(root, entry.name), { recursive: true, force: true })));
  return owned.length;
}

function jobPublic(job) {
  const { proc: _proc, ...rest } = job;
  return { ...rest, log: job.log.slice(-40) };
}

/** Resolve a studio media ref to a readable local file or URL. */
function resolveMediaRef(src, sessionId) {
  if (!src) return null;
  if (src.startsWith('__session_file__/')) {
    return { file: path.join(OUTPUT_ROOT, sessionId, src.replace('__session_file__/', '')) };
  }
  const m = src.match(/^\/api\/session\/([^/]+)\/files\/(.+)$/);
  if (m) {
    return { file: path.join(OUTPUT_ROOT, m[1], decodeURIComponent(m[2])) };
  }
  const music = src.match(/^\/api\/director\/music\/file\/([^/?#]+)$/);
  if (music) {
    const track = findDirectorMusicTrack(decodeURIComponent(music[1]));
    return track ? { file: track.absolutePath } : null;
  }
  if (/^https?:/.test(src)) return { url: src };
  if (src.startsWith('data:')) return { dataUri: src };
  // plain relative path inside the session
  return { file: path.join(OUTPUT_ROOT, sessionId, src) };
}

async function stageAsset(ref, destDir, name, job) {
  const resolved = ref;
  const dest = path.join(destDir, name);
  if (resolved.file) {
    await fs.copyFile(resolved.file, dest);
  } else if (resolved.dataUri) {
    const b64 = resolved.dataUri.split(',')[1];
    await fs.writeFile(dest, Buffer.from(b64, 'base64'));
  } else if (resolved.url) {
    const res = await fetch(resolved.url);
    if (!res.ok) throw new Error(`download failed ${res.status}: ${resolved.url}`);
    await new Promise((resolve, reject) => {
      const ws = createWriteStream(dest);
      const reader = res.body.getReader();
      const pump = () =>
        reader.read().then(({ done, value }) => {
          if (done) {
            ws.end(resolve);
            return;
          }
          ws.write(Buffer.from(value), pump);
        });
      pump();
      ws.on('error', reject);
    });
  }
  job.log.push(`staged ${name}`);
  return dest;
}

const extOf = (src, fallback) => {
  const m = String(src).match(/\.(mp4|mov|webm|mp3|wav|m4a|aac|jpg|jpeg|png|webp)(\?|$)/i);
  return m ? m[1].toLowerCase() : fallback;
};

/**
 * Convert the studio timeline (seconds) into DocumentaryMaster props,
 * staging every referenced asset. Returns { timeline } props object.
 */
async function buildMasterTimeline(
  studio,
  sessionId,
  style,
  jobId,
  job,
  soundEffectsVolume = 1,
  backgroundMusicVolume = 1,
  filmTreatment
) {
  const workDir = path.join(STORYFORGE_PATH, 'public', 'docmaster-work', jobId);
  await fs.mkdir(workDir, { recursive: true });
  const rel = (name) => `docmaster-work/${jobId}/${name}`;
  const toFrames = (s) => Math.round(s * FPS);

  const clips = [];
  const narration = [];
  const music = [];
  const soundEffects = [];
  const overlays = [];
  let mediaIdx = 0;


  for (const item of studio.items) {
    const start = toFrames(item.startTime);
    const dur = Math.max(1, toFrames(item.endTime - item.startTime));
    switch (item.kind) {
      case 'clip': {
        const name = `clip_${String(mediaIdx++).padStart(3, '0')}.${extOf(item.payload.src, 'mp4')}`;
        await stageAsset(resolveMediaRef(item.payload.src, sessionId), workDir, name, job);
        clips.push({
          studioItemId: item.id,
          src: rel(name),
          startFrame: start,
          durationInFrames: dur,
          playbackRate: item.payload.playbackRate ?? 1,
          startFrom: item.payload.startFrom ? toFrames(item.payload.startFrom) : 0,
          transitionIn: item.payload.transitionIn || 'cut',
          volume: item.payload?.muted ? 0 : (item.payload.volume ?? 0),
          push: item.payload.push !== false,
        });
        break;
      }
      case 'narration': {
        if (item.payload?.muted) break;
        const name = `narr_${String(mediaIdx++).padStart(3, '0')}.${extOf(item.payload.src, 'mp3')}`;
        await stageAsset(resolveMediaRef(item.payload.src, sessionId), workDir, name, job);
        narration.push({
          src: rel(name),
          startFrame: start,
          durationInFrames: dur,
          volume: item.payload.volume ?? 1,
        });
        break;
      }
      case 'music': {
        if (item.payload?.muted || !item.payload?.src) break;
        const name = `music_${String(mediaIdx++).padStart(3, '0')}.${extOf(item.payload.src, 'mp3')}`;
        await stageAsset(resolveMediaRef(item.payload.src, sessionId), workDir, name, job);
        music.push({
          src: rel(name),
          startFrame: start,
          durationInFrames: dur,
          volume: mixBackgroundMusicVolume(
            item.payload.volume,
            backgroundMusicVolume
          ),
          fadeInFrames: Math.max(0, toFrames(item.payload.fadeInSeconds ?? 2.2)),
          fadeOutFrames: Math.max(0, toFrames(item.payload.fadeOutSeconds ?? 2.2)),
          duckingDb: Math.max(-12, Math.min(0, Number(item.payload.duckingDb) || -3.5)),
        });
        break;
      }
      case 'sound-effect': {
        if (item.payload?.muted || !item.payload?.src) break;
        const name = `sfx_narrative_${String(mediaIdx++).padStart(3, '0')}.${extOf(item.payload.src, 'mp3')}`;
        await stageAsset(resolveMediaRef(item.payload.src, sessionId), workDir, name, job);
        soundEffects.push({
          src: rel(name),
          startFrame: start,
          durationInFrames: dur,
          volume: mixSoundEffectVolume(item.payload.volume ?? 0.28, soundEffectsVolume),
          fadeInFrames: 0,
          fadeOutFrames: Math.min(5, Math.max(1, dur - 1)),
        });
        break;
      }
      case 'map': {
        const name = `map_${String(mediaIdx++).padStart(3, '0')}.mp4`;
        await stageAsset(resolveMediaRef(item.payload.src, sessionId), workDir, name, job);
        overlays.push({
          kind: 'map',
          src: rel(name),
          startFrame: start,
          durationInFrames: dur,
          // Same default as the editor preview: split unless the editor
          // explicitly chose another mode — full-frame is never implicit.
          presentation: item.payload.presentation || 'split',
          ...(Number.isFinite(item.payload.insetFrames)
            ? { insetFrames: Math.round(item.payload.insetFrames) }
            : {}),
          // Editor's source-window trim: which stretch of the map video plays.
          ...(Number(item.payload.sourceStart) > 0
            ? { sourceStartFrames: Math.round(Number(item.payload.sourceStart) * FPS) }
            : {}),
        });
        break;
      }
      case 'motion-graphic': {
        overlays.push({
          kind: 'motion-graphic',
          spec: item.payload?.spec || {},
          startFrame: start,
          durationInFrames: dur,
        });
        break;
      }
      case 'chapter-reveal':
      case 'chapter-active': {
        const chapters = [];
        for (const ch of item.payload.chapters) {
          const name = `chapter_${String(mediaIdx++).padStart(3, '0')}.${extOf(ch.image, 'jpg')}`;
          await stageAsset(resolveMediaRef(ch.image, sessionId), workDir, name, job);
          chapters.push({ title: ch.title, eyebrow: ch.eyebrow, image: rel(name) });
        }
        overlays.push(
          item.kind === 'chapter-reveal'
            ? {
                kind: 'chapter-reveal',
                chapters,
                activationCues: (item.payload.activationCues || []).map(cue => ({
                  index: cue.index,
                  frame: Math.max(0, Math.round(cue.offset * FPS)),
                })),
                startFrame: start,
                durationInFrames: dur,
              }
            : {
                kind: 'chapter-active',
                chapters,
                activeIndex: item.payload.activeIndex ?? 0,
                startFrame: start,
                durationInFrames: dur,
              }
        );
        break;
      }
      case 'title':
        overlays.push({
          kind: 'title',
          text: item.payload.text,
          subtitle: item.payload.subtitle,
          startFrame: start,
          durationInFrames: dur,
          ...(item.payload.exit ? { exit: item.payload.exit } : {}),
        });
        break;
      case 'lower-third':
        overlays.push({
          kind: 'lower-third',
          text: item.payload.text,
          subtitle: item.payload.subtitle,
          textScale: item.payload.textScale,
          startFrame: start,
          durationInFrames: dur,
        });
        break;
      case 'date-chip':
        overlays.push({
          kind: 'date-chip',
          text: item.payload.text,
          corner: item.payload.corner || 'tl',
          textScale: item.payload.textScale,
          startFrame: start,
          durationInFrames: dur,
        });
        break;
      case 'transition':
        // First-class editorial transition. It is applied to its exact clip
        // pair after all media have been staged, so item ordering cannot
        // change the result.
        break;
      default:
        job.log.push(`skipping unknown item kind ${item.kind}`);
    }

    // Every Director element uses the same sound contract. Motion graphics
    // keep their design inside spec; stable chrome elements keep it directly
    // on the timeline payload.
    const cues = item.payload?.soundMuted
      ? []
      : item.payload?.spec?.sound_design?.cues || item.payload?.soundDesign?.cues || [];
    for (const cue of cues) {
      if (!cue?.asset || cue.status === 'failed') continue;
      const name = `sfx_${String(mediaIdx++).padStart(3, '0')}.${extOf(cue.asset, 'mp3')}`;
      await stageAsset(resolveMediaRef(cue.asset, sessionId), workDir, name, job);
      const timing = soundCueTiming(
        item.startTime,
        cue,
        item.endTime - item.startTime
      );
      soundEffects.push({
        src: rel(name),
        startFrame: timing.startFrame,
        durationInFrames: timing.durationInFrames,
        volume: mixSoundEffectVolume(timing.volume, soundEffectsVolume),
        fadeInFrames: 0,
        fadeOutFrames: Math.min(4, Math.max(1, timing.durationInFrames - 1)),
      });
      job.log.push(
        `aligned ${item.kind}/${cue.id || 'sound cue'}: visual ${timing.visualBeatSeconds.toFixed(2)}s · measured anchor ${timing.anchorSeconds.toFixed(3)}s · master ${Math.round(normalizeSoundEffectsVolume(soundEffectsVolume) * 100)}%`
      );
    }
  }

  applyStudioTransitions(clips, studio.items, FPS, line => job.log.push(line));

  for (const bed of music) {
    const bedEnd = bed.startFrame + (bed.durationInFrames || 0);
    bed.duckingRanges = narration
      .map((voice) => ({
        startFrame: Math.max(0, voice.startFrame - bed.startFrame),
        endFrame: Math.min(
          bed.durationInFrames,
          voice.startFrame + (voice.durationInFrames || 0) - bed.startFrame
        ),
        gainDb: bed.duckingDb,
      }))
      .filter((range) => range.endFrame > range.startFrame && bedEnd > bed.startFrame);
    delete bed.duckingDb;
  }

  // Deterministic hygiene: no sub-5s exposed windows, no text overlays on
  // top of maps, dark-segment title handoffs. See lib/timelineNormalize.js.
  const { timeline: normalized, log: normLog } = normalizeMasterTimeline({
    fps: FPS,
    width: 1920,
    height: 1080,
    style: style || 'chronicle',
    clips,
    narration,
    music,
    soundEffects,
    ...(filmTreatment ? { filmTreatment } : {}),
    overlays,
    tailFrames: 30,
  });
  for (const line of normLog) job.log.push(`normalize: ${line}`);

  return { workDir, props: { timeline: normalized } };
}

async function runRender(
  job,
  jobId,
  sessionId,
  studio,
  style,
  slug,
  soundEffectsVolume,
  backgroundMusicVolume,
  filmTreatment
) {
  try {
    job.stage = 'staging';
    const { workDir, props } = await buildMasterTimeline(
      studio,
      sessionId,
      style,
      jobId,
      job,
      soundEffectsVolume,
      backgroundMusicVolume,
      filmTreatment
    );
    const propsPath = path.join(workDir, 'timeline.json');
    await fs.writeFile(propsPath, JSON.stringify(props, null, 2));

    job.stage = 'rendering';
    const outPath = path.join(workDir, 'final.mp4');
    const concurrency = Math.max(2, Math.min(8, Math.floor(os.cpus().length / 2)));
    const args = [
      'remotion',
      'render',
      'src/modules/remotion-docmaster/remotion-entry.ts',
      'DocumentaryMaster',
      outPath,
      `--props=${propsPath}`,
      '--codec=h264',
      `--concurrency=${concurrency}`,
    ];
    job.log.push(`npx ${args.join(' ')}`);
    const proc = spawn('npx', args, { cwd: STORYFORGE_PATH, env: process.env });
    job.proc = proc;

    let stderrTail = '';
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      const m = [...s.matchAll(/Rendered (\d+)\/(\d+)/g)].pop();
      if (m) {
        job.progress = Math.min(99, Math.round((Number(m[1]) / Number(m[2])) * 100));
      }
      const lines = s.trim().split('\n').filter(Boolean);
      if (lines.length) job.log.push(lines[lines.length - 1].slice(0, 200));
      if (job.log.length > 300) job.log.splice(0, job.log.length - 300);
    });
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-4000);
    });

    const code = await new Promise((resolve) => proc.on('close', resolve));
    if (job.status === 'canceled') return;
    if (code !== 0) {
      throw new Error(`remotion exited ${code}: ${stderrTail.slice(-1200)}`);
    }

    job.stage = 'finalizing';
    const finalDir = path.join(OUTPUT_ROOT, sessionId, 'final');
    await fs.mkdir(finalDir, { recursive: true });
    const safeSlug = (slug || 'documentary').replace(/[^a-z0-9-_]+/gi, '_').slice(0, 80);
    const versionStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalName = `${safeSlug}-${versionStamp}.mp4`;
    const finalPath = path.join(finalDir, finalName);
    await fs.copyFile(outPath, finalPath);
    // clean the staged workspace but keep timeline.json for debugging
    const entries = await fs.readdir(workDir);
    for (const e of entries) {
      if (e !== 'timeline.json') await fs.rm(path.join(workDir, e), { force: true });
    }

    job.progress = 100;
    job.status = 'completed';
    job.stage = 'done';
    job.output = `/api/session/${sessionId}/files/final/${finalName}`;
    job.log.push(`final film → output/${sessionId}/final/${finalName}`);
  } catch (err) {
    job.status = 'failed';
    job.error = String(err.message || err);
    job.log.push(`FAILED: ${job.error}`);
  }
}

router.post('/start', async (req, res) => {
  const {
    sessionId,
    timeline,
    style,
    slug,
    soundEffectsVolume,
    backgroundMusicVolume,
    filmTreatment,
  } = req.body || {};
  if (!sessionId || !timeline?.items?.length) {
    return res.status(400).json({ error: 'sessionId and timeline.items required' });
  }
  try {
    await fs.access(STORYFORGE_PATH);
  } catch {
    return res.status(500).json({
      error: `StoryForge repo not found at ${STORYFORGE_PATH} — set STORYFORGE_PATH in backend/.env`,
    });
  }
  const jobId = newJobId(sessionId);
  const job = {
    sessionId,
    status: 'running',
    progress: 0,
    stage: 'queued',
    log: [],
    output: null,
    error: null,
    proc: null,
  };
  jobs.set(jobId, job);
  runRender(
    job,
    jobId,
    sessionId,
    timeline,
    style,
    slug,
    normalizeSoundEffectsVolume(soundEffectsVolume),
    normalizeBackgroundMusicVolume(backgroundMusicVolume),
    normalizeFilmTreatment(filmTreatment)
  );
  res.json({ jobId });
});

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  res.json(jobPublic(job));
});

router.get('/history/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!sessionId || safeSessionLabel(sessionId) !== sessionId) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  const finalDir = path.join(OUTPUT_ROOT, sessionId, 'final');
  try {
    const entries = await fs.readdir(finalDir, { withFileTypes: true });
    const history = await Promise.all(entries
      .filter(entry => entry.isFile() && safeRenderFileName(entry.name))
      .map(async entry => {
        const stat = await fs.stat(path.join(finalDir, entry.name));
        return {
          name: entry.name,
          url: `/api/session/${sessionId}/files/final/${encodeURIComponent(entry.name)}`,
          size: stat.size,
          createdAt: stat.mtime.toISOString(),
        };
      }));
    history.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return res.json({ history });
  } catch (error) {
    if (error?.code === 'ENOENT') return res.json({ history: [] });
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/history/:sessionId/:fileName', async (req, res) => {
  const sessionId = req.params.sessionId;
  const fileName = safeRenderFileName(req.params.fileName);
  if (!fileName || !sessionId || safeSessionLabel(sessionId) !== sessionId) {
    return res.status(400).json({ error: 'invalid render target' });
  }
  try {
    await fs.unlink(path.join(OUTPUT_ROOT, sessionId, 'final', fileName));
    return res.json({ ok: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return res.status(404).json({ error: 'render not found' });
    return res.status(500).json({ error: error.message });
  }
});

router.delete('/history/:sessionId', async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!sessionId || safeSessionLabel(sessionId) !== sessionId) {
    return res.status(400).json({ error: 'invalid session id' });
  }
  const finalDir = path.join(OUTPUT_ROOT, sessionId, 'final');
  try {
    const entries = await fs.readdir(finalDir, { withFileTypes: true });
    const targets = entries.filter(entry => entry.isFile() && safeRenderFileName(entry.name));
    await Promise.all(targets.map(entry => fs.unlink(path.join(finalDir, entry.name))));
    return res.json({ ok: true, deleted: targets.length });
  } catch (error) {
    if (error?.code === 'ENOENT') return res.json({ ok: true, deleted: 0 });
    return res.status(500).json({ error: error.message });
  }
});

router.post('/cancel/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'unknown job' });
  job.status = 'canceled';
  job.stage = 'canceled';
  if (job.proc) {
    try {
      job.proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  res.json({ ok: true });
});

export default router;
