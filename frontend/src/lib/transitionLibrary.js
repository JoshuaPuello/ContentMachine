export const TRANSITION_LIBRARY = Object.freeze([
  { id: 'cross-dissolve', label: 'Cross dissolve', description: 'A clean optical blend that softens a motivated scene change.', renderType: 'crossfade', defaultDuration: 0.6 },
  { id: 'dip-to-black', label: 'Dip to black', description: 'A brief editorial breath for a decisive time, place, or chapter turn.', renderType: 'dip', defaultDuration: 0.5 },
  { id: 'soft-blur', label: 'Soft blur dissolve', description: 'A restrained focus handoff for memory, inference, or location changes.', renderType: 'blur-dissolve', defaultDuration: 0.65 },
  { id: 'film-dissolve', label: 'Film dissolve', description: 'A subtle archival emulsion blend; texture stays subordinate to the story.', renderType: 'film-dissolve', defaultDuration: 0.7 },
])

export const transitionDefinition = id => (
  TRANSITION_LIBRARY.find(item => item.id === id)
  || TRANSITION_LIBRARY.find(item => item.renderType === id)
  || TRANSITION_LIBRARY[0]
)

export function transitionForClip(items, clip) {
  const explicit = items.find(item => item.kind === 'transition' && item.payload?.toClipId === clip?.id)
  if (explicit) return explicit
  return items.find(item => item.kind === 'transition' && Math.abs(Number(item.startTime) - Number(clip?.startTime)) <= 0.04) || null
}

export function transitionPlayback(transition, fallbackClip) {
  if (transition) {
    const definition = transitionDefinition(transition.payload?.type)
    return { id: definition.id, type: definition.renderType, duration: Math.max(0.2, Number(transition.endTime) - Number(transition.startTime)) }
  }
  const legacy = fallbackClip?.payload?.transitionIn
  if (legacy === 'crossfade') return { id: 'cross-dissolve', type: 'crossfade', duration: 0.27 }
  if (legacy === 'dip') return { id: 'dip-to-black', type: 'dip', duration: 0.34 }
  return { id: 'cut', type: 'cut', duration: 0 }
}
