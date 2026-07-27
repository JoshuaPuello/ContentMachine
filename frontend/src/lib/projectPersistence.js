const isQuotaError = (error) => (
  error?.name === 'QuotaExceededError'
  || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED'
  || error?.code === 22
  || error?.code === 1014
)

// The backend session is the canonical project store. Browser persistence is
// deliberately limited to user preferences, project identity, and unsaved
// intake fields so a large documentary can never exhaust localStorage merely
// by being opened.
export const compactPipelineState = (state) => ({
  settings: state.settings,
  activeSessionId: state.activeSessionId,
  sessionWriteToken: state.sessionWriteToken,
  projectName: state.projectName,
  topic: state.topic,
  maxMinutes: state.maxMinutes,
  storyInputMode: state.storyInputMode,
  storyTitle: state.storyTitle,
  storyContext: state.storyContext,
  suppliedVoiceover: state.suppliedVoiceover,
  customPrompts: state.customPrompts,
  includeThumbnail: state.includeThumbnail,
  includeMetadata: state.includeMetadata,
})

export const createQuotaResilientStorage = (storage) => ({
  getItem: (name) => storage.getItem(name),
  removeItem: (name) => storage.removeItem(name),
  setItem: (name, value) => {
    try {
      storage.setItem(name, value)
    } catch (error) {
      if (!isQuotaError(error)) throw error

      // Replacing a legacy oversized checkpoint can itself fail before the
      // browser releases the old value. Remove only our own cache key, then
      // retry the compact checkpoint. Durable project data is server-owned.
      storage.removeItem(name)
      try {
        storage.setItem(name, value)
      } catch (retryError) {
        if (!isQuotaError(retryError)) throw retryError
        console.warn('[session] browser checkpoint skipped because localStorage is full')
      }
    }
  },
})
