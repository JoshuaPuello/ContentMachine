// ─── Scene segmentation engine ────────────────────────────────────────────────
// Decides how many video clips ("segments") a scene needs so the visuals cover
// the scene's narration audio, and how each clip should be timed.
//
// Inputs per scene:
//   audioDuration  — measured length of the scene's narration audio (seconds)
//   clipOptions    — clip lengths the selected video model can generate,
//                    ascending (e.g. [8] for Veo, [6, 10, 15] for Grok)
//   speedFactor    — minimum playback rate allowed when slowing a clip down to
//                    stretch it (0.8 = the clip may play at 80% speed, so an 8s
//                    clip can cover up to 10s of audio). 1 = no slowdown.
//
// Rules (in priority order):
//   1. Segments must jointly cover the full audio duration.
//   2. No segment may cover less than MIN_SEGMENT_SECONDS of audio — a clip
//      shown for 2–3 seconds reads as a glitch, not a shot.
//   3. Prefer as few segments as possible (each extra segment = an extra image
//      + an extra video generation).
//   4. Fill segments greedily at max effective length; if that would leave a
//      final remainder under the minimum, split the audio evenly instead so
//      all segments share the load (e.g. 12s audio on a 10s-max clip → 6s + 6s,
//      never 10s + 2s).

export const MIN_SEGMENT_SECONDS = 5

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

// Returns [{ segmentIndex, targetDuration, clipDuration, playbackRate }]
//   targetDuration — seconds of audio this segment must cover
//   clipDuration   — length of the clip to request from the video model
//   playbackRate   — rate to play the clip at so it lasts targetDuration
//                    (1 = normal speed + trim; <1 = slowed down to stretch)
export function planSceneSegments(audioDuration, clipOptions, speedFactor = 1) {
  const options = [...(clipOptions?.length ? clipOptions : [8])].sort((a, b) => a - b)
  const maxClip = options[options.length - 1]
  const factor = Math.min(1, Math.max(0.5, speedFactor || 1))
  const maxEffective = maxClip / factor

  // No audio measured — single segment at the clip's natural length
  if (!audioDuration || audioDuration <= 0) {
    return [{ segmentIndex: 0, targetDuration: maxClip, clipDuration: maxClip, playbackRate: 1 }]
  }

  const count = Math.max(1, Math.ceil(audioDuration / maxEffective))

  let targets
  if (count === 1) {
    targets = [audioDuration]
  } else {
    const remainder = audioDuration - (count - 1) * maxEffective
    if (remainder >= MIN_SEGMENT_SECONDS) {
      targets = [...Array(count - 1).fill(maxEffective), remainder]
    } else {
      // Final slice would be too short — split evenly instead
      targets = Array(count).fill(audioDuration / count)
    }
  }

  return targets.map((t, i) => {
    const target = round2(t)
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
