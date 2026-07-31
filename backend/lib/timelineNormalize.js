/**
 * Deterministic timeline hygiene, applied after the studio timeline has been
 * converted to DocumentaryMaster frames and before the render starts.
 *
 * The editing law it enforces: nothing is ever VISIBLE for less than
 * MIN_EXPOSED_FRAMES. A "flash" — one second of a clip squeezed between a
 * map and the end of the film, or half a second of trailer footage between
 * the title dissolve and the chapter stinger — reads as a glitch, so short
 * exposed windows are closed by extending the adjacent overlay:
 *
 *   - maps extend via holdFrames (the renderer freezes the last frame and
 *     keeps a slow push going),
 *   - titles extend their duration and hand off 'to-black' when a dark
 *     segment follows,
 *   - chapter stingers are narration-locked and never resized (a warning is
 *     logged instead).
 *
 * It also drops text overlays (lower-thirds, date chips) that would sit on
 * top of a map: the map carries its own typography, and doubled text was a
 * real observed failure.
 */

export const MIN_EXPOSED_FRAMES = 150; // 5 s at 30 fps

const FULL_FRAME_KINDS = new Set(['map', 'chapter-reveal', 'chapter-active', 'title']);
const TEXT_KINDS = new Set(['lower-third', 'date-chip']);

const endOf = (item) => item.startFrame + item.durationInFrames;

function filmEndFrame(timeline) {
  let end = 0;
  for (const c of timeline.clips ?? []) end = Math.max(end, endOf(c));
  for (const o of timeline.overlays ?? []) end = Math.max(end, endOf(o));
  for (const n of timeline.narration ?? []) {
    end = Math.max(end, n.startFrame + (n.durationInFrames ?? 0));
  }
  return end;
}

/**
 * @param {object} timeline frames-based DocumentaryMaster timeline
 * @returns {{ timeline: object, log: string[] }} a normalized deep copy + log
 */
export function normalizeMasterTimeline(timeline) {
  const out = JSON.parse(JSON.stringify(timeline));
  const log = [];

  // 1. Small text overlays never share the frame with a map or focal motion
  // graphic. Both carry their own typography and hierarchy.
  const focalGraphics = out.overlays.filter(
    (o) => o.kind === 'map' || o.kind === 'motion-graphic'
  );
  out.overlays = out.overlays.filter((o) => {
    if (!TEXT_KINDS.has(o.kind)) return true;
    const clash = focalGraphics.find((graphic) =>
      o.startFrame < endOf(graphic) && endOf(o) > graphic.startFrame
    );
    if (!clash) return true;
    log.push(
      `dropped ${o.kind} "${o.text}" (frames ${o.startFrame}–${endOf(o)}): it overlaps a ${clash.kind}, which carries its own typography`
    );
    return false;
  });

  // 2. Close short exposed windows after each full-frame overlay.
  const filmEnd = filmEndFrame(out);
  const fullFrame = out.overlays
    .filter((o) =>
      // Split/corner maps keep the footage on screen — no exposed-window
      // flash to close, so only full/inset maps count as takeovers here.
      (FULL_FRAME_KINDS.has(o.kind)
        && !(o.kind === 'map' && (o.presentation === 'split' || o.presentation === 'corner')))
      || (o.kind === 'motion-graphic' && o.spec?.presentation === 'takeover')
    )
    .sort((a, b) => a.startFrame - b.startFrame);

  for (const ov of fullFrame) {
    const next = fullFrame.find((o) => o !== ov && o.startFrame >= endOf(ov));
    const boundary = next ? next.startFrame : filmEnd;
    const exposed = boundary - endOf(ov);
    if (exposed < 0 || exposed >= MIN_EXPOSED_FRAMES) continue;

    const nextIsDark =
      next && (next.kind === 'chapter-reveal' || next.kind === 'chapter-active' || next.kind === 'map');

    if (ov.kind === 'map') {
      if (exposed > 0) {
        ov.durationInFrames += exposed;
        ov.holdFrames = (ov.holdFrames ?? 0) + exposed;
        log.push(
          `extended map by ${exposed} frames (freeze + slow push) to ${next ? 'meet the next overlay' : 'close the film'} — a ${exposed}-frame flash of footage would have shown`
        );
      }
    } else if (ov.kind === 'title') {
      if (exposed > 0) {
        ov.durationInFrames += exposed;
        log.push(
          `extended title "${ov.text}" by ${exposed} frames to meet the next segment (no footage flash)`
        );
      }
      if (nextIsDark && ov.exit !== 'to-black') {
        ov.exit = 'to-black';
        log.push(`title "${ov.text}" hands off to a dark segment — exit set to a dissolve to black`);
      }
    } else if (exposed > 0) {
      // chapter stingers are cue-locked; flag instead of resizing
      log.push(
        `WARNING: ${exposed}-frame short exposed window after ${ov.kind} (frames ${endOf(ov)}–${boundary}); stinger timing is narration-locked, not auto-extended`
      );
    }
  }

  return { timeline: out, log };
}
