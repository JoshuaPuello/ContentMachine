import { randomUUID } from 'crypto';
import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import sharp from 'sharp';
import { callClaude, safeParseJSON } from './claude.js';
import { generateVertexImage, VERTEX_IMAGE_MODELS } from '../lib/vertex.js';
import { assertPublicImageHost, readBoundedResponse } from '../lib/windowsVideo.js';
import {
  beginWindowsImageRun,
  buildOrderedReferenceBoard,
  getWindowsImageJob,
  queueWindowsImageTask,
  retryWindowsImageTask,
} from '../lib/windowsImage.js';
import {
  readProjectR2Object,
} from '../lib/r2.js';
import {
  readSessionSnapshot,
  sessionDirectory,
  validSessionId,
  withSessionMutationLock,
  writeSessionSnapshot,
} from '../lib/sessionStore.js';
import {
  buildSceneSheetPlanningChunks,
  buildPanelExpansionPrompt,
  buildSceneSheetTemplateSvg,
  buildSheetMasterPrompt,
  compactSceneSheetShotPrompt,
  fallbackSceneSheetGroups,
  layoutForPanelCount,
  panelCropGeometry,
  runSceneSheetPlanningPool,
  safeSceneSheetId,
  sceneSheetPlanningProgress,
  validatePlannedGroups,
  validateSheetDimensions,
} from '../lib/sceneSheets.js';
import { detectSceneSheetPanels } from '../lib/sceneSheetExtraction.js';

const router = express.Router();
const MAX_SHEET_BYTES = 50 * 1024 * 1024;
const ALLOWED_UPLOAD_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MAX_VERTEX_REFERENCES = 6;
const DEFAULT_EXPANSION_MODEL = 'gemini-2.5-flash-image';
const VERTEX_MODEL_IDS = new Set(VERTEX_IMAGE_MODELS.map(model => model.id));
const MAX_SONNET_PLANNER_SESSIONS = 3;
const MAX_UNITS_PER_PLANNER_CHUNK = 30;
const MAX_PLANNER_PAYLOAD_CHARACTERS = 45_000;
const activePlanningJobs = new Map();
let activeSonnetPlannerSessions = 0;
const sonnetPlannerWaiters = [];

const withSonnetPlannerSlot = async (operation) => {
  if (activeSonnetPlannerSessions >= MAX_SONNET_PLANNER_SESSIONS) {
    await new Promise(resolve => sonnetPlannerWaiters.push(resolve));
  }
  activeSonnetPlannerSessions += 1;
  try {
    return await operation();
  } finally {
    activeSonnetPlannerSessions -= 1;
    sonnetPlannerWaiters.shift()?.();
  }
};

export const resolveSceneSheetExpansionModel = (candidate) => (
  VERTEX_MODEL_IDS.has(candidate) ? candidate : DEFAULT_EXPANSION_MODEL
);

export const sceneSheetGroupStatus = (panels = []) => {
  const expanded = panels.filter(panel => panel.expandedUrl).length;
  if (panels.length > 0 && expanded === panels.length) return 'expanded';
  if (panels.some(panel => panel.status === 'expanding')) return 'expanding';
  if (expanded > 0) return 'partial';
  if (panels.length > 0 && panels.every(panel => panel.status === 'failed')) return 'failed';
  if (panels.some(panel => panel.cropUrl)) return 'ready-to-expand';
  return 'awaiting-upload';
};

const sceneSheetWorkflowStatus = (groups = []) => {
  if (groups.length > 0 && groups.every(group => sceneSheetGroupStatus(group.panels) === 'expanded')) {
    return 'expanded';
  }
  if (groups.some(group => sceneSheetGroupStatus(group.panels) === 'expanding')) return 'expanding';
  if (groups.some(group => ['expanded', 'partial'].includes(sceneSheetGroupStatus(group.panels)))) return 'partial';
  if (groups.length > 0 && groups.every(group => sceneSheetGroupStatus(group.panels) === 'failed')) return 'failed';
  if (groups.every(group => group.sheetUrl)) return 'ready-to-expand';
  return 'awaiting-upload';
};

export const invalidatedSheetSelections = (
  snapshot,
  unitIds,
  groupId = null,
  { includePriorSources = false } = {},
) => {
  const invalidated = [];
  for (const unitId of unitIds || []) {
    const selected = snapshot.selected_images?.[unitId];
    const belongsToSheet = selected?.source === 'scene-sheet'
      || selected?.promptIndex === 'scene-sheet'
      || selected?.sceneSheetGroupId
      || selected?.scene_sheet_group_id;
    const belongsToGroup = !groupId
      || selected?.sceneSheetGroupId === groupId
      || selected?.scene_sheet_group_id === groupId;
    if (!includePriorSources && (!belongsToSheet || !belongsToGroup)) continue;
    if (includePriorSources && !selected) continue;
    delete snapshot.selected_images[unitId];
    invalidated.push(unitId);
  }
  return invalidated;
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SHEET_BYTES, files: 1, fields: 4 },
  fileFilter: (_req, file, done) => {
    done(
      ALLOWED_UPLOAD_MIMES.has(file.mimetype)
        ? null
        : new Error('Scene sheets must be PNG, JPEG, or WebP images'),
      ALLOWED_UPLOAD_MIMES.has(file.mimetype),
    );
  },
});

const receiveSceneSheet = (req, res, next) => upload.single('file')(req, res, error => {
  if (!error) return next();
  return res.status(400).json({
    error: true,
    message: error.code === 'LIMIT_FILE_SIZE'
      ? 'The uploaded scene sheet exceeds 50 MiB'
      : error.message,
    code: 'INVALID_SCENE_SHEET_UPLOAD',
  });
});

const extForMime = (mimeType) => {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/webp') return 'webp';
  return 'jpg';
};

const contentTypeForFormat = (format) => {
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return 'image/jpeg';
};

const publicSessionAsset = (req, sessionId, storedUrl) => {
  if (!String(storedUrl || '').startsWith('__session_file__/')) return storedUrl || null;
  const relativePath = storedUrl.slice('__session_file__/'.length)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `${req.protocol}://${req.get('host')}/api/session/${sessionId}/files/${relativePath}`;
};

const assertSessionWriteToken = (snapshot, providedToken) => {
  const expected = snapshot?._session?.write_token;
  if (!expected || !providedToken || String(providedToken) !== String(expected)) {
    const error = new Error('This project changed in another session. Reopen it before editing scene sheets.');
    error.status = 409;
    error.code = 'STALE_SESSION';
    throw error;
  }
};

const rotateWriteToken = (snapshot) => {
  const token = randomUUID();
  snapshot._session = { ...(snapshot._session || {}), write_token: token };
  return token;
};

const buildCanonicalUnits = (snapshot) => {
  const planByScene = new Map(
    (snapshot.scene_plan?.scenes || []).map(scene => [Number(scene.scene_number), scene]),
  );
  return (snapshot.scenes || [])
    .map(scene => {
      const sceneNumber = Number(scene.scene_number);
      const segmentIndex = Number(scene.segment_index ?? 0);
      const planScene = planByScene.get(sceneNumber) || {};
      const selected = snapshot.selected_images?.[`${sceneNumber}_${segmentIndex}`];
      const prompt = compactSceneSheetShotPrompt(selected?.prompt || scene.prompts?.[0] || '');
      return {
        unitId: `${sceneNumber}_${segmentIndex}`,
        sceneNumber,
        segmentIndex,
        prompt,
        label: scene.segment_count > 1
          ? `Scene ${sceneNumber} · Shot ${segmentIndex + 1}`
          : `Scene ${sceneNumber}`,
        narration: String(scene.narration || '').trim(),
        scenarioId: String(
          planScene.environment_family_id || planScene.scenario_id || `scene-${sceneNumber}`,
        ).trim(),
        scenarioTitle: String(planScene.visual_description || scene.scene_title || '').trim(),
        scenarioContinuity: String(
          planScene.environment_family_continuity
          || planScene.scenario_continuity
          || 'Preserve the same physical environment, lighting, weather, recurring props, and character identities.',
        ).trim(),
        visualDescription: String(planScene.visual_description || scene.scene_description || '').trim(),
        characterIds: [
          ...new Set(snapshot.character_scene_links?.[String(sceneNumber)]?.character_ids || []),
        ],
      };
    })
    .filter(unit => Number.isFinite(unit.sceneNumber) && unit.prompt)
    .sort((left, right) =>
      left.sceneNumber - right.sceneNumber || left.segmentIndex - right.segmentIndex,
    );
};

const plannerSystemPrompt = `You are a documentary previsualization continuity planner.
Group individual shot units into scene sheets so a human can generate several visually consistent frames in one image.

Rules:
- Each group contains 2 to 6 unique unitIds.
- Preserve story order inside each group, even when matching environments recur non-adjacently.
- Exact scenario_id matches are strong evidence, but connected spaces in the same continuity state may share a broader family (for example a vault corridor and its visible vault interior at the same time).
- Never combine incompatible era, time of day, weather, wardrobe state, action continuity, or disconnected places merely to fill a sheet.
- Each unit may appear in at most one group.
- Leave genuinely isolated units ungrouped.
- Prefer cohesive 4–6-panel sheets over fragmented 2-panel sheets when shots share the same connected environment, time, light, wardrobe, props, and story-time state.
- Do not split one connected setup into separate sheets merely because the camera crosses a doorway or reveals an adjoining room. Do split it when continuity would have to be invented.
- Return concise JSON only.`;

const planWithSonnet = async (
  req,
  units,
  { chunkIndex = 0, totalChunks = 1, signal } = {},
) => {
  const planningRequest = Object.create(req);
  planningRequest.body = {
    ...req.body,
    provider: 'claude-cli',
    model: 'sonnet',
    systemPrompt: undefined,
  };
  const text = await callClaude(
    planningRequest,
    plannerSystemPrompt,
    `This is planning chunk ${chunkIndex + 1} of ${totalChunks}. It contains complete scenario families; never invent or refer to units outside this chunk.

Plan scene sheets for these canonical shot units:\n${JSON.stringify(units)}

Return:
{"groups":[{"id":"stable-slug","title":"Human-readable continuity group","scenarioId":"broader-family-slug","scenarioContinuity":"all fixed world anchors shared by these panels","unitIds":["1_0","1_1"]}]}`,
    {
      ignoreSystemOverride: true,
      noSessionPersistence: true,
      timeoutMs: 3 * 60_000,
      signal,
    },
  );
  const parsed = safeParseJSON(text);
  return Array.isArray(parsed) ? parsed : parsed.groups;
};

const referencesForGroup = (snapshot, panels) => {
  const characterById = new Map((snapshot.characters || []).map(character => [character.id, character]));
  const seen = new Set();
  const references = [];
  for (const panel of panels) {
    for (const characterId of panel.characterIds || []) {
      if (seen.has(characterId)) continue;
      const character = characterById.get(characterId);
      if (!character?.image) continue;
      seen.add(characterId);
      references.push({
        order: references.length + 1,
        type: 'character',
        characterId,
        name: character.name || characterId,
      });
    }
  }
  return references;
};

const materializeWorkflow = (snapshot, planned, units, options = {}) => {
  const unitById = new Map(units.map(unit => [unit.unitId, unit]));
  const groups = planned.groups.map(group => {
    const layout = layoutForPanelCount(group.unitIds.length);
    const panels = group.unitIds.map((unitId, index) => {
      const unit = unitById.get(unitId);
      return {
        ordinal: index + 1,
        label: unit.label,
        unitId,
        sceneNumber: unit.sceneNumber,
        segmentIndex: unit.segmentIndex,
        prompt: unit.prompt,
        characterIds: unit.characterIds,
        status: 'awaiting-sheet',
        error: null,
      };
    });
    const materialized = {
      id: group.id,
      title: group.title,
      scenarioId: group.scenarioId,
      scenarioContinuity: group.scenarioContinuity,
      unitIds: group.unitIds,
      layout,
      panels,
      references: referencesForGroup(snapshot, panels),
      status: 'awaiting-upload',
      error: null,
    };
    materialized.masterPrompt = buildSheetMasterPrompt(materialized, panels, materialized.references);
    return materialized;
  });
  return {
    version: 1,
    planId: options.planId || randomUUID(),
    status: options.status || (groups.length ? 'awaiting-upload' : 'no-groups'),
    groups,
    isolatedUnitIds: planned.isolatedUnitIds,
    ...(options.pendingUnitIds ? { pendingUnitIds: options.pendingUnitIds } : {}),
    ...(options.planning ? { planning: options.planning } : {}),
    updatedAt: new Date().toISOString(),
  };
};

const planningLedger = (chunks) => {
  const records = chunks.map(chunk => ({
    index: chunk.index,
    status: 'queued',
    unitCount: chunk.units.length,
    payloadCharacters: chunk.payloadCharacters,
    unitIds: chunk.unitIds,
    startedAt: null,
    completedAt: null,
    usedFallback: false,
    error: null,
  }));
  return {
    status: 'planning',
    maxParallel: MAX_SONNET_PLANNER_SESSIONS,
    startedAt: new Date().toISOString(),
    completedAt: null,
    chunks: records,
    ...sceneSheetPlanningProgress(records),
  };
};

const updatePlanningSnapshot = async (sessionId, planId, operation) =>
  withSessionMutationLock(sessionId, async () => {
    const snapshot = await readSessionSnapshot(sessionId);
    if (snapshot.scene_sheet_workflow?.planId !== planId) return false;
    await operation(snapshot);
    snapshot.scene_sheet_workflow.updatedAt = new Date().toISOString();
    await writeSessionSnapshot(sessionId, snapshot);
    return true;
  });

const runSceneSheetPlanningJob = async ({
  sessionId,
  planId,
  req,
  units,
  chunks,
  signal,
}) => {
  const chunkPlans = new Array(chunks.length);

  const persistAggregate = async (snapshot, { finished = false } = {}) => {
    const completedPlans = chunkPlans.filter(Boolean);
    const aggregate = validatePlannedGroups(
      completedPlans.flatMap(plan => plan.groups || []),
      units,
    );
    if (!finished) {
      aggregate.isolatedUnitIds = [
        ...new Set(completedPlans.flatMap(plan => plan.isolatedUnitIds || [])),
      ];
    }
    const currentPlanning = snapshot.scene_sheet_workflow.planning;
    const progress = sceneSheetPlanningProgress(currentPlanning.chunks);
    const planning = {
      ...currentPlanning,
      ...progress,
      status: finished ? 'completed' : 'planning',
      completedAt: finished ? new Date().toISOString() : null,
    };
    const processedIds = new Set(
      currentPlanning.chunks
        .filter(chunk => chunk.status === 'completed')
        .flatMap(chunk => chunk.unitIds || []),
    );
    snapshot.scene_sheet_workflow = materializeWorkflow(snapshot, aggregate, units, {
      planId,
      status: finished
        ? (aggregate.groups.length ? 'awaiting-upload' : 'no-groups')
        : 'planning',
      planning,
      pendingUnitIds: finished
        ? []
        : units.map(unit => unit.unitId).filter(unitId => !processedIds.has(unitId)),
    });
  };

  const processChunk = async (chunk, chunkIndex) => {
      if (signal?.aborted) return;
      const startedAt = new Date().toISOString();
      console.info(
        `[scene-sheets] plan ${planId} chunk ${chunkIndex + 1}/${chunks.length} started (${chunk.units.length} units)`,
      );
      const stillCurrent = await updatePlanningSnapshot(sessionId, planId, async snapshot => {
        const record = snapshot.scene_sheet_workflow.planning.chunks[chunkIndex];
        record.status = 'running';
        record.startedAt = startedAt;
        record.error = null;
        Object.assign(
          snapshot.scene_sheet_workflow.planning,
          sceneSheetPlanningProgress(snapshot.scene_sheet_workflow.planning.chunks),
        );
      });
      if (!stillCurrent) return;

      let planned;
      let usedFallback = false;
      let warning = null;
      try {
        const rawGroups = await withSonnetPlannerSlot(() => planWithSonnet(
          req,
          chunk.units,
          {
            chunkIndex,
            totalChunks: chunks.length,
            signal,
          },
        ));
        planned = validatePlannedGroups(rawGroups, chunk.units);
        if (planned.groups.length === 0) {
          usedFallback = true;
          warning = 'Sonnet returned no valid continuity groups';
          planned = fallbackSceneSheetGroups(chunk.units);
        }
      } catch (error) {
        if (signal?.aborted) return;
        usedFallback = true;
        warning = error.message;
        console.warn(
          `[scene-sheets] plan ${planId} chunk ${chunkIndex + 1}/${chunks.length} Sonnet failed; using deterministic fallback: ${error.message}`,
        );
        planned = fallbackSceneSheetGroups(chunk.units);
      }
      chunkPlans[chunkIndex] = planned;

      const persisted = await updatePlanningSnapshot(sessionId, planId, async snapshot => {
        const record = snapshot.scene_sheet_workflow.planning.chunks[chunkIndex];
        record.status = 'completed';
        record.completedAt = new Date().toISOString();
        record.usedFallback = usedFallback;
        record.error = warning;
        record.groupCount = planned.groups.length;
        record.isolatedCount = planned.isolatedUnitIds.length;
        await persistAggregate(snapshot);
      });
      if (!persisted) return;
      console.info(
        `[scene-sheets] plan ${planId} chunk ${chunkIndex + 1}/${chunks.length} completed (${planned.groups.length} groups${usedFallback ? ', fallback' : ''})`,
      );
  };

  try {
    await runSceneSheetPlanningPool(
      chunks,
      processChunk,
      MAX_SONNET_PLANNER_SESSIONS,
    );
    await updatePlanningSnapshot(sessionId, planId, async snapshot => {
      await persistAggregate(snapshot, { finished: true });
    });
    console.info(`[scene-sheets] plan ${planId} completed (${chunks.length} chunks)`);
  } catch (error) {
    console.error(`[scene-sheets] plan ${planId} failed:`, error);
    await updatePlanningSnapshot(sessionId, planId, async snapshot => {
      snapshot.scene_sheet_workflow.status = 'failed';
      snapshot.scene_sheet_workflow.planning = {
        ...snapshot.scene_sheet_workflow.planning,
        status: 'failed',
        error: error.message,
        completedAt: new Date().toISOString(),
      };
    }).catch(() => {});
  }
};

const workflowForResponse = (req, snapshot, sessionId) => {
  const workflow = JSON.parse(JSON.stringify(snapshot.scene_sheet_workflow || {
    version: 1,
    status: 'not-planned',
    groups: [],
    isolatedUnitIds: [],
  }));
  const characterById = new Map((snapshot.characters || []).map(character => [character.id, character]));
  for (const group of workflow.groups || []) {
    if (group.windowsGeneration?.outputs?.length) {
      group.windowsGeneration = decorateWindowsJobForGroup(group.windowsGeneration, group);
    }
    group.sheetUrl = publicSessionAsset(req, sessionId, group.sheetUrl);
    for (const panel of group.panels || []) {
      panel.cropUrl = publicSessionAsset(req, sessionId, panel.cropUrl);
      panel.expandedUrl = publicSessionAsset(req, sessionId, panel.expandedUrl);
    }
    for (const reference of group.references || []) {
      const source = reference.type === 'character'
        ? characterById.get(reference.characterId)?.image
        : reference.sourceUrl;
      reference.sourceUrl = publicSessionAsset(req, sessionId, source);
    }
  }
  return workflow;
};

const routeError = (res, error, fallbackCode) => {
  const status = Number(error.status) || (/not found/i.test(error.message) ? 404 : 400);
  return res.status(status).json({
    error: true,
    message: error.message,
    code: error.code || fallbackCode,
  });
};

const applySceneSheetBuffer = async ({
  snapshot,
  sessionId,
  groupId,
  buffer,
  sizeBytes,
  generatedSource,
}) => {
  const group = snapshot.scene_sheet_workflow?.groups?.find(candidate => candidate.id === groupId);
  if (!group) throw new Error('Scene-sheet group not found');
  const metadata = await sharp(buffer, { failOn: 'warning' }).metadata();
  if (!['jpeg', 'png', 'webp'].includes(metadata.format)) {
    throw new Error('The scene sheet is not a valid PNG, JPEG, or WebP image');
  }
  const sheetValidation = validateSheetDimensions(
    metadata,
    group.layout,
    { sizeBytes },
  );
  const relativeRoot = `images/scene-sheets/${groupId}`;
  snapshot.scene_sheet_workflow.planId = randomUUID();
  const invalidatedUnitIds = invalidatedSheetSelections(
    snapshot,
    group.unitIds,
    groupId,
    { includePriorSources: true },
  );
  await fs.rm(path.join(sessionDirectory(sessionId), relativeRoot, 'expanded'), {
    recursive: true,
    force: true,
  });
  const actualMimeType = contentTypeForFormat(metadata.format);
  const sourceRelativePath = `${relativeRoot}/source.${extForMime(actualMimeType)}`;
  const sourcePath = path.join(sessionDirectory(sessionId), sourceRelativePath);
  const extraction = await detectSceneSheetPanels(buffer, group.layout);
  const cropBuffers = await Promise.all(group.panels.map(async panel => {
    const geometry = extraction.geometries[panel.ordinal - 1]
      || panelCropGeometry(metadata.width, metadata.height, group.layout, panel.ordinal);
    const cropBuffer = await sharp(buffer, { failOn: 'warning' })
      .extract(geometry)
      .png({ compressionLevel: 9 })
      .toBuffer();
    return { panel, geometry, buffer: cropBuffer };
  }));
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  const sourceTemporary = `${sourcePath}.tmp.${randomUUID()}`;
  await fs.writeFile(sourceTemporary, buffer);
  await fs.rename(sourceTemporary, sourcePath);
  for (const crop of cropBuffers) {
    const cropRelativePath = `${relativeRoot}/tiles/${String(crop.panel.ordinal).padStart(2, '0')}-${crop.panel.unitId}.png`;
    const cropPath = path.join(sessionDirectory(sessionId), cropRelativePath);
    await fs.mkdir(path.dirname(cropPath), { recursive: true });
    const temporary = `${cropPath}.tmp.${randomUUID()}`;
    await fs.writeFile(temporary, crop.buffer);
    await fs.rename(temporary, cropPath);
    crop.panel.cropUrl = `__session_file__/${cropRelativePath}`;
    crop.panel.crop = crop.geometry;
    delete crop.panel.expandedUrl;
    delete crop.panel.expanded;
    crop.panel.status = 'ready-to-expand';
    crop.panel.error = null;
  }
  group.sheetUrl = `__session_file__/${sourceRelativePath}`;
  group.sheet = {
    mimeType: actualMimeType,
    sizeBytes,
    width: metadata.width,
    height: metadata.height,
    layoutMode: sheetValidation.layoutMode,
    actualPanelAspectRatio: sheetValidation.actualPanelAspectRatio,
    needsOutpaint: sheetValidation.needsOutpaint,
    extraction: {
      strategy: extraction.strategy,
      detectedDividers: extraction.detectedDividers,
      dividerCount: extraction.dividerCount,
      confidence: Number(extraction.confidence.toFixed(3)),
      xBoundaries: extraction.xBoundaries,
      yBoundaries: extraction.yBoundaries,
      xInsets: extraction.xInsets,
      yInsets: extraction.yInsets,
    },
    uploadedAt: new Date().toISOString(),
    ...(generatedSource ? { generatedSource } : {}),
  };
  group.status = 'ready-to-expand';
  group.error = null;
  snapshot.scene_sheet_workflow.status = snapshot.scene_sheet_workflow.groups
    .every(candidate => candidate.sheetUrl)
    ? 'ready-to-expand'
    : 'awaiting-upload';
  snapshot.scene_sheet_workflow.updatedAt = new Date().toISOString();
  return invalidatedUnitIds;
};

router.post('/plan', async (req, res) => {
  const { sessionId, writeToken } = req.body || {};
  if (!validSessionId(sessionId)) {
    return res.status(400).json({ error: true, message: 'A valid sessionId is required', code: 'INVALID_SESSION' });
  }
  try {
    const snapshot = await readSessionSnapshot(sessionId);
    assertSessionWriteToken(snapshot, writeToken);
    const units = buildCanonicalUnits(snapshot);
    if (units.length < 2) throw new Error('At least two authored image-prompt units are required');
    const chunks = buildSceneSheetPlanningChunks(
      units,
      MAX_UNITS_PER_PLANNER_CHUNK,
      MAX_PLANNER_PAYLOAD_CHARACTERS,
    );
    const planId = randomUUID();
    const planning = planningLedger(chunks);
    let workflow;
    let nextWriteToken;
    let invalidatedUnitIds = [];
    await withSessionMutationLock(sessionId, async () => {
      const current = await readSessionSnapshot(sessionId);
      assertSessionWriteToken(current, writeToken);
      const priorUnitIds = (current.scene_sheet_workflow?.groups || [])
        .flatMap(group => group.unitIds || []);
      invalidatedUnitIds = invalidatedSheetSelections(current, priorUnitIds);
      workflow = materializeWorkflow(
        current,
        { groups: [], isolatedUnitIds: [] },
        units,
        {
          planId,
          status: 'planning',
          planning,
          pendingUnitIds: units.map(unit => unit.unitId),
        },
      );
      current.scene_sheet_workflow = workflow;
      nextWriteToken = rotateWriteToken(current);
      await writeSessionSnapshot(sessionId, current);
    });

    const plannerRequest = Object.create(req);
    plannerRequest.body = { ...(req.body || {}) };
    activePlanningJobs.get(sessionId)?.controller?.abort();
    const controller = new AbortController();
    const job = runSceneSheetPlanningJob({
      sessionId,
      planId,
      req: plannerRequest,
      units,
      chunks,
      signal: controller.signal,
    }).finally(() => {
      if (activePlanningJobs.get(sessionId)?.promise === job) activePlanningJobs.delete(sessionId);
    });
    activePlanningJobs.set(sessionId, { promise: job, controller, planId });

    const responseSnapshot = await readSessionSnapshot(sessionId);
    return res.status(202).json({
      workflow: workflowForResponse(req, responseSnapshot, sessionId),
      writeToken: nextWriteToken,
      invalidatedUnitIds,
    });
  } catch (error) {
    console.error('[scene-sheets] planning failed:', error);
    return routeError(res, error, 'SCENE_SHEET_PLAN_FAILED');
  }
});

router.get('/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  if (!validSessionId(sessionId)) {
    return res.status(400).json({ error: true, message: 'A valid sessionId is required', code: 'INVALID_SESSION' });
  }
  try {
    const snapshot = await readSessionSnapshot(sessionId);
    return res.json({
      workflow: workflowForResponse(req, snapshot, sessionId),
      writeToken: snapshot._session?.write_token || null,
    });
  } catch (error) {
    return routeError(res, error, 'SCENE_SHEET_LOAD_FAILED');
  }
});

router.post('/:sessionId/:groupId/upload', receiveSceneSheet, async (req, res) => {
  const { sessionId, groupId } = req.params;
  if (!validSessionId(sessionId) || !safeSceneSheetId(groupId)) {
    return res.status(400).json({ error: true, message: 'Invalid session or scene-sheet group', code: 'INVALID_INPUT' });
  }
  if (!req.file) {
    return res.status(400).json({ error: true, message: 'A scene-sheet image file is required', code: 'MISSING_FILE' });
  }
  try {
    let workflow;
    let nextWriteToken;
    let invalidatedUnitIds = [];
    await withSessionMutationLock(sessionId, async () => {
      const snapshot = await readSessionSnapshot(sessionId);
      assertSessionWriteToken(snapshot, req.body.writeToken);
      invalidatedUnitIds = await applySceneSheetBuffer({
        snapshot,
        sessionId,
        groupId,
        sizeBytes: req.file.size,
        buffer: req.file.buffer,
      });
      nextWriteToken = rotateWriteToken(snapshot);
      await writeSessionSnapshot(sessionId, snapshot);
      workflow = workflowForResponse(req, snapshot, sessionId);
    });
    return res.json({ workflow, writeToken: nextWriteToken, invalidatedUnitIds });
  } catch (error) {
    console.error('[scene-sheets] upload failed:', error);
    return routeError(res, error, 'SCENE_SHEET_UPLOAD_FAILED');
  }
});

const containedSessionAssetPath = (sessionId, storedUrl) => {
  const prefix = '__session_file__/';
  if (!String(storedUrl || '').startsWith(prefix)) throw new Error('Scene-sheet asset is not stored locally');
  const root = sessionDirectory(sessionId);
  const absolute = path.resolve(root, storedUrl.slice(prefix.length));
  if (!absolute.startsWith(`${root}${path.sep}`)) throw new Error('Scene-sheet asset path is invalid');
  return absolute;
};

const loadReferenceImage = async (sessionId, source) => {
  if (String(source || '').startsWith('__session_file__/')) {
    const absolute = containedSessionAssetPath(sessionId, source);
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_SHEET_BYTES) throw new Error('Reference image exceeds the 50 MiB limit');
    const buffer = await fs.readFile(absolute);
    const metadata = await sharp(buffer).metadata();
    return { mimeType: contentTypeForFormat(metadata.format), data: buffer.toString('base64') };
  }
  const match = String(source || '').match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/);
  if (match) {
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > MAX_SHEET_BYTES) throw new Error('Reference image exceeds the 50 MiB limit');
    return { mimeType: match[1], data: match[2] };
  }
  if (/^https?:\/\//.test(String(source || ''))) {
    const parsed = new URL(String(source));
    if (parsed.protocol !== 'https:') throw new Error('Remote scene-sheet references must use HTTPS');
    await assertPublicImageHost(parsed.hostname);
    const response = await fetch(parsed, {
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Reference image returned HTTP ${response.status}`);
    const contentType = String(response.headers.get('content-type') || '').split(';')[0];
    if (!ALLOWED_UPLOAD_MIMES.has(contentType)) throw new Error('Reference URL did not return a supported image');
    const buffer = await readBoundedResponse(response, MAX_SHEET_BYTES);
    return { mimeType: contentType, data: buffer.toString('base64') };
  }
  throw new Error('A required scene-sheet reference image is unavailable');
};

const sceneSheetWindowsInputs = async (snapshot, sessionId, group) => {
  const template = await sharp(Buffer.from(
    buildSceneSheetTemplateSvg(group.layout, group.panels.length),
  )).png().toBuffer();
  const references = [{
    referenceId: 'scene-layout',
    contentType: 'image/png',
    bytes: template,
  }];
  const characterById = new Map(
    (snapshot.characters || []).map(character => [String(character.id), character]),
  );
  const orderedCharacters = [];
  for (const reference of group.references || []) {
    const character = characterById.get(String(reference.characterId));
    if (!character?.image) continue;
    const loaded = await loadReferenceImage(sessionId, character.image);
    orderedCharacters.push({
      referenceId: String(reference.characterId),
      name: character.name || String(reference.characterId),
      contentType: loaded.mimeType,
      bytes: Buffer.from(loaded.data, 'base64'),
    });
  }
  const board = await buildOrderedReferenceBoard(orderedCharacters);
  if (board) references.push(board);
  const referenceInstruction = board
    ? '- Attach ONE packed ordered character-reference board as the SECOND reference image. Its left-to-right slots follow the REFERENCE IMAGE ORDER below.'
    : '- No character-reference attachment follows the grid template for this sheet.';
  const adaptedPrompt = String(group.masterPrompt || '').replace(
    '- Attach the ordered character reference images only AFTER the grid template, in the exact numbered order listed below.',
    referenceInstruction,
  );
  const boardContract = board
    ? `\n\nPACKED REFERENCE CONTRACT
- The SECOND attached image is one ordered character-reference board, not a story panel.
- Its left-to-right character slots are: ${board.names.map((name, index) => `${index + 1}. ${name}`).join('; ')}.
- Use each slot only for the character named by the panel instructions. Do not copy the board layout, labels, black strip, or reference numbers into the generated scene sheet.
- The FIRST attached image remains the authoritative scene-sheet grid.`
    : '';
  return {
    references,
    prompt: `${adaptedPrompt}${boardContract}`,
  };
};

export const decorateWindowsJobForGroup = (job, group) => {
  const outputs = (job.outputs || []).map(output => {
    try {
      validateSheetDimensions(
        { width: output.width, height: output.height },
        group.layout,
        { sizeBytes: output.bytes },
      );
      return {
        ...output,
        layoutValidation: {
          valid: true,
          message: 'Usable source canvas · panels will be detected and expanded to 16:9',
        },
      };
    } catch (error) {
      return {
        ...output,
        layoutValidation: { valid: false, message: error.message },
      };
    }
  });
  const selectedOrdinal = outputs.some(
    output => output.ordinal === job.selectedOrdinal && output.layoutValidation?.valid,
  )
    ? job.selectedOrdinal
    : null;
  return {
    ...job,
    outputs,
    selectedOrdinal,
  };
};

const persistGroupWindowsJob = async (sessionId, groupId, job) => {
  await withSessionMutationLock(sessionId, async () => {
    const snapshot = await readSessionSnapshot(sessionId);
    const group = snapshot.scene_sheet_workflow?.groups?.find(candidate => candidate.id === groupId);
    if (!group) return;
    const decorated = decorateWindowsJobForGroup(job, group);
    const requestedSelection = group.windowsGeneration?.selectedOrdinal
      || decorated.selectedOrdinal
      || null;
    const selectedOrdinal = decorated.outputs.some(
      output => output.ordinal === requestedSelection && output.layoutValidation?.valid,
    )
      ? requestedSelection
      : null;
    group.windowsGeneration = {
      taskId: decorated.taskId,
      status: decorated.status,
      attempts: decorated.attempts,
      outputCount: decorated.outputCount,
      progress: decorated.progress || null,
      nextAttemptAt: decorated.nextAttemptAt || null,
      outputs: decorated.outputs,
      selectedOrdinal,
      error: decorated.error || decorated.brokerError || null,
      updatedAt: decorated.updatedAt,
    };
    snapshot.scene_sheet_workflow.updatedAt = new Date().toISOString();
    await writeSessionSnapshot(sessionId, snapshot);
  });
};

router.post('/:sessionId/:groupId/windows/generate', async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { outputCount, retry = false, writeToken, runId: requestedRunId } = req.body || {};
  if (!validSessionId(sessionId) || !safeSceneSheetId(groupId)) {
    return res.status(400).json({ error: true, message: 'Invalid session or scene-sheet group', code: 'INVALID_INPUT' });
  }
  try {
    const snapshot = await readSessionSnapshot(sessionId);
    assertSessionWriteToken(snapshot, writeToken);
    const group = snapshot.scene_sheet_workflow?.groups?.find(candidate => candidate.id === groupId);
    if (!group) throw new Error('Scene-sheet group not found');
    const effectiveOutputCount = Number(
      outputCount ?? snapshot.settings?.windowsImageOutputs ?? 1,
    );
    const runId = requestedRunId || await beginWindowsImageRun(sessionId);
    const taskInput = await sceneSheetWindowsInputs(snapshot, sessionId, group);
    const request = {
      sessionId,
      itemId: `scene-sheet-${groupId}`,
      prompt: taskInput.prompt,
      references: taskInput.references,
      outputCount: effectiveOutputCount,
      metadata: {
        assetType: 'scene-sheet',
        sceneSheetGroupId: groupId,
        planId: snapshot.scene_sheet_workflow.planId,
      },
      runId,
    };
    const prior = await getWindowsImageJob(sessionId, request.itemId, { reconcile: true });
    const job = retry || ['complete', 'failed', 'canceled'].includes(prior?.status)
      ? await retryWindowsImageTask(sessionId, request.itemId, request)
      : await queueWindowsImageTask(request);
    const decorated = decorateWindowsJobForGroup(job, group);
    await persistGroupWindowsJob(sessionId, groupId, decorated);
    return res.status(job.status === 'complete' ? 200 : 202).json({ job: decorated });
  } catch (error) {
    console.error('[scene-sheets] Windows generation failed:', error);
    return routeError(res, error, 'WINDOWS_IMAGE_GENERATION_FAILED');
  }
});

router.get('/:sessionId/:groupId/windows/status', async (req, res) => {
  const { sessionId, groupId } = req.params;
  if (!validSessionId(sessionId) || !safeSceneSheetId(groupId)) {
    return res.status(400).json({ error: true, message: 'Invalid session or scene-sheet group', code: 'INVALID_INPUT' });
  }
  try {
    const job = await getWindowsImageJob(sessionId, `scene-sheet-${groupId}`, {
      reconcile: true,
    });
    if (!job) return res.status(404).json({ error: true, message: 'No Windows image task exists for this sheet', code: 'TASK_NOT_FOUND' });
    const snapshot = await readSessionSnapshot(sessionId);
    const group = snapshot.scene_sheet_workflow?.groups?.find(candidate => candidate.id === groupId);
    if (!group) throw new Error('Scene-sheet group not found');
    const decorated = decorateWindowsJobForGroup(job, group);
    await persistGroupWindowsJob(sessionId, groupId, decorated);
    return res.json({ job: decorated });
  } catch (error) {
    return routeError(res, error, 'WINDOWS_IMAGE_STATUS_FAILED');
  }
});

router.post('/:sessionId/:groupId/windows/select', async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { ordinal, writeToken } = req.body || {};
  if (!validSessionId(sessionId) || !safeSceneSheetId(groupId)) {
    return res.status(400).json({ error: true, message: 'Invalid session or scene-sheet group', code: 'INVALID_INPUT' });
  }
  try {
    const job = await getWindowsImageJob(sessionId, `scene-sheet-${groupId}`, {
      reconcile: true,
    });
    if (job?.status !== 'complete') throw new Error('Windows image generation is not complete');
    const output = job.outputs.find(candidate => candidate.ordinal === Number(ordinal));
    if (!output) throw new Error('The selected Windows image variation does not exist');
    const object = await readProjectR2Object(
      sessionId,
      output.relativePath,
      output.mimeType || 'image/png',
    );
    let workflow;
    let nextWriteToken;
    let invalidatedUnitIds;
    await withSessionMutationLock(sessionId, async () => {
      const snapshot = await readSessionSnapshot(sessionId);
      assertSessionWriteToken(snapshot, writeToken);
      const currentGroup = snapshot.scene_sheet_workflow.groups.find(candidate => candidate.id === groupId);
      const validated = decorateWindowsJobForGroup(job, currentGroup)
        .outputs.find(candidate => candidate.ordinal === output.ordinal);
      if (!validated?.layoutValidation?.valid) {
        throw new Error(validated?.layoutValidation?.message || 'This variation does not fit the planned sheet layout');
      }
      invalidatedUnitIds = await applySceneSheetBuffer({
        snapshot,
        sessionId,
        groupId,
        buffer: object.bytes,
        sizeBytes: object.sizeBytes,
        generatedSource: {
          provider: 'windows-image',
          taskId: job.taskId,
          ordinal: output.ordinal,
          sha256: output.sha256,
        },
      });
      const group = snapshot.scene_sheet_workflow.groups.find(candidate => candidate.id === groupId);
      group.windowsGeneration = {
        ...(group.windowsGeneration || {}),
        taskId: job.taskId,
        status: job.status,
        attempts: job.attempts,
        outputCount: job.outputCount,
        outputs: job.outputs,
        selectedOrdinal: output.ordinal,
        updatedAt: new Date().toISOString(),
      };
      nextWriteToken = rotateWriteToken(snapshot);
      await writeSessionSnapshot(sessionId, snapshot);
      workflow = workflowForResponse(req, snapshot, sessionId);
    });
    return res.json({
      workflow,
      writeToken: nextWriteToken,
      invalidatedUnitIds,
    });
  } catch (error) {
    console.error('[scene-sheets] Windows option selection failed:', error);
    return routeError(res, error, 'WINDOWS_IMAGE_SELECTION_FAILED');
  }
});

const decodeGeneratedImage = (dataUri) => {
  const match = String(dataUri || '').match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) throw new Error('Vertex did not return a valid image');
  return Buffer.from(match[2], 'base64');
};

router.post('/:sessionId/:groupId/expand', async (req, res) => {
  const { sessionId, groupId } = req.params;
  const { writeToken, panelOrdinals } = req.body || {};
  if (!validSessionId(sessionId) || !safeSceneSheetId(groupId)) {
    return res.status(400).json({ error: true, message: 'Invalid session or scene-sheet group', code: 'INVALID_INPUT' });
  }
  let planId;
  let expansionInputs;
  try {
    await withSessionMutationLock(sessionId, async () => {
      const snapshot = await readSessionSnapshot(sessionId);
      assertSessionWriteToken(snapshot, writeToken);
      const workflow = snapshot.scene_sheet_workflow;
      const group = workflow?.groups?.find(candidate => candidate.id === groupId);
      if (!group?.sheetUrl) throw new Error('Upload and validate the scene sheet before expanding panels');
      const requested = Array.isArray(panelOrdinals) && panelOrdinals.length
        ? new Set(panelOrdinals.map(Number))
        : null;
      const panels = group.panels.filter(panel => !requested || requested.has(panel.ordinal));
      if (!panels.length || panels.some(panel => !panel.cropUrl)) {
        throw new Error('No extracted panels are available for expansion');
      }
      if (requested && [...requested].some(ordinal => !panels.some(panel => panel.ordinal === ordinal))) {
        throw new Error('One or more requested panel ordinals are invalid');
      }
      planId = workflow.planId;
      const characterById = new Map((snapshot.characters || []).map(character => [character.id, character]));
      expansionInputs = {
        imageModel: resolveSceneSheetExpansionModel(snapshot.settings?.image_model),
        group: JSON.parse(JSON.stringify(group)),
        sheetUrl: group.sheetUrl,
        panels: panels.map(panel => ({
          ...JSON.parse(JSON.stringify(panel)),
          characterSources: (panel.characterIds || [])
            .map(characterId => characterById.get(characterId)?.image)
            .filter(Boolean),
        })),
      };
      panels.forEach(panel => {
        panel.status = 'expanding';
        panel.error = null;
      });
      group.status = 'expanding';
      group.error = null;
      workflow.status = 'expanding';
      workflow.updatedAt = new Date().toISOString();
      await writeSessionSnapshot(sessionId, snapshot);
    });

    const sheetReference = await loadReferenceImage(sessionId, expansionInputs.sheetUrl);
    const generated = await Promise.allSettled(expansionInputs.panels.map(async panel => {
      const cropReference = await loadReferenceImage(sessionId, panel.cropUrl);
      const characterReferences = [];
      for (const source of panel.characterSources) {
        if (characterReferences.length >= MAX_VERTEX_REFERENCES - 2) break;
        characterReferences.push(await loadReferenceImage(sessionId, source));
      }
      const output = await generateVertexImage({
        model: expansionInputs.imageModel,
        prompt: buildPanelExpansionPrompt(panel, expansionInputs.group),
        aspectRatio: '16:9',
        imageSize: '2K',
        images: [cropReference, sheetReference, ...characterReferences],
      });
      const rawBuffer = decodeGeneratedImage(output);
      const outputMetadata = await sharp(rawBuffer, { failOn: 'warning' }).metadata();
      if (!outputMetadata.width || !outputMetadata.height
        || Math.abs((outputMetadata.width / outputMetadata.height) - (16 / 9)) / (16 / 9) > 0.04) {
        throw new Error('Expanded panel did not return a valid 16:9 image');
      }
      const buffer = await sharp(rawBuffer).rotate().png({ compressionLevel: 9 }).toBuffer();
      const relativePath = `images/scene-sheets/${groupId}/expanded/${String(panel.ordinal).padStart(2, '0')}-${panel.unitId}.png`;
      return {
        ordinal: panel.ordinal,
        buffer,
        relativePath,
        expandedUrl: `__session_file__/${relativePath}`,
        metadata: {
          width: outputMetadata.width,
          height: outputMetadata.height,
          mimeType: 'image/png',
          generatedAt: new Date().toISOString(),
          model: expansionInputs.imageModel,
        },
      };
    }));

    let workflow;
    let nextWriteToken;
    let invalidatedUnitIds = [];
    const selectedImages = {};
    await withSessionMutationLock(sessionId, async () => {
      const snapshot = await readSessionSnapshot(sessionId);
      if (snapshot.scene_sheet_workflow?.planId !== planId) {
        const error = new Error('The scene-sheet plan changed while panels were expanding');
        error.status = 409;
        error.code = 'SUPERSEDED_SCENE_SHEET';
        throw error;
      }
      const group = snapshot.scene_sheet_workflow.groups.find(candidate => candidate.id === groupId);
      invalidatedUnitIds = invalidatedSheetSelections(
        snapshot,
        expansionInputs.panels.map(panel => panel.unitId),
        groupId,
        { includePriorSources: true },
      );
      for (const [index, result] of generated.entries()) {
        const inputPanel = expansionInputs.panels[index];
        const panel = group.panels.find(candidate => candidate.ordinal === inputPanel.ordinal);
        if (result.status === 'fulfilled') {
          const target = path.join(sessionDirectory(sessionId), result.value.relativePath);
          await fs.mkdir(path.dirname(target), { recursive: true });
          const temporary = `${target}.tmp.${randomUUID()}`;
          await fs.writeFile(temporary, result.value.buffer);
          await fs.rename(temporary, target);
          panel.expandedUrl = result.value.expandedUrl;
          panel.expanded = result.value.metadata;
          panel.status = 'expanded';
          panel.error = null;
          const selection = {
            url: result.value.expandedUrl,
            prompt: panel.prompt,
            promptIndex: 'scene-sheet',
            source: 'scene-sheet',
            sceneSheetGroupId: groupId,
            panelOrdinal: panel.ordinal,
          };
          snapshot.selected_images ||= {};
          snapshot.selected_images[panel.unitId] = selection;
          selectedImages[panel.unitId] = selection;
        } else {
          panel.status = 'failed';
          panel.error = result.reason?.message || 'Panel expansion failed';
        }
      }
      group.status = sceneSheetGroupStatus(group.panels);
      group.error = group.status === 'failed' ? 'Every requested panel expansion failed' : null;
      snapshot.scene_sheet_workflow.status = sceneSheetWorkflowStatus(
        snapshot.scene_sheet_workflow.groups,
      );
      snapshot.scene_sheet_workflow.updatedAt = new Date().toISOString();
      nextWriteToken = rotateWriteToken(snapshot);
      await writeSessionSnapshot(sessionId, snapshot);
      workflow = workflowForResponse(req, snapshot, sessionId);
    });
    return res.json({ workflow, writeToken: nextWriteToken, invalidatedUnitIds, selectedImages });
  } catch (error) {
    console.error('[scene-sheets] expansion failed:', error);
    if (planId && expansionInputs) {
      await withSessionMutationLock(sessionId, async () => {
        const snapshot = await readSessionSnapshot(sessionId).catch(() => null);
        if (!snapshot || snapshot.scene_sheet_workflow?.planId !== planId) return;
        const group = snapshot.scene_sheet_workflow.groups
          .find(candidate => candidate.id === groupId);
        if (!group) return;
        const requested = new Set(expansionInputs.panels.map(panel => panel.ordinal));
        for (const panel of group.panels) {
          if (!requested.has(panel.ordinal) || panel.status !== 'expanding') continue;
          panel.status = 'failed';
          panel.error = error.message;
        }
        group.status = sceneSheetGroupStatus(group.panels);
        group.error = group.status === 'failed' ? error.message : null;
        snapshot.scene_sheet_workflow.status = sceneSheetWorkflowStatus(
          snapshot.scene_sheet_workflow.groups,
        );
        snapshot.scene_sheet_workflow.updatedAt = new Date().toISOString();
        await writeSessionSnapshot(sessionId, snapshot);
      }).catch(persistError => {
        console.warn(`[scene-sheets] could not persist fatal expansion state: ${persistError.message}`);
      });
    }
    return routeError(res, error, 'SCENE_SHEET_EXPANSION_FAILED');
  }
});

export default router;
