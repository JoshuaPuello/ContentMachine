import sharp from 'sharp';
import { panelCropGeometry } from './sceneSheets.js';

const MAX_ANALYSIS_EDGE = 1200;
const SEARCH_FRACTION = 0.16;
const MIN_CONFIDENCE = 0.28;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

const axisPixel = (data, width, height, axis, position, perpendicular) => {
  const x = axis === 'x' ? position : perpendicular;
  const y = axis === 'x' ? perpendicular : position;
  if (x < 0 || x >= width || y < 0 || y >= height) return 0;
  return data[(y * width) + x];
};

const dividerScore = (data, width, height, axis, position) => {
  const axisSize = axis === 'x' ? width : height;
  const perpendicularSize = axis === 'x' ? height : width;
  if (position < 3 || position >= axisSize - 3) return 0;
  let contrast = 0;
  let samples = 0;
  let mean = 0;
  let squareMean = 0;
  const stride = Math.max(1, Math.floor(perpendicularSize / 420));
  for (let perpendicular = 0; perpendicular < perpendicularSize; perpendicular += stride) {
    const center = axisPixel(data, width, height, axis, position, perpendicular);
    const before = axisPixel(data, width, height, axis, position - 2, perpendicular);
    const after = axisPixel(data, width, height, axis, position + 2, perpendicular);
    contrast += Math.abs(center - before) + Math.abs(center - after)
      + (Math.abs(before - after) * 0.35);
    mean += center;
    squareMean += center * center;
    samples += 1;
  }
  if (!samples) return 0;
  const average = mean / samples;
  const variance = Math.max(0, (squareMean / samples) - (average * average));
  const uniformity = 1 - Math.min(1, Math.sqrt(variance) / 90);
  return (contrast / samples) + (uniformity * 10);
};

const detectAxisDividers = (data, width, height, axis, segments) => {
  if (segments <= 1) {
    return {
      dividers: [],
      detected: [],
      confidence: 1,
      detectedCount: 0,
    };
  }
  const axisSize = axis === 'x' ? width : height;
  const segmentSize = axisSize / segments;
  const dividers = [];
  const confidences = [];
  let previous = 0;
  for (let ordinal = 1; ordinal < segments; ordinal += 1) {
    const expected = (ordinal * axisSize) / segments;
    const radius = Math.max(5, Math.floor(segmentSize * SEARCH_FRACTION));
    const minimum = Math.max(previous + Math.floor(segmentSize * 0.5), Math.floor(expected - radius));
    const maximum = Math.min(
      axisSize - Math.floor(segmentSize * 0.5),
      Math.ceil(expected + radius),
    );
    const scored = [];
    for (let position = minimum; position <= maximum; position += 1) {
      scored.push({ position, score: dividerScore(data, width, height, axis, position) });
    }
    scored.sort((left, right) => right.score - left.score);
    const best = scored[0];
    const baseline = scored[Math.floor(scored.length * 0.5)]?.score || 0;
    const relativeGain = best && best.score > 0
      ? clamp((best.score - baseline) / Math.max(best.score, 1), 0, 1)
      : 0;
    const detected = relativeGain >= MIN_CONFIDENCE;
    const position = detected ? best.position : Math.round(expected);
    dividers.push(position);
    confidences.push(detected ? relativeGain : 0);
    previous = position;
  }
  return {
    dividers,
    detected: confidences.map(value => value > 0),
    confidence: confidences.length
      ? confidences.reduce((total, value) => total + value, 0) / confidences.length
      : 1,
    detectedCount: confidences.filter(value => value > 0).length,
  };
};

const mapBoundaries = (size, analysisSize, dividers) => [
  0,
  ...dividers.map(value => clamp(Math.round((value / analysisSize) * size), 1, size - 1)),
  size,
];

const dividerInset = (sourceSize, analysisSize, detected) => (
  detected ? Math.max(1, Math.round((2 / analysisSize) * sourceSize)) : 0
);

export const detectSceneSheetPanels = async (buffer, layout) => {
  const sourceMetadata = await sharp(buffer, { failOn: 'warning' }).metadata();
  const sourceWidth = Number(sourceMetadata.width);
  const sourceHeight = Number(sourceMetadata.height);
  if (!sourceWidth || !sourceHeight) throw new Error('Scene-sheet pixels could not be inspected');
  const scale = Math.min(1, MAX_ANALYSIS_EDGE / Math.max(sourceWidth, sourceHeight));
  const analysisWidth = Math.max(1, Math.round(sourceWidth * scale));
  const analysisHeight = Math.max(1, Math.round(sourceHeight * scale));
  const { data, info } = await sharp(buffer, { failOn: 'warning' })
    .resize(analysisWidth, analysisHeight, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const horizontal = detectAxisDividers(
    data,
    info.width,
    info.height,
    'x',
    Number(layout.columns),
  );
  const vertical = detectAxisDividers(
    data,
    info.width,
    info.height,
    'y',
    Number(layout.rows),
  );
  const xBoundaries = mapBoundaries(sourceWidth, info.width, horizontal.dividers);
  const yBoundaries = mapBoundaries(sourceHeight, info.height, vertical.dividers);
  const xInsets = horizontal.detected.map(detected =>
    dividerInset(sourceWidth, info.width, detected));
  const yInsets = vertical.detected.map(detected =>
    dividerInset(sourceHeight, info.height, detected));
  const capacity = Number(layout.columns) * Number(layout.rows);
  const geometries = Array.from({ length: capacity }, (_, panelIndex) => {
    const column = panelIndex % Number(layout.columns);
    const row = Math.floor(panelIndex / Number(layout.columns));
    const left = xBoundaries[column] + (column > 0 ? xInsets[column - 1] : 0);
    const right = xBoundaries[column + 1]
      - (column < Number(layout.columns) - 1 ? xInsets[column] : 0);
    const top = yBoundaries[row] + (row > 0 ? yInsets[row - 1] : 0);
    const bottom = yBoundaries[row + 1]
      - (row < Number(layout.rows) - 1 ? yInsets[row] : 0);
    if (right <= left || bottom <= top) {
      return panelCropGeometry(sourceWidth, sourceHeight, layout, panelIndex + 1);
    }
    return { left, top, width: right - left, height: bottom - top };
  });
  const detectedCount = horizontal.detectedCount + vertical.detectedCount;
  const dividerCount = Math.max(0, Number(layout.columns) - 1)
    + Math.max(0, Number(layout.rows) - 1);
  return {
    geometries,
    xBoundaries,
    yBoundaries,
    xInsets,
    yInsets,
    strategy: detectedCount > 0 ? 'divider-aware' : 'proportional-fallback',
    detectedDividers: detectedCount,
    dividerCount,
    confidence: dividerCount
      ? ((horizontal.confidence * Math.max(0, Number(layout.columns) - 1))
        + (vertical.confidence * Math.max(0, Number(layout.rows) - 1))) / dividerCount
      : 1,
  };
};
