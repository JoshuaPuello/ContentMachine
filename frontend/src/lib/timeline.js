/**
 * Studio timeline model — pure functions, no store imports.
 *
 * The timeline is the editable film plan: an ordered list of items with
 * absolute times in SECONDS. It is derived from pipeline state (scenes,
 * selected videos, measured audio), enriched by the Director plan, edited
 * by the user in the editor step, and finally sent to /api/render/start.
 *
 * TimelineItem = {
 *   id, kind, startTime, endTime, label, locked?, payload }
 * kinds: 'clip' | 'narration' | 'music' | 'map' | 'chapter-reveal' |
 *        'chapter-active' | 'motion-graphic' | 'title' | 'lower-third' |
 *        'date-chip' | 'transition' | 'sound-effect'
 */
import { parseUnitKey } from './segmentation.js';
import { transitionDefinition } from './transitionLibrary.js';

let idCounter = 0;
export const newItemId = (prefix = 'tl') =>
  `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

/** Track lane assignment for the editor UI. */
export const TRACKS = [
  { id: 'transitions', label: 'Transitions', kinds: ['transition'] },
  { id: 'picture', label: 'Picture', kinds: ['clip'] },
  { id: 'cinema', label: 'Cinema', kinds: ['map', 'chapter-reveal', 'chapter-active', 'title'] },
  { id: 'graphics', label: 'Graphics', kinds: ['motion-graphic', 'lower-third', 'date-chip'] },
  { id: 'narration', label: 'Narration', kinds: ['narration'] },
  { id: 'sfx', label: 'SFX', kinds: ['sound-effect'] },
  { id: 'music', label: 'Music', kinds: ['music'] },
];

export const trackOf = (kind) =>
  TRACKS.find((t) => t.kinds.includes(kind))?.id ?? 'graphics';

function scoreTrackCandidates(score, cue) {
  const library = score?.library || [];
  const role = cue.section === 'opening' ? 'opening' : cue.role || 'chapter';
  return library
    .map((track) => ({
      track,
      relevance:
        (track.id === cue.track_id ? 20 : 0)
        + (track.moods?.includes(cue.mood) ? 8 : 0)
        + (track.roles?.includes(role) ? 4 : 0),
    }))
    .sort((a, b) => b.relevance - a.relevance || a.track.id.localeCompare(b.track.id))
    .map(({ track }) => track);
}

/**
 * Convert the Director's semantic score into real timeline music clips.
 * Long sections are chained from compatible catalog tracks; every handoff
 * overlaps, so no project length can expose an abrupt musical cut.
 */
export function buildDirectorMusicItems({ score, sceneWindows, totalDuration }) {
  if (!score?.enabled || !score.cues?.length || totalDuration <= 0) return [];
  const crossfade = Math.max(1.2, Math.min(4, Number(score.crossfade_seconds) || 2.2));
  const narrationDuckDb = Math.max(-8, Math.min(0, Number(score.narration_duck_db) || -3.5));
  const orderedWindows = Object.entries(sceneWindows || {})
    .map(([scene, window]) => ({ scene: Number(scene), ...window }))
    .filter((window) => Number.isFinite(window.scene) && Number.isFinite(window.start) && Number.isFinite(window.end))
    .sort((a, b) => a.scene - b.scene);
  const firstWindow = orderedWindows[0];
  if (!firstWindow) return [];

  const openingCue = score.cues.find((cue) => cue.section === 'opening');
  const storyCues = score.cues
    .filter((cue) => cue.section !== 'opening' && sceneWindows?.[cue.start_scene])
    .sort((a, b) => a.start_scene - b.start_scene);
  const openingCarry = Math.min(10, Math.max(4, (firstWindow.end - firstWindow.start) * 0.45));
  const openingEnd = openingCue
    ? Math.min(totalDuration, firstWindow.start + openingCarry)
    : firstWindow.start;
  const spans = [];
  if (openingCue && openingEnd > 0.5) {
    spans.push({ cue: openingCue, start: 0, end: openingEnd });
  }
  storyCues.forEach((cue, index) => {
    const boundary = sceneWindows[cue.start_scene].start;
    const next = storyCues[index + 1];
    const nextBoundary = next ? sceneWindows[next.start_scene]?.start : totalDuration;
    const start = index === 0 && openingCue
      ? Math.max(0, openingEnd - crossfade)
      : Math.max(0, boundary - crossfade / 2);
    const end = next
      ? Math.min(totalDuration, (nextBoundary ?? totalDuration) + crossfade / 2)
      : totalDuration;
    if (end - start > 0.5) spans.push({ cue, start, end });
  });
  if (!storyCues.length && openingCue && openingEnd < totalDuration) {
    spans[0].end = totalDuration;
  }

  const items = [];
  let lastTrackId = null;
  for (const span of spans) {
    const candidates = scoreTrackCandidates(score, span.cue);
    if (!candidates.length) continue;
    let cursor = span.start;
    let part = 0;
    while (cursor < span.end - 0.1) {
      const eligible = candidates.filter((track) => track.id !== lastTrackId);
      const track = (eligible.length ? eligible : candidates)[part % Math.max(1, eligible.length || candidates.length)];
      const sourceDuration = Math.max(3, Number(track.duration_seconds || span.cue.track_duration_seconds) || 60);
      const segmentEnd = Math.min(span.end, cursor + sourceDuration);
      const duration = segmentEnd - cursor;
      const isFirst = items.length === 0;
      const isFinal = segmentEnd >= totalDuration - 0.05;
      items.push({
        id: newItemId('music'),
        kind: 'music',
        startTime: cursor,
        endTime: segmentEnd,
        label: `Score · ${track.name || span.cue.track_name || 'Documentary underscore'}`,
        payload: {
          src: track.url || span.cue.asset_url,
          trackId: track.id || span.cue.track_id,
          trackName: track.name || span.cue.track_name,
          provider: track.provider,
          model: track.model,
          role: span.cue.role,
          mood: span.cue.mood,
          reason: span.cue.reason,
          volume: Number.isFinite(span.cue.authored_volume)
            ? span.cue.authored_volume
            : 0.5,
          fadeInSeconds: isFirst ? 1.6 : crossfade,
          fadeOutSeconds: isFinal ? 3.5 : crossfade,
          duckingDb: narrationDuckDb,
          waveformPeaks: track.waveform_peaks || span.cue.waveform_peaks || [],
          auto: true,
          muted: false,
        },
      });
      lastTrackId = track.id;
      if (segmentEnd >= span.end - 0.1) break;
      cursor = Math.max(cursor + 0.5, segmentEnd - crossfade);
      part += 1;
    }
  }
  return items;
}

/**
 * Derive the base film (clips + narration) from pipeline state.
 *
 * sceneOrder: array of scene numbers in story order
 * sceneAudio: { [sceneId]: { url, durationSeconds } } keyed the way the
 *   audio step stores it (sceneId like 's01' or scene number — pass a
 *   resolve function)
 * sceneSegments: { [sceneNumber]: [{ segmentIndex, targetDuration,
 *   clipDuration, playbackRate }] }
 * selectedVideos: { ['scene_segment']: { url, playback_rate, ... } }
 *
 * Returns { items, sceneWindows: { [sceneNumber]: { start, end } },
 *           totalDuration }
 */
export function deriveBaseTimeline({ sceneOrder, sceneAudioBySceneNumber, sceneSegments, selectedVideos }) {
  const items = [];
  const sceneWindows = {};
  let cursor = 0;

  for (const sceneNumber of sceneOrder) {
    const audio = sceneAudioBySceneNumber?.[sceneNumber];
    const segments = sceneSegments?.[sceneNumber] ?? [];
    const sceneStart = cursor;

    // scene length = measured audio if present, else sum of segment targets
    const segSum = segments.reduce((s, seg) => s + (seg.targetDuration || 0), 0);
    const sceneLen = audio?.durationSeconds || segSum || 8;

    if (audio?.url) {
      const audioParts = audio.parts?.length
        ? audio.parts
        : [{ src: audio.url, durationSeconds: sceneLen }];
      const measuredTotal = audioParts.reduce(
        (sum, part) => sum + (part.durationSeconds || 0),
        0
      );
      let narrationCursor = sceneStart;
      audioParts.forEach((part, index) => {
        const duration = measuredTotal > 0
          ? (part.durationSeconds || sceneLen / audioParts.length)
          : sceneLen / audioParts.length;
        if (!part.src || duration <= 0) return;
        items.push({
          id: newItemId('nar'),
          kind: 'narration',
          startTime: narrationCursor,
          endTime: narrationCursor + duration,
          label: audioParts.length > 1
            ? `Scene ${sceneNumber} narration · ${index + 1}`
            : `Scene ${sceneNumber} narration`,
          locked: true,
          payload: { src: part.src, sceneNumber, partIndex: index },
        });
        narrationCursor += duration;
      });
    }

    let clipCursor = sceneStart;
    for (const seg of segments) {
      const key = `${sceneNumber}_${seg.segmentIndex}`;
      const vid = selectedVideos?.[key];
      const dur = seg.targetDuration || seg.clipDuration || 6;
      if (vid?.url) {
        items.push({
          id: newItemId('clip'),
          kind: 'clip',
          startTime: clipCursor,
          endTime: clipCursor + dur,
          label: `S${sceneNumber} · shot ${seg.segmentIndex + 1}`,
          payload: {
            src: vid.url,
            sceneNumber,
            segmentIndex: seg.segmentIndex,
            playbackRate: vid.playback_rate ?? seg.playbackRate ?? 1,
            // A transition is a visible timeline object authored by the
            // Director. Base footage therefore starts with honest hard cuts.
            transitionIn: 'cut',
          },
        });
      }
      clipCursor += dur;
    }

    cursor = sceneStart + Math.max(sceneLen, clipCursor - sceneStart);
    sceneWindows[sceneNumber] = { start: sceneStart, end: cursor };
  }

  return { items, sceneWindows, totalDuration: cursor };
}

const spokenWordCount = (line) => String(line || '')
  .trim()
  .split(/\s+/)
  .filter(Boolean)
  .length;

/**
 * Turn narration-script [SFX:...] markers into real timeline audio items.
 * The marker's position among the scene's spoken words determines its offset
 * inside the Whisper/measured scene window, so cues remain attached to the
 * exact narrative beat as scene durations change.
 */
export function buildNarrationSfxItems({
  ttsScript,
  scenePlan,
  sceneWindows,
  sfxAudio,
  sceneAudio,
}) {
  const sceneNumberById = Object.fromEntries(
    (scenePlan?.scenes || []).map(scene => [scene.scene_id, scene.scene_number])
  );
  const units = ttsScript?.scene_breakdown || [];
  const items = [];

  for (const unit of units) {
    const sceneNumber = unit.scene_number ?? sceneNumberById[unit.scene_id];
    const window = sceneWindows?.[sceneNumber];
    if (!window) continue;
    const lines = Array.isArray(unit.lines) ? unit.lines : [];
    const spokenLines = lines.filter(line => !String(line).startsWith('['));
    const whisperWords = sceneAudio?.[unit.scene_id]?.wordTimings || [];
    const measuredParts = (sceneAudio?.[unit.scene_id]?.parts || [])
      .filter(part => part.type === 'audio' && Number(part.durationSeconds) > 0);
    const totalWords = Math.max(1, lines
      .filter(line => !String(line).startsWith('['))
      .reduce((sum, line) => sum + spokenWordCount(line), 0));
    let wordsBefore = 0;

    lines.forEach((line, lineIndex) => {
      const cue = String(line || '');
      if (!cue.startsWith('[SFX:')) {
        if (!cue.startsWith('[')) wordsBefore += spokenWordCount(cue);
        return;
      }
      const asset = sfxAudio?.[cue];
      if (!asset?.audio) return;
      const sceneDuration = Math.max(0.5, window.end - window.start);
      const wordFraction = Math.max(0, Math.min(1, wordsBefore / totalWords));
      const spokenLinesBefore = lines
        .slice(0, lineIndex)
        .filter(candidate => !String(candidate).startsWith('['))
        .length;
      const measuredOffset = measuredParts.length >= spokenLines.length
        ? measuredParts
            .slice(0, spokenLinesBefore)
            .reduce((sum, part) => sum + Number(part.durationSeconds), 0)
        : null;
      const previousWord = whisperWords.find(word => word.wordIndex === wordsBefore - 1);
      const nextWord = whisperWords.find(word => word.wordIndex === wordsBefore);
      const whisperOffset = previousWord && nextWord
        ? (Number(previousWord.endSeconds) + Number(nextWord.startSeconds)) / 2
        : nextWord
          ? Math.max(0, Number(nextWord.startSeconds) - 0.12)
          : previousWord
            ? Number(previousWord.endSeconds)
            : null;
      const startTime = Math.min(
        window.end - 0.08,
        window.start + (
          Number.isFinite(whisperOffset)
            ? whisperOffset
            : Number.isFinite(measuredOffset)
            ? measuredOffset
            : wordFraction * sceneDuration
        )
      );
      const requestedDuration = Math.max(0.25, Number(asset.durationSeconds) || 3);
      items.push({
        id: newItemId('sfx'),
        kind: 'sound-effect',
        startTime,
        endTime: startTime + requestedDuration,
        label: cue.replace(/^\[SFX:|\]$/g, '').replace(/_/g, ' '),
        payload: {
          src: asset.audio,
          cue,
          prompt: asset.prompt || '',
          sceneNumber,
          lineIndex,
          source: 'narration-cue',
          volume: Number.isFinite(Number(asset.volume)) ? Number(asset.volume) : 0.28,
        },
      });
    });
  }
  return items;
}

/** Shift every item at or after `fromTime` by `delta` seconds. */
export function shiftItems(items, fromTime, delta) {
  return items.map((it) =>
    it.startTime >= fromTime - 1e-6
      ? { ...it, startTime: it.startTime + delta, endTime: it.endTime + delta }
      : it
  );
}

/**
 * Apply a Director plan to a base timeline. Returns new items array.
 * Full-frame cinema moments (maps, stingers, titles) are INSERTED into the
 * film: everything after their insert point shifts right so no narration
 * is covered... EXCEPT maps, which by design play OVER continuing
 * narration (no shift). Stingers/titles shift because narration pauses.
 */
export function applyDirectorPlan({
  baseItems,
  sceneWindows,
  plan,
  chapters,
  storyTitle,
  cinemaAudio = {},
  graphicTextScales = {},
}) {
  let items = [...baseItems];

  const addNarrationParts = ({ unit, startTime, label, cinemaUnitId }) => {
    if (!unit?.src || !unit.durationSeconds) return;
    const parts = unit.parts?.length
      ? unit.parts
      : [{ src: unit.src, durationSeconds: unit.durationSeconds }];
    const measuredTotal = parts.reduce(
      (sum, part) => sum + (part.durationSeconds || 0),
      0
    );
    let cursor = startTime;
    parts.forEach((part, index) => {
      const duration = measuredTotal > 0
        ? (part.durationSeconds || unit.durationSeconds / parts.length)
        : unit.durationSeconds / parts.length;
      if (!part.src || duration <= 0) return;
      items.push({
        id: newItemId('nar'),
        kind: 'narration',
        startTime: cursor,
        endTime: cursor + duration,
        label: parts.length > 1 ? `${label} · ${index + 1}` : label,
        locked: true,
        payload: { src: part.src, cinemaUnitId, partIndex: index },
      });
      cursor += duration;
    });
  };

  const insertWithShift = (item) => {
    const dur = item.endTime - item.startTime;
    items = shiftItems(items, item.startTime, dur);
    items.push(item);
  };

  // 1. Trailer cold open at t=0 (shots referencing selected clips are
  //    resolved by the caller into payload.srcs before building this item).
  if (plan?.trailerItems?.length) {
    const trailerVoice = cinemaAudio['cinema:trailer'];
    let t = 0;
    const introItems = [];
    for (const shot of plan.trailerItems) {
      introItems.push({
        id: newItemId('intro'),
        kind: 'clip',
        startTime: t,
        endTime: t + shot.duration,
        label: `Intro · S${shot.sceneNumber}`,
        payload: {
          src: shot.src,
          playbackRate: 1,
          transitionIn: t === 0 ? 'cut' : 'dip',
          volume: 0,
          intro: true,
        },
      });
      t += shot.duration;
    }
    // The title blooms over the final seconds of the narrated montage. This
    // preserves the elegant reveal without creating a separate silent block.
    const titleDur = Math.min(5, t);
    items = shiftItems(items, 0, t);
    items.push(...introItems);
    if (trailerVoice?.src && trailerVoice.durationSeconds > 0) {
      addNarrationParts({
        unit: trailerVoice,
        startTime: 0,
        label: 'Trailer voiceover',
        cinemaUnitId: 'cinema:trailer',
      });
    }
    items.push({
      id: newItemId('title'),
      kind: 'title',
      startTime: t - titleDur,
      endTime: t,
      label: 'Title',
      payload: {
        text: plan.trailer?.title || storyTitle || '',
        subtitle: plan.trailer?.subtitle || '',
        intro: true,
        soundDesign: plan.trailer?.sound_design,
      },
    });
    // scene windows shift too
    for (const k of Object.keys(sceneWindows)) {
      sceneWindows[k] = {
        start: sceneWindows[k].start + t,
        end: sceneWindows[k].end + t,
      };
    }
  }

  // 2. Chapter reveal after intro (or at start), active stingers at chapter starts
  if (chapters?.length) {
    const overviewAudio = chapters.map((_, index) => cinemaAudio[`cinema:overview:${index + 1}`]);
    const firstTransitionAudio = cinemaAudio['cinema:transition:1'];
    const activationCues = [];
    let revealDur = 0;
    for (let index = 0; index < overviewAudio.length; index++) {
      const unit = overviewAudio[index];
      activationCues.push({ index, offset: revealDur + (unit?.speechStartSeconds || 0) });
      revealDur += unit?.durationSeconds || 0;
    }
    if (firstTransitionAudio) {
      activationCues.push({ index: 0, offset: revealDur + (firstTransitionAudio.speechStartSeconds || 0) });
      revealDur += firstTransitionAudio.durationSeconds || 0;
    }
    // Chapter 1 selection is part of the overview itself. Keeping its five
    // seconds inside the reveal prevents a full-screen sequence reset between
    // "all chapters" and the first selected chapter while preserving the
    // existing total timeline duration.
    const firstSceneStart = Math.min(...Object.values(sceneWindows).map((w) => w.start));
    const reveal = {
      id: newItemId('chrev'),
      kind: 'chapter-reveal',
      startTime: firstSceneStart,
      endTime: firstSceneStart + revealDur,
      label: 'Chapters',
      payload: {
        chapters: chapters.map((c) => ({ title: c.title, image: c.image })),
        activationCues,
        soundDesign: plan.chapter_overview_sound_design,
      },
    };
    insertWithShift(reveal);
    let narrationCursor = firstSceneStart;
    for (let index = 0; index < overviewAudio.length; index++) {
      const unit = overviewAudio[index];
      if (!unit?.src || !unit.durationSeconds) continue;
      addNarrationParts({
        unit,
        startTime: narrationCursor,
        label: `Chapter overview · ${index + 1}`,
        cinemaUnitId: `cinema:overview:${index + 1}`,
      });
      narrationCursor += unit.durationSeconds;
    }
    if (firstTransitionAudio?.src && firstTransitionAudio.durationSeconds) {
      addNarrationParts({
        unit: firstTransitionAudio,
        startTime: narrationCursor,
        label: 'Chapter 1 transition',
        cinemaUnitId: 'cinema:transition:1',
      });
    }
    for (const k of Object.keys(sceneWindows)) {
      sceneWindows[k] = {
        start: sceneWindows[k].start + revealDur,
        end: sceneWindows[k].end + revealDur,
      };
    }
    // insert in start_scene order so shifts accumulate correctly
    const sorted = [...chapters].sort((a, b) => a.start_scene - b.start_scene);
    // Chapter 1 is selected during the reveal's final phase. Later chapters
    // retain their standalone active stingers at their scene boundaries.
    for (let i = 1; i < sorted.length; i++) {
      const ch = sorted[i];
      const win = sceneWindows[ch.start_scene];
      if (!win) continue;
      const transitionVoice = cinemaAudio[`cinema:transition:${i + 1}`];
      const activeDur = transitionVoice?.durationSeconds || 0;
      if (activeDur <= 0) continue;
      const item = {
        id: newItemId('chact'),
        kind: 'chapter-active',
        startTime: win.start,
        endTime: win.start + activeDur,
        label: `Ch. ${i + 1}`,
        payload: {
          chapters: chapters.map((c) => ({ title: c.title, image: c.image })),
          activeIndex: i,
          soundDesign: ch.sound_design,
        },
      };
      insertWithShift(item);
      addNarrationParts({
        unit: transitionVoice,
        startTime: win.start,
        label: `Chapter ${i + 1} transition`,
        cinemaUnitId: `cinema:transition:${i + 1}`,
      });
      for (const k of Object.keys(sceneWindows)) {
        if (sceneWindows[k].start >= win.start - 1e-6) {
          sceneWindows[k] = {
            start: sceneWindows[k].start + activeDur,
            end: sceneWindows[k].end + activeDur,
          };
        }
      }
    }
  }

  // 3. Maps: play OVER the film (no shift). Placement law:
  //    - the map belongs to the first clip playing in its anchor scene and
  //      enters ~2s after that clip starts (a beat of clean footage first)
  //    - it spans at most two clips
  //    - it runs at most ~7s, but never exits within 2s of the hosting
  //      clip's own end — a map-out immediately followed by a cut reads as
  //      a glitch, so it holds to the clip boundary instead.
  const MAP_ENTRY_DELAY = 2;
  const MAP_MAX_SECONDS = 7;
  const MAP_MIN_CLIP_TAIL = 2;
  const clipsForMaps = items
    .filter(item => item.kind === 'clip')
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime);
  for (const m of plan?.maps ?? []) {
    const win = sceneWindows[m.after_scene];
    if (!win) continue;
    const requested = Math.min(MAP_MAX_SECONDS, m.duration_seconds || MAP_MAX_SECONDS);
    const ownerIndex = clipsForMaps.findIndex(clip => clip.endTime > win.start + 1e-6);
    const owner = ownerIndex >= 0 ? clipsForMaps[ownerIndex] : null;
    const second = ownerIndex >= 0 ? clipsForMaps[ownerIndex + 1] : null;
    let start;
    let end;
    if (owner) {
      const ownerLength = owner.endTime - owner.startTime;
      start = Math.max(win.start, owner.startTime + Math.min(MAP_ENTRY_DELAY, ownerLength / 2));
      const lastReachable = second ? second.endTime : owner.endTime;
      end = Math.min(start + requested, lastReachable);
      const host = second && end > second.startTime + 1e-6 ? second : owner;
      if (end < host.endTime - 1e-6 && host.endTime - end < MAP_MIN_CLIP_TAIL) {
        end = Math.min(host.endTime, lastReachable);
      }
    } else {
      start = Math.max(win.start, win.end - requested);
      end = start + requested;
    }
    if (end - start < 3) {
      // Degenerate clip layout (tiny shots): fall back to the scene tail.
      start = Math.max(win.start, win.end - requested);
      end = start + requested;
    }
    const hint = m.request?.presentation_hint;
    items.push({
      id: m.id || newItemId('map'),
      kind: 'map',
      startTime: start,
      endTime: end,
      label: `Map · ${m.request?.subject?.slice(0, 30) ?? 'segment'}`,
      payload: {
        src: m.src || null,
        posterUrl: m.posterUrl || null,
        request: m.request,
        status: m.src ? 'ready' : 'pending',
        mapModels: m.mapModels || { ideation: 'opus', executor: 'opus' },
        mapOptions: m.options || [],
        selectedOptionId: m.selectedOptionId || null,
        presentation: ['split', 'corner', 'full', 'inset'].includes(hint) ? hint : (m.presentation || null),
      },
    });
  }

  // 4. Agentic motion graphics play over continuing narration. The Director
  //    owns their duration, pace, layout, background, and presentation; the
  //    backend arbiter has already enforced spacing/collision/coverage laws.
  for (const graphic of plan?.motion_graphics ?? []) {
    const win = sceneWindows[graphic.scene_number];
    if (!win) continue;
    const duration = Math.min(
      graphic.duration_seconds,
      Math.max(0, win.end - win.start)
    );
    if (duration < 0.5) continue;
    const start = Math.min(
      win.start + (graphic.at_seconds_into_scene ?? 0),
      win.end - duration
    );
    items.push({
      id: graphic.id || newItemId('mg'),
      kind: 'motion-graphic',
      startTime: Math.max(win.start, start),
      endTime: Math.max(win.start, start) + duration,
      label: `Motion · ${graphic.composition?.content?.title || graphic.intent || graphic.category}`,
      payload: {
        spec: graphic,
        presentation: graphic.presentation,
        soundDesign: graphic.sound_design,
      },
    });
  }

  // 5. Lower thirds + date chips (over the film, no shift)
  for (const lt of plan?.lower_thirds ?? []) {
    const win = sceneWindows[lt.scene_number];
    if (!win) continue;
    const start = Math.min(win.start + (lt.at_seconds_into_scene ?? 1), win.end - lt.duration_seconds);
    items.push({
      id: newItemId('lt'),
      kind: 'lower-third',
      startTime: start,
      endTime: start + lt.duration_seconds,
      label: lt.text,
      payload: {
        text: lt.text,
        subtitle: lt.subtitle,
        textScale: graphicTextScales.lowerThird ?? 1.18,
        soundDesign: lt.sound_design,
      },
    });
  }
  for (const dc of plan?.date_chips ?? []) {
    const win = sceneWindows[dc.scene_number];
    if (!win) continue;
    items.push({
      id: newItemId('dc'),
      kind: 'date-chip',
      startTime: win.start + 0.5,
      endTime: Math.min(win.end, win.start + 0.5 + dc.duration_seconds),
      label: dc.text,
      payload: {
        text: dc.text,
        corner: dc.corner,
        textScale: graphicTextScales.dateChip ?? 1.22,
        soundDesign: dc.sound_design,
      },
    });
  }
  for (const tc of plan?.title_cards ?? []) {
    const win = sceneWindows[tc.after_scene];
    if (!win) continue;
    const item = {
      id: newItemId('tc'),
      kind: 'title',
      startTime: win.end,
      endTime: win.end + tc.duration_seconds,
      label: tc.text,
      payload: { text: tc.text, subtitle: tc.subtitle, soundDesign: tc.sound_design },
    };
    insertWithShift(item);
    for (const k of Object.keys(sceneWindows)) {
      if (sceneWindows[k].start >= win.end - 1e-6) {
        sceneWindows[k] = {
          start: sceneWindows[k].start + tc.duration_seconds,
          end: sceneWindows[k].end + tc.duration_seconds,
        };
      }
    }
  }

  // 6. First-class transitions point at the exact outgoing/incoming clips.
  // They do not shift narration or scene timing; preview and render derive the
  // same blend from this single timeline object.
  const clips = items
    .filter(item => item.kind === 'clip' && item.payload?.src)
    .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
  for (const transition of plan?.transitions ?? []) {
    const beforeScene = Number(transition.before_scene)
    const beforeSegment = Number.isFinite(Number(transition.before_segment_index))
      ? Number(transition.before_segment_index)
      : 0
    const toIndex = clips.findIndex(clip => (
      Number(clip.payload?.sceneNumber) === beforeScene
      && Number(clip.payload?.segmentIndex || 0) === beforeSegment
    ))
    if (toIndex <= 0) continue
    const fromClip = clips[toIndex - 1]
    const toClip = clips[toIndex]
    const definition = transitionDefinition(transition.type)
    const requested = Number(transition.duration_seconds) || definition.defaultDuration
    const duration = Math.max(0.25, Math.min(1.2, requested, (toClip.endTime - toClip.startTime) * 0.45))
    items.push({
      id: transition.id || newItemId('tr'),
      kind: 'transition',
      startTime: toClip.startTime,
      endTime: toClip.startTime + duration,
      label: definition.label,
      payload: {
        type: definition.id,
        fromClipId: fromClip.id,
        toClipId: toClip.id,
        reason: transition.reason || '',
        authoredBy: 'director',
        soundDesign: transition.sound_design,
      },
    })
  }

  const totalDuration = items.reduce((max, item) => Math.max(max, item.endTime), 0);
  items.push(...buildDirectorMusicItems({
    score: plan?.score,
    sceneWindows,
    totalDuration,
  }));

  items.sort((a, b) => a.startTime - b.startTime || a.id.localeCompare(b.id));
  return { items, sceneWindows };
}

export function timelineTotalDuration(items) {
  return items.reduce((m, it) => Math.max(m, it.endTime), 0);
}

/** Validate/normalize items before render: clamp negatives, drop zero-length. */
export function normalizeTimeline(items) {
  return items
    .filter((it) => it.endTime - it.startTime > 0.05)
    .map((it) => ({
      ...it,
      startTime: Math.max(0, Math.round(it.startTime * 1000) / 1000),
      endTime: Math.max(0.1, Math.round(it.endTime * 1000) / 1000),
    }))
    .sort((a, b) => a.startTime - b.startTime);
}
