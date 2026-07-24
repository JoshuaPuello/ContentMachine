const imageKey = (sceneNumber, segmentIndex, promptIndex) =>
  `${sceneNumber}_${segmentIndex ?? 0}_${promptIndex}`

const unitPrefix = (sceneNumber, segmentIndex) =>
  `${sceneNumber}_${segmentIndex ?? 0}_`

/**
 * Apply a variation-count change only to untouched shots in an existing run.
 *
 * Generated and currently in-flight shots remain byte-for-byte unchanged.
 * Untouched shots keep their complete authored prompt pool so lowering the
 * count and changing it back before generation never requires another LLM
 * pass or loses the original alternatives.
 */
export const replanPendingImageVariations = ({
  scenes = [],
  images = {},
  imagesLoading = {},
  imageProgress = { total: 0, completed: [], pending: [] },
  requestedCount,
}) => {
  const target = Math.min(4, Math.max(1, Number(requestedCount) || 1))
  const pendingSet = new Set(imageProgress.pending || [])
  const completed = [...new Set(imageProgress.completed || [])]
  const retainedPending = new Set(pendingSet)
  const replannedKeys = []
  let replannedShots = 0
  let limitedShots = 0

  const nextScenes = scenes.map((scene) => {
    const prefix = unitPrefix(scene.scene_number, scene.segment_index)
    const hasPending = [...pendingSet].some(key => key.startsWith(prefix))
    const hasSuccessfulImage = Object.entries(images).some(
      ([key, value]) => key.startsWith(prefix) && value?.url && !value?.error
    )
    const isInFlight = Object.entries(imagesLoading).some(
      ([key, loading]) => key.startsWith(prefix) && loading
    )

    if (!hasPending || hasSuccessfulImage || isInFlight) return scene

    const promptPool = Array.isArray(scene.prompt_pool) && scene.prompt_pool.length > 0
      ? scene.prompt_pool
      : (scene.prompts || [])
    const nextPrompts = promptPool.slice(0, target)
    if (nextPrompts.length < target) limitedShots++

    for (const key of pendingSet) {
      if (key.startsWith(prefix)) retainedPending.delete(key)
    }
    nextPrompts.forEach((_, promptIndex) => {
      replannedKeys.push(imageKey(scene.scene_number, scene.segment_index, promptIndex))
    })
    replannedShots++

    return {
      ...scene,
      prompts: nextPrompts,
      prompt_pool: promptPool,
    }
  })

  const pending = [
    ...[...retainedPending].filter(key => !completed.includes(key)),
    ...replannedKeys.filter(key => !completed.includes(key)),
  ]

  return {
    scenes: nextScenes,
    imageProgress: {
      ...imageProgress,
      total: completed.length + pending.length,
      completed,
      pending,
    },
    target,
    replannedShots,
    limitedShots,
    previousPendingCount: pendingSet.size,
    pendingCount: pending.length,
  }
}
