const clipUnitId = (item) => {
  if (item?.kind !== 'clip') return null
  const sceneNumber = item.payload?.sceneNumber
  if (sceneNumber == null) return null
  return `${sceneNumber}_${item.payload?.segmentIndex ?? 0}`
}

/**
 * Make the editor timeline follow the canonical editorial video selections.
 * A timeline can remain built while a shot is regenerated and re-selected;
 * final rendering must never keep the older clip URL in that case.
 */
export const reconcileTimelineVideoSelections = (items = [], selectedVideos = {}) => {
  let changed = false
  const nextItems = items.map((item) => {
    const unitId = clipUnitId(item)
    const selectedUrl = unitId ? selectedVideos?.[unitId]?.url : null
    if (!selectedUrl || item.payload?.src === selectedUrl) return item
    changed = true
    return {
      ...item,
      payload: {
        ...item.payload,
        src: selectedUrl,
      },
    }
  })
  return changed ? nextItems : items
}

