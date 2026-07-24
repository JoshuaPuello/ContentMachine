export const hasProjectCore = (project) => Boolean(
  project?.story
  || project?.scene_plan
  || project?.selectedStory
  || project?.scenePlan
  || project?.tts_script
  || project?.ttsScript
  || project?.scenes?.length
  || project?.video_prompts?.length
  || project?.videoPrompts?.length
)

export const projectHydrationDecision = ({ sessionId, activeSessionId, backendProject, localState }) => {
  const sameSession = activeSessionId === sessionId
  const backendHasCore = hasProjectCore(backendProject)
  const localHasCore = hasProjectCore(localState)
  const backendTitle = String(backendProject?.story?.title || '').trim().toLowerCase()
  const localTitle = String(localState?.selectedStory?.title || localState?.story?.title || '').trim().toLowerCase()
  const coreIdentityConflict = backendTitle && localTitle && backendTitle !== localTitle
  if (!sameSession && backendHasCore) return 'load-backend'
  if (!sameSession && !backendHasCore) return 'clear-local'
  if (sameSession && backendHasCore && localHasCore && coreIdentityConflict) return 'load-backend'
  if (backendHasCore && !localHasCore) return 'load-backend'
  return 'merge-assets'
}
