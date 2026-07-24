/**
 * The Director — smart placement pipeline.
 *
 * POST /api/director/plan       → placement plan (maps/motion graphics/
 *                                 lower-thirds/chips/titles/chapters/trailer)
 *                                 via collaborating editorial skills
 * POST /api/director/map/start  → generate one map segment (job)
 * GET  /api/director/map/status/:jobId
 */
import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { callClaude, extractJsonBlock, safeParseJSON } from './claude.js';
import { generateMapSegment } from '../lib/mapAgent.js';
import { sanitizeMotionGraphics } from '../lib/motionGraphics.js';
import { AceStepSfxClient, materializeCueOptions } from '../lib/aceStepSfx.js';
import { ChainedSfxClient, ElevenLabsSfxClient } from '../lib/elevenLabsSfx.js';
import {
  attachDirectorElementSoundDesign,
  directorSoundDesignOwners,
} from '../lib/directorElementCatalog.js';
import {
  directorMusicPromptCatalog,
  findDirectorMusicTrack,
  publicDirectorMusicCatalog,
  sanitizeDirectorScore,
} from '../lib/directorMusicCatalog.js';

const router = express.Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIRECTOR_SKILL = path.resolve(
  __dirname, '..', '..', '.claude', 'skills', 'documentary-director', 'SKILL.md'
);
const MOTION_GRAPHICS_SKILL = path.resolve(
  __dirname, '..', '..', '.claude', 'skills', 'motion-graphics-director', 'SKILL.md'
);
const OUTPUT_ROOT = path.resolve(__dirname, '..', '..', 'output');

const mapJobs = new Map();
const safePathSegment = (value) => /^[a-zA-Z0-9_-]+$/.test(String(value || ''))
  ? String(value)
  : null;

router.get('/music/catalog', (_req, res) => {
  try {
    res.json({ tracks: publicDirectorMusicCatalog() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/music/file/:trackId', (req, res) => {
  const track = findDirectorMusicTrack(req.params.trackId);
  if (!track) return res.status(404).json({ error: 'Unknown Director music track' });
  res.type('audio/mpeg').sendFile(track.absolutePath);
});

router.post('/sfx/materialize', async (req, res) => {
  try {
    const { sessionId, plan: rawPlan, motionGraphics, optionCount = 2 } = req.body || {};
    const inputPlan = rawPlan || { motion_graphics: motionGraphics };
    if (!safePathSegment(sessionId) || !Array.isArray(inputPlan?.motion_graphics)) {
      return res.status(400).json({ error: 'valid sessionId and Director plan are required' });
    }
    const keys = req.app.get('apiKeys') || {};
    const elevenLabs = new ElevenLabsSfxClient({ apiKey: keys.elevenlabs || process.env.ELEVENLABS_API_KEY });
    const aceStep = new AceStepSfxClient();
    const preferAce = process.env.DIRECTOR_SFX_PROVIDER === 'ace-step';
    const client = new ChainedSfxClient(preferAce
      ? [aceStep, elevenLabs]
      : [elevenLabs, aceStep]);
    if (!client.configured) {
      return res.json({
        plan: inputPlan,
        motionGraphics: inputPlan.motion_graphics,
        logs: ['Director sound design skipped: no sound-effects provider is configured'],
        warning: 'Configure ELEVENLABS_API_KEY or ACESTEP_API_KEY',
      });
    }

    const cloned = structuredClone(inputPlan);
    const queue = [];
    for (const owner of directorSoundDesignOwners(cloned)) {
      const cues = owner.sound_design?.cues || [];
      for (const cue of cues.slice(0, 2)) {
        if (!cue.description || queue.length >= 32) continue;
        queue.push({ owner, cue });
      }
      if (queue.length >= 32) break;
    }

    const logs = [];
    // Two cloud generations at a time keeps the Director responsive without
    // flooding the provider or making the accepted/rejected audit unreadable.
    const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (queue.length) {
        const entry = queue.shift();
        const sourceCueId = entry.cue.id;
        const result = await materializeCueOptions({
          cue: {
            ...entry.cue,
            id: `${entry.owner.id}-${sourceCueId}`,
          },
          sessionId,
          outputRoot: OUTPUT_ROOT,
          optionCount: Math.max(1, Math.min(3, Number(optionCount) || 2)),
          maxAttempts: 3,
          client,
          onProgress: (line) => logs.push(line),
        });
        Object.assign(entry.cue, result, {
          id: sourceCueId,
          generated_asset_id: result.id,
        });
      }
    });
    await Promise.all(workers);

    for (const owner of directorSoundDesignOwners(cloned)) {
      const ready = (owner.sound_design?.cues || []).some((cue) => cue.status === 'ready');
      if (owner.sound_design) owner.sound_design.enabled = ready;
    }
    res.json({ plan: cloned, motionGraphics: cloned.motion_graphics, logs });
  } catch (err) {
    console.error('director sfx materialize failed:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

/** Structural validation of the director plan; drops invalid entries
 * rather than failing the whole plan (restraint bias). */
export function sanitizePlan(plan, sceneCount, options) {
  const out = {
    maps: [],
    motion_graphics: [],
    lower_thirds: [],
    date_chips: [],
    title_cards: [],
  };
  const inScene = (n) => Number.isFinite(n) && n >= 1 && n <= sceneCount;

  for (const m of plan?.maps ?? []) {
    if (!inScene(m.after_scene) || !m.request) continue;
    m.duration_seconds = Math.max(10, Math.min(30, Number(m.duration_seconds) || 18));
    m.request.duration_seconds = m.duration_seconds;
    out.maps.push(m);
  }
  const totalDurationSeconds = Object.values(options?.audioDurations || {})
    .reduce((sum, duration) => sum + (Number(duration) || 0), 0);
  // Mechanical restraint: at most one map per full minute, never more
  // than four. A two-minute documentary therefore cannot accidentally launch
  // four heavyweight map agents and appear frozen for most of an hour.
  const mapCap = Math.max(1, Math.min(4, Math.floor(totalDurationSeconds / 60) || 1));
  out.maps = out.maps.slice(0, mapCap);

  for (const lt of plan?.lower_thirds ?? []) {
    if (!inScene(lt.scene_number) || !lt.text) continue;
    lt.duration_seconds = Math.max(4, Math.min(9, Number(lt.duration_seconds) || 6));
    lt.at_seconds_into_scene = Math.max(0, Number(lt.at_seconds_into_scene) || 1);
    out.lower_thirds.push(lt);
  }
  for (const dc of plan?.date_chips ?? []) {
    if (!inScene(dc.scene_number) || !dc.text) continue;
    dc.duration_seconds = Math.max(4, Math.min(9, Number(dc.duration_seconds) || 6));
    dc.corner = ['tl', 'tr', 'bl', 'br'].includes(dc.corner) ? dc.corner : 'tr';
    out.date_chips.push(dc);
  }
  for (const tc of plan?.title_cards ?? []) {
    if (!inScene(tc.after_scene) || !tc.text) continue;
    tc.duration_seconds = Math.max(3, Math.min(7, Number(tc.duration_seconds) || 5));
    out.title_cards.push(tc);
  }
  out.title_cards = out.title_cards.slice(0, 1);

  if (options?.chaptersEnabled) {
    const chapterSource = options.cinemaBlueprint?.chapters || plan?.chapters || [];
    const chapters = chapterSource
      .filter((c) => c.title && inScene(c.start_scene) && c.portrait_prompt)
      .sort((a, b) => a.start_scene - b.start_scene)
      .slice(0, 5);
    if (chapters.length >= 2 && chapters[0].start_scene === 1) out.chapters = chapters;
  }

  const motionGraphics = sanitizeMotionGraphics(
    plan?.motion_graphics ?? [],
    sceneCount,
    {
      audioDurations: options?.audioDurations,
      maps: out.maps,
      titleCards: out.title_cards,
      chapters: out.chapters,
      openingFocalMoment: !!options?.trailerEnabled,
    }
  );
  out.motion_graphics = motionGraphics.items;
  out.motion_graphics_audit = motionGraphics.audit;
  // Every text the plan will show as a screen overlay is reserved: the map
  // author must not repeat it as map typography (observed failure: a date
  // chip AND a marker plaque both saying "24 MARCH 1944").
  const reservedTexts = [
    ...out.date_chips.map((dc) => dc.text),
    ...out.lower_thirds.flatMap((lt) => [lt.text, lt.subtitle]),
    ...out.title_cards.map((tc) => tc.text),
  ].filter((text) => typeof text === 'string' && text.trim());
  for (const m of out.maps) {
    m.request.reserved_overlay_texts = [...new Set(reservedTexts)];
  }

  if (options?.trailerEnabled) {
    const blueprintTrailer = options.cinemaBlueprint?.trailer;
    const shotSource = blueprintTrailer?.candidate_scenes?.map(scene_number => ({ scene_number }))
      || plan?.trailer?.shots
      || [];
    const shots = shotSource
      .filter((s) => inScene(s.scene_number))
      .slice(0, 8);
    if (shots.length >= 3) {
      out.trailer = {
        shots,
        title: blueprintTrailer?.title || plan?.trailer?.title || '',
        subtitle: blueprintTrailer?.subtitle || plan?.trailer?.subtitle || '',
      };
    }
  }
  out.score = sanitizeDirectorScore(plan?.score, {
    sceneCount,
    chapters: out.chapters,
    storyTitle: options?.storyTitle,
    enabled: options?.backgroundMusicEnabled !== false,
  });
  return attachDirectorElementSoundDesign(out);
}

router.post('/plan', async (req, res) => {
  try {
    const { scenePlan, sceneBreakdown, audioDurations, storyTitle, options, cinemaBlueprint } = req.body || {};
    const scenes = scenePlan?.scenes || scenePlan || [];
    if (!scenes.length) return res.status(400).json({ error: 'scenePlan required' });

    // default to the local Claude CLI (the Director's native brain)
    req.body.provider = req.body.provider || 'claude-cli';
    req.body.model = req.body.model || 'opus';
    const [skill, motionGraphicsSkill] = await Promise.all([
      fs.readFile(DIRECTOR_SKILL, 'utf8'),
      fs.readFile(MOTION_GRAPHICS_SKILL, 'utf8'),
    ]);
    const systemPrompt =
      skill +
      `\n\n## Runtime request settings\nchapters_enabled: ${!!options?.chaptersEnabled}\ntrailer_enabled: ${!!options?.trailerEnabled}\nstyle: ${options?.style || 'chronicle'}\n` +
      `background_music_enabled: ${options?.backgroundMusicEnabled !== false}\n` +
      `Available reusable true-crime underscore catalog:\n${directorMusicPromptCatalog()}\n` +
      `A pre-audio cinema blueprint may be supplied. Its chapter titles/boundaries and trailer candidates are canonical because narration has already been recorded; never rename or repartition them.\nRespond with the JSON contract only.`;

    const context = {
      story_title: storyTitle,
      total_scenes: scenes.length,
      scenes: scenes.map((s) => ({
        scene_number: s.scene_number ?? s.sceneNumber,
        description: s.visual_description ?? s.description ?? s.scene_description,
        duration_seconds: audioDurations?.[String(s.scene_number ?? s.sceneNumber)] ?? s.duration,
      })),
      narration: (sceneBreakdown ?? []).map((b) => ({
        scene: b.scene_number ?? b.scene_id,
        lines: (b.lines ?? []).join(' ').slice(0, 600),
      })),
      cinema_blueprint: cinemaBlueprint || null,
    };

    // Placement planning is a compact JSON task. It should normally complete
    // in well under a minute; three minutes is a generous hard ceiling and
    // prevents the Editor from presenting an endless spinner.
    const motionGraphicsPrompt =
      motionGraphicsSkill +
      `\n\n## Runtime request settings\nstyle: ${options?.style || 'chronicle'}\n` +
      `Analyze the supplied narration and scene context. The reference catalog is guidance, not a boundary. ` +
      `Choose, adapt, or invent only the motion graphics that materially improve this film. ` +
      `Respond with the JSON contract only.`;

    // Overall editorial placement and specialist visual direction are
    // independent analyses, so run them together. A visual-direction failure
    // must never discard the main Director's valid map/chapter/title plan.
    const [mainResult, graphicsResult] = await Promise.allSettled([
      callClaude(req, systemPrompt, JSON.stringify(context), {
        ignoreSystemOverride: true,
        timeoutMs: 180_000,
      }),
      callClaude(req, motionGraphicsPrompt, JSON.stringify(context), {
        ignoreSystemOverride: true,
        timeoutMs: 180_000,
      }),
    ]);
    if (mainResult.status === 'rejected') throw mainResult.reason;
    const parsed = safeParseJSON(extractJsonBlock(mainResult.value));
    if (!parsed) return res.status(502).json({ error: 'Director returned unparseable output' });
    const graphicsParsed = graphicsResult.status === 'fulfilled'
      ? safeParseJSON(extractJsonBlock(graphicsResult.value))
      : null;
    parsed.motion_graphics = graphicsParsed?.motion_graphics || [];
    if (graphicsResult.status === 'rejected') {
      parsed.director_warnings = [
        ...(parsed.director_warnings || []),
        `Motion Graphics Director unavailable: ${graphicsResult.reason?.message || graphicsResult.reason}`,
      ];
    } else if (!graphicsParsed) {
      parsed.director_warnings = [
        ...(parsed.director_warnings || []),
        'Motion Graphics Director returned unparseable output; the main cinema plan was preserved.',
      ];
    }

    const plan = sanitizePlan(parsed, scenes.length, {
      ...options,
      cinemaBlueprint,
      audioDurations,
      storyTitle,
    });
    plan.director_warnings = parsed.director_warnings || [];
    res.json({ plan });
  } catch (err) {
    console.error('director plan failed:', err);
    const message = String(err.message || err);
    res.status(/timed out/i.test(message) ? 504 : 500).json({ error: message });
  }
});

router.post('/map/start', (req, res) => {
  const { request, durationSeconds, style, sessionId, model, models, mapId } = req.body || {};
  if (!request || !sessionId) {
    return res.status(400).json({ error: 'request and sessionId required' });
  }
  if (!safePathSegment(sessionId) || (mapId && !safePathSegment(mapId))) {
    return res.status(400).json({ error: 'invalid sessionId or mapId' });
  }
  const jobId = `map_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const job = { status: 'running', log: [], trace: null, result: null, error: null };
  mapJobs.set(jobId, job);
  generateMapSegment({
    request,
    durationSeconds,
    style,
    sessionId,
    model: model || 'opus',
    models,
    mapId: mapId || jobId,
    onLog: (line, transient) => {
      if (
        transient
        && job.log.length
        && /^(?:render \d+\/|map-author waiting)/.test(job.log[job.log.length - 1])
      ) {
        job.log[job.log.length - 1] = line;
      } else {
        job.log.push(line);
      }
      if (job.log.length > 100) job.log.splice(0, job.log.length - 100);
    },
    onTrace: (trace) => { job.trace = trace; },
  })
    .then((result) => {
      job.status = result.status === 'needs-selection' ? 'needs-selection' : 'completed';
      job.result = result;
      job.trace = result.trace || job.trace;
      job.error = result.error || null;
    })
    .catch((err) => {
      job.status = 'failed';
      job.error = String(err.message || err);
    });
  res.json({ jobId });
});

router.get('/map/history/:sessionId/:mapId', async (req, res) => {
  const sessionId = safePathSegment(req.params.sessionId);
  const mapId = safePathSegment(req.params.mapId);
  if (!sessionId || !mapId) return res.status(400).json({ error: 'invalid sessionId or mapId' });
  try {
    const mapsDir = path.join(OUTPUT_ROOT, sessionId, 'maps');
    const names = (await fs.readdir(mapsDir))
      .filter((name) => name.startsWith(`${mapId}.run-`) && name.endsWith('.generation.json'))
      .sort();
    const histories = [];
    for (const name of names) {
      try {
        histories.push(JSON.parse(await fs.readFile(path.join(mapsDir, name), 'utf8')));
      } catch { /* an in-flight atomic replacement will be readable next poll */ }
    }
    if (!histories.length) {
      const latest = JSON.parse(await fs.readFile(path.join(mapsDir, `${mapId}.generation.json`), 'utf8'));
      histories.push(latest);
    }
    const trace = histories.at(-1);
    const options = histories.flatMap((history) => history.options || []);
    res.json({ trace, histories, options });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'No saved map generation history' });
    res.status(500).json({ error: error.message });
  }
});

router.get('/map/status/:jobId', (req, res) => {
  const job = mapJobs.get(req.params.jobId);
  if (!job) {
    return res.status(410).json({
      error: 'Map job is no longer available. The backend may have restarted; run the Director again.',
      code: 'MAP_JOB_LOST',
    });
  }
  res.json({
    status: job.status,
    log: job.log.slice(-30),
    trace: job.trace,
    result: job.result,
    error: job.error,
  });
});

export default router;
