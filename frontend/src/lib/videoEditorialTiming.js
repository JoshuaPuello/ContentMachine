const positiveNumber = (...values) => {
  for (const value of values) {
    const number = Number(value)
    if (Number.isFinite(number) && number > 0) return number
  }
  return null
}

/**
 * Keep provider generation length and editorial screen time as separate,
 * explicit contracts on every motion-authoring unit.
 */
export function videoRequestTimingFields(unit = {}, fallback = {}, providerFallback = 6) {
  const providerDuration = positiveNumber(
    unit.clip_duration,
    unit.duration_seconds,
    fallback.clip_duration,
    fallback.duration_seconds,
    providerFallback
  )
  const targetDuration = positiveNumber(
    unit.target_duration,
    unit.action_duration_seconds,
    unit.editorial_duration_seconds,
    fallback.target_duration,
    fallback.action_duration_seconds,
    fallback.editorial_duration_seconds,
    providerDuration
  )
  const playbackRate = positiveNumber(
    unit.playback_rate,
    fallback.playback_rate,
    1
  )
  // targetDuration is timeline time. The motion prompt's action boundary is in
  // source-clip time, so a 5s timeline window played at 0.8x must complete its
  // generated action by source second 4. The provider bound also handles a
  // slowed clip stretched beyond its natural source duration.
  const actionDuration = Math.min(
    providerDuration,
    Math.round(targetDuration * playbackRate * 100) / 100
  )

  return {
    duration_seconds: providerDuration,
    target_duration: targetDuration,
    action_duration_seconds: actionDuration,
    // Explicitly remains timeline/on-screen duration, unlike the source-time
    // action boundary above.
    editorial_duration_seconds: targetDuration,
    clip_duration: providerDuration,
    playback_rate: playbackRate,
  }
}

/**
 * Reapply canonical scalar timing after joining a backend prompt to its local
 * unit, while retaining the backend's richer editorial_timing object intact.
 */
export function enrichedVideoPromptTiming(prompt = {}, unit = {}, storeUnit = {}, providerFallback = 6) {
  const fields = videoRequestTimingFields(unit, storeUnit, providerFallback)
  const backendTiming = prompt.editorial_timing ?? prompt.video_prompt?.editorial_timing
  return {
    ...fields,
    editorial_timing: backendTiming ?? {
      provider_duration_seconds: fields.duration_seconds,
      action_duration_seconds: fields.action_duration_seconds,
      clean_hold_duration_seconds: Math.max(
        0,
        Math.round((fields.duration_seconds - fields.action_duration_seconds) * 100) / 100
      ),
    },
  }
}

export const selectedVideoTargetDuration = (videoPrompt = {}) =>
  positiveNumber(
    videoPrompt.target_duration,
    videoPrompt.editorial_duration_seconds,
    videoPrompt.action_duration_seconds,
    videoPrompt.editorial_timing?.action_duration_seconds
  )
