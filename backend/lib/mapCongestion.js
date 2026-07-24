/**
 * Crowded-theater staging for authored map plans.
 *
 * A spray of many concurrent routes from one origin (the map-2 breakout: 10+
 * escape filaments out of Sagan) is geographically truthful but reads as
 * clutter when every route is on screen at once. Professional motion-graphics
 * grammar for this is a ROUTE PROGRESSION:
 *
 *   - routes draw in small waves (≤3 drawing at once) instead of all together,
 *   - each route settles briefly, then RETRACTS tail-to-head into its
 *     destination, leaving a small pulsing endpoint dot,
 *   - the underlying map-plane typography recedes (dims) while the action
 *     passes over it, and returns afterward,
 *   - the end state is a quiet field of outcome dots — not eleven arrows.
 *
 * Everything here is deterministic and bounded: narrative hero routes
 * (chained legs, routes ending at named markers) are never touched, labels
 * whose hero moment falls inside the action window are never dimmed, and the
 * transform is idempotent. Detection and staging both run before rendering,
 * so the model never has to solve concurrency arithmetic.
 */
import { cameraAt, geoToScreen, labelScreenBox } from './mapQuality.js';

const HUB_RADIUS_DEG = 0.6;
const HUB_MIN_ROUTES = 5;
const WAVE_CONCURRENCY = 3;
const WAVE_STAGGER = 8;
const DRAW_FRAMES = 42;
const SETTLE_FRAMES = 12;
const RETRACT_FRAMES = 26;

const clone = (value) => JSON.parse(JSON.stringify(value));

/**
 * Find origin hubs whose independent same-faction route count is high enough
 * to read as clutter. Chained legs (another arrow continues from the end) and
 * routes ending at a named marker are narrative heroes, not spray.
 */
export function analyzeCongestion(plan) {
  const arrows = plan?.props?.arrows ?? [];
  const markers = plan?.props?.markers ?? [];
  const clusters = [];
  arrows.forEach((arrow, index) => {
    const [lon, lat] = arrow.points?.[0] ?? [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    let cluster = clusters.find(
      (entry) => Math.hypot(entry.origin[0] - lon, entry.origin[1] - lat) < HUB_RADIUS_DEG
    );
    if (!cluster) {
      cluster = { origin: [lon, lat], indices: [] };
      clusters.push(cluster);
    }
    cluster.indices.push(index);
  });

  const hubs = [];
  for (const cluster of clusters) {
    if (cluster.indices.length < HUB_MIN_ROUTES) continue;
    const colorCounts = {};
    for (const index of cluster.indices) {
      const color = arrows[index].color ?? 'red';
      colorCounts[color] = (colorCounts[color] ?? 0) + 1;
    }
    const majority = Object.entries(colorCounts).sort((a, b) => b[1] - a[1])[0][0];
    const sprayIndices = cluster.indices.filter((index) => {
      const arrow = arrows[index];
      if ((arrow.color ?? 'red') !== majority) return false;
      const end = arrow.points[2];
      const continues = arrows.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          Math.hypot(other.points[0][0] - end[0], other.points[0][1] - end[1]) < 0.4
      );
      if (continues) return false;
      const endsAtMarker = markers.some(
        (marker) => Math.hypot(marker.lon - end[0], marker.lat - end[1]) < 0.4
      );
      return !endsAtMarker;
    });
    if (sprayIndices.length >= HUB_MIN_ROUTES) {
      hubs.push({ origin: cluster.origin, sprayIndices, allIndices: cluster.indices });
    }
  }
  return { hubs };
}

/**
 * Re-stage every detected spray hub as a route progression. Returns a new
 * plan plus a log of applied adjustments; the input plan is not mutated.
 */
export function applyCongestionStrategy(plan) {
  const working = clone(plan);
  const log = [];
  const report = analyzeCongestion(working);

  for (const hub of report.hubs) {
    const spray = hub.sprayIndices.map((index) => working.props.arrows[index]);
    if (spray.every((arrow) => Array.isArray(arrow.retract))) continue; // already staged

    const durationInFrames = working.props.durationInFrames ?? 480;
    const windowStart = Math.min(...spray.map((arrow) => arrow.grow[0]));
    const authoredFadeEnds = spray.map((arrow) => arrow.fade?.[1]).filter(Number.isFinite);
    const windowEnd = Math.min(
      durationInFrames - 20,
      authoredFadeEnds.length ? Math.max(...authoredFadeEnds) : windowStart + 300
    );

    const waves = Math.ceil(spray.length / WAVE_CONCURRENCY);
    const lastWaveStart =
      windowEnd - RETRACT_FRAMES - SETTLE_FRAMES - DRAW_FRAMES - (WAVE_CONCURRENCY - 1) * WAVE_STAGGER;
    const pitch = waves > 1
      ? Math.max(30, Math.floor((lastWaveStart - windowStart) / (waves - 1)))
      : 0;

    // The dots' exit follows the authors' latest fade intent (one synchronized
    // "ash out"), or they persist as the outcome field if no fade was authored.
    let dotFade = null;
    for (const arrow of spray) {
      if (arrow.fade && (!dotFade || arrow.fade[1] > dotFade[1])) dotFade = [...arrow.fade];
    }

    const ordered = [...hub.sprayIndices].sort(
      (a, b) => working.props.arrows[a].grow[0] - working.props.arrows[b].grow[0]
    );
    working.props.dots = Array.isArray(working.props.dots) ? working.props.dots : [];
    ordered.forEach((arrowIndex, position) => {
      const arrow = working.props.arrows[arrowIndex];
      const wave = Math.floor(position / WAVE_CONCURRENCY);
      const slot = position % WAVE_CONCURRENCY;
      const growStart = windowStart + wave * pitch + slot * WAVE_STAGGER;
      const growEnd = growStart + DRAW_FRAMES;
      arrow.grow = [growStart, growEnd];
      arrow.retract = [growEnd + SETTLE_FRAMES, growEnd + SETTLE_FRAMES + RETRACT_FRAMES];
      delete arrow.fade;
      working.props.dots.push({
        lon: arrow.points[2][0],
        lat: arrow.points[2][1],
        appear: [growEnd - 4, growEnd + 10],
        color: arrow.color ?? 'neutral',
        radius: 6,
        ...(dotFade ? { fade: dotFade } : {}),
      });
    });

    const actionEnd =
      windowStart + (waves - 1) * pitch + (WAVE_CONCURRENCY - 1) * WAVE_STAGGER +
      DRAW_FRAMES + SETTLE_FRAMES + RETRACT_FRAMES;

    // Map-plane typography under the hub recedes while the action plays.
    const midFrame = Math.round((windowStart + actionEnd) / 2);
    const midCamera = cameraAt(working.props.camera, midFrame);
    const actionPoints = [hub.origin, ...spray.map((arrow) => arrow.points[2])]
      .map(([lon, lat]) => geoToScreen(lon, lat, midCamera));
    const pad = 40;
    const hubBox = {
      left: Math.min(...actionPoints.map((point) => point.x)) - pad,
      right: Math.max(...actionPoints.map((point) => point.x)) + pad,
      top: Math.min(...actionPoints.map((point) => point.y)) - pad,
      bottom: Math.max(...actionPoints.map((point) => point.y)) + pad,
    };
    for (const label of working.props.labels ?? []) {
      if (label.dim) continue;
      const hero = label.heroFrame ?? 0;
      if (hero >= windowStart && hero <= actionEnd) continue; // must stay readable
      const visibleInWindow =
        (!label.appear || label.appear[0] <= actionEnd) &&
        (!label.fade || label.fade[1] >= windowStart);
      if (!visibleInWindow) continue;
      const box = labelScreenBox(label, midCamera);
      const overlaps =
        box.right > hubBox.left && box.left < hubBox.right &&
        box.bottom > hubBox.top && box.top < hubBox.bottom;
      if (!overlaps) continue;
      label.dim = { window: [windowStart + 10, actionEnd], to: 0.22 };
      log.push({
        op: 'label-dim',
        target: label.lines.join(' '),
        detail: `recedes to 22% during frames ${windowStart + 10}–${actionEnd}`,
      });
    }

    // A plaque whose hero moment sits inside the crowded window drops its
    // second line — the title carries it until the theater clears.
    for (const marker of working.props.markers ?? []) {
      if (!marker.detail) continue;
      const nearHub = Math.hypot(marker.lon - hub.origin[0], marker.lat - hub.origin[1]) < 1.5;
      const heroInWindow = Number.isFinite(marker.heroFrame) &&
        marker.heroFrame >= windowStart && marker.heroFrame <= actionEnd;
      if (nearHub && heroInWindow) {
        log.push({ op: 'marker-detail-drop', target: marker.label, detail: marker.detail });
        delete marker.detail;
      }
    }

    log.push({
      op: 'route-progression',
      target: `${spray.length} routes @ ${hub.origin.map((v) => v.toFixed(1)).join(',')}`,
      detail: `${waves} wave(s) of ≤${WAVE_CONCURRENCY}, draw ${DRAW_FRAMES}f, retract ${RETRACT_FRAMES}f, window ${windowStart}–${actionEnd}`,
    });
  }
  return { plan: working, log };
}
