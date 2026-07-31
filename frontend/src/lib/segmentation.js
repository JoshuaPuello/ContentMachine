// ─── Scene segmentation engine ────────────────────────────────────────────────
// Decides how many editorial shots ("segments") a scene needs so the visuals
// cover the scene's narration audio, and how each generated source clip should
// be trimmed/timed. A provider's 8-second generation is a source asset, not an
// instruction to hold one image on screen for all eight seconds.
//
// Inputs per scene:
//   audioDuration  — measured length of the scene's narration audio (seconds)
//   clipOptions    — clip lengths the selected video model can generate,
//                    ascending (e.g. [8] for Veo, [6, 10, 15] for Grok)
//   speedFactor    — minimum playback rate allowed when slowing a clip down to
//                    stretch it (0.8 = the clip may play at 80% speed, so an 8s
//                    clip can cover up to 10s of audio). 1 = no slowdown.
//   sceneContext   — optional scene-plan/narration metadata used to infer pace.
//
// Rules (in priority order):
//   1. Segments must jointly cover the full audio duration.
//   2. Editorial shots normally last 2–8 seconds; the scene's action density,
//      narrative role, and authored beat list decide where it sits in that
//      range.
//   3. Multiple shots use intentionally varied durations. Mechanical equal
//      slices make edits feel metronomic and hide the payoff beat.
//   4. Every target is backed by a valid provider clip. Short editorial shots
//      are made by trimming a longer source, never by asking a fixed-duration
//      provider for an unsupported duration.

export const MIN_SEGMENT_SECONDS = 2
export const MAX_EDITORIAL_SHOT_SECONDS = 8

// Clip lengths per video model (ascending). Models not listed fall back to a
// single fixed clip equal to the scene plan duration.
export const MODEL_CLIP_OPTIONS = {
  'windows-default':            [8],
  'veo-3.1-fast':               [8],
  'grok-3':                     [6, 10, 15],
  'lightricks/ltx-2-pro':       [6, 8, 10],
  'lightricks/ltx-2-fast':      [6, 8, 10, 12, 14, 16, 18, 20],
  'kwaivgi/kling-v3-video':     [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  'kwaivgi/kling-v2.5-turbo-pro': [5, 10],
}

export const getClipOptions = (videoModel, maxClipDuration) => {
  const all = MODEL_CLIP_OPTIONS[videoModel] || [8]
  if (!maxClipDuration) return all
  const capped = all.filter(c => c <= maxClipDuration)
  return capped.length > 0 ? capped : [all[0]]
}

const round2 = (n) => Math.round(n * 100) / 100

const asText = (value) => {
  if (Array.isArray(value)) return value.map(asText).join(' ')
  if (value && typeof value === 'object') return Object.values(value).map(asText).join(' ')
  return value == null ? '' : String(value)
}

const sceneText = (scene = {}) => [
  scene.narrative_beat,
  scene.importance,
  scene.editorial_pace,
  scene.pacing_profile,
  scene.pacing,
  scene.shot_type,
  scene.camera_intent,
  scene.visual_description,
  scene.source_narration,
  scene.narration,
  scene.lines,
  scene.timing_notes,
  scene.mannequin_details?.action,
].map(asText).join(' ').toLowerCase()

const authoredBeats = (scene = {}) => {
  const candidates = [
    scene.editorial_beats,
    scene.visual_beats,
    scene.action_beats,
    scene.shot_beats,
  ]
  return candidates.find(value => Array.isArray(value) && value.length > 0) || []
}

const countMatches = (text, pattern) => (text.match(pattern) || []).length

// Join the three metadata layers available at different points in the
// pipeline. Plan fields are authoritative, narration contributes spoken beats,
// and an already-authored scene unit provides useful fallback text on resumes.
export function buildScenePacingContext(planScene, narrationUnit, generatedScene) {
  return {
    ...(generatedScene || {}),
    ...(narrationUnit || {}),
    ...(planScene || {}),
    lines: narrationUnit?.lines ?? generatedScene?.lines ?? planScene?.lines,
    narration: narrationUnit?.narration
      ?? generatedScene?.full_scene_narration
      ?? generatedScene?.narration
      ?? planScene?.source_narration,
  }
}

/**
 * Infer an editorial rhythm from scene metadata.
 *
 * The score is deliberately explainable and deterministic: explicit pace and
 * narrative-role language carries more weight than incidental action verbs.
 * Authored beat arrays are stronger still and may directly request a shot
 * count. Consumers can surface `reason` in future planning UI without needing
 * to reproduce this analysis.
 */
export function inferEditorialPacing(sceneContext = {}) {
  const text = sceneText(sceneContext)
  const beats = authoredBeats(sceneContext)
  const declaredBeatCount = Math.max(0, Math.round(Number(sceneContext.visual_beat_count) || 0))
  const beatCount = Math.max(beats.length, declaredBeatCount)
  const declaredProfile = String(sceneContext.pacing_profile || '').trim().toLowerCase()
  const explicitProfiles = {
    kinetic: { pace: 'fast', score: 5, idealShotDuration: 2.7 },
    standard: { pace: 'standard', score: 0, idealShotDuration: 4.75 },
    deliberate: { pace: 'slow', score: -4, idealShotDuration: 7.5 },
  }
  if (explicitProfiles[declaredProfile]) {
    return {
      ...explicitProfiles[declaredProfile],
      authoredShotCount: beatCount || null,
      beats,
      reason: `explicit ${declaredProfile} pacing profile`,
    }
  }
  let score = 0
  const reasons = []

  const add = (amount, reason) => {
    score += amount
    reasons.push(reason)
  }

  if (/\b(frenetic|rapid|fast[- ]paced|urgent|kinetic)\b/.test(text)) add(4, 'explicit fast pace')
  else if (/\b(action|climax|chase|fight|escape|crash|arrest|pursuit)\b/.test(text)) add(3, 'action or climax')
  else if (/\b(hook|critical|reveal|turning point|inciting)\b/.test(text)) add(2, 'high-retention narrative beat')

  if (/\b(contemplative|meditative|lingering|slow[- ]paced|solemn|deliberate)\b/.test(text)) add(-4, 'explicit slow pace')
  else if (/\b(establishing|atmospheric|landscape|holds? still|waits?|reflects?)\b/.test(text)) add(-2, 'visual hold')

  const actionCount = countMatches(
    text,
    /\b(runs?|rushes?|turns?|grabs?|strikes?|falls?|rises?|opens?|closes?|enters?|exits?|drives?|swerves?|reaches?|pulls?|pushes?|throws?|catches?|points?|reacts?|reveals?|discovers?|confronts?|restrains?|leans?|steps?|moves?)\b/g
  )
  if (actionCount >= 4) add(2, 'multiple visible actions')
  else if (actionCount >= 2) add(1, 'more than one visible action')

  if (beatCount >= 2) add(Math.min(3, beatCount - 1), `${beatCount} authored visual beats`)

  const idealShotDuration = score >= 5 ? 2.7
    : score >= 3 ? 3.25
      : score >= 1 ? 3.8
        : score <= -4 ? 7.5
          : score <= -2 ? 6.25
            : 4.75

  return {
    pace: score >= 3 ? 'fast' : score <= -2 ? 'slow' : 'standard',
    score,
    idealShotDuration,
    authoredShotCount: beatCount || null,
    beats,
    reason: reasons.join(', ') || 'standard editorial rhythm',
  }
}

const genericWeights = (count) => {
  const patterns = {
    1: [1],
    2: [0.56, 0.44],
    3: [0.34, 0.29, 0.37],
    4: [0.28, 0.22, 0.26, 0.24],
    5: [0.21, 0.18, 0.22, 0.17, 0.22],
    6: [0.18, 0.15, 0.17, 0.16, 0.15, 0.19],
  }
  return patterns[count] || Array.from({ length: count }, (_, index) =>
    1 + (((index * 7) % 5) - 2) * 0.06
  )
}

const beatWeight = (beat, index, count) => {
  const text = asText(beat).toLowerCase()
  let weight = genericWeights(count)[index]
  if (/\b(establish|setup|wide|context|approach)\b/.test(text)) weight *= 1.12
  if (/\b(detail|insert|glance|reaction|impact|cutaway)\b/.test(text)) weight *= 0.84
  if (/\b(reveal|payoff|climax|decision|consequence)\b/.test(text)) weight *= 1.08
  return weight
}

// Weighted water-fill with lower/upper editorial bounds. The final correction
// is applied after rounding so segment targets still sum to the measured audio.
const distributeDuration = (duration, count, beats, maxTarget) => {
  if (count <= 1) return [round2(duration)]
  const minTarget = duration >= count * MIN_SEGMENT_SECONDS
    ? MIN_SEGMENT_SECONDS
    : 0
  const weights = Array.from({ length: count }, (_, index) =>
    beats[index] == null ? genericWeights(count)[index] : beatWeight(beats[index], index, count)
  )
  const targets = Array(count).fill(0)
  const open = new Set(targets.map((_, index) => index))
  let remaining = duration

  while (open.size) {
    const weightSum = [...open].reduce((sum, index) => sum + weights[index], 0)
    const candidates = [...open].map(index => ({
      index,
      value: remaining * weights[index] / weightSum,
    }))
    const below = candidates
      .filter(candidate => candidate.value < minTarget - 0.0001)
      .sort((a, b) => a.value - b.value)[0]
    const above = candidates
      .filter(candidate => candidate.value > maxTarget + 0.0001)
      .sort((a, b) => b.value - a.value)[0]
    const constrained = below || above

    if (!constrained) {
      for (const index of open) targets[index] = remaining * weights[index] / weightSum
      break
    }

    targets[constrained.index] = below ? minTarget : maxTarget
    remaining -= targets[constrained.index]
    open.delete(constrained.index)
  }

  const rounded = targets.map(round2)
  let correctionCents = Math.round(
    (round2(duration) - rounded.reduce((sum, target) => sum + target, 0)) * 100
  )
  // Correct one cent at a time on a shot that still has room. This preserves
  // both the exact scene total and the per-shot upper/lower bounds after
  // decimal rounding.
  while (correctionCents !== 0) {
    const step = correctionCents > 0 ? 0.01 : -0.01
    const index = rounded.findIndex(target => step > 0
      ? target + step <= maxTarget + 0.0001
      : target + step >= minTarget - 0.0001)
    if (index < 0) break
    rounded[index] = round2(rounded[index] + step)
    correctionCents += correctionCents > 0 ? -1 : 1
  }
  return rounded
}

// Returns [{ segmentIndex, targetDuration, clipDuration, playbackRate }]
//   targetDuration — seconds of audio this segment must cover
//   clipDuration   — length of the clip to request from the video model
//   playbackRate   — rate to play the clip at so it lasts targetDuration
//                    (1 = normal speed + trim; <1 = slowed down to stretch)
export function planSceneSegments(audioDuration, clipOptions, speedFactor = 1, sceneContext = null) {
  const options = [...(clipOptions?.length ? clipOptions : [8])].sort((a, b) => a - b)
  const maxClip = options[options.length - 1]
  const factor = Math.min(1, Math.max(0.5, speedFactor || 1))
  const maxEffective = maxClip / factor

  // No audio measured — single segment at the clip's natural length
  if (!audioDuration || audioDuration <= 0) {
    return [{ segmentIndex: 0, targetDuration: maxClip, clipDuration: maxClip, playbackRate: 1 }]
  }

  const maxTarget = Math.min(MAX_EDITORIAL_SHOT_SECONDS, maxEffective)
  const minimumCount = Math.max(1, Math.ceil(audioDuration / maxTarget))
  // Coverage wins when a provider's maximum is itself close to the editorial
  // minimum (for example 3.1s of audio with fixed 3s clips). In that narrow
  // case the final shot may be under two seconds because no all-in-bounds
  // solution exists.
  const maximumCount = Math.max(minimumCount, Math.floor(audioDuration / MIN_SEGMENT_SECONDS))
  const pacing = sceneContext ? inferEditorialPacing(sceneContext) : null
  const pacedCount = pacing
    ? Math.max(1, Math.round(audioDuration / pacing.idealShotDuration))
    : minimumCount
  const authoredCount = pacing?.authoredShotCount
    ? Math.max(pacedCount, pacing.authoredShotCount)
    : pacedCount
  const count = Math.min(maximumCount, Math.max(minimumCount, authoredCount))
  const targets = distributeDuration(audioDuration, count, pacing?.beats || [], maxTarget)

  return targets.map((t, i) => {
    const target = t
    // Smallest clip that covers the target once slowed to the speed floor
    const clipDuration = options.find(c => c / factor >= target - 0.001) ?? maxClip
    // Rate that makes the clip last exactly targetDuration, clamped:
    // never faster than normal speed (trim instead), never below the floor
    const playbackRate = round2(Math.min(1, Math.max(factor, clipDuration / target)))
    return { segmentIndex: i, targetDuration: target, clipDuration, playbackRate }
  })
}

// Composite key helpers — images/videos are tracked per (scene, segment)
export const unitKey = (sceneNumber, segmentIndex) => `${sceneNumber}_${segmentIndex}`
export const parseUnitKey = (key) => {
  const [scene, seg] = String(key).split('_').map(Number)
  return { sceneNumber: scene, segmentIndex: seg || 0 }
}
