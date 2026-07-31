import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '../..');
const SKILL_PATH = path.join(PROJECT_ROOT, '.claude', 'skills', 'seedance-2-0', 'SKILL.md');

export const MOTION_PROMPT_MAX_CHARS = 5000;

const SKILL_FALLBACK = `# Seedance 2.0 Motion Discipline
The selected image is immutable frame zero. Preserve its composition, character count, identities, mannequin material, wardrobe, props, setting, lighting, and style. Porcelain is a visual surface treatment only: every represented person moves with natural human biomechanics, weight, balance, joint arcs, and object interaction—never like a toy, robot, puppet, statue, or rigid display mannequin. Direct motion only. Use one restrained camera move, one continuous take, physically plausible secondary motion, no invented entities, and a stable ending.`;

const BASE_NEGATIVE_CONSTRAINTS = [
  'extra or missing figures',
  'duplicate subjects',
  'extra limbs',
  'human skin',
  'realistic human faces',
  'facial features',
  'identity drift',
  'wardrobe change',
  'new props',
  'object replacement',
  'morphing',
  'melting',
  'porcelain cracks',
  'seams',
  'doll joints',
  'robotic stiffness',
  'puppet motion',
  'doll motion',
  'statue motion',
  'hinge-only articulation',
  'foot skating',
  'ground sliding',
  'floating figures',
  'weightless movement',
  'impossible balance',
  'rubber limbs',
  'mechanically repeated gestures',
  'cuts',
  'montage',
  'teleportation',
  'abrupt camera changes',
  'readable text',
  'subtitles',
  'captions',
  'UI',
  'logos',
  'watermark',
  'letterboxing',
  'unstable edges',
];

let cachedSkill = null;

export function loadSeedanceMotionSkill() {
  if (cachedSkill !== null) return cachedSkill;
  try {
    cachedSkill = readFileSync(SKILL_PATH, 'utf8').trim();
  } catch (error) {
    console.warn(`[motionPrompts] Could not read ${SKILL_PATH}; using embedded safeguards: ${error.message}`);
    cachedSkill = SKILL_FALLBACK;
  }
  return cachedSkill;
}

export function resetSeedanceMotionSkillCache() {
  cachedSkill = null;
}

const secondsLabel = (seconds) => `00:${String(seconds).padStart(2, '0')}`;

export function buildShotGrid(durationSeconds) {
  const duration = Math.max(2, Math.round(Number(durationSeconds) || 6));
  const grid = [];
  for (let start = 0; start + 2 <= duration; start += 2) {
    grid.push([start, start + 2]);
  }
  if (grid.length === 0) return [[0, duration]];
  if (duration > grid.at(-1)[1]) grid.at(-1)[1] = duration;
  return grid.map(([start, end], index) => ({
    shot: index + 1,
    start,
    end,
    label: `SHOT ${index + 1} — ${secondsLabel(start)}–${secondsLabel(end)}`,
  }));
}

const finitePositive = (value) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

const roundTenth = (value) => Math.round(value * 10) / 10;

/**
 * Separates the provider's generated duration from the portion intended for the
 * final edit. Fixed-duration providers can still author a fast 3–6 second beat:
 * the story action finishes inside the editorial window and the unused tail is
 * a stable continuation that can be trimmed without cutting through motion.
 */
export function resolveEditorialTiming(scene = {}) {
  const providerDuration = Math.max(2, roundTenth(finitePositive(scene.duration_seconds) || 6));
  const requestedActionDuration = [
    scene.action_duration_seconds,
    scene.usable_duration_seconds,
    scene.editorial_duration_seconds,
    scene.target_duration,
  ].map(finitePositive).find(value => value !== null);
  const actionDuration = roundTenth(Math.min(providerDuration, requestedActionDuration || providerDuration));
  const hasCleanTail = actionDuration < providerDuration;
  return {
    provider_duration_seconds: providerDuration,
    action_duration_seconds: actionDuration,
    clean_hold_duration_seconds: roundTenth(providerDuration - actionDuration),
    trim_after_seconds: hasCleanTail ? actionDuration : null,
  };
}

export function buildEditorialShotGrid(scene = {}) {
  const timing = resolveEditorialTiming(scene);
  const baseGrid = buildShotGrid(timing.provider_duration_seconds);
  const boundaries = new Set(baseGrid.flatMap(({ start, end }) => [start, end]));
  if (timing.clean_hold_duration_seconds > 0) boundaries.add(timing.action_duration_seconds);
  const sorted = [...boundaries].sort((a, b) => a - b);
  return sorted.slice(0, -1).map((start, index) => {
    const end = sorted[index + 1];
    const phase = start >= timing.action_duration_seconds ? 'clean_hold' : 'action';
    return {
      shot: index + 1,
      start,
      end,
      phase,
      label: `SHOT ${index + 1} — ${secondsLabel(start)}–${secondsLabel(end)}${phase === 'clean_hold' ? ' [CLEAN HOLD]' : ' [ACTION WINDOW]'}`,
    };
  });
}

const compact = (value, max = 900) => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  const clipped = normalized.slice(0, max - 1);
  const boundary = clipped.lastIndexOf(' ');
  return `${clipped.slice(0, boundary > max * 0.7 ? boundary : max - 1).trim()}…`;
};

const unitKey = (scene) => `${scene.scene_number}:${scene.segment_index ?? 0}`;

export function buildMotionPromptSystem(creativeDirection = '') {
  const creative = String(creativeDirection || '').trim();
  return `You are an elite image-to-video motion director. You author only controlled motion that begins from a supplied, immutable source frame.

## SEEDANCE 2.0 SKILL — NON-NEGOTIABLE
${loadSeedanceMotionSkill()}

## CONTENTMACHINE HARD CONTRACT
- The actual selected image supplied to the video provider is frame zero and always overrides prose when they conflict.
- Every visible person remains a seamless, featureless glossy porcelain mannequin for the entire clip. A mannequin must never become a realistic human or gain skin, eyes, a nose, a mouth, facial detail, cracks, seams, or joints.
- PORCELAIN IS VISUAL ONLY: every mannequin represents a living human and must move with natural human biomechanics. Use believable center of gravity, weight transfer, balance, planted feet, joint arcs, reach, grip, inertia, anticipation, follow-through, and recovery. Respect age, build, injury, terrain, clothing, and carried weight. Never choreograph toy-like, robotic, puppet-like, statue-like, stiff display-mannequin, sliding, floating, weightless, or mechanically repeated motion.
- Preserve the source-frame figure count, silhouettes, porcelain tones, sculpted/painted hair, complete clothing, footwear, accessories, props, composition, lighting, and environment.
- Choose exactly ONE restrained primary camera move. Never combine moves into a showcase.
- Write exactly one continuous take on the supplied timed beat grid. No internal cuts, angle swaps, montages, teleports, transformations, or new entities.
- Treat provider duration and editorial action duration as different contracts. Complete the essential visible action inside the ACTION WINDOW, front-loaded enough to survive a trim. After that boundary, introduce no new story action: maintain a composed CLEAN HOLD with only natural settling and continuous existing atmosphere.
- The scene narration and description define what matters. Choreograph concrete actions and object interactions that directly illustrate them.
- ContentMachine supplies narration separately: no dialogue, lip-sync instructions, subtitles, captions, labels, UI, or generated text.
- Return every requested scene_number + segment_index exactly once. Return JSON only.

${creative ? `## PROJECT CREATIVE DIRECTION\nApply this only when it does not conflict with the hard contract above:\n${creative}` : ''}`.trim();
}

export function buildMotionPromptUserContent(sceneData, { useSegments = true, repairIssues = [] } = {}) {
  const prepared = sceneData.map((scene) => {
    const editorialTiming = resolveEditorialTiming(scene);
    return {
      ...scene,
      editorial_timing: editorialTiming,
      required_shot_grid: buildEditorialShotGrid(scene).map((shot) => ({
        shot: shot.shot,
        time: `${secondsLabel(shot.start)}–${secondsLabel(shot.end)}`,
        phase: shot.phase,
      })),
    };
  });
  const repairBlock = repairIssues.length > 0
    ? `\n\nYOUR PREVIOUS RESPONSE WAS REJECTED. Correct every issue:\n- ${repairIssues.join('\n- ')}`
    : '';
  const segmentInstruction = useSegments
    ? 'Segments with the same scene_number play sequentially. Later segments advance the action and must not restart it.'
    : 'Each entry is one complete scene clip.';

  return `Create stable motion specifications for these selected-frame documentary clips.

${segmentInstruction}

HUMAN-MOTION REQUIREMENT:
Porcelain describes appearance only. Choreograph every represented person exactly like a real human body. Each subject_action must include physically credible weight, balance, foot contact, joint coordination, reach, grip, effort, and timing appropriate to the action. Never describe movement as mannequin-like, robotic, puppet-like, doll-like, statue-like, sliding, floating, weightless, or mechanically stiff.

EDITORIAL PACING REQUIREMENT:
duration_seconds is the provider output length, not a command to stretch one action across the whole clip. editorial_timing.action_duration_seconds is the usable story window. Start meaningful motion immediately, deliver the visible payoff before that boundary, and use every later clean_hold beat only for natural deceleration into the same stable pose. A clean_hold beat must add no gesture, reaction, prop interaction, camera reveal, or new story information. It exists so an editor can trim the provider tail cleanly.

SCENES:
${JSON.stringify(prepared, null, 2)}${repairBlock}

Return ONLY this JSON array:
[
  {
    "scene_id": "s01",
    "scene_number": 1,
    "segment_index": 0,
    "duration_seconds": 10,
    "video_prompt": {
      "scene_intent": "One precise sentence describing the visible story beat",
      "primary_camera_move": "One restrained camera move only",
      "storyboard": [
        {
          "shot": 1,
          "time": "00:00–00:02",
          "phase": "action",
          "subject_action": "Concrete physical action beginning exactly from the selected frame, with natural human biomechanics, weight transfer, balance, joint coordination, and object resistance",
          "camera_progression": "How the single primary move advances during this beat",
          "environment_motion": "One subtle physically plausible secondary motion, or none"
        }
      ],
      "ending_state": "Specific stable final pose, prop state, framing, and hold"
    },
    "continuity_notes": {
      "source_frame_authority": "What must remain unchanged",
      "action_progression": "How this advances from prior context without contradicting frame zero"
    }
  }
]

The storyboard array MUST contain exactly the supplied required_shot_grid entries, in order, with matching shot numbers, time strings, and phase values. In clean_hold entries, describe only a stable continuation after the action is already complete. Do not emit full_prompt_string; the server composes protected locks around your motion specification.`;
}

export function coerceVideoPromptArray(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return null;
  const candidate = parsed.prompts || parsed.video_prompts || parsed.scenes;
  if (Array.isArray(candidate)) return candidate;
  const values = Object.values(parsed);
  return values.length > 0 && values.every((value) => value && typeof value === 'object')
    ? values
    : null;
}

const normalizeTime = (value) => String(value || '')
  .toUpperCase()
  .replace(/^SHOT\s*\d+\s*[—:-]\s*/i, '')
  .replace(/\s/g, '')
  .replace(/-/g, '–');

export function validateMotionPromptBatch(items, sceneData) {
  const issues = [];
  const byKey = new Map();
  const expectedKeys = new Set(sceneData.map(unitKey));
  for (const item of items || []) {
    const key = unitKey(item || {});
    if (byKey.has(key)) issues.push(`Duplicate output for unit ${key}.`);
    if (!expectedKeys.has(key)) issues.push(`Unexpected output for unit ${key}.`);
    byKey.set(key, item);
  }

  for (const scene of sceneData) {
    const key = unitKey(scene);
    const item = byKey.get(key);
    if (!item) {
      issues.push(`Missing output for unit ${key}.`);
      continue;
    }
    if (item.scene_id && scene.scene_id && item.scene_id !== scene.scene_id) {
      issues.push(`Unit ${key} changed scene_id from ${scene.scene_id} to ${item.scene_id}.`);
    }
    if (Number(item.duration_seconds) !== Number(scene.duration_seconds)) {
      issues.push(`Unit ${key} must preserve duration_seconds ${scene.duration_seconds}.`);
    }
    const motion = item.video_prompt;
    if (!motion || typeof motion !== 'object') {
      issues.push(`Unit ${key} has no structured video_prompt object.`);
      continue;
    }
    if (!compact(motion.primary_camera_move, 300)) {
      issues.push(`Unit ${key} has no primary_camera_move.`);
    } else {
      const storyboard = Array.isArray(motion.storyboard) ? motion.storyboard : [];
      const camera = [
        motion.primary_camera_move,
        ...storyboard.map(beat => beat?.camera_progression),
      ].filter(Boolean).join(' ').toLowerCase();
      const authoredMotion = [
        motion.scene_intent,
        motion.primary_camera_move,
        motion.ending_state,
        ...storyboard.flatMap(beat => [beat?.subject_action, beat?.camera_progression, beat?.environment_motion]),
      ].filter(Boolean).join(' ').toLowerCase();
      const lockedSubjectMotion = [
        motion.scene_intent,
        motion.ending_state,
        ...storyboard.map(beat => beat?.subject_action),
      ].filter(Boolean).join(' ').toLowerCase();
      const banned = authoredMotion.match(/\b(whip pan|snap zoom|dolly zoom|hard cut|cut to|montage|transform(?:s|ing)? into|morph(?:s|ing)? into|becomes? (?:a )?(?:realistic )?human|human skin|realistic human face)\b/);
      if (banned) issues.push(`Unit ${key} uses forbidden camera/action language: ${banned[0]}.`);
      const inventedEntity = authoredMotion.match(/\b(?:add(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|materializ(?:e|es|ed|ing)|new)\b.{0,48}\b(?:person|people|figure|character|weapon|prop|animal|vehicle|tool)\b/);
      if (inventedEntity) issues.push(`Unit ${key} invents a source-frame entity: ${inventedEntity[0]}.`);
      const enteringEntity = authoredMotion.match(/\b(?:second|another|additional|extra)\s+(?:person|people|figure|character|subject|animal|vehicle|weapon|prop|tool)\b/);
      if (enteringEntity) issues.push(`Unit ${key} invents a source-frame entity: ${enteringEntity[0]}.`);
      const appearingEntity = authoredMotion.match(/\b(?:person|people|figure|character|subject|worker|soldier|man|woman|animal|vehicle|weapon|prop|tool)\b.{0,32}\b(?:enters?|appears?|emerges?|joins?)\b(?:.{0,24}\b(?:frame|scene|shot)\b)?|\b(?:enters?|appears?|emerges?|joins?)\b.{0,32}\b(?:person|people|figure|character|subject|worker|soldier|man|woman|animal|vehicle|weapon|prop|tool)\b/);
      if (appearingEntity) issues.push(`Unit ${key} invents a source-frame entity: ${appearingEntity[0]}.`);
      const gainedAnatomy = authoredMotion.match(/\b(?:gain(?:s|ed|ing)?|grow(?:s|ing)?|develop(?:s|ed|ing)?|sprout(?:s|ed|ing)?)\b.{0,48}\b(?:skin|eyes?|nose|mouth|face|facial features?|limbs?|arms?|legs?|hands?|fingers?)\b/);
      if (gainedAnatomy) issues.push(`Unit ${key} changes locked mannequin anatomy: ${gainedAnatomy[0]}.`);
      const unnaturalBiomechanics = lockedSubjectMotion.match(/\b(?:moves?|walks?|runs?|turns?|reaches?|gestures?|rises?|sits?|stands?)\s+(?:with\s+)?(?:a\s+)?(?:robotic|mechanical|puppet[- ]like|doll[- ]like|toy[- ]like|statue[- ]like|mannequin[- ]like|rigid display-mannequin)\b|\b(?:robotic|puppet[- ]like|doll[- ]like|toy[- ]like|statue[- ]like|mannequin[- ]like)\s+(?:motion|movement|gait|gesture|steps?)\b|\b(?:foot skating|slides? across (?:the )?ground without stepping|floats? above (?:the )?ground|weightless movement|hinge-only articulation|rubber limbs?)\b/i);
      if (unnaturalBiomechanics) issues.push(`Unit ${key} uses non-human mannequin biomechanics: ${unnaturalBiomechanics[0]}.`);
      const facialization = authoredMotion.match(/\b(?:eyes?\s+(?:open(?:s|ed|ing)?|blink(?:s|ed|ing)?)|blink(?:s|ed|ing)?|smil(?:e|es|ed|ing)|lips?\s+(?:move(?:s|d|ing)?|part(?:s|ed|ing)?)|skin|flesh)\b.{0,40}\b(?:appear(?:s|ed|ing)?|form(?:s|ed|ing)?|become(?:s|ing)?|lifelike|realistic|human)?|\bface\b.{0,32}\b(?:lifelike|realistic|human|animate(?:s|d|ing)?)\b/);
      if (facialization) issues.push(`Unit ${key} facializes a locked featureless mannequin: ${facialization[0]}.`);
      const wardrobeRecolor = authoredMotion.match(/\b(?:clothing|wardrobe|garments?|clothes|coveralls?|overalls?|shirt|jacket|coat|dress|uniform|trousers|pants|boots?|shoes?|hat|helmet)\b.{0,48}\b(?:turn(?:s|ed|ing)?|chang(?:e|es|ed|ing)|recolor(?:s|ed|ing)?|become(?:s|ing)?)\b.{0,24}\b(?:red|orange|yellow|green|blue|purple|pink|brown|black|white|grey|gray|silver|gold|beige|tan)\b/);
      if (wardrobeRecolor) issues.push(`Unit ${key} changes locked wardrobe color: ${wardrobeRecolor[0]}.`);
      const lockedEntity = '(?:person|people|figure|character|subject|mannequin|weapon|prop|animal|vehicle|tool|wrench|clothing|wardrobe|garment|coveralls?|overalls?|shirt|jacket|coat|dress|uniform|trousers|pants|boots?|shoes?|hat|helmet)';
      const removalVerb = '(?:disappear(?:s|ed|ing)?|vanish(?:es|ed|ing)?|cease(?:s|d)? to exist|is removed from (?:the )?frame)';
      const disappearingEntity = lockedSubjectMotion.match(new RegExp(`\\b${lockedEntity}\\b.{0,48}\\b${removalVerb}\\b|\\b${removalVerb}\\b.{0,48}\\b${lockedEntity}\\b`));
      if (disappearingEntity) issues.push(`Unit ${key} removes a source-frame entity: ${disappearingEntity[0]}.`);
      const internalCut = authoredMotion.match(/\b(?:camera\s+)?cuts?\s+(?:to|away|between)\b|\b(?:angle|view|shot)\s+(?:changes?|switches?)\b/);
      if (internalCut) issues.push(`Unit ${key} introduces an internal cut or angle change: ${internalCut[0]}.`);
      const moveFamilies = [
        /\bpush(?:es|ing)?(?:\s+in)?\b/,
        /\bpull(?:s|ing)?(?:\s+back|\s+out)?\b/,
        /\bpan(?:s|ning)?\b/,
        /\btilt(?:s|ing)?\b/,
        /\btrack(?:s|ing)?\b|\blateral dolly\b/,
        /\borbit(?:s|ing)?\b|\barc(?:s|ing)?\b/,
        /\brack focus\b/,
        /\bcrane(?:s|ing)?\b|\bpedestal(?:s|ing)?\b/,
        /\bzoom(?:s|ing)?\b/,
      ].filter(pattern => pattern.test(camera));
      if (moveFamilies.length > 1) issues.push(`Unit ${key} combines ${moveFamilies.length} primary camera moves; choose exactly one.`);
    }
    if (!compact(motion.scene_intent, 500)) {
      issues.push(`Unit ${key} has no scene_intent.`);
    }
    if (!compact(motion.ending_state, 500)) {
      issues.push(`Unit ${key} has no ending_state.`);
    }
    const expectedGrid = buildEditorialShotGrid(scene);
    const storyboard = Array.isArray(motion.storyboard) ? motion.storyboard : [];
    if (storyboard.length !== expectedGrid.length) {
      issues.push(`Unit ${key} needs exactly ${expectedGrid.length} storyboard beats; received ${storyboard.length}.`);
      continue;
    }
    expectedGrid.forEach((expected, index) => {
      const beat = storyboard[index] || {};
      if (Number(beat.shot) !== expected.shot) {
        issues.push(`Unit ${key} storyboard beat ${index + 1} must use shot ${expected.shot}.`);
      }
      const expectedTime = normalizeTime(`${secondsLabel(expected.start)}–${secondsLabel(expected.end)}`);
      if (normalizeTime(beat.time) !== expectedTime) {
        issues.push(`Unit ${key} shot ${expected.shot} must use ${secondsLabel(expected.start)}–${secondsLabel(expected.end)}.`);
      }
      if (beat.phase !== expected.phase) {
        issues.push(`Unit ${key} shot ${expected.shot} must use phase ${expected.phase}.`);
      }
      if (!compact(beat.subject_action, 700)) {
        issues.push(`Unit ${key} shot ${expected.shot} has no subject_action.`);
      }
      if (expected.phase === 'clean_hold') {
        const holdText = [
          beat.subject_action,
          beat.camera_progression,
          beat.environment_motion,
        ].filter(Boolean).join(' ');
        if (!/\b(?:hold(?:s|ing)?|held|stable|still|settle(?:s|d|ing)?|remain(?:s|ed|ing)?|rest(?:s|ed|ing)?|stop(?:s|ped|ping)?|complete(?:s|d)?|no new)\b/i.test(holdText)) {
          issues.push(`Unit ${key} shot ${expected.shot} clean_hold must describe a stable trimmable tail.`);
        }
        const newAction = holdText.match(/\b(?:begins?|starts?|initiates?|raises?|lifts?|reaches?|grabs?|turns?|walks?|runs?|opens?|closes?|reveals?|reacts?|gestures?|strikes?|throws?|enters?|exits?)\b/i);
        if (newAction) {
          issues.push(`Unit ${key} shot ${expected.shot} clean_hold introduces new action: ${newAction[0]}.`);
        }
      }
    });
  }

  return [...new Set(issues)];
}

// Last-resort authoring path for provider outages or responses that remain
// structurally unsafe after the repair pass. This is intentionally restrained:
// it never invents visible action and still goes through the same deterministic
// source-frame/style locks as AI-authored prompts. A usable protected prompt is
// better than leaving a project permanently stranded on an empty Videos page.
export function createFallbackMotionPromptBatch(sceneData, reason = '') {
  return (sceneData || []).map((scene) => {
    const editorialTiming = resolveEditorialTiming(scene);
    const storyboard = buildEditorialShotGrid(scene).map(({ shot, start, end, phase }, index, grid) => {
      const isFirst = index === 0;
      const isLast = index === grid.length - 1;
      const isHold = phase === 'clean_hold';
      return {
        shot,
        time: `${secondsLabel(start)}–${secondsLabel(end)}`,
        phase,
        subject_action: isHold
          ? 'The completed pose remains in a composed stable hold; grounded balance and grip stay unchanged while only minute natural settling continues, with no new action.'
          : isFirst
          ? 'Every visible subject begins in the exact source-frame pose; natural human weight, balance, and joint coordination initiate only the smallest physically plausible motion already implied by frame zero.'
          : isLast
            ? 'The restrained action settles through natural human deceleration, weight transfer, and balance recovery while every visible subject and prop finishes in a composed stable hold.'
            : 'The same visible subjects continue one minimal action with natural human biomechanics, grounded weight, coordinated joints, and believable object resistance without changing identity, count, wardrobe, or props.',
        camera_progression: isHold
          ? 'The same camera position remains stable for a clean editorial trim.'
          : isLast
          ? 'The same near-locked documentary drift eases to a complete stop.'
          : 'The same near-locked documentary drift advances almost imperceptibly.',
        environment_motion: 'Only atmosphere or practical light already visible in frame may shift subtly and continuously.',
      };
    });

    return {
      scene_id: scene.scene_id,
      scene_number: scene.scene_number,
      segment_index: scene.segment_index ?? 0,
      duration_seconds: scene.duration_seconds,
      editorial_timing: editorialTiming,
      authoring_source: 'protected-local-fallback',
      authoring_warning: compact(reason, 500) || undefined,
      video_prompt: {
        scene_intent: 'Preserve the selected frame while the documented beat advances through restrained motion performed with natural human biomechanics; porcelain remains a visual surface treatment only.',
        primary_camera_move: 'near-locked documentary drift at 10% intensity',
        storyboard,
        ending_state: `Every source-frame subject, garment, prop, and environmental feature remains intact as the essential action completes by ${secondsLabel(editorialTiming.action_duration_seconds)} and motion settles into a clean stable hold.`,
      },
      continuity_notes: {
        source_frame_authority: 'The selected image remains immutable frame zero and controls all visible identities, objects, styling, and composition.',
        action_progression: 'Advance only the action already implied by the selected frame, then settle without replaying or inventing a beat.',
      },
    };
  });
}

const safeMotionText = (value, fallback, max = 900) => {
  const text = compact(value, max);
  return text || compact(fallback, max);
};

const limitPrompt = (head, tail, maxChars = MOTION_PROMPT_MAX_CHARS) => {
  const separator = '\n\n';
  const allowance = maxChars - tail.length - separator.length;
  if (head.length <= allowance) return `${head}${separator}${tail}`;
  const lines = head.split('\n');
  const isStructural = (line) => /^(?:[A-Z][A-Z /&-]+:|STORYBOARD \/ SHOT LIST|SHOT \d+ —)/.test(line.trim());
  const contentIndexes = lines
    .map((line, index) => (!isStructural(line) && line.trim() ? index : -1))
    .filter(index => index >= 0);
  const fixedChars = lines.reduce((sum, line) => sum + (isStructural(line) ? line.length : 0), 0)
    + Math.max(0, lines.length - 1);
  const availableContent = Math.max(0, allowance - fixedChars);
  const originalTotal = contentIndexes.reduce((sum, index) => sum + lines[index].length, 0);
  const minimum = availableContent >= contentIndexes.length * 48 ? 48 : 12;
  const budgets = new Map(contentIndexes.map(index => [
    index,
    Math.min(lines[index].length, Math.max(minimum, Math.floor(lines[index].length * availableContent / Math.max(1, originalTotal)))),
  ]));
  let budgetTotal = [...budgets.values()].reduce((sum, value) => sum + value, 0);
  while (budgetTotal > availableContent) {
    const reducible = [...budgets.entries()]
      .filter(([, value]) => value > minimum)
      .sort((a, b) => b[1] - a[1]);
    if (reducible.length === 0) break;
    const [index, value] = reducible[0];
    const reduction = Math.min(value - minimum, budgetTotal - availableContent);
    budgets.set(index, value - reduction);
    budgetTotal -= reduction;
  }
  const compacted = lines.map((line, index) => budgets.has(index) ? compact(line, budgets.get(index)) : line).join('\n');
  return `${compacted}${separator}${tail}`;
};

function composeProtectedPrompt(scene, item, handoff = {}) {
  const motion = item.video_prompt || {};
  const editorialTiming = resolveEditorialTiming(scene);
  const details = scene.mannequin_details || {};
  const count = Number.isFinite(Number(details.count)) ? Math.max(0, Math.round(Number(details.count))) : null;
  const props = Array.isArray(scene.environment?.key_props)
    ? scene.environment.key_props.filter(Boolean).map((prop) => compact(prop, 100))
    : [];
  const expectedCount = count === null
    ? 'Keep exactly the same number of figures visible in the source frame. Never add, remove, duplicate, merge, or replace one.'
    : count === 0
      ? 'Scene-plan reference count: 0. The selected source image is authoritative if it visibly contains any figure. Preserve exactly the number of figures actually visible in frame zero; never add, remove, duplicate, merge, or replace one.'
      : `Scene-plan reference count: ${count}. The selected source image is authoritative in both directions if its visible count differs. Preserve exactly the number of figures actually visible in frame zero; never add, remove, duplicate, merge, or replace one.`;
  const clothing = compact(details.clothing, 280);
  const porcelainTone = compact(details.porcelain_tone, 120) || 'the exact source-frame porcelain tone';
  const narration = compact(scene.narration, 360) || 'No narration text supplied; follow the scene intent and selected frame.';
  const sourceDescription = compact(scene.selected_prompt || scene.visual_description, 350);
  const previous = compact(scene.continuity_context, 180);
  const previousSelectedFrame = compact(handoff.previousSelectedFrame || scene.previous_selected_prompt, 280);
  const previousEndingState = compact(handoff.previousEndingState || scene.previous_ending_state, 240);

  const head = [
    'SOURCE FRAME LOCK:',
    'The supplied selected image is immutable frame zero. Begin at its exact pose, composition, crop, subject placement, lighting, setting, and object state. When prose conflicts with the image, the image wins.',
    sourceDescription ? `Source-frame description: ${sourceDescription}` : '',
    '',
    'CHARACTER / STYLE LOCK:',
    expectedCount,
    `Every visible figure remains a seamless, featureless glossy porcelain mannequin in ${porcelainTone} for every frame. Porcelain is visual appearance only: each represented person moves exactly like a real human, with natural center of gravity, grounded weight transfer, balance, planted feet, coordinated joint arcs, reach, grip, inertia, effort, anticipation, follow-through, and recovery appropriate to age, build, injury, terrain, clothing, and carried weight. Never move like a toy, robot, puppet, doll, statue, or rigid display mannequin; never foot-skate, ground-slide, float, move weightlessly, use hinge-only articulation, rubber limbs, impossible balance, synchronized mechanical limbs, or repeated mechanical gestures. Preserve silhouette, proportions, sculpted or painted hair, accessories, and pristine surface. Never become a realistic human; never gain skin, eyes, nose, mouth, facial detail, cracks, seams, or doll joints.`,
    '',
    'WARDROBE LOCK:',
    clothing
      ? `Scene-plan wardrobe vocabulary: ${clothing}. The selected source image alone controls which items are worn, held, or set aside and overrides any conflicting wardrobe prose. Preserve every visible garment and footwear item in exactly that source-frame state; nothing may appear, disappear, recolor, simplify, move onto or off the body, or change material.`
      : 'Preserve every garment, footwear item, hairstyle, and accessory exactly as visible in the source frame. Nothing appears, disappears, recolors, simplifies, or changes material.',
    '',
    'OBJECT LOCK:',
    props.length > 0
      ? `Scene props: ${props.join('; ')}. Only objects already visible in frame may move. Preserve their identity, count, material, location, and held-hand relationship unless the storyboard explicitly moves one.`
      : 'Only objects already visible in the source frame may move. Do not add, remove, replace, or transform any prop, sign, structure, animal, weapon, or vehicle.',
    '',
    'SCENE INTENT:',
    safeMotionText(motion.scene_intent, compact(scene.visual_description, 240) || 'Animate the documented scene beat without inventing action.', 240),
    `Narration covered by this clip: ${narration}`,
    previous ? `Compatible continuity context: ${previous}` : '',
    previousSelectedFrame ? `Previous selected-frame reference: ${previousSelectedFrame}` : '',
    previousEndingState ? `Previous clip ending handoff: ${previousEndingState}` : '',
    '',
    'CAMERA:',
    `Exactly one restrained primary move at 10–15% intensity: ${safeMotionText(motion.primary_camera_move, scene.camera_intent || 'near-locked documentary drift', 140)}. Do not layer a second move.`,
    '',
    'EDITORIAL TIMING:',
    editorialTiming.clean_hold_duration_seconds > 0
      ? `The provider generates ${editorialTiming.provider_duration_seconds} seconds, but the intended usable story action is ${editorialTiming.action_duration_seconds} seconds. Start the meaningful action immediately and complete its payoff by ${secondsLabel(editorialTiming.action_duration_seconds)}. From that exact boundary through ${secondsLabel(editorialTiming.provider_duration_seconds)}, add no new story action; preserve the completed pose and composition as a clean stable tail that may be trimmed.`
      : `Use the full ${editorialTiming.provider_duration_seconds}-second provider output. Begin meaningful motion immediately, complete the action without padding, and finish on a composed stable frame.`,
    '',
    `STORYBOARD / SHOT LIST — 00:00–${secondsLabel(editorialTiming.provider_duration_seconds)}:`,
    ...(motion.storyboard || []).flatMap((beat, index) => {
      const expected = buildEditorialShotGrid(scene)[index];
      return [
        expected?.label || `SHOT ${index + 1}`,
        [
          safeMotionText(beat.subject_action, 'The source-frame subject holds its pose with subtle natural human breathing, grounded weight, and postural settling.', 130),
          safeMotionText(beat.camera_progression, 'The single camera move advances subtly and continuously.', 65),
          safeMotionText(beat.environment_motion, 'Environmental motion remains minimal and physically consistent.', 65),
        ].join(' '),
      ];
    }),
    '',
    'ENDING STATE:',
    safeMotionText(motion.ending_state, 'Complete the important action, preserve every locked attribute, and settle into a clean stable hold.', 180),
  ].filter((line) => line !== '').join('\n');

  const tail = [
    ...(editorialTiming.clean_hold_duration_seconds > 0 ? [
      'EDITORIAL TRIM CONTRACT:',
      `The essential action is complete by ${secondsLabel(editorialTiming.action_duration_seconds)}. After that boundary, allow no new story action and maintain the completed composition as a [CLEAN HOLD] through ${secondsLabel(editorialTiming.provider_duration_seconds)}.`,
    ] : []),
    ...(previousSelectedFrame || previousEndingState ? [
      'CONTINUITY HANDOFF:',
      previousSelectedFrame ? `Previous selected-frame reference: ${previousSelectedFrame}` : '',
      previousEndingState ? `Previous clip ended in this stable state: ${previousEndingState}` : '',
      'Advance from that completed beat without replaying it, but treat the current selected image as immutable frame zero whenever any prior state conflicts with it.',
    ].filter(Boolean) : []),
    'STABILITY / NEGATIVE CONSTRAINTS:',
    'One continuous unbroken take. Begin exactly at the selected frame. Porcelain remains purely visual while every represented person obeys natural human biomechanics, grounded weight, balance, joint coordination, grip, inertia, and physically credible timing. Finish in a stable human hold with consistent lighting, geometry, edges, figure count, mannequin material, wardrobe, footwear, props, and setting. No dialogue or lip-sync; narration is supplied separately.',
    `Avoid: ${BASE_NEGATIVE_CONSTRAINTS.join(', ')}.`,
  ].join('\n');

  return limitPrompt(head, tail);
}

export function composeMotionPromptBatch(items, sceneData) {
  const byKey = new Map((items || []).map((item) => [unitKey(item || {}), item]));
  let previousComposed = null;
  let previousScene = null;
  return sceneData.map((scene) => {
    const item = byKey.get(unitKey(scene));
    if (!item) throw new Error(`Cannot compose missing motion prompt for unit ${unitKey(scene)}`);
    const previousSelectedFrame = previousScene?.selected_prompt || scene.previous_selected_prompt || '';
    const previousEndingState = previousComposed?.video_prompt?.ending_state || scene.previous_ending_state || '';
    const result = {
      ...item,
      scene_id: scene.scene_id,
      scene_number: scene.scene_number,
      segment_index: scene.segment_index ?? 0,
      duration_seconds: scene.duration_seconds,
      editorial_timing: resolveEditorialTiming(scene),
      motion_prompt_version: 'seedance-2-0-v1',
      source_frame_locked: true,
      negative_prompt: BASE_NEGATIVE_CONSTRAINTS.join(', '),
      continuity_handoff: previousSelectedFrame || previousEndingState ? {
        previous_unit_key: previousScene ? unitKey(previousScene) : null,
        previous_selected_frame: previousSelectedFrame || null,
        previous_ending_state: previousEndingState || null,
      } : null,
      full_prompt_string: composeProtectedPrompt(scene, item, { previousSelectedFrame, previousEndingState }),
    };
    previousComposed = result;
    previousScene = scene;
    return result;
  });
}
