const REGION = { lonMin: -15, lonMax: 180, latMin: -15, latMax: 80 };
const SCALE = 45;
const WIDTH = 1920;
const HEIGHT = 1080;
const ANCHOR_X = WIDTH / 2;
const ANCHOR_Y = HEIGHT * 0.56;
const PITCH = (34 * Math.PI) / 180;
const PERSPECTIVE = 1650;

const smoothstep = (t) => t * t * (3 - 2 * t);

export function cameraAt(keyframes, frame) {
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (frame <= first.frame) return { ...first };
  if (frame >= last.frame) return { ...last };
  let a = first;
  let b = keyframes[1];
  for (let i = 1; i < keyframes.length; i += 1) {
    if (keyframes[i].frame >= frame) {
      a = keyframes[i - 1];
      b = keyframes[i];
      break;
    }
  }
  let t = (frame - a.frame) / Math.max(1, b.frame - a.frame);
  if ((b.ease ?? 'linear') === 'inOut') t = smoothstep(t);
  return {
    frame,
    lon: a.lon + (b.lon - a.lon) * t,
    lat: a.lat + (b.lat - a.lat) * t,
    zoom: a.zoom + (b.zoom - a.zoom) * t,
  };
}

/** Inverse of EpicMapScene's 3D map-plane transform for a screen point. */
export function screenToGeo(screenX, screenY, camera) {
  const sy = screenY - ANCHOR_Y;
  const cos = Math.cos(PITCH);
  const sin = Math.sin(PITCH);
  const planeDy = (sy * PERSPECTIVE) / (cos * PERSPECTIVE + sy * sin);
  const perspectiveScale = PERSPECTIVE / (PERSPECTIVE - planeDy * sin);
  const planeDx = (screenX - ANCHOR_X) / perspectiveScale;
  return {
    lon: camera.lon + planeDx / (camera.zoom * SCALE),
    lat: camera.lat - planeDy / (camera.zoom * SCALE),
  };
}

/** Project a real lon/lat point into the rendered 1920x1080 frame. */
export function geoToScreen(lon, lat, camera) {
  const dx = (lon - camera.lon) * SCALE * camera.zoom;
  const dy = (camera.lat - lat) * SCALE * camera.zoom;
  const y = dy * Math.cos(PITCH);
  const z = dy * Math.sin(PITCH);
  const perspectiveScale = PERSPECTIVE / (PERSPECTIVE - z);
  return {
    x: ANCHOR_X + dx * perspectiveScale,
    y: ANCHOR_Y + y * perspectiveScale,
  };
}

export function viewportAt(camera) {
  const corners = [
    screenToGeo(0, 0, camera),
    screenToGeo(WIDTH, 0, camera),
    screenToGeo(WIDTH, HEIGHT, camera),
    screenToGeo(0, HEIGHT, camera),
  ];
  const lons = corners.map((p) => p.lon);
  const lats = corners.map((p) => p.lat);
  return {
    corners,
    west: Math.min(...lons),
    east: Math.max(...lons),
    south: Math.min(...lats),
    north: Math.max(...lats),
  };
}

export function coverageErrors(camera, margin = 0.2) {
  const view = viewportAt(camera);
  const errors = [];
  if (view.west < REGION.lonMin + margin) errors.push(`west edge ${view.west.toFixed(1)}° < ${REGION.lonMin + margin}°`);
  if (view.east > REGION.lonMax - margin) errors.push(`east edge ${view.east.toFixed(1)}° > ${REGION.lonMax - margin}°`);
  if (view.south < REGION.latMin + margin) errors.push(`south edge ${view.south.toFixed(1)}° < ${REGION.latMin + margin}°`);
  if (view.north > REGION.latMax - margin) errors.push(`north edge ${view.north.toFixed(1)}° > ${REGION.latMax - margin}°`);
  return errors;
}

export function minimumCoverageZoom(camera, maxZoom = 3.4) {
  for (let zoom = Math.max(0.5, camera.zoom); zoom <= maxZoom + 0.001; zoom += 0.02) {
    if (coverageErrors({ ...camera, zoom }).length === 0) return Number(zoom.toFixed(2));
  }
  return null;
}

export function focusErrors(focus, camera) {
  const errors = [];
  if (!Array.isArray(focus.bounds) || focus.bounds.length !== 4) {
    return ['bounds must be [west,south,east,north]'];
  }
  const [west, south, east, north] = focus.bounds.map(Number);
  if (![west, south, east, north].every(Number.isFinite) || west >= east || south >= north) {
    return ['bounds must be finite and ordered west < east, south < north'];
  }
  if (west < REGION.lonMin || east > REGION.lonMax || south < REGION.latMin || north > REGION.latMax) {
    errors.push('bounds leave the available real-world map');
  }

  const center = geoToScreen((west + east) / 2, (south + north) / 2, camera);
  if (center.x < WIDTH * 0.1 || center.x > WIDTH * 0.9 || center.y < HEIGHT * 0.08 || center.y > HEIGHT * 0.92) {
    errors.push(`subject center projects outside the safe frame at (${Math.round(center.x)},${Math.round(center.y)})`);
  }

  const view = viewportAt(camera);
  const occupancy = Math.max(
    (east - west) / (view.east - view.west),
    (north - south) / (view.north - view.south)
  );
  // Establishing shots may breathe, but a detail phase has to feel like the
  // viewer has arrived at the event—not like a pin dropped on a continent.
  const minimum = focus.kind === 'establishing' ? 0.12 : 0.32;
  if (occupancy < minimum) {
    errors.push(`subject occupies only ${(occupancy * 100).toFixed(0)}% of the view; ${focus.kind === 'establishing' ? 'establishing' : 'detail'} focus requires at least ${minimum * 100}%`);
  }
  if (occupancy > 0.92) errors.push(`subject occupies ${(occupancy * 100).toFixed(0)}% of the view and will be clipped`);
  return errors;
}

export function labelScreenBox(label, camera) {
  const center = geoToScreen(label.lon, label.lat, camera);
  const onePlanePixelX = Math.abs(geoToScreen(label.lon + 1 / SCALE, label.lat, camera).x - center.x);
  const onePlanePixelY = Math.abs(geoToScreen(label.lon, label.lat - 1 / SCALE, camera).y - center.y);
  const longest = Math.max(...label.lines.map((line) => String(line).length));
  const baseWidth = longest * label.size * (0.56 + label.tracking);
  const baseHeight = label.lines.length * label.size * 1.75;
  const radians = ((Number(label.rotate) || 0) * Math.PI) / 180;
  const width = Math.abs(baseWidth * onePlanePixelX * Math.cos(radians)) +
    Math.abs(baseHeight * onePlanePixelY * Math.sin(radians));
  const height = Math.abs(baseWidth * onePlanePixelX * Math.sin(radians)) +
    Math.abs(baseHeight * onePlanePixelY * Math.cos(radians));
  return {
    left: center.x - width / 2,
    right: center.x + width / 2,
    top: center.y - height / 2,
    bottom: center.y + height / 2,
    width,
    height,
    center,
    fontPixels: label.size * Math.min(onePlanePixelX, onePlanePixelY),
  };
}

export const MAP_REGION = REGION;
