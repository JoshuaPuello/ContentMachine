const imageKey = (sceneNumber, segmentIndex, promptIndex) => (
  `${sceneNumber}_${segmentIndex ?? 0}_${promptIndex}`
)

const selectionKey = (sceneNumber, segmentIndex) => (
  `${sceneNumber}_${segmentIndex ?? 0}`
)

export const selectableImageUnitCount = (scenes = [], images = {}) => (
  scenes.reduce((count, scene) => {
    const promptCount = scene.prompts?.length ?? 0
    const hasImage = Array.from({ length: promptCount }, (_, promptIndex) => (
      images[imageKey(scene.scene_number, scene.segment_index, promptIndex)]
    )).some(image => image?.url && !image?.error)
    return count + (hasImage ? 1 : 0)
  }, 0)
)

export const areAllSelectableImageUnitsSelected = (
  scenes = [],
  images = {},
  selectedImages = {}
) => {
  let selectableCount = 0

  for (const scene of scenes) {
    const promptCount = scene.prompts?.length ?? 0
    const hasImage = Array.from({ length: promptCount }, (_, promptIndex) => (
      images[imageKey(scene.scene_number, scene.segment_index, promptIndex)]
    )).some(image => image?.url && !image?.error)
    if (!hasImage) continue

    selectableCount += 1
    const unit = selectionKey(scene.scene_number, scene.segment_index)
    if (!selectedImages[unit]?.url) return false
  }

  return selectableCount > 0
}

export const buildBulkImageSelection = (
  scenes = [],
  images = {},
  currentSelections = {}
) => {
  const selections = {}

  for (const scene of scenes) {
    const unit = selectionKey(scene.scene_number, scene.segment_index)
    const current = currentSelections[unit]

    // Preserve deliberate manual choices as long as their image is still
    // available. Select All should fill gaps, not overwrite creative choices.
    if (current?.url) {
      selections[unit] = current
      continue
    }

    const promptCount = scene.prompts?.length ?? 0
    for (let promptIndex = 0; promptIndex < promptCount; promptIndex += 1) {
      const image = images[imageKey(scene.scene_number, scene.segment_index, promptIndex)]
      if (!image?.url || image?.error) continue

      selections[unit] = {
        url: image.url,
        prompt: image.prompt ?? scene.prompts?.[promptIndex] ?? '',
        promptIndex,
      }
      break
    }
  }

  return selections
}
