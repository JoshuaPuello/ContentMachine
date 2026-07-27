export const WINDOWS_VIDEO_PROVIDER = 'windows-worker'
export const WINDOWS_VIDEO_MODEL = 'windows-default'
export const WINDOWS_VIDEO_API_ROUTES = Object.freeze({
  generate: '/videos/windows/generate',
  status: (sessionId) => `/videos/windows/status/${encodeURIComponent(sessionId)}`,
  pause: '/videos/windows/pause',
  resume: '/videos/windows/resume',
  retryMissing: '/videos/windows/retry-missing',
  cancel: '/videos/windows/cancel',
  manualAttach: '/videos/manual-attach',
})

export const usesWindowsVideoBackend = (settings = {}) =>
  settings.videoGenerationBackend === 'windows-worker'
  || (
    settings.videoGenerationBackend == null
    && settings.videoProvider === WINDOWS_VIDEO_PROVIDER
  )

export const WINDOWS_VIDEO_STATES = Object.freeze([
  'queued',
  'leased',
  'generating',
  'uploading',
  'validating',
  'completed',
  'failed',
  'canceled',
  'superseded',
])

export const WINDOWS_VIDEO_DISPLAY_STATES = Object.freeze([
  'queued',
  'waiting-for-worker',
  'claimed',
  'preparing',
  'downloading',
  'waiting-for-veo',
  'generating',
  'output-ready',
  'uploading',
  'server-validating',
  'retrying',
  'missing',
  'orphaned',
  'broker-unavailable',
  'completed',
  'failed',
  'canceled',
  'superseded',
])

const ACTIVE_STATES = new Set([
  'queued',
  'leased',
  'generating',
  'uploading',
  'validating',
])

const TERMINAL_STATES = new Set([
  'completed',
  'failed',
  'canceled',
  'superseded',
])

const STATUS_ALIASES = {
  pending: 'queued',
  processing: 'generating',
  rendering: 'generating',
  upload: 'uploading',
  validation: 'validating',
  complete: 'completed',
  cancelled: 'canceled',
}

export const normalizeWindowsVideoState = (value) => {
  const normalized = String(value || 'queued').trim().toLowerCase()
  const state = STATUS_ALIASES[normalized] || normalized
  return WINDOWS_VIDEO_STATES.includes(state) ? state : 'queued'
}

export const isWindowsVideoActive = (status) =>
  ACTIVE_STATES.has(normalizeWindowsVideoState(status))

export const isWindowsVideoTerminal = (status) =>
  TERMINAL_STATES.has(normalizeWindowsVideoState(status))

export const windowsVideoStateLabel = (status) => ({
  queued: 'Queued',
  leased: 'Claimed',
  generating: 'Generating',
  uploading: 'Uploading',
  validating: 'Server validating',
  completed: 'Ready',
  failed: 'Failed',
  canceled: 'Canceled',
  superseded: 'Superseded',
})[normalizeWindowsVideoState(status)]

const DISPLAY_PHASE_ALIASES = {
  waiting: 'waiting-for-worker',
  waiting_worker: 'waiting-for-worker',
  waiting_for_worker: 'waiting-for-worker',
  'waiting-for-worker': 'waiting-for-worker',
  claimed: 'claimed',
  prepare: 'preparing',
  preparing: 'preparing',
  download: 'downloading',
  downloading: 'downloading',
  downloading_input: 'downloading',
  waiting_veo: 'waiting-for-veo',
  waiting_for_veo: 'waiting-for-veo',
  'waiting-for-veo': 'waiting-for-veo',
  veo: 'waiting-for-veo',
  generation: 'generating',
  generating: 'generating',
  output_ready: 'output-ready',
  'output-ready': 'output-ready',
  upload: 'uploading',
  uploading: 'uploading',
  validation: 'server-validating',
  validating: 'server-validating',
  server_validating: 'server-validating',
  server_validation: 'server-validating',
  'server-validating': 'server-validating',
  retry: 'retrying',
  retrying: 'retrying',
  missing: 'missing',
  orphaned: 'orphaned',
  broker_unavailable: 'broker-unavailable',
  'broker-unavailable': 'broker-unavailable',
}

export const windowsVideoDisplayState = (task = {}, brokerAvailable = true) => {
  const status = normalizeWindowsVideoState(task.status)
  if (!brokerAvailable && isWindowsVideoActive(status)) return 'broker-unavailable'
  const phase = String(task.phase ?? task.progress?.phase ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
  const fromPhase = DISPLAY_PHASE_ALIASES[phase]
  if (fromPhase) return fromPhase
  return ({
    queued: 'queued',
    leased: 'claimed',
    generating: 'generating',
    uploading: 'uploading',
    validating: 'server-validating',
    completed: 'completed',
    failed: 'failed',
    canceled: 'canceled',
    superseded: 'superseded',
  })[status]
}

export const windowsVideoDisplayLabel = (displayState) => ({
  queued: 'Queued',
  'waiting-for-worker': 'Waiting for worker',
  claimed: 'Claimed',
  preparing: 'Preparing',
  downloading: 'Downloading source',
  'waiting-for-veo': 'Waiting for Veo',
  generating: 'Generating',
  'output-ready': 'Output ready',
  uploading: 'Uploading',
  'server-validating': 'Server validating',
  retrying: 'Retrying',
  missing: 'Missing',
  orphaned: 'Orphaned',
  'broker-unavailable': 'Broker unavailable',
  completed: 'Ready',
  failed: 'Failed',
  canceled: 'Canceled',
  superseded: 'Superseded',
})[displayState] || 'Queued'

export const normalizeWindowsVideoTask = (task = {}) => {
  const owner = task.owner || {}
  const result = task.result || {}
  const progress = task.progress || {}
  const error = task.error
  const unitId = String(
    task.unitId
      ?? task.unit_id
      ?? task.sceneNumber
      ?? task.scene_number
      ?? owner.itemId
      ?? owner.item_id
      ?? ''
  )

  const normalized = {
    unitId,
    jobId: task.taskId ?? task.task_id ?? task.jobId ?? task.job_id ?? task.id ?? null,
    status: normalizeWindowsVideoState(task.status),
    url: task.url ?? task.videoUrl ?? task.video_url ?? result.url ?? result.publicUrl ?? result.public_url ?? null,
    error: typeof error === 'string' ? error : error?.message ?? task.errorMessage ?? task.error_message ?? null,
    attempt: Number(task.attempt ?? 0) || 0,
    maxAttempts: Number(task.maxAttempts ?? task.max_attempts ?? 0) || 0,
    phase: progress.phase ?? task.phase ?? null,
    percent: Number(progress.percent ?? task.percent ?? 0) || 0,
    message: progress.message ?? task.message ?? null,
    updatedAt: task.updatedAt ?? task.updated_at ?? null,
  }
  return {
    ...normalized,
    displayState: windowsVideoDisplayState(normalized),
  }
}

export const normalizeWindowsVideoStatus = (payload = {}) => {
  const data = payload.data && typeof payload.data === 'object' ? payload.data : payload
  const status = data.status && typeof data.status === 'object' ? data.status : data
  const rawTasks = Array.isArray(status.tasks)
    ? status.tasks
    : Array.isArray(status.items)
      ? status.items
      : []
  const brokerAvailable = Boolean(
    status.brokerAvailable
      ?? status.broker_available
      ?? data.brokerAvailable
      ?? data.broker_available
  )
  const tasks = rawTasks
    .map(normalizeWindowsVideoTask)
    .filter(task => task.unitId)
    .map(task => ({
      ...task,
      displayState: windowsVideoDisplayState(task, brokerAvailable),
    }))
  const worker = status.worker || status.workerStatus || status.worker_status || {}

  return {
    paused: Boolean(status.paused ?? status.isPaused ?? status.is_paused),
    brokerAvailable,
    workerConnected: Boolean(
      worker.connected
        ?? status.workerConnected
        ?? status.worker_connected
        ?? status.connected
    ),
    workerName: worker.name ?? worker.workerId ?? worker.worker_id ?? null,
    occupiedSlots: Number(worker.occupiedSlots ?? worker.occupied_slots ?? status.occupiedSlots ?? status.occupied_slots ?? 0) || 0,
    maxSlots: Number(worker.maxSlots ?? worker.max_slots ?? status.maxSlots ?? status.max_slots ?? 0) || 0,
    tasks,
    counts: status.counts || {},
    updatedAt: status.updatedAt ?? status.updated_at ?? new Date().toISOString(),
    error: status.error?.message ?? status.error ?? null,
  }
}

export const mergeWindowsTasksIntoJobs = (jobs = {}, snapshot = {}) => {
  const merged = { ...jobs }
  for (const task of snapshot.tasks || []) {
    const existing = merged[task.unitId] || {}
    merged[task.unitId] = {
      ...existing,
      jobId: task.jobId || existing.jobId || null,
      provider: WINDOWS_VIDEO_PROVIDER,
      status: task.status,
      url: task.url || existing.url || null,
      error: task.error,
      attempt: task.attempt,
      maxAttempts: task.maxAttempts,
      workerPhase: task.phase,
      workerPercent: task.percent,
      workerMessage: task.message,
      workerDisplayState: task.displayState,
      updatedAt: task.updatedAt,
      submissionToken: null,
    }
  }
  return merged
}
