/**
 * Deterministic repair layer for authored map plans.
 *
 * The validators in mapQuality/mapAgent are a precise oracle: they compute the
 * exact camera, box, and occupancy geometry the renderer will produce. What
 * they report is therefore not only a rejection but a diagnosis — and most
 * diagnoses are numerically solvable without another model call:
 *
 *   - a focus phase 1 point under its occupancy threshold  → scale phase zoom
 *   - an exposed finite-plane edge                          → apply the computed minimum zoom
 *   - a label box a few px past the title-safe frame        → nudge it inward
 *   - two labels colliding at a hero frame                  → retime the later-phase one, or shift the smaller
 *   - a hero frame where an element is unsafe               → scan its visible window for a safe frame
 *
 * Every operator is bounded (small zoom factors, ≤2.5° label shifts, hero
 * retimes within ±45 frames) so a repair can never restructure the map — it
 * can only finish the author's layout. Anything a bounded operator cannot fix
 * is a creative problem and is left in `errors` for the model or the editor.
 *
 * repairPlan never mutates its input; the returned plan is a repaired clone
 * that has been through validateAndFix.
 */
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
import { validateAndFix } from './mapAgent.js';
import { analyzeCongestion } from './mapCongestion.js';

const TITLE_SAFE = { left: 36, right: 1884, top: 28, bottom: 1052 };
const MARKER_SAFE = { left: 64, right: 1856, top: 64, bottom: 1016 };
const MAX_APPLIED_OPERATIONS = 12;
const MAX_PASSES = 16;

const clone = (value) => JSON.parse(JSON.stringify(value));

const labelByText = (plan, text) =>
  plan.props.labels.find((label) => label.lines.join(' ') === text);

/** Keyframe index range of the camera phase containing `frame`. Phases are
 * delimited by 'inOut' arrival keyframes (the end of a big move). */
function phaseKeyframeRange(camera, frame) {
  let start = 0;
  let end = camera.length - 1;
  for (let i = 0; i < camera.length; i += 1) {
    if (camera[i].ease !== 'inOut') continue;
    if (camera[i].frame <= frame) start = i;
    if (camera[i].frame > frame) {
      end = i - 1;
      break;
    }
  }
  return { start, end: Math.max(start, end) };
}

function focusOccupancy(focus, camera) {
  const [west, south, east, north] = focus.bounds.map(Number);
  const view = viewportAt(camera);
  return Math.max(
    (east - west) / (view.east - view.west),
    (north - south) / (view.north - view.south)
  );
}

function labelSafetyMargin(box) {
  return Math.min(
    box.left - TITLE_SAFE.left,
    TITLE_SAFE.right - box.right,
    box.top - TITLE_SAFE.top,
    TITLE_SAFE.bottom - box.bottom
  );
}

function overlapRatio(boxA, boxB) {
  const overlapW = Math.max(0, Math.min(boxA.right, boxB.right) - Math.max(boxA.left, boxB.left));
  const overlapH = Math.max(0, Math.min(boxA.bottom, boxB.bottom) - Math.max(boxA.top, boxB.top));
  const smaller = Math.min(boxA.width * boxA.height, boxB.width * boxB.height);
  return smaller > 0 ? (overlapW * overlapH) / smaller : 0;
}

// ---------------------------------------------------------------------------
// Operators. Each returns a log entry when it changed the plan, or null when
// it does not apply / cannot fix within its bounds. Operators mutate the
// working clone owned by repairPlan.
// ---------------------------------------------------------------------------

/** R1 — focus occupancy: scale the zoom of the phase's keyframes. */
function repairFocusOccupancy(plan, error) {
  const match = /^focus (\d+) /.exec(error);
  if (!match || !/occupies/.test(error)) return null;
  const index = Number(match[1]) - 1;
  const focus = plan.focus?.[index];
  const camera = plan.props?.camera;
  if (!focus || !Array.isArray(camera) || camera.length < 2) return null;

  const occupancy = focusOccupancy(focus, cameraAt(camera, focus.frame));
  const minimum = focus.kind === 'establishing' ? 0.12 : 0.32;
  // Only under-occupancy: zooming IN is always coverage-safe. Zooming OUT
  // for over-occupancy risks exposing the finite plane and ping-ponging with
  // the coverage operator — that case belongs to the joint camera solver.
  if (occupancy >= minimum) return null;
  const factor = (minimum * 1.03) / occupancy;
  if (factor > 1.25) return null;

  const { start, end } = phaseKeyframeRange(camera, focus.frame);
  const next = camera.map((keyframe) => ({ ...keyframe }));
  for (let i = start; i <= end; i += 1) {
    const zoom = Number((next[i].zoom * factor).toFixed(3));
    if (zoom > 3.4 || zoom < 0.5) return null;
    next[i].zoom = zoom;
  }
  plan.props.camera = next;
  return {
    op: 'focus-zoom',
    target: `focus[${index}] ${focus.subject ?? ''}`.trim(),
    detail: `occupancy ${(occupancy * 100).toFixed(1)}% → zoom ×${factor.toFixed(4)} on keyframes ${next
      .slice(start, end + 1)
      .map((keyframe) => keyframe.frame)
      .join(',')}`,
  };
}

/** R5 — finite-plane exposure: raise the bracketing keyframes to the
 * validator's own computed minimum coverage zoom. */
function repairCoverage(plan, error) {
  const match = /camera at frame (\d+) exposes/.exec(error);
  if (!match) return null;
  const frame = Number(match[1]);
  const camera = plan.props?.camera;
  if (!Array.isArray(camera) || camera.length < 2) return null;
  const minZoom = minimumCoverageZoom(cameraAt(camera, frame));
  if (!minZoom) return null;

  let before = camera.length - 1;
  let after = 0;
  for (let i = 0; i < camera.length; i += 1) {
    if (camera[i].frame <= frame) before = i;
    if (camera[i].frame >= frame) {
      after = i;
      break;
    }
  }
  const touched = [];
  for (const i of new Set([before, after])) {
    if (camera[i].zoom >= minZoom) continue;
    if (minZoom > 3.4) return null;
    touched.push(`kf@${camera[i].frame} ${camera[i].zoom}→${minZoom}`);
    camera[i] = { ...camera[i], zoom: minZoom };
  }
  if (!touched.length) return null;
  return { op: 'coverage-zoom', target: `frame ${frame}`, detail: touched.join(', ') };
}

/** R3 — clipped label: nudge it inward, bounded to 2.5°. */
function repairLabelClip(plan, error) {
  const match = /^label '(.+?)' is clipped at heroFrame (\d+)/.exec(error);
  if (!match) return null;
  const label = labelByText(plan, match[1]);
  if (!label) return null;
  const camera = cameraAt(plan.props.camera, label.heroFrame);
  const startLon = label.lon;
  const startLat = label.lat;

  for (let step = 0; step < 60; step += 1) {
    const box = labelScreenBox(label, camera);
    let dx = 0;
    let dy = 0;
    if (box.right > TITLE_SAFE.right) dx = -(box.right - TITLE_SAFE.right);
    if (box.left < TITLE_SAFE.left) dx = TITLE_SAFE.left - box.left;
    if (box.bottom > TITLE_SAFE.bottom) dy = -(box.bottom - TITLE_SAFE.bottom);
    if (box.top < TITLE_SAFE.top) dy = TITLE_SAFE.top - box.top;
    if (!dx && !dy) break;
    const origin = geoToScreen(label.lon, label.lat, camera);
    const stepLon = geoToScreen(label.lon + 0.1, label.lat, camera);
    const stepLat = geoToScreen(label.lon, label.lat - 0.1, camera);
    label.lon += dx * (0.1 / (stepLon.x - origin.x)) * 1.05;
    label.lat += dy * (-0.1 / (stepLat.y - origin.y)) * 1.05;
  }

  const shift = Math.hypot(label.lon - startLon, label.lat - startLat);
  const clipped = labelSafetyMargin(labelScreenBox(label, camera)) < 0;
  if (clipped || shift > 2.5) {
    label.lon = startLon;
    label.lat = startLat;
    return null;
  }
  label.lon = Number(label.lon.toFixed(3));
  label.lat = Number(label.lat.toFixed(3));
  return {
    op: 'label-nudge',
    target: match[1],
    detail: `moved ${shift.toFixed(2)}° to ${label.lon},${label.lat}`,
  };
}

/** R4 — unsafe hero frame: rescan the label's visible window (±45 frames of
 * the authored beat) for the safest readable frame. heroFrame is validator
 * metadata only, so this never changes the rendered pixels. */
function repairLabelHeroFrame(plan, error, durationInFrames) {
  const match = /^label '(.+?)' is (?:clipped at heroFrame|only \d+px at heroFrame) (\d+)/.exec(error);
  if (!match) return null;
  const label = labelByText(plan, match[1]);
  if (!label) return null;
  const original = label.heroFrame;
  const low = Math.max(label.appear?.[1] ?? 0, original - 45, 0);
  const high = Math.min(label.fade?.[0] ?? durationInFrames - 1, original + 45, durationInFrames - 1);
  let best = null;
  for (let frame = low; frame <= high; frame += 3) {
    const box = labelScreenBox(label, cameraAt(plan.props.camera, frame));
    if (box.fontPixels < 15) continue;
    const margin = labelSafetyMargin(box);
    if (margin < 0) continue;
    if (!best || margin > best.margin) best = { frame, margin };
  }
  if (!best || best.frame === original) return null;
  label.heroFrame = best.frame;
  return { op: 'label-heroframe', target: match[1], detail: `${original} → ${best.frame}` };
}

/** R2 — hero-frame collision where exactly one label belongs to a later
 * phase: delay its entrance to its own phase instead of moving anything. */
function repairOverlapRetime(plan, error) {
  const match = /^labels overlap at frame (\d+): '(.+?)' and '(.+?)'$/.exec(error);
  if (!match) return null;
  const frame = Number(match[1]);
  const first = labelByText(plan, match[2]);
  const second = labelByText(plan, match[3]);
  if (!first || !second) return null;
  const later = [first, second].filter((label) => (label.heroFrame ?? 0) > frame);
  if (later.length !== 1) return null;
  const mover = later[0];
  const anchor = mover === first ? second : first;
  if (mover.appear && mover.appear[0] > frame) return null;
  const start = anchor.fade?.[0] ?? Math.round((frame + mover.heroFrame) / 2);
  if (start <= frame || start >= mover.heroFrame) return null;
  mover.appear = [start, Math.min(start + 40, mover.heroFrame)];
  return {
    op: 'label-retime',
    target: mover.lines.join(' '),
    detail: `appear [${mover.appear.join(', ')}] (enters with its own phase, hero ${mover.heroFrame})`,
  };
}

/** R6 — remaining collision: shift the smaller label away along the line
 * between centers, bounded by the label's scale; if that fails, one 12% size
 * step-down. Small labels (cities, rivers — size < 28) get a tight 0.6°
 * budget: a city label exiled from its city reads as a geography error
 * (observed failure: ANTWERP shifted 1.24° into the North Sea). Large
 * region/sea labels float over big features and may travel up to 2°. */
function repairOverlapShift(plan, error) {
  const match = /^labels overlap at frame (\d+): '(.+?)' and '(.+?)'$/.exec(error);
  if (!match) return null;
  const frame = Number(match[1]);
  const first = labelByText(plan, match[2]);
  const second = labelByText(plan, match[3]);
  if (!first || !second) return null;
  const camera = cameraAt(plan.props.camera, frame);
  const boxFirst = labelScreenBox(first, camera);
  const boxSecond = labelScreenBox(second, camera);
  const smallerIsFirst = boxFirst.width * boxFirst.height <= boxSecond.width * boxSecond.height;
  const mover = smallerIsFirst ? first : second;
  const anchor = smallerIsFirst ? second : first;
  const anchorBox = smallerIsFirst ? boxSecond : boxFirst;

  const startLon = mover.lon;
  const startLat = mover.lat;
  const moverPoint = geoToScreen(mover.lon, mover.lat, camera);
  let directionX = moverPoint.x - anchorBox.center.x;
  let directionY = moverPoint.y - anchorBox.center.y;
  const length = Math.hypot(directionX, directionY) || 1;
  directionX /= length;
  directionY /= length;

  const origin = geoToScreen(mover.lon, mover.lat, camera);
  const stepLon = geoToScreen(mover.lon + 0.1, mover.lat, camera);
  const stepLat = geoToScreen(mover.lon, mover.lat - 0.1, camera);
  const lonPerPx = 0.1 / (stepLon.x - origin.x);
  const latPerPx = -0.1 / (stepLat.y - origin.y);

  const maxShift = (Number(mover.size) || 0) >= 28 ? 2.0 : 0.6;
  for (let step = 0; step < 40; step += 1) {
    const ratio = overlapRatio(labelScreenBox(mover, camera), labelScreenBox(anchor, camera));
    if (ratio <= 0.1) break;
    if (Math.hypot(mover.lon - startLon, mover.lat - startLat) >= maxShift) break;
    mover.lon += directionX * 12 * lonPerPx;
    mover.lat += directionY * 12 * latPerPx;
  }
  const shift = Math.hypot(mover.lon - startLon, mover.lat - startLat);
  const resolved =
    overlapRatio(labelScreenBox(mover, camera), labelScreenBox(anchor, camera)) <= 0.1;
  const heroBox = labelScreenBox(mover, cameraAt(plan.props.camera, mover.heroFrame));
  if (resolved && shift <= maxShift && labelSafetyMargin(heroBox) >= 0) {
    mover.lon = Number(mover.lon.toFixed(3));
    mover.lat = Number(mover.lat.toFixed(3));
    return {
      op: 'label-shift',
      target: mover.lines.join(' '),
      detail: `moved ${shift.toFixed(2)}° away from '${anchor.lines.join(' ')}'`,
    };
  }
  mover.lon = startLon;
  mover.lat = startLat;
  const reduced = Math.max(12, Math.round(mover.size * 0.88));
  if (reduced < mover.size) {
    const previous = mover.size;
    mover.size = reduced;
    if (overlapRatio(labelScreenBox(mover, camera), labelScreenBox(anchor, camera)) <= 0.1) {
      return { op: 'label-shrink', target: mover.lines.join(' '), detail: `size ${previous} → ${reduced}` };
    }
    mover.size = previous;
  }
  return null;
}

/** Keyframe group for the joint camera solver: the arrival-delimited camera
 * phase whose anchor keyframe is nearest the target frame. Includes the
 * arrival keyframe itself, so a constraint that falls late in the approach
 * move (e.g. a focus frame at 93% of the way to the arrival) is still
 * dominated by the keyframes being adjusted. */
function solveGroup(camera, targetFrame) {
  let anchor = 0;
  for (let i = 1; i < camera.length; i += 1) {
    if (Math.abs(camera[i].frame - targetFrame) < Math.abs(camera[anchor].frame - targetFrame)) anchor = i;
  }
  let start = 0;
  for (let i = anchor; i >= 0; i -= 1) {
    if (camera[i].ease === 'inOut') {
      start = i;
      break;
    }
  }
  let end = camera.length - 1;
  for (let i = anchor + 1; i < camera.length; i += 1) {
    if (camera[i].ease === 'inOut') {
      end = i - 1;
      break;
    }
  }
  return { start: Math.min(start, anchor), end: Math.max(end, anchor) };
}

/** R8 — joint camera solve. When single-axis fixes cannot satisfy a phase
 * (over-occupancy that breaks coverage when zoomed out, a hero marker the
 * camera never brings on screen), search (Δlon, Δlat, zoom×) applied
 * uniformly to the phase's keyframes for the closest camera that satisfies
 * coverage, every focus in the phase, and every hero-marker dot at once.
 * Drift choreography is preserved because the delta is uniform. */
function repairCameraSolve(plan, error, durationInFrames) {
  const focusMatch = /^focus (\d+) .*occupies/.exec(error);
  const markerMatch = /^marker '(.+?)' dot is outside the safe frame at heroFrame (\d+)/.exec(error);
  let targetFrame = null;
  if (focusMatch) targetFrame = plan.focus?.[Number(focusMatch[1]) - 1]?.frame;
  else if (markerMatch) targetFrame = Number(markerMatch[2]);
  if (!Number.isFinite(targetFrame)) return null;
  const camera = plan.props?.camera;
  if (!Array.isArray(camera) || camera.length < 2) return null;

  const { start, end } = solveGroup(camera, targetFrame);
  const windowStart = start > 0 ? camera[start - 1].frame + 1 : camera[start].frame;
  const windowEnd = end === camera.length - 1 ? durationInFrames - 1 : camera[end].frame;
  const focuses = (plan.focus ?? []).filter((f) => f.frame >= windowStart && f.frame <= windowEnd);
  const heroMarkers = (plan.props.markers ?? []).filter(
    (m) => Number.isFinite(m.heroFrame) && m.heroFrame >= windowStart && m.heroFrame <= windowEnd
  );

  const evaluate = (dLon, dLat, zScale, markerMargin) => {
    const trial = camera.map((keyframe, i) => (i >= start && i <= end
      ? {
          ...keyframe,
          lon: Number((keyframe.lon + dLon).toFixed(3)),
          lat: Number((keyframe.lat + dLat).toFixed(3)),
          zoom: Number((keyframe.zoom * zScale).toFixed(3)),
        }
      : { ...keyframe }));
    for (let i = start; i <= end; i += 1) {
      const keyframe = trial[i];
      if (keyframe.zoom < 0.5 || keyframe.zoom > 3.4) return null;
      if (keyframe.lon < MAP_REGION.lonMin || keyframe.lon > MAP_REGION.lonMax ||
          keyframe.lat < MAP_REGION.latMin || keyframe.lat > MAP_REGION.latMax) return null;
    }
    const checkFrames = new Set([
      ...trial.slice(start, end + 1).map((keyframe) => keyframe.frame),
      ...focuses.map((f) => f.frame),
      ...heroMarkers.map((m) => m.heroFrame),
    ]);
    for (let i = Math.max(1, start); i <= end; i += 1) {
      checkFrames.add(Math.round((trial[i - 1].frame + trial[i].frame) / 2));
    }
    for (const frame of checkFrames) {
      if (coverageErrors(cameraAt(trial, frame)).length) return null;
    }
    for (const focus of focuses) {
      if (focusErrors(focus, cameraAt(trial, focus.frame)).length) return null;
    }
    for (const marker of heroMarkers) {
      const point = geoToScreen(marker.lon, marker.lat, cameraAt(trial, marker.heroFrame));
      if (point.x < MARKER_SAFE.left + markerMargin || point.x > MARKER_SAFE.right - markerMargin ||
          point.y < MARKER_SAFE.top + markerMargin || point.y > MARKER_SAFE.bottom - markerMargin) return null;
    }
    return trial;
  };

  for (const markerMargin of [40, 8]) {
    let best = null;
    for (let zi = 0; zi <= 16; zi += 1) {
      const zScale = 0.6 + zi * 0.05;
      for (let yi = -10; yi <= 10; yi += 1) {
        const dLat = yi * 0.5;
        for (let xi = -10; xi <= 10; xi += 1) {
          const dLon = xi * 0.5;
          const trial = evaluate(dLon, dLat, zScale, markerMargin);
          if (!trial) continue;
          const cost = Math.abs(dLon) + Math.abs(dLat) + Math.abs(zScale - 1) * 8;
          if (!best || cost < best.cost) best = { trial, cost, dLon, dLat, zScale };
        }
      }
    }
    if (best) {
      plan.props.camera = best.trial;
      return {
        op: 'camera-solve',
        target: focusMatch ? `focus[${Number(focusMatch[1]) - 1}]` : `marker ${markerMatch[1]}`,
        detail: `keyframes ${camera[start].frame}–${camera[end].frame} moved (${best.dLon.toFixed(1)}°, ${best.dLat.toFixed(1)}°), zoom ×${best.zScale.toFixed(2)}`,
      };
    }
  }
  return null;
}

/** R6b — an over-wide single-line label is the typographer's cue to stack it
 * into two balanced lines: the box halves in width, which is usually what a
 * "giant label collides with everything" situation actually needs. */
function repairOverlapStack(plan, error) {
  const match = /^labels overlap at frame (\d+): '(.+?)' and '(.+?)'$/.exec(error);
  if (!match) return null;
  const frame = Number(match[1]);
  const first = labelByText(plan, match[2]);
  const second = labelByText(plan, match[3]);
  if (!first || !second) return null;
  const camera = cameraAt(plan.props.camera, frame);
  const candidates = [first, second]
    .filter((label) => label.lines.length === 1 && !label.arc && !label.rotate)
    .filter((label) => label.lines[0].trim().split(/\s+/).length >= 2)
    .sort((a, b) => labelScreenBox(b, camera).width - labelScreenBox(a, camera).width);
  for (const label of candidates) {
    if (labelScreenBox(label, camera).width < 380) continue;
    const words = label.lines[0].trim().split(/\s+/);
    let stacked = null;
    for (let i = 1; i < words.length; i += 1) {
      const lines = [words.slice(0, i).join(' '), words.slice(i).join(' ')];
      const imbalance = Math.abs(lines[0].length - lines[1].length);
      if (!stacked || imbalance < stacked.imbalance) stacked = { lines, imbalance };
    }
    if (!stacked) continue;
    const other = label === first ? second : first;
    const originalLines = label.lines;
    label.lines = stacked.lines;
    const heroBox = labelScreenBox(label, cameraAt(plan.props.camera, label.heroFrame));
    const resolved = overlapRatio(labelScreenBox(label, camera), labelScreenBox(other, camera)) <= 0.1;
    if (resolved && labelSafetyMargin(heroBox) >= 0) {
      return {
        op: 'label-stack',
        target: originalLines.join(' '),
        detail: `stacked into ["${stacked.lines.join('", "')}"]`,
      };
    }
    label.lines = originalLines;
  }
  return null;
}

/** R6d — the geography-honest last resort for a stubborn label pair: drop
 * the smaller label rather than exiling it from its feature or burning a
 * whole model retry on a text collision. Never drops below the 3-label
 * minimum. */
function repairOverlapDrop(plan, error) {
  const match = /^labels overlap at frame \d+: '(.+?)' and '(.+?)'$/.exec(error);
  if (!match) return null;
  const labels = plan.props.labels;
  if (!Array.isArray(labels) || labels.length <= 3) return null;
  const first = labelByText(plan, match[1]);
  const second = labelByText(plan, match[2]);
  if (!first || !second || first === second) return null;
  const dropped = (Number(first.size) || 0) <= (Number(second.size) || 0) ? first : second;
  const kept = dropped === first ? second : first;
  plan.props.labels = labels.filter((label) => label !== dropped);
  return {
    op: 'label-drop',
    target: dropped.lines.join(' '),
    detail: `dropped to clear '${kept.lines.join(' ')}' without dislocating geography`,
  };
}

/** R4m — marker dot off the safe frame: rescan its visible window for a safe
 * hero frame (also render-inert; the renderer auto-places the callout). */
function repairMarkerHeroFrame(plan, error, durationInFrames) {
  const match =
    /^marker '(.+?)' (?:is outside the callout-safe frame|dot is outside the safe frame) at heroFrame (\d+)/.exec(error);
  if (!match) return null;
  const marker = plan.props.markers.find((entry) => entry.label === match[1]);
  if (!marker) return null;
  const original = marker.heroFrame;
  const low = Math.max(marker.appear?.[1] ?? 0, original - 45, 0);
  const high = Math.min(marker.fade?.[0] ?? durationInFrames - 1, original + 45, durationInFrames - 1);
  let best = null;
  for (let frame = low; frame <= high; frame += 3) {
    const point = geoToScreen(marker.lon, marker.lat, cameraAt(plan.props.camera, frame));
    const margin = Math.min(
      point.x - MARKER_SAFE.left,
      MARKER_SAFE.right - point.x,
      point.y - MARKER_SAFE.top,
      MARKER_SAFE.bottom - point.y
    );
    if (margin < 0) continue;
    if (!best || margin > best.margin) best = { frame, margin };
  }
  if (!best || best.frame === original) return null;
  marker.heroFrame = best.frame;
  return { op: 'marker-heroframe', target: match[1], detail: `${original} → ${best.frame}` };
}

/** Too many routes = an arrow pile, not a story. The editorial fix the user
 * asked for by name: mass dispersal reads as a field of pulsing outcome
 * dots, not eleven arrows. Convert each detected spray (same-origin,
 * same-faction routes that are neither chained legs nor marker-terminated)
 * into dots appearing on the spray's original stagger — an outbreak map.
 * Narrative hero routes are never touched. */
function repairSprayToDots(plan) {
  const p = plan.props;
  if ((p.arrows ?? []).length <= 12) return null;
  const report = analyzeCongestion(plan);
  const toConvert = new Set(report.hubs.flatMap((hub) => hub.sprayIndices));
  if (!toConvert.size) return null;
  p.dots = Array.isArray(p.dots) ? p.dots : [];
  const durationInFrames = p.durationInFrames ?? 480;
  const kept = [];
  let converted = 0;
  p.arrows.forEach((arrow, index) => {
    if (!toConvert.has(index)) {
      kept.push(arrow);
      return;
    }
    const end = arrow.points[2];
    const growEnd = Array.isArray(arrow.grow) ? arrow.grow[1] : Math.round(durationInFrames * 0.5);
    p.dots.push({
      lon: end[0],
      lat: end[1],
      appear: [Math.max(0, growEnd - 6), Math.min(durationInFrames - 1, growEnd + 12)],
      color: ['red', 'teal', 'neutral'].includes(arrow.color) ? arrow.color : 'neutral',
      radius: 6,
      ...(Array.isArray(arrow.fade) ? { fade: [...arrow.fade] } : {}),
    });
    converted += 1;
  });
  if (!converted) return null;
  p.arrows = kept;
  return {
    op: 'spray-to-dots',
    target: `${converted} spray route${converted === 1 ? '' : 's'}`,
    detail: `converted to a pulsing outcome-dot field; ${kept.length} narrative routes kept`,
  };
}

/** A route into unlabeled emptiness gets a pulsing outcome dot at its
 * destination — the smallest honest fix (the alternative, deleting the
 * route, would erase story). Batch operator: one application resolves every
 * unexplained endpoint so a many-route spray cannot exhaust the operation
 * budget. */
function repairUnexplainedEndpoints(plan) {
  const p = plan.props;
  const arrows = p.arrows ?? [];
  const markers = p.markers ?? [];
  const labels = p.labels ?? [];
  p.dots = Array.isArray(p.dots) ? p.dots : [];
  const durationInFrames = p.durationInFrames ?? 480;
  let added = 0;
  for (const [index, arrow] of arrows.entries()) {
    const end = arrow.points?.[2];
    if (!end || !Number.isFinite(end[0]) || !Number.isFinite(end[1])) continue;
    const explained =
      markers.some((m) => Math.hypot(m.lon - end[0], m.lat - end[1]) <= 1.2) ||
      p.dots.some((d) => Math.hypot(d.lon - end[0], d.lat - end[1]) <= 1.2) ||
      labels.some((l) => Math.hypot(Number(l.lon) - end[0], Number(l.lat) - end[1]) <= 3.0) ||
      arrows.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          Array.isArray(other.points?.[0]) &&
          Math.hypot(other.points[0][0] - end[0], other.points[0][1] - end[1]) <= 0.5
      );
    if (explained) continue;
    const growEnd = Array.isArray(arrow.grow) ? arrow.grow[1] : Math.round(durationInFrames * 0.5);
    p.dots.push({
      lon: end[0],
      lat: end[1],
      appear: [Math.max(0, growEnd - 4), Math.min(durationInFrames - 1, growEnd + 10)],
      color: ['red', 'teal', 'neutral'].includes(arrow.color) ? arrow.color : 'neutral',
      radius: 6,
      ...(Array.isArray(arrow.fade) ? { fade: [...arrow.fade] } : {}),
    });
    added += 1;
  }
  if (!added) return null;
  return {
    op: 'endpoint-dots',
    target: `${added} route${added === 1 ? '' : 's'}`,
    detail: 'pulsing outcome dot planted at each unexplained destination',
  };
}

/** R7 — two markers below the engine's resolvable scale are one story point
 * authored twice (a city plus a street inside it). Keep the later hero — the
 * narration's destination — inherit the earliest appear start, and carry the
 * dropped place name in the survivor's detail text if it has none. */
function repairMarkerMerge(plan, error) {
  const match = /^markers '(.+?)' and '(.+?)' are [\d.]+° apart/.exec(error);
  if (!match) return null;
  const markers = plan.props.markers ?? [];
  const first = markers.find((m) => (m.label || 'unnamed') === match[1]);
  const second = markers.find((m) => (m.label || 'unnamed') === match[2]);
  if (!first || !second || first === second) return null;
  const kept = (Number(second.heroFrame) || 0) >= (Number(first.heroFrame) || 0) ? second : first;
  const dropped = kept === second ? first : second;
  if (Array.isArray(kept.appear) && Array.isArray(dropped.appear) && dropped.appear[0] < kept.appear[0]) {
    const rampLength = kept.appear[1] - kept.appear[0];
    kept.appear = [dropped.appear[0], dropped.appear[0] + rampLength];
  }
  if (!kept.detail && dropped.label && dropped.label !== kept.label) {
    kept.detail = String(dropped.label).slice(0, 38);
  }
  kept.radius = Math.max(Number(kept.radius) || 16, Number(dropped.radius) || 16);
  plan.props.markers = markers.filter((m) => m !== dropped);
  return {
    op: 'marker-merge',
    target: `${dropped.label || 'unnamed'} → ${kept.label || 'unnamed'}`,
    detail: `sub-resolution pair merged; '${kept.label || 'unnamed'}' keeps the story point`,
  };
}

const OPERATOR_CHAIN = [
  { name: 'marker-merge', matches: /below the engine's resolvable scale/, apply: repairMarkerMerge },
  { name: 'spray-to-dots', matches: /^too many routes/, apply: repairSprayToDots },
  { name: 'endpoint-dots', matches: /^route \d+ ends unexplained/, apply: repairUnexplainedEndpoints },
  { name: 'coverage-zoom', matches: /exposes the finite map plane/, apply: repairCoverage },
  { name: 'focus-zoom', matches: /^focus \d+ .*occupies/, apply: repairFocusOccupancy },
  { name: 'camera-solve', matches: /^focus \d+ .*occupies/, apply: repairCameraSolve },
  { name: 'label-retime', matches: /^labels overlap at frame /, apply: repairOverlapRetime },
  { name: 'label-stack', matches: /^labels overlap at frame /, apply: repairOverlapStack },
  { name: 'label-shift', matches: /^labels overlap at frame /, apply: repairOverlapShift },
  { name: 'label-drop', matches: /^labels overlap at frame /, apply: repairOverlapDrop },
  { name: 'label-nudge', matches: /^label '.+?' is clipped at heroFrame /, apply: repairLabelClip },
  { name: 'label-heroframe', matches: /^label '.+?' is (?:clipped|only \d+px) at heroFrame /, apply: repairLabelHeroFrame },
  { name: 'marker-heroframe', matches: /^marker '.+?' .*at heroFrame /, apply: repairMarkerHeroFrame },
  { name: 'camera-solve', matches: /^marker '.+?' dot is outside the safe frame/, apply: repairCameraSolve },
];

/**
 * Repair a parsed plan against the production validators.
 *
 * @param {object} options
 * @param {object} options.plan            parsed { bakes, focus, props } plan (not mutated)
 * @param {number} options.durationSeconds requested map duration
 * @param {(plan: object) => string[]} [options.extraValidate]
 *        additional synchronous checks (e.g. unknown-fill references)
 * @param {string[]} [options.reservedTexts]
 *        overlay texts the plan must not duplicate (passed to validateAndFix)
 * @returns {{ plan: object, log: Array<object>, errors: string[] }}
 */
export function repairPlan({ plan, durationSeconds, extraValidate, reservedTexts }) {
  let working = clone(plan);
  const log = [];
  const attempted = new Set();
  let errors = [];

  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const result = validateAndFix(working, durationSeconds, { reservedTexts });
    working = result.plan;
    errors = [...result.errors, ...(extraValidate ? extraValidate(working) : [])];
    if (!errors.length) return { plan: working, log, errors: [] };
    if (log.length >= MAX_APPLIED_OPERATIONS) break;

    const durationInFrames = working.props?.durationInFrames ?? Math.round(durationSeconds * 30);
    let entry = null;
    for (const error of errors) {
      for (const operator of OPERATOR_CHAIN) {
        if (!operator.matches.test(error)) continue;
        const key = `${operator.name}::${error}`;
        if (attempted.has(key)) continue;
        attempted.add(key);
        entry = operator.apply(working, error, durationInFrames);
        if (entry) break;
      }
      if (entry) break;
    }
    if (!entry) break;
    log.push(entry);
  }
  return { plan: working, log, errors };
}
