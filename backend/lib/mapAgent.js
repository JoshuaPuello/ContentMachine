/**
 * Map-author agent pipeline.
 *
 * Turns a Director map request into a rendered epic-map MP4:
 *   1. claude -p (default opus) with the map-author skill as system prompt
 *   2. projection-aware validation (coverage, focus occupancy, legibility)
 *   3. bake only real ISO-backed territory sprites
 *   4. render representative proof frames and review them locally
 *   5. feed any failures back to the author (max 3 attempts total)
 *   6. render the accepted MP4 + poster
 */
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { callClaudeCli, extractJsonBlock, safeParseJSON } from '../routes/claude.js';
import {
  MAP_REGION,
  cameraAt,
  coverageErrors,
  focusErrors,
  geoToScreen,
  labelScreenBox,
  minimumCoverageZoom,
  viewportAt,
} from './mapQuality.js';
import { repairPlan } from './mapRepair.js';
import { applyCongestionStrategy } from './mapCongestion.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_ROOT = path.resolve(__dirname, '..', '..', 'output');

export const STORYFORGE_PATH =
  process.env.STORYFORGE_PATH ||
  path.join(os.homedir(), 'IdeaProjects', 'Personal', 'storyforge');

const SKILL_PATH = path.resolve(__dirname, '..', '..', '.claude', 'skills', 'map-author', 'SKILL.md');
const GEOMETRY_PATH = path.join(STORYFORGE_PATH, 'public', 'epic-map', 'geometry.json');
const MAP_PUBLIC_DIR = path.join(os.tmpdir(), 'contentmachine-epic-map-public');

const FPS = 30;
// Opus map authoring is a substantially larger constrained-JSON task than the
// Director placement pass. Real runs commonly cross three minutes, so keep a
// bounded but realistic ceiling. This remains configurable for slower hosts.
const MAP_AUTHOR_ATTEMPT_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.MAP_AUTHOR_ATTEMPT_TIMEOUT_MS) || 10 * 60_000,
);
const MAP_IDEATION_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.MAP_IDEATION_TIMEOUT_MS) || 3 * 60_000,
);
const MAP_REVIEW_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.MAP_REVIEW_TIMEOUT_MS) || 3 * 60_000,
);
const IDEATION_PROMPT_VERSION = 3;

const safePathSegment = (value, fallback) => {
  const safe = String(value || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  return safe || fallback;
};

const nowIso = () => new Date().toISOString();

function createRunRecorder({ mapsDir, mapId, runId, request, durationSeconds, style, models, onTrace }) {
  const tracePath = path.join(mapsDir, `${mapId}.run-${runId}.generation.json`);
  const latestTracePath = path.join(mapsDir, `${mapId}.generation.json`);
  const trace = {
    version: 1,
    mapId,
    runId,
    status: 'running',
    startedAt: nowIso(),
    finishedAt: null,
    request: { map: request, durationSeconds, style, models, ideationPromptVersion: IDEATION_PROMPT_VERSION },
    phases: { ideation: [], execution: [], review: [] },
    events: [],
    options: [],
    recommendedOptionId: null,
    error: null,
  };
  let timer = null;
  let writes = Promise.resolve();
  const persist = () => {
    const snapshot = JSON.stringify(trace, null, 2);
    writes = writes.then(async () => {
      const temp = `${tracePath}.tmp`;
      await fs.writeFile(temp, snapshot);
      await fs.rename(temp, tracePath);
      const latestTemp = `${latestTracePath}.tmp`;
      await fs.writeFile(latestTemp, snapshot);
      await fs.rename(latestTemp, latestTracePath);
    }).catch(() => {});
    return writes;
  };
  const touch = (immediate = false) => {
    onTrace?.(trace);
    if (immediate) {
      if (timer) clearTimeout(timer);
      timer = null;
      void persist();
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void persist();
      }, 750);
    }
  };
  const event = (message, level = 'info') => {
    trace.events.push({ at: nowIso(), level, message });
    if (trace.events.length > 250) trace.events.splice(0, trace.events.length - 250);
    touch();
  };
  const finish = async (status, error = null) => {
    trace.status = status;
    trace.error = error;
    trace.finishedAt = nowIso();
    if (timer) clearTimeout(timer);
    timer = null;
    onTrace?.(trace);
    await persist();
  };
  touch(true);
  return { trace, touch, event, finish, path: tracePath };
}

async function runTracedClaude({
  collection,
  label,
  model,
  systemPrompt,
  userPrompt,
  timeoutMs,
  recorder,
  tools = '',
  addDirs = [],
  effort = 'high',
}) {
  const entry = {
    label,
    model,
    effort,
    status: 'running',
    startedAt: nowIso(),
    finishedAt: null,
    systemPrompt,
    userPrompt,
    response: '',
    error: null,
  };
  if (Array.isArray(collection)) collection.push(entry);
  recorder.touch(true);
  try {
    const raw = await callClaudeCli(model, systemPrompt, userPrompt, {
      timeoutMs,
      stream: true,
      tools,
      addDirs,
      effort,
      safeMode: true,
      noSessionPersistence: true,
      onText: (_delta, full) => {
        entry.response = full;
        recorder.touch();
      },
    });
    entry.response = raw;
    entry.status = 'completed';
    return raw;
  } catch (error) {
    entry.status = /timed out/i.test(String(error?.message || error)) ? 'timed-out' : 'failed';
    entry.error = String(error?.message || error);
    throw error;
  } finally {
    entry.finishedAt = nowIso();
    recorder.touch(true);
  }
}

const IDEATION_SYSTEM_PROMPT = `You are the senior documentary cartographic director.
Design a concise, executable narrative strategy for one map segment. THE NARRATION IS THE DRIVER: the request's narration_excerpt is the only story this map may tell — the map plays under that voiceover, and every route, marker, and beat must restate something the narration actually says. If the narration names one journey, draw one route; if it names a place, mark the place; never invent movements, destinations, or context the listener will not hear. Geography labels (countries, seas, cities) are always allowed for orientation. Use ONLY facts and locations explicitly supplied by the request; do not research, enrich, or enumerate implied stops. Simplicity is the style: aim for 1–4 routes and 1–3 markers; represent mass dispersal as a field of pulsing dots, never an arrow per participant. If reserved_overlay_texts is present, those texts already appear as screen overlays — the map must not repeat them. The downstream engine allows 2–4 phases, at most two major camera moves, a continuously drifting camera, and red/teal/neutral routes—never white. For a 10–18 second map, use 2–3 phases. Prefer close readable views and group distant outcomes symbolically instead of listing every route. Return JSON only with: summary, narrative_phases (each with purpose, locations, movement, labels, and a narration_ref quoting the exact narration words it illustrates), critical_facts, and execution_notes. Do not produce Remotion props. Maximum 600 words. This is a compact blueprint, not an essay; engine constraints always outrank creative ambition.`;

const REVIEW_SYSTEM_PROMPT = `You are a ruthless senior documentary-map quality reviewer. Use the Read tool to inspect every supplied proof PNG. Judge geographic truth, full-frame coverage, subject scale, arrow continuity, label readability, collisions, and professional finish. Return JSON only: {"pass":boolean,"summary":string,"issues":[string],"recommended":boolean}. A merely usable result does not pass; it must be publication quality.`;

const compactText = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const compactValue = (value, depth = 0) => {
  if (typeof value === 'string') return compactText(value, depth === 0 ? 900 : 420);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, depth === 0 ? 10 : 7).map((item) => compactValue(item, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, depth === 0 ? 12 : 9)
        .map(([key, item]) => [key, compactValue(item, depth + 1)])
    );
  }
  return compactText(value);
};

/** Keep the creative decisions while preventing ideation prose from becoming
 * a second giant system prompt on every executor retry. */
export const compactIdeationDirection = (direction) => {
  if (!direction || typeof direction !== 'object') return null;
  const compact = {
    summary: compactText(direction.summary, 900),
    narrative_phases: (direction.narrative_phases || []).slice(0, 4).map((phase) => compactValue(phase, 1)),
    critical_facts: (direction.critical_facts || []).slice(0, 10).map((fact) => compactValue(fact, 1)),
    execution_notes: compactValue(direction.execution_notes, 1),
  };
  // An unusually verbose object still gets a deterministic final ceiling.
  // The canonical request remains alongside it, so no factual input is lost.
  const serialized = JSON.stringify(compact);
  if (serialized.length <= 8_000) return compact;
  const slimItem = (item, max) => compactText(
    typeof item === 'string' ? item : JSON.stringify(compactValue(item, 2)),
    max,
  );
  const slimList = (value, count, max) => (
    Array.isArray(value) ? value : Object.values(value || {})
  ).slice(0, count).map((item) => slimItem(item, max));
  const strict = {
    summary: compactText(compact.summary, 700),
    narrative_phases: compact.narrative_phases.map((phase) => ({
      phase: phase?.phase,
      beat_ref: phase?.beat_ref,
      time_window_seconds: phase?.time_window_seconds,
      purpose: compactText(phase?.purpose, 220),
      locations: slimList(phase?.locations, 5, 80),
      movement: compactText(phase?.movement, 260),
      labels: slimList(phase?.labels, 4, 70),
    })),
    critical_facts: slimList(compact.critical_facts, 8, 140),
    execution_notes: slimList(compact.execution_notes, 8, 140),
  };
  return strict;
};

export const compactMapAuthorSystemPrompt = (prompt) => String(prompt || '')
  .replace(/^---[\s\S]*?---\s*/, '')
  .replace(/\n## Worked example[\s\S]*?(?=\n## Self-check)/, '\n');

/**
 * Retry context: the model can only converge if it sees the plan it is asked
 * to fix and the full history of constraints it must not reintroduce. Blind
 * "resend everything" retries oscillate (proven on map-2: error counts went
 * 11→19→6 and 10→1→2 across runs while each attempt rewrote valid sections).
 */
export const buildRetryFeedback = ({ attemptNumber, plan, errors, history }) => {
  const cumulative = [...new Set((history ?? []).flatMap((entry) => entry.errors ?? []))];
  return (
    `Previous attempt ${attemptNumber} produced this plan (JSON):\n` +
    `${JSON.stringify(plan, null, 2)}\n\n` +
    'Unresolved issues in that plan — fix these:\n' +
    errors.map((error) => `- ${error}`).join('\n') +
    '\n\nAll constraints violated across attempts so far — do not reintroduce any of them:\n' +
    cumulative.map((error) => `- ${error}`).join('\n') +
    '\n\nModify only what these issues require; keep every other field of the plan identical.'
  );
};

/** Ideation from a run that never produced a single valid plan may carry an
 * infeasible creative directive (e.g. an impossible resolution frame) — do
 * not pin it across runs. */
export const ideationReusable = (previous) =>
  previous?.status === 'completed'
  || (previous?.options?.length ?? 0) > 0
  || (previous?.phases?.execution ?? []).some(
    (entry) => entry.status === 'completed'
      && Array.isArray(entry.validationErrors)
      && entry.validationErrors.length === 0
  );

async function reusableIdeation({ mapsDir, mapId, request, durationSeconds, style, model }) {
  try {
    const previous = JSON.parse(await fs.readFile(path.join(mapsDir, `${mapId}.generation.json`), 'utf8'));
    if (!ideationReusable(previous)) return null;
    const sameRequest = JSON.stringify(previous.request?.map) === JSON.stringify(request);
    const sameSettings = Number(previous.request?.durationSeconds) === Number(durationSeconds)
      && previous.request?.style === style
      && previous.request?.models?.ideation === model
      && previous.request?.ideationPromptVersion === IDEATION_PROMPT_VERSION;
    const entry = previous.phases?.ideation?.find((phase) => (
      ['completed', 'reused'].includes(phase.status) && phase.response
    ));
    if (!sameRequest || !sameSettings || !entry) return null;
    const direction = compactIdeationDirection(safeParseJSON(extractJsonBlock(entry.response)));
    return direction ? { direction, entry, sourceRunId: previous.runId || null } : null;
  } catch {
    return null;
  }
}

async function buildSystemPrompt() {
  const skill = await fs.readFile(SKILL_PATH, 'utf8');
  let existing = [];
  try {
    const geo = JSON.parse(await fs.readFile(GEOMETRY_PATH, 'utf8'));
    existing = Object.keys(geo.variants?.archival?.highlights ?? {});
  } catch {
    /* geometry not baked yet */
  }
  // Single source of truth for the numbers the model plans against: derive
  // them from the same projection the validator measures with, so prompt and
  // validator can never drift apart again.
  const view = viewportAt({ lon: 40, lat: 40, zoom: 1 });
  const lonSpan = (view.east - view.west).toFixed(1);
  const latSpan = (view.north - view.south).toFixed(1);
  return (
    skill +
    `\n\n## Runtime facts\n\nExisting highlight names you may use without baking: ${existing.join(', ') || '(none)'}.\n` +
    `\nValidator geometry: the projected viewport bounding box spans ≈${lonSpan}°/zoom of longitude and ≈${latSpan}°/zoom of latitude — about a third wider than the nominal 43°/zoom footprint, because the tilted top edge sees farther. Focus occupancy percentages are measured against THESE spans. Small numeric misses (occupancy a point short, a label a few pixels past a margin) are repaired deterministically after authoring; prioritize composition, story completeness, and correct geography over exact screen arithmetic.\n` +
    'Respond with the JSON contract only.'
  );
}

/** Case/punctuation-insensitive comparison space for overlay-text dedup. */
const normalizeOverlayText = (value) =>
  String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const duplicatesReservedText = (text, reservedTexts) => {
  const target = normalizeOverlayText(text);
  if (!target) return null;
  for (const reserved of reservedTexts) {
    const normalized = normalizeOverlayText(reserved);
    if (normalized.length >= 4 && target.includes(normalized)) return reserved;
  }
  return null;
};

/** Mechanical validation + safe fix-ups. Returns { errors, plan }. */
export function validateAndFix(plan, durationSeconds, options = {}) {
  const errors = [];
  const reservedTexts = Array.isArray(options.reservedTexts) ? options.reservedTexts : [];
  const p = plan?.props;
  if (!p) return { errors: ['missing props object'], plan };
  if (plan.unsupported) return { errors: [`unsupported: ${plan.unsupported}`], plan };

  const dur = Math.round(durationSeconds * FPS);
  p.durationInFrames = dur;
  p.pitch = 34;
  p.rotateZ = 0;
  p.perspective = 1650;
  if (!['archival', 'atlas', 'obsidian'].includes(p.variant)) p.variant = 'archival';

  // Camera. Unlike the old fixed target bounds, viewport projection catches
  // the true trapezoidal edges created by perspective and zoom.
  if (!Array.isArray(p.camera) || p.camera.length < 2) {
    errors.push('camera must have >= 2 keyframes');
  } else {
    // rescale frames to [0, dur-1] if the author's last frame is off
    const last = p.camera[p.camera.length - 1].frame || 1;
    if (Math.abs(last - (dur - 1)) > 5) {
      const scale = (dur - 1) / Math.max(1, last);
      for (const k of p.camera) k.frame = Math.round(k.frame * scale);
      for (const f of plan.focus ?? []) f.frame = Math.round((Number(f.frame) || 0) * scale);
    }
    p.camera[0].frame = 0;
    p.camera[p.camera.length - 1].frame = dur - 1;
    // Rescaling can round two authored keyframes onto the same frame; that is
    // a rounding artifact, not an authoring error — restore strict ascent.
    for (let i = 1; i < p.camera.length; i += 1) {
      if (p.camera[i].frame <= p.camera[i - 1].frame) p.camera[i].frame = p.camera[i - 1].frame + 1;
    }
    p.camera[p.camera.length - 1].frame = dur - 1;
    for (let i = p.camera.length - 2; i > 0; i -= 1) {
      if (p.camera[i].frame >= p.camera[i + 1].frame) p.camera[i].frame = p.camera[i + 1].frame - 1;
    }
    let prev = -1;
    for (const k of p.camera) {
      if (k.frame <= prev) errors.push('camera frames must be strictly ascending');
      prev = k.frame;
      k.lon = Number(k.lon);
      k.lat = Number(k.lat);
      k.zoom = Math.max(0.5, Math.min(3.4, Number(k.zoom) || 0.8));
      if (!Number.isFinite(k.lon) || !Number.isFinite(k.lat) ||
          k.lon < MAP_REGION.lonMin || k.lon > MAP_REGION.lonMax ||
          k.lat < MAP_REGION.latMin || k.lat > MAP_REGION.latMax) {
        errors.push(`camera target outside map: ${k.lon},${k.lat}`);
      }
    }

    // Coverage is checked at every frame (a few hundred cheap projections),
    // then consecutive failing frames are aggregated into one actionable
    // error per exposure window so a fully-exposed move reads as one problem,
    // not hundreds.
    const failing = [];
    for (let frame = 0; frame <= dur - 1; frame += 1) {
      const sample = cameraAt(p.camera, frame);
      const uncovered = coverageErrors(sample);
      if (uncovered.length) failing.push({ frame, sample, uncovered });
    }
    const exposureRuns = [];
    for (const entry of failing) {
      const run = exposureRuns.at(-1);
      if (run && entry.frame === run.at(-1).frame + 1) run.push(entry);
      else exposureRuns.push([entry]);
    }
    for (const run of exposureRuns) {
      const probes = [run[0], run[Math.floor(run.length / 2)], run.at(-1)];
      let worst = probes[0];
      let worstZoom = null;
      for (const probe of probes) {
        const minZoom = minimumCoverageZoom(probe.sample);
        if (minZoom === null) {
          worst = probe;
          worstZoom = null;
          break;
        }
        if (worstZoom === null || minZoom > worstZoom) {
          worst = probe;
          worstZoom = minZoom;
        }
      }
      errors.push(
        `camera at frame ${worst.frame} exposes the finite map plane (${worst.uncovered.join(', ')}) ` +
        `during frames ${run[0].frame}–${run.at(-1).frame}. ` +
        (worstZoom
          ? `At this center use zoom >= ${worstZoom}, or shift the wide establishing center inward and move to the subject later.`
          : 'Shift the camera center inward; no allowed zoom can cover this target.')
      );
    }
  }

  // Each narrative camera phase declares the real bounds it is presenting.
  // This prevents tiny red/teal specks in a continent-wide frame and makes
  // distant subjects become separate camera moves instead of one giant view.
  plan.focus = Array.isArray(plan.focus) ? plan.focus : [];
  if (plan.focus.length === 0) errors.push('focus[] must describe 1–4 narrative subjects and their real geographic bounds');
  if (plan.focus.length > 4) errors.push('focus[] may contain at most 4 phases');
  for (const [index, focus] of plan.focus.entries()) {
    focus.frame = Math.max(0, Math.min(dur - 1, Math.round(Number(focus.frame) || 0)));
    focus.kind = focus.kind === 'establishing' ? 'establishing' : 'detail';
    if (!focus.subject) errors.push(`focus ${index + 1} needs a subject`);
    if (p.camera?.length >= 2) {
      const at = cameraAt(p.camera, focus.frame);
      for (const issue of focusErrors(focus, at)) errors.push(`focus ${index + 1} (${focus.subject || 'unnamed'}): ${issue}`);
    }
  }

  // fills reference check happens against bakes + existing at call time
  p.fills = Array.isArray(p.fills) ? p.fills : [];
  p.labels = Array.isArray(p.labels) ? p.labels : [];
  p.arrows = Array.isArray(p.arrows) ? p.arrows : [];
  p.markers = Array.isArray(p.markers) ? p.markers : [];
  p.grade = Array.isArray(p.grade) ? p.grade : [];

  if (p.labels.length < 3) errors.push(`at least 3 labels required (found ${p.labels.length})`);
  for (const l of p.labels) {
    if (!Array.isArray(l.lines) || !l.lines.length) errors.push('label missing lines[]');
    l.size = Math.max(12, Math.min(100, Number(l.size) || 30));
    l.tracking = Math.max(0.3, Math.min(0.95, Number(l.tracking) || 0.6));
    if (l.dim) {
      const window = Array.isArray(l.dim.window)
        ? l.dim.window.map((f) => Math.max(0, Math.min(dur - 1, Math.round(Number(f) || 0))))
        : null;
      if (window && window.length === 2) {
        l.dim = { window, to: Math.max(0.05, Math.min(0.9, Number(l.dim.to) || 0.25)) };
      } else {
        delete l.dim;
      }
    }
    const hasHeroFrame = Number.isFinite(Number(l.heroFrame));
    l.heroFrame = Math.max(0, Math.min(dur - 1, Math.round(Number(l.heroFrame) || 0)));
    if (!hasHeroFrame) {
      errors.push(`label needs heroFrame: ${l.lines?.join(' ')}`);
    }
    if (
      l.lon < MAP_REGION.lonMin || l.lon > MAP_REGION.lonMax ||
      l.lat < MAP_REGION.latMin || l.lat > MAP_REGION.latMax
    ) {
      errors.push(`label out of region: ${l.lines?.join(' ')}`);
    }
    const duplicatedReserved = duplicatesReservedText((l.lines ?? []).join(' '), reservedTexts);
    if (duplicatedReserved) {
      errors.push(
        `label '${l.lines?.join(' ')}' duplicates an on-screen overlay ('${duplicatedReserved}'); map-plane typography carries geography only — the overlay already says this`
      );
    }
  }
  if (p.camera?.length >= 2) {
    for (const l of p.labels) {
      const box = labelScreenBox(l, cameraAt(p.camera, l.heroFrame));
      if (box.left < 36 || box.right > 1884 || box.top < 28 || box.bottom > 1052) {
        errors.push(
          `label '${l.lines?.join(' ')}' is clipped at heroFrame ${l.heroFrame} ` +
          `(box ${Math.round(box.left)},${Math.round(box.top)}–${Math.round(box.right)},${Math.round(box.bottom)}); keep inside the 36px title-safe frame)`
        );
      }
      if (box.fontPixels < 15) {
        errors.push(`label '${l.lines?.join(' ')}' is only ${box.fontPixels.toFixed(0)}px at heroFrame ${l.heroFrame}`);
      }
    }

    const isActive = (label, frame) =>
      (!label.appear || frame >= label.appear[0]) && (!label.fade || frame <= label.fade[1]);
    // A label dimmed to near-invisibility is receded background, not a
    // collision partner — the renderer draws it as a ghost under the action.
    const dimmedOpacityAt = (label, frame) => {
      if (!label.dim) return 1;
      const lo = Math.min(label.dim.window[0], label.dim.window[1]);
      const hi = Math.max(label.dim.window[0], label.dim.window[1]);
      const to = label.dim.to ?? 0.25;
      if (frame >= lo && frame <= hi) return to;
      if (frame >= lo - 18 && frame < lo) return 1 - (1 - to) * ((frame - (lo - 18)) / 18);
      if (frame > hi && frame <= hi + 18) return to + (1 - to) * ((frame - hi) / 18);
      return 1;
    };
    const heroFrames = [...new Set(p.labels.map((label) => label.heroFrame))];
    for (const frame of heroFrames) {
      const active = p.labels
        .filter((label) => isActive(label, frame))
        .map((label) => ({ label, box: labelScreenBox(label, cameraAt(p.camera, frame)) }));
      for (let i = 0; i < active.length; i += 1) {
        for (let j = i + 1; j < active.length; j += 1) {
          const a = active[i];
          const b = active[j];
          if (dimmedOpacityAt(a.label, frame) <= 0.3 || dimmedOpacityAt(b.label, frame) <= 0.3) continue;
          const overlapW = Math.max(0, Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left));
          const overlapH = Math.max(0, Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top));
          const overlap = overlapW * overlapH;
          const smaller = Math.min(a.box.width * a.box.height, b.box.width * b.box.height);
          if (smaller > 0 && overlap / smaller > 0.12) {
            errors.push(`labels overlap at frame ${frame}: '${a.label.lines.join(' ')}' and '${b.label.lines.join(' ')}'`);
          }
        }
      }
    }
  }
  for (const a of p.arrows) {
    if (!Array.isArray(a.points) || a.points.length !== 3) {
      errors.push('arrow needs exactly 3 [lon,lat] points');
      continue;
    }
    for (const [lon, lat] of a.points) {
      if (lon < MAP_REGION.lonMin || lon > MAP_REGION.lonMax || lat < MAP_REGION.latMin || lat > MAP_REGION.latMax) {
        errors.push('arrow point out of region');
      }
    }
    if (!Array.isArray(a.grow)) a.grow = [Math.round(dur * 0.4), Math.round(dur * 0.4) + 55];
    if (Array.isArray(a.retract)) {
      a.retract = a.retract.map((f) => Math.max(0, Math.min(dur - 1, Math.round(Number(f) || 0))));
    }
    if (!['red', 'teal', 'neutral'].includes(a.color)) a.color = 'red';
  }
  if (p.arrows.length > 12) {
    errors.push(
      `too many routes (${p.arrows.length}): a narration-driven map stays simple — merge legs, drop routes the narration never mentions, or represent mass dispersal as pulsing dots instead of arrows`
    );
  }
  p.dots = Array.isArray(p.dots) ? p.dots : [];
  for (const dot of p.dots) {
    dot.lon = Number(dot.lon);
    dot.lat = Number(dot.lat);
    if (!Number.isFinite(dot.lon) || !Number.isFinite(dot.lat) ||
        dot.lon < MAP_REGION.lonMin || dot.lon > MAP_REGION.lonMax ||
        dot.lat < MAP_REGION.latMin || dot.lat > MAP_REGION.latMax) {
      errors.push(`dot outside map region: ${dot.lon},${dot.lat}`);
    }
    if (!Array.isArray(dot.appear)) dot.appear = [Math.round(dur * 0.3), Math.round(dur * 0.3) + 18];
    dot.radius = Math.max(4, Math.min(14, Number(dot.radius) || 7));
    if (!['red', 'teal', 'neutral'].includes(dot.color)) dot.color = 'neutral';
  }
  for (const marker of p.markers) {
    marker.lon = Number(marker.lon);
    marker.lat = Number(marker.lat);
    marker.radius = Math.max(9, Math.min(28, Number(marker.radius) || 16));
    if (marker.lon < MAP_REGION.lonMin || marker.lon > MAP_REGION.lonMax ||
        marker.lat < MAP_REGION.latMin || marker.lat > MAP_REGION.latMax) {
      errors.push('marker outside map region');
    }
    if (!Array.isArray(marker.appear)) marker.appear = [Math.round(dur * 0.2), Math.round(dur * 0.2) + 24];
    if (!['red', 'teal'].includes(marker.color)) marker.color = 'red';
    marker.label = String(marker.label ?? '').trim().slice(0, 24);
    marker.detail = String(marker.detail ?? '').trim().slice(0, 38) || undefined;
    // Overlay dedup: a plaque detail repeating a scheduled overlay text (a
    // date chip, a lower third) is redundant chrome — drop it silently. A
    // duplicated LABEL means the marker itself is mis-authored: hard error.
    if (marker.detail && duplicatesReservedText(marker.detail, reservedTexts)) {
      delete marker.detail;
    }
    const reservedLabelHit = duplicatesReservedText(marker.label, reservedTexts);
    if (reservedLabelHit) {
      errors.push(
        `marker label '${marker.label}' duplicates an on-screen overlay ('${reservedLabelHit}'); name the PLACE instead — the overlay already carries that text`
      );
    }
    const hasHeroFrame = Number.isFinite(Number(marker.heroFrame));
    marker.heroFrame = Math.max(0, Math.min(dur - 1, Math.round(Number(marker.heroFrame) || 0)));
    if (!marker.label) errors.push('every marker needs a short label so the viewer knows what the point represents');
    if (!hasHeroFrame) errors.push(`marker '${marker.label || 'unnamed'}' needs heroFrame`);
    if (p.camera?.length >= 2) {
      const point = geoToScreen(marker.lon, marker.lat, cameraAt(p.camera, marker.heroFrame));
      if (point.x < 64 || point.x > 1856 || point.y < 64 || point.y > 1016) {
        errors.push(
          `marker '${marker.label || 'unnamed'}' dot is outside the safe frame at heroFrame ${marker.heroFrame} ` +
          `(${Math.round(point.x)},${Math.round(point.y)}); pick a heroFrame where the dot is on screen or reframe the camera — the callout card places itself automatically`
        );
      }
    }
  }

  // Every route must END at something the viewer can read: a marker plaque,
  // a pulsing dot, a nearby map label, or a continuation leg. An arrow into
  // unlabeled emptiness leaves the audience blind about what it just watched.
  for (const [index, arrow] of p.arrows.entries()) {
    const end = arrow.points?.[2];
    if (!end || end.length !== 2 || !Number.isFinite(end[0]) || !Number.isFinite(end[1])) continue;
    const nearMarker = p.markers.some(
      (marker) => Math.hypot(marker.lon - end[0], marker.lat - end[1]) <= 1.2
    );
    const nearDot = p.dots.some(
      (dot) => Math.hypot(dot.lon - end[0], dot.lat - end[1]) <= 1.2
    );
    const nearLabel = p.labels.some(
      (label) => Math.hypot(Number(label.lon) - end[0], Number(label.lat) - end[1]) <= 3.0
    );
    const continues = p.arrows.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        Array.isArray(other.points?.[0]) &&
        Math.hypot(other.points[0][0] - end[0], other.points[0][1] - end[1]) <= 0.5
    );
    if (!nearMarker && !nearDot && !nearLabel && !continues) {
      errors.push(
        `route ${index + 1} ends unexplained at (${end[0]}, ${end[1]}): give the destination a marker, a dot, or a nearby label so the viewer knows what the movement reached`
      );
    }
  }

  // Normalize uninterrupted route legs into an exact geometric join. The
  // renderer suppresses the intermediate head and preserves a smooth tangent;
  // a named marker at the join intentionally keeps the stop visible.
  for (let index = 0; index < p.arrows.length - 1; index += 1) {
    const current = p.arrows[index];
    const next = p.arrows[index + 1];
    const end = current.points?.[2];
    const start = next.points?.[0];
    if (!end || !start) continue;
    const joinDistance = Math.hypot(end[0] - start[0], end[1] - start[1]);
    const narratedStop = p.markers.some((marker) =>
      Math.hypot(marker.lon - end[0], marker.lat - end[1]) < 0.4
    );
    const timingIsContinuous = next.grow[0] - current.grow[1] <= 20;
    const sameFaction = (current.color || 'red') === (next.color || 'red');
    if (joinDistance < 0.35 && !narratedStop && timingIsContinuous && sameFaction) {
      next.points[0] = [...end];
    }
  }

  // bakes
  const bakes = Array.isArray(plan.bakes) ? plan.bakes : [];
  for (const b of bakes) {
    if (!b.name || !/^[a-z0-9-]+$/.test(b.name)) errors.push(`bad bake name: ${b.name}`);
    if (!['red', 'teal'].includes(b.color)) errors.push(`bake color must be red|teal: ${b.name}`);
    b.ids = (b.ids ?? []).map((id) => String(id).padStart(3, '0'));
    if (!b.ids.length) errors.push(`bake ${b.name} has no ISO country ids`);
    if (b.polys?.length) {
      errors.push(
        `bake ${b.name} uses an unverified custom polygon. Generated polygons are disabled because straight or invented borders are not factual; use ISO-backed country ids, or markers/arrows for local events.`
      );
    }
  }
  plan.bakes = bakes;
  return { errors, plan };
}

async function runBakes(bakes, variant, log) {
  for (const b of bakes) {
    const args = [
      'tools/epic-map/bake-highlight.mjs',
      '--name', b.name,
      '--color', b.color,
      '--variants', variant,
    ];
    if (b.ids?.length) args.push('--ids', b.ids.join(','));
    if (b.polys?.length) args.push('--polys', JSON.stringify(b.polys));
    log(`baking highlight ${b.name} (${b.color})`);
    await execFileAsync('node', args, { cwd: STORYFORGE_PATH, maxBuffer: 8 * 1024 * 1024 });
  }
}

async function ensureMapPublicDir() {
  await fs.mkdir(MAP_PUBLIC_DIR, { recursive: true });
  const stagedMapDir = path.join(MAP_PUBLIC_DIR, 'epic-map');
  try {
    const stat = await fs.lstat(stagedMapDir);
    if (stat.isSymbolicLink()) await fs.unlink(stagedMapDir);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // Remotion's public-file server does not reliably follow directory
  // symlinks after a bundle cache invalidation. Keep a real synchronized
  // map-only public directory: still much smaller than copying every video
  // and upload in StoryForge's full public tree.
  await fs.cp(
    path.join(STORYFORGE_PATH, 'public', 'epic-map'),
    stagedMapDir,
    { recursive: true, force: true }
  );
}

function runRemotion(args, log) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'npx',
      ['remotion', ...args, `--public-dir=${MAP_PUBLIC_DIR}`],
      { cwd: STORYFORGE_PATH, env: process.env }
    );
    let stderrTail = '';
    proc.stdout.on('data', (d) => {
      const m = [...d.toString().matchAll(/Rendered (\d+)\/(\d+)/g)].pop();
      if (m) log(`render ${m[1]}/${m[2]}`, true);
    });
    proc.stderr.on('data', (d) => {
      stderrTail = (stderrTail + d.toString()).slice(-3000);
    });
    proc.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`remotion exited ${code}: ${stderrTail.slice(-800)}`))
    );
    proc.on('error', reject);
  });
}

function proofFrames(plan) {
  const duration = plan.props.durationInFrames;
  const frames = [
    ...plan.focus.map((focus) => focus.frame),
    Math.round(duration * 0.18),
    Math.round(duration * 0.56),
    Math.round(duration * 0.84),
  ];
  return [...new Set(frames.map((frame) => Math.max(0, Math.min(duration - 1, frame))))]
    .sort((a, b) => a - b)
    .slice(0, 6);
}

async function reviewProofFrames({ plan, paths, frames }) {
  const errors = [];
  const reports = [];
  for (let i = 0; i < paths.length; i += 1) {
    const { stdout } = await execFileAsync(
      'node',
      ['tools/epic-map/review-frame.mjs', paths[i]],
      { cwd: STORYFORGE_PATH, maxBuffer: 1024 * 1024 }
    );
    const report = JSON.parse(stdout);
    reports.push({ frame: frames[i], file: paths[i], ...report });
    if (report.width !== 1920 || report.height !== 1080) {
      errors.push(`proof at frame ${frames[i]} is ${report.width}x${report.height}, expected 1920x1080`);
    }
    if (report.entropy < 4.8) {
      errors.push(`proof at frame ${frames[i]} is visually too flat (entropy ${report.entropy})`);
    }
    for (const edge of report.samples.filter((sample) => sample.name !== 'center')) {
      if (edge.stdev < 2.5) {
        errors.push(`proof at frame ${frames[i]} has a suspiciously flat ${edge.name} edge`);
      }
    }
  }

  // Re-run projection checks at the exact rendered frames so the review
  // report records what the viewer saw, not only what authoring implied.
  for (const frame of frames) {
    const at = cameraAt(plan.props.camera, frame);
    for (const issue of coverageErrors(at)) errors.push(`rendered frame ${frame}: ${issue}`);
  }
  for (const focus of plan.focus) {
    const at = cameraAt(plan.props.camera, focus.frame);
    for (const issue of focusErrors(focus, at)) {
      errors.push(`rendered focus '${focus.subject}': ${issue}`);
    }
  }
  return { pass: errors.length === 0, errors: [...new Set(errors)], frames: reports };
}

async function renderAndReviewAttempt({ plan, mapsDir, mapId, attempt, log }) {
  await ensureMapPublicDir();
  const propsPath = path.join(mapsDir, `${mapId}.attempt-${attempt}.props.json`);
  await fs.writeFile(propsPath, JSON.stringify(plan.props, null, 2));
  const frames = proofFrames(plan);
  const paths = [];
  for (const frame of frames) {
    const proofPath = path.join(mapsDir, `${mapId}.attempt-${attempt}.frame-${frame}.png`);
    log(`rendering quality proof ${paths.length + 1}/${frames.length} (frame ${frame})`);
    await runRemotion([
      'still',
      'src/modules/remotion-epic-map/remotion-entry.ts',
      'EpicMapCustom',
      proofPath,
      `--props=${propsPath}`,
      `--frame=${frame}`,
    ], log);
    paths.push(proofPath);
  }
  const review = await reviewProofFrames({ plan, paths, frames });
  await fs.writeFile(
    path.join(mapsDir, `${mapId}.attempt-${attempt}.review.json`),
    JSON.stringify(review, null, 2)
  );
  return { review, propsPath, paths, frames };
}

// Every plan that survives structural/geographic validation becomes a durable
// playable candidate before subjective review. Rejected candidates remain
// available to the editor instead of being silently discarded.
async function renderMapOption({ plan, propsPath, mapsDir, mapId, attempt, sessionId, log }) {
  const stem = `${mapId}.option-${attempt}`;
  const outMp4 = path.join(mapsDir, `${stem}.mp4`);
  const poster = path.join(mapsDir, `${stem}_poster.png`);
  log(`rendering playable option ${attempt}...`);
  await runRemotion([
    'render',
    'src/modules/remotion-epic-map/remotion-entry.ts',
    'EpicMapCustom',
    outMp4,
    `--props=${propsPath}`,
    '--codec=h264',
  ], log);
  await runRemotion([
    'still',
    'src/modules/remotion-epic-map/remotion-entry.ts',
    'EpicMapCustom',
    poster,
    `--props=${propsPath}`,
    `--frame=${Math.round((plan.props.durationInFrames || 300) * 0.6)}`,
  ], log);
  return {
    id: `${mapId.split('.run-').at(-1)}-option-${attempt}`,
    attempt,
    artifactStem: stem,
    url: `/api/session/${sessionId}/files/maps/${stem}.mp4`,
    posterUrl: `/api/session/${sessionId}/files/maps/${stem}_poster.png`,
    propsUrl: `/api/session/${sessionId}/files/maps/${mapId}.attempt-${attempt}.props.json`,
  };
}

async function promoteMapOption({ option, mapsDir, mapId, sessionId }) {
  const optionStem = option.artifactStem || `${mapId}.option-${option.attempt}`;
  await fs.copyFile(path.join(mapsDir, `${optionStem}.mp4`), path.join(mapsDir, `${mapId}.mp4`));
  await fs.copyFile(
    path.join(mapsDir, `${optionStem}_poster.png`),
    path.join(mapsDir, `${mapId}_poster.png`),
  );
  return {
    url: `/api/session/${sessionId}/files/maps/${mapId}.mp4`,
    posterUrl: `/api/session/${sessionId}/files/maps/${mapId}_poster.png`,
  };
}

async function renderFinalMap({ plan, acceptedPropsPath, mapsDir, mapId, sessionId, attempts, log }) {
  const propsPath = path.join(mapsDir, `${mapId}.props.json`);
  await fs.copyFile(acceptedPropsPath, propsPath);
  const outMp4 = path.join(mapsDir, `${mapId}.mp4`);
  const poster = path.join(mapsDir, `${mapId}_poster.png`);
  log('rendering map segment...');
  await runRemotion([
    'render',
    'src/modules/remotion-epic-map/remotion-entry.ts',
    'EpicMapCustom',
    outMp4,
    `--props=${propsPath}`,
    '--codec=h264',
  ], log);
  await runRemotion([
    'still',
    'src/modules/remotion-epic-map/remotion-entry.ts',
    'EpicMapCustom',
    poster,
    `--props=${propsPath}`,
    `--frame=${Math.round((plan.props.durationInFrames || 300) * 0.6)}`,
  ], log);
  return {
    url: `/api/session/${sessionId}/files/maps/${mapId}.mp4`,
    posterUrl: `/api/session/${sessionId}/files/maps/${mapId}_poster.png`,
    plan,
    attempts,
  };
}

async function loadExistingHighlights(variant) {
  try {
    const geo = JSON.parse(await fs.readFile(GEOMETRY_PATH, 'utf8'));
    return Object.keys(geo.variants?.[variant]?.highlights ?? {});
  } catch {
    return [];
  }
}

export function unknownFillErrorsFor(plan, existing) {
  const bakeNames = (plan.bakes ?? []).map((b) => b.name);
  return (plan.props?.fills ?? [])
    .filter((fill) => !existing.includes(fill.highlight) && !bakeNames.includes(fill.highlight))
    .map((fill) => `fill references unknown highlight '${fill.highlight}' (declare it in bakes)`);
}

async function unknownFillErrors(plan, variant) {
  return unknownFillErrorsFor(plan, await loadExistingHighlights(variant));
}

/** A run that ends with zero artifacts is undiagnosable. When every attempt
 * failed validation, render proof stills of the best near-miss so the trace
 * and the editor still get pixels. A diagnostic render failure must never
 * mask the run's real error. */
async function renderDiagnosticStills({ plan, variant, mapsDir, runMapKey, recorder, log }) {
  try {
    if (!Array.isArray(plan?.props?.camera) || plan.props.camera.length < 2) return;
    await runBakes(plan.bakes ?? [], variant, log);
    await ensureMapPublicDir();
    const propsPath = path.join(mapsDir, `${runMapKey}.diagnostic.props.json`);
    await fs.writeFile(propsPath, JSON.stringify(plan.props, null, 2));
    const frames = proofFrames(plan).slice(0, 3);
    const files = [];
    for (const frame of frames) {
      const stillPath = path.join(mapsDir, `${runMapKey}.diagnostic-frame-${frame}.png`);
      log(`rendering diagnostic still (frame ${frame})`);
      await runRemotion([
        'still',
        'src/modules/remotion-epic-map/remotion-entry.ts',
        'EpicMapCustom',
        stillPath,
        `--props=${propsPath}`,
        `--frame=${frame}`,
      ], log);
      files.push(path.basename(stillPath));
    }
    recorder.trace.diagnostics = { propsFile: path.basename(propsPath), frames: files };
    recorder.event(`Rendered ${files.length} diagnostic stills of the best rejected plan for manual review.`);
    recorder.touch(true);
  } catch (error) {
    recorder.event(`Diagnostic render failed: ${String(error?.message || error)}`, 'warning');
  }
}

/** Render a local, already-authored plan through the exact production gates. */
export async function renderValidatedMapPlan({
  plan,
  durationSeconds,
  sessionId,
  mapId = 'map',
  onLog = () => {},
}) {
  const { errors, plan: fixed } = validateAndFix(plan, durationSeconds);
  const variant = fixed?.props?.variant || 'archival';
  errors.push(...await unknownFillErrors(fixed, variant));
  if (errors.length) throw new Error(`local map plan failed validation: ${errors.join('; ')}`);

  const mapsDir = path.join(OUTPUT_ROOT, sessionId, 'maps');
  await fs.mkdir(mapsDir, { recursive: true });
  await runBakes(fixed.bakes, variant, onLog);
  const proof = await renderAndReviewAttempt({
    plan: fixed,
    mapsDir,
    mapId,
    attempt: 'local',
    log: onLog,
  });
  if (!proof.review.pass) {
    throw new Error(`local rendered-frame review failed: ${proof.review.errors.join('; ')}`);
  }
  onLog(`rendered-frame review passed (${proof.review.frames.length} proofs)`);
  return renderFinalMap({
    plan: fixed,
    acceptedPropsPath: proof.propsPath,
    mapsDir,
    mapId,
    sessionId,
    attempts: 1,
    log: onLog,
  });
}

/**
 * Generate one map segment. Returns { url, posterUrl, plan, attempts }.
 * onLog(line) receives progress lines.
 */
export async function generateMapSegment({
  request,
  durationSeconds,
  style = 'chronicle',
  sessionId,
  model = 'opus',
  models = null,
  mapId = 'map',
  onLog = () => {},
  onTrace = () => {},
}) {
  const allowedModels = new Set(['opus', 'sonnet']);
  const selectedModels = {
    ideation: allowedModels.has(models?.ideation) ? models.ideation : (allowedModels.has(model) ? model : 'opus'),
    executor: allowedModels.has(models?.executor) ? models.executor : (allowedModels.has(model) ? model : 'opus'),
    reviewer: allowedModels.has(models?.reviewer) ? models.reviewer : 'opus',
  };
  const variant = { chronicle: 'archival', heritage: 'atlas', nocturne: 'obsidian' }[style] || 'archival';
  const systemPrompt = await buildSystemPrompt();
  const dur = Math.max(8, Math.min(35, Number(durationSeconds) || 18));
  const sessionKey = safePathSegment(sessionId, 'session');
  const mapKey = safePathSegment(mapId, 'map');
  const runId = Date.now().toString(36);
  const runMapKey = `${mapKey}.run-${runId}`;
  const mapsDir = path.join(OUTPUT_ROOT, sessionKey, 'maps');
  await fs.mkdir(mapsDir, { recursive: true });
  const cachedIdeation = await reusableIdeation({
    mapsDir,
    mapId: mapKey,
    request,
    durationSeconds: dur,
    style,
    model: selectedModels.ideation,
  });
  const recorder = createRunRecorder({
    mapsDir,
    mapId: mapKey,
    runId,
    request,
    durationSeconds: dur,
    style,
    models: selectedModels,
    onTrace,
  });

  let acceptedPlan = null;
  let acceptedOption = null;
  let attempts = 0;
  let direction = null;
  let finished = false;
  // Retry context: best plan seen so far (fewest residual errors) and every
  // constraint violated by any attempt. Retries anchor on these instead of
  // regenerating blind — see buildRetryFeedback.
  let previousBest = null;
  const violationHistory = [];
  const existingHighlights = await loadExistingHighlights(variant);
  const mapRequest = { ...request, style, duration_seconds: dur, variant };
  // Texts the Director already presents as overlays (date chips, lower
  // thirds, titles) around this map's window: the map must not repeat them.
  const reservedTexts = Array.isArray(request?.reserved_overlay_texts)
    ? request.reserved_overlay_texts.filter((text) => typeof text === 'string' && text.trim())
    : [];

  try {
    if (cachedIdeation) {
      direction = cachedIdeation.direction;
      recorder.trace.phases.ideation.push({
        ...cachedIdeation.entry,
        label: 'Map narrative and geographic strategy · reused',
        status: 'reused',
        sourceRunId: cachedIdeation.sourceRunId,
      });
      recorder.trace.request.ideationHandoffChars = direction ? JSON.stringify(direction).length : 0;
      recorder.event(`Reused completed ${selectedModels.ideation} ideation from the previous identical request.`);
      onLog(`reusing completed map ideation (model: ${selectedModels.ideation})`);
      recorder.touch(true);
    } else {
      onLog(`map ideation (model: ${selectedModels.ideation})`);
      try {
        const ideationRaw = await runTracedClaude({
          collection: recorder.trace.phases.ideation,
          label: 'Map narrative and geographic strategy',
          model: selectedModels.ideation,
          systemPrompt: IDEATION_SYSTEM_PROMPT,
          userPrompt: `Map request:\n${JSON.stringify(mapRequest, null, 2)}`,
          timeoutMs: MAP_IDEATION_TIMEOUT_MS,
          recorder,
        });
        direction = compactIdeationDirection(safeParseJSON(extractJsonBlock(ideationRaw)));
        recorder.trace.request.ideationHandoffChars = direction ? JSON.stringify(direction).length : 0;
        recorder.touch(true);
        if (!direction) recorder.event('Ideation response was not parseable; executor will use the canonical request.', 'warning');
      } catch (error) {
        recorder.event(`Ideation unavailable (${error.message}); executor will use the canonical request.`, 'warning');
        onLog(`map ideation fallback: ${error.message}`);
      }
    }

    while (attempts < 3) {
      attempts += 1;
      // Retries are the hardest calls (all constraints plus every fix at
      // once): they keep full effort and the complete skill, worked example
      // included. The old latency problem was prompt bloat from verbose
      // ideation, which the compact handoff already solved.
      const effort = 'high';
      onLog(`map executor attempt ${attempts} (model: ${selectedModels.executor}, effort: ${effort})`);
      recorder.event(`Executor attempt ${attempts} started with ${selectedModels.executor} at ${effort} effort.`);
      const retryContext = previousBest
        ? buildRetryFeedback({
            attemptNumber: previousBest.attemptNumber,
            plan: previousBest.plan,
            errors: previousBest.errors,
            history: violationHistory,
          })
        : violationHistory.length
          ? 'Earlier attempts failed before producing a usable plan. Do not repeat these failures:\n' +
            [...new Set(violationHistory.flatMap((entry) => entry.errors))].map((issue) => `- ${issue}`).join('\n')
          : '';
      const userContent =
        `Map request:\n${JSON.stringify(mapRequest, null, 2)}\n` +
        (direction
          ? `\nConcise narrative guidance (the map contract and canonical request override any conflict):\n${JSON.stringify(direction, null, 2)}\n`
          : '') +
        (retryContext ? `\n${retryContext}\n` : '') +
        '\nReturn only the JSON object — no prose, no restatement of the request. The narration_excerpt is the contract: include every label, route, marker, and camera phase the NARRATION needs — and nothing it does not mention. Geography labels (countries, seas, cities) are always welcome for orientation; extra routes and markers the narration never speaks of are not. Represent mass dispersal as pulsing dots, not an arrow per escapee.';
      let raw;
      try {
        raw = await runTracedClaude({
          collection: recorder.trace.phases.execution,
          label: `Executable map plan · attempt ${attempts}`,
          model: selectedModels.executor,
          systemPrompt,
          userPrompt: userContent,
          timeoutMs: MAP_AUTHOR_ATTEMPT_TIMEOUT_MS,
          recorder,
          effort,
        });
      } catch (error) {
        if (!/timed out/i.test(String(error?.message || error))) throw error;
        const timeoutMessage = `map executor response exceeded ${Math.round(MAP_AUTHOR_ATTEMPT_TIMEOUT_MS / 1000)} seconds`;
        violationHistory.push({ attempt: attempts, errors: [timeoutMessage] });
        recorder.event(`${timeoutMessage} on attempt ${attempts}.`, 'error');
        onLog(`${timeoutMessage}; retrying within the three-attempt quality budget`);
        continue;
      }

      const execution = recorder.trace.phases.execution.at(-1);
      const parsed = safeParseJSON(extractJsonBlock(raw));
      if (!parsed) {
        violationHistory.push({ attempt: attempts, errors: ['response was not parseable JSON'] });
        execution.validationErrors = ['response was not parseable JSON'];
        recorder.touch(true);
        continue;
      }
      const { errors, plan: validated } = validateAndFix(parsed, dur, { reservedTexts });
      errors.push(...unknownFillErrorsFor(validated, existingHighlights));
      execution.validationErrors = errors;
      let fixed = validated;
      if (errors.length > 0) {
        // Deterministic repair before any model retry: bounded local
        // operators finish the author's layout when the diagnosis is
        // numeric (zoom a point short, a label a few px out, a retimable
        // collision). Only what they cannot fix goes back to the model.
        const repair = repairPlan({
          plan: validated,
          durationSeconds: dur,
          extraValidate: (candidate) => unknownFillErrorsFor(candidate, existingHighlights),
          reservedTexts,
        });
        execution.repairs = repair.log;
        execution.errorsAfterRepair = repair.errors;
        recorder.touch(true);
        for (const step of repair.log) {
          recorder.event(`repair: ${step.op} — ${step.target}: ${step.detail}`);
        }
        if (repair.errors.length > 0) {
          violationHistory.push({ attempt: attempts, errors: repair.errors });
          if (!previousBest || repair.errors.length < previousBest.errors.length) {
            previousBest = { attemptNumber: attempts, plan: repair.plan, errors: repair.errors };
          }
          onLog(`validation errors after ${repair.log.length} repair(s): ${repair.errors.join('; ')}`);
          continue;
        }
        onLog(`deterministic repair resolved ${errors.length} validation error(s) with ${repair.log.length} operation(s)`);
        fixed = repair.plan;
      }

      // Crowded-theater staging: a valid plan whose routes would render as
      // clutter is re-staged as a sequential route progression (waves,
      // retracts, endpoint dots, receding typography). Adopted only if the
      // staged plan still validates cleanly.
      const congestion = applyCongestionStrategy(fixed);
      if (congestion.log.length > 0) {
        const staged = validateAndFix(congestion.plan, dur, { reservedTexts });
        const stagedErrors = [
          ...staged.errors,
          ...unknownFillErrorsFor(staged.plan, existingHighlights),
        ];
        if (stagedErrors.length === 0) {
          fixed = staged.plan;
          execution.congestion = congestion.log;
          for (const step of congestion.log) {
            recorder.event(`congestion: ${step.op} — ${step.target}: ${step.detail}`);
          }
          onLog(`congestion staging applied ${congestion.log.length} adjustment(s) (route progression)`);
        } else {
          recorder.event(
            `Congestion staging skipped (would invalidate the plan): ${stagedErrors.join('; ')}`,
            'warning'
          );
        }
      }
      recorder.touch(true);

      await runBakes(fixed.bakes, variant, onLog);
      const proof = await renderAndReviewAttempt({
        plan: fixed,
        mapsDir,
        mapId: runMapKey,
        attempt: attempts,
        log: onLog,
      });
      const candidate = await renderMapOption({
        plan: fixed,
        propsPath: proof.propsPath,
        mapsDir,
        mapId: runMapKey,
        attempt: attempts,
        sessionId: sessionKey,
        log: onLog,
      });

      let aiReview = null;
      let aiReviewError = null;
      onLog(`quality review (model: ${selectedModels.reviewer})`);
      const reviewPrompt =
        `Inspect these proof frames:\n${proof.paths.join('\n')}\n\n` +
        `Map request:\n${JSON.stringify(mapRequest, null, 2)}\n\n` +
        `Mechanical review:\n${JSON.stringify(proof.review, null, 2)}\n\n` +
        `Executable plan:\n${JSON.stringify(fixed, null, 2)}`;
      try {
        const reviewRaw = await runTracedClaude({
          collection: recorder.trace.phases.review,
          label: `Visual quality review · option ${attempts}`,
          model: selectedModels.reviewer,
          systemPrompt: REVIEW_SYSTEM_PROMPT,
          userPrompt: reviewPrompt,
          timeoutMs: MAP_REVIEW_TIMEOUT_MS,
          recorder,
          tools: 'Read',
          addDirs: [mapsDir],
        });
        aiReview = safeParseJSON(extractJsonBlock(reviewRaw));
        if (!aiReview) aiReviewError = 'Reviewer response was not parseable JSON';
      } catch (error) {
        aiReviewError = error.message;
      }

      const reviewPass = proof.review.pass && (!aiReview || aiReview.pass !== false);
      const option = {
        ...candidate,
        status: reviewPass ? 'recommended' : 'review-rejected',
        createdAt: nowIso(),
        models: selectedModels,
        review: {
          mechanical: proof.review,
          claude: aiReview,
          claudeError: aiReviewError,
        },
      };
      recorder.trace.options.push(option);
      execution.optionId = option.id;
      execution.artifacts = {
        video: option.url,
        poster: option.posterUrl,
        props: option.propsUrl,
        proofFrames: proof.paths.map((proofPath) => path.basename(proofPath)),
      };
      recorder.touch(true);

      if (!reviewPass) {
        const issues = [
          ...proof.review.errors,
          ...(Array.isArray(aiReview?.issues) ? aiReview.issues : []),
        ];
        const reviewErrors = issues.length ? issues : ['visual reviewer rejected this option'];
        violationHistory.push({ attempt: attempts, errors: reviewErrors });
        // A rendered, reviewed plan is the strongest possible anchor for the
        // next attempt regardless of its issue count.
        previousBest = { attemptNumber: attempts, plan: fixed, errors: reviewErrors };
        onLog(`option ${attempts} retained, but review requested another attempt: ${reviewErrors.join('\n')}`);
        continue;
      }
      acceptedPlan = fixed;
      acceptedOption = option;
      recorder.trace.recommendedOptionId = option.id;
      onLog(`option ${attempts} passed mechanical and visual review`);
      break;
    }

    if (acceptedPlan && acceptedOption) {
      const canonical = await promoteMapOption({
        option: acceptedOption,
        mapsDir,
        mapId: mapKey,
        sessionId: sessionKey,
      });
      await recorder.finish('completed');
      finished = true;
      // A simple map (a place, one short movement) doesn't need the full-
      // frame takeover: the studio can open it as an inset card over the
      // still-playing scene and let it expand.
      const complexity = {
        arrows: acceptedPlan.props.arrows?.length ?? 0,
        markers: acceptedPlan.props.markers?.length ?? 0,
        dots: acceptedPlan.props.dots?.length ?? 0,
        labels: acceptedPlan.props.labels?.length ?? 0,
      };
      const suggestedPresentation =
        complexity.arrows <= 2 && complexity.markers <= 2 && complexity.dots === 0
          ? 'inset'
          : 'full';
      return {
        ...canonical,
        plan: acceptedPlan,
        attempts,
        complexity,
        suggestedPresentation,
        options: recorder.trace.options,
        selectedOptionId: acceptedOption.id,
        trace: recorder.trace,
      };
    }

    if (recorder.trace.options.length > 0) {
      const message = `No option passed review after ${attempts} attempts. Review the retained playable options or retry.`;
      await recorder.finish('needs-selection', message);
      finished = true;
      return {
        status: 'needs-selection',
        url: null,
        posterUrl: null,
        plan: null,
        attempts,
        options: recorder.trace.options,
        selectedOptionId: null,
        trace: recorder.trace,
        error: message,
      };
    }

    if (previousBest) {
      await renderDiagnosticStills({
        plan: previousBest.plan,
        variant,
        mapsDir,
        runMapKey,
        recorder,
        log: onLog,
      });
    }
    const lastErrors = violationHistory.at(-1)?.errors ?? ['no attempt produced a parseable plan'];
    throw new Error(`map-author failed after ${attempts} attempts: ${lastErrors.join('\n')}`);
  } catch (error) {
    if (!finished) await recorder.finish('failed', String(error.message || error));
    throw error;
  }
}
