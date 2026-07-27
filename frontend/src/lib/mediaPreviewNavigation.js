export const buildImagePreviewItems = (scenes = [], images = {}, history = {}) => {
  const seen = new Set()
  const items = []
  for (const scene of scenes) {
    const sceneNumber = scene.scene_number
    const segmentIndex = scene.segment_index ?? 0
    for (let promptIndex = 0; promptIndex < (scene.prompts || []).length; promptIndex += 1) {
      const id = `${sceneNumber}_${segmentIndex}_${promptIndex}`
      if (seen.has(id)) continue
      seen.add(id)
      if (!images[id]?.url && !(history[id] || []).some(version => version?.url)) continue
      items.push({ id, sceneNumber, segmentIndex, promptIndex })
    }
  }
  return items
}

export const buildVideoPreviewItems = (videoPrompts = [], jobs = {}, history = {}) => {
  const seen = new Set()
  const items = []
  for (const prompt of videoPrompts) {
    const id = `${prompt.scene_number}_${prompt.segment_index ?? 0}`
    if (seen.has(id)) continue
    seen.add(id)
    if (!jobs[id]?.url && !(history[id] || []).some(version => version?.url)) continue
    items.push(id)
  }
  return items
}

export const adjacentPreviewItems = (items, currentId, getId = item => item) => {
  const index = items.findIndex(item => getId(item) === currentId)
  return {
    index,
    previous: index > 0 ? items[index - 1] : null,
    next: index >= 0 && index < items.length - 1 ? items[index + 1] : null,
    position: index >= 0 ? index + 1 : 0,
    total: items.length,
  }
}
