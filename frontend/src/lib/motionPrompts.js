const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim()

const isSentenceEnd = (token) => /[.!?]["')\]]?$/.test(token)

// Split narration across generated video segments without dropping or
// duplicating words. Weighted targets follow each segment's actual timeline
// duration; cuts prefer nearby sentence boundaries so every motion prompt gets
// a coherent, segment-specific story beat.
export function splitNarrationAcrossSegments(text, segmentDurations) {
  const narration = normalizeText(text)
  const weights = (segmentDurations || []).map(value => Math.max(0.01, Number(value) || 1))
  if (weights.length === 0) return []
  if (!narration) return weights.map(() => '')
  if (weights.length === 1) return [narration]

  const words = narration.split(' ')
  if (words.length <= weights.length) {
    return weights.map((_, index) => words[index] || '')
  }

  const totalWeight = weights.reduce((sum, value) => sum + value, 0)
  const cuts = []
  let consumedWeight = 0
  let previousCut = 0

  for (let index = 0; index < weights.length - 1; index += 1) {
    consumedWeight += weights[index]
    const ideal = Math.round((consumedWeight / totalWeight) * words.length)
    const minCut = previousCut + 1
    const maxCut = words.length - (weights.length - index - 1)
    const clampedIdeal = Math.min(maxCut, Math.max(minCut, ideal))
    const searchRadius = Math.min(10, Math.max(3, Math.round(words.length * 0.08)))
    let bestCut = clampedIdeal
    let bestDistance = Infinity

    for (let candidate = Math.max(minCut, clampedIdeal - searchRadius); candidate <= Math.min(maxCut, clampedIdeal + searchRadius); candidate += 1) {
      if (!isSentenceEnd(words[candidate - 1])) continue
      const distance = Math.abs(candidate - clampedIdeal)
      if (distance < bestDistance) {
        bestCut = candidate
        bestDistance = distance
      }
    }

    cuts.push(bestCut)
    previousCut = bestCut
  }

  const result = []
  let start = 0
  for (const cut of [...cuts, words.length]) {
    result.push(words.slice(start, cut).join(' ').trim())
    start = cut
  }
  return result
}

export function buildContinuityContext({ previousUnit, previousPlanScene, previousSelectedPrompt, previousEndingState, currentUnit }) {
  if (!previousUnit && !previousPlanScene) return ''
  const sameScene = previousUnit?.scene_number === currentUnit?.scene_number
  const pieces = [
    sameScene
      ? `This is segment ${(currentUnit?.segment_index ?? 0) + 1} of ${currentUnit?.segment_count || 1}; advance the same scene action rather than restarting it.`
      : 'This follows the preceding documentary shot; preserve compatible period, location, lighting, wardrobe, and prop state while treating the new selected image as authoritative frame zero.',
    previousPlanScene?.visual_description
      ? `Previous visible beat: ${normalizeText(previousPlanScene.visual_description)}`
      : '',
    previousUnit?.scene_description
      ? `Previous selected-frame intent: ${normalizeText(previousUnit.scene_description)}`
      : '',
    previousSelectedPrompt
      ? `Previous selected frame: ${normalizeText(previousSelectedPrompt)}`
      : '',
    previousEndingState
      ? `Previous authored ending: ${normalizeText(previousEndingState)}`
      : '',
  ]
  return pieces.filter(Boolean).join(' ')
}

export function derivePreviousEndingState({ previousUnit, previousPlanScene, previousSelectedPrompt }) {
  if (!previousUnit && !previousPlanScene && !previousSelectedPrompt) return ''
  const sourceBeat = normalizeText(
    previousSelectedPrompt
      || previousUnit?.scene_description
      || previousPlanScene?.visual_description
      || 'the preceding documentary beat'
  )
  return `The preceding clip completes its restrained action from ${sourceBeat} and settles into a stable hold without changing figure count, wardrobe, props, or visual style.`
}

const editableMotionRange = (prompt) => {
  const text = String(prompt || '')
  const start = text.indexOf('SCENE INTENT:')
  const continuity = text.indexOf('CONTINUITY HANDOFF:', start + 1)
  const stability = text.indexOf('STABILITY / NEGATIVE CONSTRAINTS:', start + 1)
  const candidates = [continuity, stability].filter(index => index > start)
  return { text, start, end: candidates.length ? Math.min(...candidates) : -1 }
}

// The editor may refine scene action, camera, storyboard, and ending state,
// but it must never rewrite the deterministic identity/style/source locks.
export function preserveProtectedMotionPrompt(originalPrompt, editedPrompt) {
  const original = editableMotionRange(originalPrompt)
  const edited = editableMotionRange(editedPrompt)
  if (original.start < 0 || original.end < 0 || edited.start < 0 || edited.end < 0) {
    throw new Error('This protected motion prompt is incomplete. Regenerate Video Prompts before editing it.')
  }
  return `${original.text.slice(0, original.start)}${edited.text.slice(edited.start, edited.end)}${original.text.slice(original.end)}`
}
