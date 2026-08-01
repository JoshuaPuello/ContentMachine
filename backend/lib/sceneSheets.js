const UNIT_ID_PATTERN = /^\d+_\d+$/;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,95}$/;

const cleanText = (value, fallback = '') => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
};

export const compactSceneSheetShotPrompt = (value) => {
  const sentences = String(value || '').trim().split(/(?<=[.!?])\s+(?=[A-Z])/);
  return sentences.filter((sentence, index) => {
    if (index === 0) return true;
    return cleanText(sentence).toLowerCase() !== cleanText(sentences[index - 1]).toLowerCase();
  }).join(' ');
};

export const safeSceneSheetId = (value) => SAFE_ID_PATTERN.test(String(value || ''));

export const layoutForPanelCount = (panelCount) => {
  const count = Number(panelCount);
  if (!Number.isInteger(count) || count < 2 || count > 6) {
    throw new Error('A scene sheet must contain between 2 and 6 panels');
  }
  if (count <= 3) return {
    columns: count, rows: 1, panelAspectRatio: '16:9', tileAspectRatio: '16:9',
  };
  if (count === 4) return {
    columns: 2, rows: 2, panelAspectRatio: '16:9', tileAspectRatio: '16:9',
  };
  return { columns: 3, rows: 2, panelAspectRatio: '16:9', tileAspectRatio: '16:9' };
};

const escapeSvg = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

export const buildSceneSheetTemplateSvg = (layout, panelCount, {
  width = 1600,
  height = 900,
} = {}) => {
  const columns = Number(layout?.columns);
  const rows = Number(layout?.rows);
  const count = Number(panelCount);
  const capacity = columns * rows;
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) {
    throw new Error('Scene-sheet template requires a valid grid layout');
  }
  if (!Number.isInteger(count) || count < 2 || count > capacity) {
    throw new Error('Scene-sheet template panel count is outside its grid');
  }
  const cells = Array.from({ length: capacity }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const x = (column * width) / columns;
    const y = (row * height) / rows;
    const cellWidth = width / columns;
    const cellHeight = height / rows;
    const occupied = index < count;
    const label = occupied ? String(index + 1).padStart(2, '0') : 'EMPTY';
    return `<g data-panel="${index + 1}" data-state="${occupied ? 'occupied' : 'unused'}">
      <rect x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" fill="${occupied ? (index % 2 ? '#151922' : '#11151d') : '#07090d'}"/>
      <rect x="${x + 1.5}" y="${y + 1.5}" width="${cellWidth - 3}" height="${cellHeight - 3}" fill="none" stroke="${occupied ? '#aeb7c6' : '#414754'}" stroke-width="3"/>
      <text x="${x + 24}" y="${y + cellHeight - 24}" fill="${occupied ? '#f5f7fa' : '#656c78'}" font-family="Arial, sans-serif" font-size="${occupied ? 32 : 24}" letter-spacing="3">${escapeSvg(label)}</text>
    </g>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#07090d"/>
    ${cells}
  </svg>`;
};

export const expectedSheetAspectRatio = ({ columns, rows }) =>
  (Number(columns) * 16) / (Number(rows) * 9);

export const validateSheetDimensions = (
  metadata,
  layout,
  { maxBytes = 50 * 1024 * 1024, sizeBytes = 0, tolerance = 0.09 } = {},
) => {
  const width = Number(metadata?.width);
  const height = Number(metadata?.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 640 || height < 360) {
    throw new Error('The uploaded scene sheet is too small or has invalid dimensions');
  }
  if (Number(sizeBytes) > maxBytes) throw new Error('The uploaded scene sheet exceeds 50 MiB');
  const expected = expectedSheetAspectRatio(layout);
  const actual = width / height;
  const panelWidth = width / Number(layout.columns);
  const panelHeight = height / Number(layout.rows);
  if (panelWidth < 256 || panelHeight < 256) {
    throw new Error('Each scene-sheet panel must contain at least 256×256 source pixels');
  }
  const canonicalGrid = Math.abs(actual - expected) / expected <= tolerance;
  const actualPanelAspectRatio = panelWidth / panelHeight;
  return {
    width,
    height,
    expectedAspectRatio: expected,
    actualAspectRatio: actual,
    actualPanelAspectRatio,
    layoutMode: canonicalGrid ? 'native-16:9-panels' : 'flexible-source-canvas',
    needsOutpaint: !canonicalGrid,
  };
};

export const panelCropGeometry = (width, height, layout, ordinal) => {
  const panelIndex = Number(ordinal) - 1;
  const panelCapacity = layout.columns * layout.rows;
  if (!Number.isInteger(panelIndex) || panelIndex < 0 || panelIndex >= panelCapacity) {
    throw new Error('Panel ordinal is outside the scene-sheet layout');
  }
  const column = panelIndex % layout.columns;
  const row = Math.floor(panelIndex / layout.columns);
  const left = Math.floor((column * width) / layout.columns);
  const top = Math.floor((row * height) / layout.rows);
  const right = Math.floor(((column + 1) * width) / layout.columns);
  const bottom = Math.floor(((row + 1) * height) / layout.rows);
  return { left, top, width: right - left, height: bottom - top };
};

export const validatePlannedGroups = (rawGroups, units) => {
  const unitById = new Map(units.map(unit => [unit.unitId, unit]));
  const unitOrder = new Map(units.map((unit, index) => [unit.unitId, index]));
  const claimed = new Set();
  const groups = [];
  for (const [index, raw] of (Array.isArray(rawGroups) ? rawGroups : []).entries()) {
    const unitIds = [...new Set((raw?.unitIds || raw?.unit_ids || [])
      .map(String)
      .filter(unitId => UNIT_ID_PATTERN.test(unitId) && unitById.has(unitId)))]
      .sort((left, right) => unitOrder.get(left) - unitOrder.get(right));
    if (unitIds.length < 2 || unitIds.length > 6 || unitIds.some(unitId => claimed.has(unitId))) {
      continue;
    }
    unitIds.forEach(unitId => claimed.add(unitId));
    const idSeed = cleanText(raw?.id, `sheet-${index + 1}`)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
    const id = safeSceneSheetId(idSeed) ? idSeed : `sheet-${index + 1}`;
    groups.push({
      id: groups.some(group => group.id === id) ? `${id}-${index + 1}` : id,
      title: cleanText(raw?.title, `Scene sheet ${index + 1}`),
      scenarioId: cleanText(raw?.scenarioId || raw?.scenario_id, 'continuity-group'),
      scenarioContinuity: cleanText(
        raw?.scenarioContinuity || raw?.scenario_continuity,
        'Preserve the same physical environment, time, lighting, props, and character identities.',
      ),
      unitIds,
    });
  }
  return {
    groups,
    isolatedUnitIds: units.map(unit => unit.unitId).filter(unitId => !claimed.has(unitId)),
  };
};

const balancedChunks = (items, maxSize) => {
  const chunkCount = Math.ceil(items.length / maxSize);
  const baseSize = Math.floor(items.length / chunkCount);
  const remainder = items.length % chunkCount;
  const result = [];
  let offset = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const size = baseSize + (index < remainder ? 1 : 0);
    result.push(items.slice(offset, offset + size));
    offset += size;
  }
  return result;
};

// Scene-sheet planning can involve hundreds of authored shots. Keep every
// exact scenario family together (including non-adjacent returns to the same
// place), then pack those families into bounded Sonnet requests. Exceptionally
// large families are split in balanced story order because a single request
// must never grow without bound; every unit still carries the same continuity
// anchors so the separate planners preserve the authored world.
export const buildSceneSheetPlanningChunks = (
  units,
  maxUnits = 30,
  maxPayloadCharacters = 45_000,
) => {
  const limit = Math.max(6, Number(maxUnits) || 30);
  const characterLimit = Math.max(10_000, Number(maxPayloadCharacters) || 45_000);
  const scenarioBuckets = new Map();
  for (const unit of units || []) {
    const scenarioId = cleanText(unit.scenarioId, `scene-${unit.sceneNumber}`);
    if (!scenarioBuckets.has(scenarioId)) {
      scenarioBuckets.set(scenarioId, {
        scenarioId,
        firstIndex: scenarioBuckets.size,
        units: [],
      });
    }
    scenarioBuckets.get(scenarioId).units.push(unit);
  }

  const chunks = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    chunks.push(current);
    current = [];
  };
  for (const bucket of scenarioBuckets.values()) {
    const boundedBuckets = [];
    let bounded = [];
    for (const unit of bucket.units) {
      if (bounded.length && (
        bounded.length >= limit
        || JSON.stringify([...bounded, unit]).length > characterLimit
      )) {
        boundedBuckets.push(bounded);
        bounded = [];
      }
      bounded.push(unit);
    }
    if (bounded.length) boundedBuckets.push(bounded);
    for (const bounded of boundedBuckets) {
      if (current.length && (
        current.length + bounded.length > limit
        || JSON.stringify([...current, ...bounded]).length > characterLimit
      )) flush();
      current.push(...bounded);
      if (current.length >= limit) flush();
    }
  }
  flush();
  return chunks.map((chunk, index) => ({
    index,
    unitIds: chunk.map(unit => unit.unitId),
    units: chunk,
    payloadCharacters: JSON.stringify(chunk).length,
  }));
};

export const sceneSheetPlanningProgress = (chunks = []) => {
  const completed = chunks.filter(chunk => chunk.status === 'completed');
  const running = chunks.filter(chunk => chunk.status === 'running');
  const failed = chunks.filter(chunk => chunk.status === 'failed');
  const processedUnits = completed.reduce(
    (total, chunk) => total + Number(chunk.unitCount || chunk.unitIds?.length || 0),
    0,
  );
  const totalUnits = chunks.reduce(
    (total, chunk) => total + Number(chunk.unitCount || chunk.unitIds?.length || 0),
    0,
  );
  return {
    totalChunks: chunks.length,
    completedChunks: completed.length,
    activeChunks: running.length,
    failedChunks: failed.length,
    fallbackChunks: completed.filter(chunk => chunk.usedFallback).length,
    processedUnits,
    totalUnits,
    percent: totalUnits ? Math.round((processedUnits / totalUnits) * 100) : 0,
  };
};

export const runSceneSheetPlanningPool = async (
  chunks,
  operation,
  maxParallel = 3,
) => {
  const work = Array.isArray(chunks) ? chunks : [];
  const limit = Math.max(1, Math.min(work.length || 1, Number(maxParallel) || 1));
  const results = new Array(work.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= work.length) return;
      results[index] = await operation(work[index], index);
    }
  };
  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
};

export const fallbackSceneSheetGroups = (units) => {
  const byScenario = new Map();
  for (const unit of units) {
    const key = cleanText(unit.scenarioId, `scene-${unit.sceneNumber}`);
    if (!byScenario.has(key)) byScenario.set(key, []);
    byScenario.get(key).push(unit);
  }
  const rawGroups = [];
  let sequence = 0;
  for (const [scenarioId, scenarioUnits] of byScenario.entries()) {
    if (scenarioUnits.length < 2) continue;
    for (const groupUnits of balancedChunks(scenarioUnits, 6)) {
      if (groupUnits.length < 2) continue;
      sequence += 1;
      rawGroups.push({
        id: `sheet-${sequence}-${scenarioId}`,
        title: groupUnits[0].scenarioTitle || `Scene sheet ${sequence}`,
        scenarioId,
        scenarioContinuity: groupUnits[0].scenarioContinuity,
        unitIds: groupUnits.map(unit => unit.unitId),
      });
    }
  }
  return validatePlannedGroups(rawGroups, units);
};

const ordinalLabel = (ordinal) => String(ordinal).padStart(2, '0');

export const buildSheetMasterPrompt = (group, panels, references) => {
  const unusedCells = (group.layout.columns * group.layout.rows) - panels.length;
  const refLines = references.length
    ? references.map(reference =>
      `${reference.order}. ${reference.type === 'character' ? 'CHARACTER' : 'REFERENCE'} — ${reference.name}`,
    ).join('\n')
    : 'No reusable character portrait is required for this sheet.';
  const panelLines = panels.map(panel =>
    `PANEL ${ordinalLabel(panel.ordinal)} · ${panel.label}\n${panel.prompt}`,
  ).join('\n\n');
  return `Create ONE cinematic scene sheet containing exactly ${panels.length} distinct panels.

LAYOUT
- Exact ${group.layout.columns} columns × ${group.layout.rows} rows.
- Every occupied panel is a separate native 16:9 cinematic frame with equal dimensions.
- Preferred full-sheet canvas ratio: ${expectedSheetAspectRatio(group.layout).toFixed(3)}:1. If the image provider forces the complete sheet onto a conventional 16:9, 3:2, or 4:3 canvas, preserve the exact equal ${group.layout.columns}×${group.layout.rows} grid and all content; Content Machine will outpaint each extracted panel to native 16:9 afterward.
- Thin neutral separators only. No overlapping collage, margins, captions, or decorative storyboard treatment.
- Put only the small removable panel number ${panels.map(panel => ordinalLabel(panel.ordinal)).join(', ')} in the lower-left safe area of its matching panel.
${unusedCells > 0 ? `- Leave the final ${unusedCells} unused grid cell${unusedCells === 1 ? '' : 's'} empty, flat neutral charcoal, and completely free of subjects, scenery, props, labels, or story content.` : ''}

GRID TEMPLATE CONTRACT
- Attach the supplied ${group.layout.columns}×${group.layout.rows} grid template as the FIRST reference image. It is authoritative for canvas geometry, equal cell boundaries, reading order, and the ${panels.length} occupied cells.
- Use the template only as a structural mask. Replace every occupied dark cell with its assigned cinematic panel while preserving the exact divider positions.
- Keep any cell marked EMPTY completely empty, flat neutral charcoal, and free of story content.
- Keep only the requested small lower-left panel numbers. Do not reproduce template colors, placeholder fills, or extra guide text.
- Attach the ordered character reference images only AFTER the grid template, in the exact numbered order listed below.

CONTINUITY WORLD
${group.scenarioContinuity}

REFERENCE IMAGE ORDER
${refLines}
Match every referenced character's exact identity, porcelain surface, hair silhouette, proportions, and immutable appearance. Apply each panel's specified wardrobe and action. Every visible person—including distant or reflected people—must be a seamless, anatomically realistic, life-size porcelain mannequin, never a human and never a toy.

PANELS
${panelLines}

GLOBAL QUALITY
Each panel must look like a finished high-end documentary film still, not concept art. Preserve connected geography, architecture, persistent props, light direction, time, weather, wardrobe, character identity, and material realism across the full sheet. Each panel must advance the story with a genuinely different action or information beat. No duplicated poses, malformed anatomy, doll joints, text other than the requested small panel numbers, logos, watermarks, split subjects, or objects crossing panel boundaries.`;
};

export const buildPanelExpansionPrompt = (panel, group) =>
  `EDIT AND EXPAND THE FIRST REFERENCE IMAGE, which is panel ${ordinalLabel(panel.ordinal)} from a manually approved scene sheet.

Create one clean, native 16:9, high-resolution cinematic frame. Preserve the first reference panel's exact composition, camera angle, lens character, subject identity, pose, wardrobe, environment geometry, lighting, palette, evidence placement, and visual narrative. The second reference is the complete approved sheet and is authoritative for environment and cross-panel continuity. Additional references identify the exact linked character(s).

MANDATORY FULL-BLEED CLEAN-FRAME DELIVERY: use the meaningful cinematic content inside the first reference as the source composition, even if that content does not perfectly fill its extracted grid region. Expand and reconstruct it into a complete edge-to-edge 16:9 scene. Do not place the source inside a frame. Do not preserve or invent letterboxing, pillarboxing, matte bars, blank bands, black/white margins, unused grid-cell pixels, transparent edges, soft empty strips, dead space, or a smaller image floating on a canvas. Every pixel along all four output edges must be natural scene content continuous with the authored environment.

Remove the panel number completely, including every digit, numeral fragment, shadow, glow, outline, or impression left by it. Remove every grid divider, border, guide mark, label, caption, watermark, and crop-edge residue. In particular, the lower-left corner where the panel number appeared must contain only naturally reconstructed scene pixels. The final frame must contain ZERO readable text and ZERO panel numbering. This requirement is critical and overrides any tendency to preserve markings from either reference image.

Reconstruct only the tiny pixels covered by those removable markings and extend crop edges naturally. Do not redesign, recast, restage, beautify, add, remove, duplicate, or relocate important subjects or story objects.

ORIGINAL AUTHORED SHOT:
${panel.prompt}

CONTINUITY WORLD:
${group.scenarioContinuity}

The result must remain a photorealistic documentary recreation with seamless glossy porcelain mannequins using life-size realistic human anatomy. No human skin or facial features, no toy proportions, no doll joints, no digits, no letters, no text, no captions, no panel identifiers, no watermark, no border, no matte, and no empty canvas. Before returning the image, inspect all four corners and all four edges: confirm the old sheet number is entirely absent and natural scene imagery reaches every edge.`;
