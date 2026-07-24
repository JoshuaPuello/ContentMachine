import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DIRECTOR_MUSIC_ROOT = path.resolve(
  __dirname,
  '..',
  'assets',
  'director-music',
  'true-crime'
);
const MANIFEST_PATH = path.join(DIRECTOR_MUSIC_ROOT, 'manifest.json');

const MOOD_ALIASES = {
  suspense: 'suspense',
  mystery: 'mystery',
  'cold-open': 'cold-open',
  investigative: 'investigative',
  procedural: 'procedural',
  neutral: 'neutral',
  uncertainty: 'uncertainty',
  pressure: 'pressure',
  danger: 'danger',
  escalation: 'escalation',
  'human-cost': 'human-cost',
  human: 'human-cost',
  reflective: 'reflective',
  somber: 'somber',
  aftermath: 'aftermath',
  resolution: 'resolution',
};

let cachedManifest;

export function loadDirectorMusicManifest() {
  if (!cachedManifest) {
    cachedManifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  }
  return cachedManifest;
}

export function publicDirectorMusicCatalog() {
  return loadDirectorMusicManifest().tracks.map((track) => ({
    id: track.id,
    name: track.name,
    description: track.description,
    roles: track.roles,
    moods: track.moods,
    intensity: track.intensity,
    provider: track.provider,
    model: track.model,
    duration_seconds: track.analysis.duration_seconds,
    waveform_peaks: track.analysis.waveform_peaks,
    integrated_lufs: track.analysis.integrated_lufs,
    url: `/api/director/music/file/${encodeURIComponent(track.id)}`,
  }));
}

export function findDirectorMusicTrack(trackId) {
  const track = loadDirectorMusicManifest().tracks.find((entry) => entry.id === trackId);
  if (!track) return null;
  return {
    ...track,
    absolutePath: path.join(DIRECTOR_MUSIC_ROOT, track.file),
    url: `/api/director/music/file/${encodeURIComponent(track.id)}`,
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function normalizeMood(value, fallback = 'investigative') {
  return MOOD_ALIASES[String(value || '').toLowerCase()] || fallback;
}

function authoredVolume(track) {
  // Normalize every generated bed toward -30 LUFS before the project master
  // is applied. This keeps the quiet and loud generations perceptually
  // consistent while leaving narration clearly in front.
  const measured = Number(track.analysis?.integrated_lufs);
  const adjustmentDb = Number.isFinite(measured) ? -30 - measured : -6;
  return Number(Math.max(0.24, Math.min(0.9, 10 ** (adjustmentDb / 20))).toFixed(4));
}

function chooseTrack({ mood, role, seed, usedIds }) {
  const catalog = loadDirectorMusicManifest().tracks;
  const normalizedMood = normalizeMood(mood);
  const roleMatches = catalog.filter((track) => track.roles.includes(role));
  const pool = (roleMatches.length ? roleMatches : catalog)
    .map((track) => ({
      track,
      score:
        (track.moods.includes(normalizedMood) ? 8 : 0)
        + (track.roles.includes(role) ? 4 : 0)
        + (usedIds.has(track.id) ? -5 : 0),
    }))
    .sort((a, b) => b.score - a.score || a.track.id.localeCompare(b.track.id));
  const bestScore = pool[0]?.score ?? 0;
  const finalists = pool.filter((candidate) => candidate.score === bestScore);
  return finalists[hashString(seed) % Math.max(1, finalists.length)]?.track || catalog[0];
}

function decorateCue(cue, index, storyTitle, usedIds) {
  const role = cue.section === 'opening'
    ? 'opening'
    : cue.role === 'ending'
      ? 'ending'
      : cue.role || 'chapter';
  const requested = findDirectorMusicTrack(cue.track_id);
  const track = requested || chooseTrack({
    mood: cue.mood,
    role,
    seed: `${storyTitle}:${cue.id || index}:${cue.mood}:${role}`,
    usedIds,
  });
  usedIds.add(track.id);
  return {
    ...cue,
    id: cue.id || `score-${index + 1}`,
    mood: normalizeMood(cue.mood, cue.section === 'opening' ? 'cold-open' : 'investigative'),
    intensity: ['low', 'medium', 'high'].includes(cue.intensity) ? cue.intensity : 'low',
    track_id: track.id,
    track_name: track.name,
    asset_url: track.url || `/api/director/music/file/${encodeURIComponent(track.id)}`,
    track_duration_seconds: track.analysis.duration_seconds,
    waveform_peaks: track.analysis.waveform_peaks,
    authored_volume: authoredVolume(track),
  };
}

function fallbackStoryCues(sceneCount, chapters) {
  if (chapters?.length >= 2) {
    return chapters.map((chapter, index) => {
      const next = chapters[index + 1];
      const last = index === chapters.length - 1;
      return {
        id: `score-chapter-${index + 1}`,
        section: 'story',
        role: last ? 'ending' : 'chapter',
        start_scene: chapter.start_scene,
        end_scene: next ? next.start_scene - 1 : sceneCount,
        mood: last ? 'aftermath' : index === 0 ? 'investigative' : 'pressure',
        intensity: last ? 'low' : index === 0 ? 'low' : 'medium',
        reason: last
          ? 'The final chapter needs a restrained accounting rather than a musical climax.'
          : 'The chapter receives one stable narration-safe dramatic bed.',
      };
    });
  }
  if (sceneCount <= 4) {
    return [{
      id: 'score-story-1',
      section: 'story',
      role: 'chapter',
      start_scene: 1,
      end_scene: sceneCount,
      mood: 'investigative',
      intensity: 'low',
      reason: 'A short film benefits from one stable bed instead of frequent music changes.',
    }];
  }
  const handoff = Math.max(2, Math.ceil(sceneCount * 0.72));
  return [
    {
      id: 'score-story-1',
      section: 'story',
      role: 'chapter',
      start_scene: 1,
      end_scene: handoff - 1,
      mood: 'investigative',
      intensity: 'low',
      reason: 'A neutral investigative bed supports the main factual development.',
    },
    {
      id: 'score-story-2',
      section: 'story',
      role: 'ending',
      start_scene: handoff,
      end_scene: sceneCount,
      mood: 'aftermath',
      intensity: 'low',
      reason: 'The closing movement shifts to consequence and final accounting.',
    },
  ];
}

export function sanitizeDirectorScore(rawScore, {
  sceneCount,
  chapters,
  storyTitle,
  enabled = true,
} = {}) {
  if (!enabled) {
    return {
      enabled: false,
      strategy: 'Background music disabled in project settings.',
      crossfade_seconds: 2.2,
      narration_duck_db: -3.5,
      cues: [],
      library: publicDirectorMusicCatalog(),
    };
  }
  const validScene = (value) => Number.isFinite(Number(value))
    && Number(value) >= 1
    && Number(value) <= sceneCount;
  const authored = (rawScore?.cues || [])
    .filter((cue) => validScene(cue.start_scene))
    .slice(0, 5)
    .map((cue, index, source) => {
      const nextStart = Number(source[index + 1]?.start_scene);
      const start = Math.round(Number(cue.start_scene));
      const requestedEnd = validScene(cue.end_scene)
        ? Math.round(Number(cue.end_scene))
        : Number.isFinite(nextStart)
          ? Math.round(nextStart) - 1
          : sceneCount;
      return {
        id: cue.id || `score-story-${index + 1}`,
        section: 'story',
        role: cue.role,
        start_scene: start,
        end_scene: Math.max(start, Math.min(sceneCount, requestedEnd)),
        mood: normalizeMood(cue.mood),
        intensity: cue.intensity,
        reason: String(cue.reason || '').slice(0, 240),
        track_id: cue.track_id,
      };
    })
    .sort((a, b) => a.start_scene - b.start_scene);

  const storyCues = authored.length ? authored : fallbackStoryCues(sceneCount, chapters);
  const opening = {
    id: 'score-opening',
    section: 'opening',
    role: 'opening',
    mood: normalizeMood(rawScore?.opening_mood, 'cold-open'),
    intensity: 'medium',
    reason: 'One continuous cold-open bed carries the trailer, title, chapter overview, and first handoff.',
  };
  const usedIds = new Set();
  const cues = [opening, ...storyCues].map((cue, index) =>
    decorateCue(cue, index, storyTitle, usedIds)
  );
  return {
    enabled: true,
    strategy: String(rawScore?.strategy || 'Continuous narration-safe underscore with changes only at genuine act or chapter turns.').slice(0, 400),
    crossfade_seconds: 2.2,
    narration_duck_db: -3.5,
    cues,
    library: publicDirectorMusicCatalog(),
  };
}

export function directorMusicPromptCatalog() {
  const compact = publicDirectorMusicCatalog().map((track) => ({
    id: track.id,
    name: track.name,
    roles: track.roles,
    moods: track.moods,
    intensity: track.intensity,
    duration_seconds: Math.round(track.duration_seconds),
  }));
  return JSON.stringify(compact);
}
