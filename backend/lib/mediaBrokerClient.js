const DEFAULT_TIMEOUT_MS = 30_000

const configuration = () => ({
  baseUrl: String(process.env.MEDIA_BROKER_URL || '').replace(/\/+$/, ''),
  producerId: String(process.env.MEDIA_BROKER_PRODUCER_ID || 'content-machine'),
  token: String(process.env.MEDIA_BROKER_PRODUCER_TOKEN || ''),
  protocolVersion: String(process.env.MEDIA_BROKER_PROTOCOL_VERSION || '1'),
  timeoutMs: Math.max(1_000, Number(process.env.MEDIA_BROKER_REQUEST_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS),
})

const isLocalDevelopmentHost = (hostname) => ['127.0.0.1', 'localhost', '::1'].includes(hostname)

const assertSecureServiceUrl = (value, label) => {
  const parsed = new URL(value)
  if (parsed.protocol !== 'https:' && !isLocalDevelopmentHost(parsed.hostname)) {
    throw new Error(`${label} must use HTTPS outside local development`)
  }
  return parsed
}

export const isMediaBrokerConfigured = () => {
  const config = configuration()
  return Boolean(config.baseUrl && config.producerId && config.token && config.protocolVersion === '1')
}

const headers = () => {
  const config = configuration()
  if (!isMediaBrokerConfigured()) throw new Error('Windows media broker is not configured')
  return {
    Authorization: `Bearer ${config.token}`,
    'X-Media-Producer-Id': config.producerId,
    'X-Media-Protocol-Version': config.protocolVersion,
    'Content-Type': 'application/json',
  }
}

const brokerRequest = async (path, options = {}) => {
  const config = configuration()
  assertSecureServiceUrl(config.baseUrl, 'Media broker URL')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(`${config.baseUrl}${path}`, {
      ...options,
      headers: { ...headers(), ...(options.headers || {}) },
      redirect: 'error',
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok || payload?.error) {
      const error = new Error(payload?.error?.message || `Media broker returned HTTP ${response.status}`)
      error.code = payload?.error?.code || `BROKER_HTTP_${response.status}`
      error.retryable = payload?.error?.retryable ?? response.status >= 500
      error.status = response.status
      throw error
    }
    return payload?.data ?? payload
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error(`Media broker request timed out after ${config.timeoutMs}ms`)
      timeoutError.code = 'BROKER_TIMEOUT'
      timeoutError.retryable = true
      throw timeoutError
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

export const mediaBroker = {
  health: () => brokerRequest('/api/media-producers/v1/health', { headers: {} }),
  createInputSession: (body) => brokerRequest('/api/media-producers/v1/inputs/session', {
    method: 'POST', body: JSON.stringify(body),
  }),
  uploadInput: async (session, bytes) => {
    const upload = assertSecureServiceUrl(session.uploadUrl, 'Broker upload URL')
    const configuredHosts = String(process.env.MEDIA_BROKER_UPLOAD_HOSTS || '')
      .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
    const allowed = isLocalDevelopmentHost(upload.hostname)
      || configuredHosts.includes(upload.hostname.toLowerCase())
    if (!allowed) throw new Error('Broker upload URL host is not allowlisted')
    const response = await fetch(session.uploadUrl, {
      method: session.method || 'PUT',
      headers: session.requiredHeaders,
      body: bytes,
      redirect: 'error',
      signal: AbortSignal.timeout(15 * 60 * 1000),
    })
    if (!response.ok) throw new Error(`Broker input upload failed with HTTP ${response.status}`)
  },
  enqueue: (body) => brokerRequest('/api/media-producers/v1/tasks', {
    method: 'POST', body: JSON.stringify(body),
  }),
  getTask: (taskId, projectId) => brokerRequest(`/api/media-producers/v1/tasks/${encodeURIComponent(taskId)}?projectId=${encodeURIComponent(projectId)}`),
  listProject: async (projectId, filters = {}) => {
    const tasks = []
    let cursor = '0'
    do {
      const query = new URLSearchParams({ projectId, limit: '500', cursor })
      if (filters.status) query.set('status', filters.status)
      if (filters.itemId) query.set('itemId', filters.itemId)
      const page = await brokerRequest(`/api/media-producers/v1/tasks?${query}`)
      tasks.push(...(page.tasks || []))
      cursor = page.pagination?.nextCursor || ''
    } while (cursor && tasks.length < 5_000)
    return tasks
  },
  cancelTask: (taskId, projectId, reason) => brokerRequest(`/api/media-producers/v1/tasks/${encodeURIComponent(taskId)}/cancel?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST', body: JSON.stringify({ reason }),
  }),
  cancelProject: (projectId, options = {}) => brokerRequest(`/api/media-producers/v1/projects/${encodeURIComponent(projectId)}/cancel`, {
    method: 'POST', body: JSON.stringify(options),
  }),
  markApplied: (taskId, projectId) => brokerRequest(`/api/media-producers/v1/tasks/${encodeURIComponent(taskId)}/applied?projectId=${encodeURIComponent(projectId)}`, {
    method: 'POST', body: '{}',
  }),
}
