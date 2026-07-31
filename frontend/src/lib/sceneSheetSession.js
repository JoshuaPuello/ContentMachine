export const isStaleSceneSheetSessionError = (error) => (
  error?.response?.data?.code === 'STALE_SESSION'
  || error?.code === 'STALE_SESSION'
)

// Scene-sheet mutations are server-canonical: the request contains only an
// operation and the optimistic write token. If a just-finished autosave
// rotated that token, refresh the canonical token and retry exactly once.
export const runSceneSheetMutationWithTokenRecovery = async ({
  getToken,
  refresh,
  operation,
}) => {
  try {
    return await operation(getToken())
  } catch (error) {
    if (!isStaleSceneSheetSessionError(error)) throw error
    const refreshed = await refresh()
    const token = refreshed?.writeToken
    if (!token) throw error
    return operation(token)
  }
}
