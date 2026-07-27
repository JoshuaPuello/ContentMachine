import axios from 'axios'
import { WINDOWS_VIDEO_API_ROUTES } from '../lib/windowsVideoWorker'

const api = axios.create({
  baseURL: '/api',
  // Generous timeout: local Claude CLI batches can take 5-10+ minutes.
  // Must exceed the backend's CLI timeout (15 min) so errors surface properly.
  timeout: 1000000
})

const sessionCache = new Map()

const fetchSession = (sessionId, { force = false, optional = false } = {}) => {
  if (force) sessionCache.delete(sessionId)
  if (sessionCache.has(sessionId)) return sessionCache.get(sessionId)
  const request = api.get(`/session/${sessionId}`, {
    timeout: 20000,
    params: optional ? { optional: '1' } : undefined,
  })
    .then(r => r.data)
    .catch(err => {
      sessionCache.delete(sessionId)
      throw err
    })
  sessionCache.set(sessionId, request)
  return request
}

const exportedApi = {
  getSettings: () => api.get('/settings').then(r => r.data),
  
  saveSettings: (keys) => api.post('/settings', keys).then(r => r.data),
  
  validateApiKey: (provider, key) =>
    api.post('/settings/validate', { provider, key }).then(r => r.data),
  
  getDefaultPrompts: () => api.get('/claude/default-prompts').then(r => r.data),

  generateStories: (topic, maxMinutes, provider = 'fal', model, systemPrompt, intake = {}) =>
    api.post('/claude/stories', {
      topic,
      maxMinutes,
      provider,
      model,
      systemPrompt: systemPrompt || undefined,
      mode: intake.mode || 'discover',
      title: intake.title || undefined,
      context: intake.context || undefined,
    }).then(r => r.data),

  extractCharacters: (story, scenePlan, narration) =>
    api.post('/claude/characters/extract', { story, scenePlan, narration }, { timeout: 1000000 }).then(r => r.data),

  linkCharacters: (characters, scenePlan, narration) =>
    api.post('/claude/characters/link', { characters, scenePlan, narration }, { timeout: 1000000 }).then(r => r.data),
  
  generateScenePlan: (story, maxMinutes, provider = 'fal', model, systemPrompt, videoModel) =>
    api.post('/claude/scene-planning', { story, maxMinutes, provider, model, systemPrompt: systemPrompt || undefined, videoModel }).then(r => r.data),
  
  generateImagePrompts: (scenePlan, aspectRatio, provider = 'fal', model, systemPrompt, scenesOverride, variationsPerSegment) =>
    api.post('/claude/image-prompts', {
      scenePlan: scenesOverride ? undefined : scenePlan,
      scenes: scenesOverride || undefined,
      aspectRatio, provider, model, systemPrompt: systemPrompt || undefined,
      variationsPerSegment: variationsPerSegment || undefined
    }).then(r => r.data),
  
  generateVideoPrompts: (scenePlan, selectedImages, provider = 'fal', model, systemPrompt, scenesOverride) =>
    api.post('/claude/video-prompts', {
      scenePlan: scenesOverride ? undefined : scenePlan,
      scenes: scenesOverride || undefined,
      selectedImages,
      provider,
      model,
      systemPrompt: systemPrompt || undefined
    }).then(r => r.data),
  
  generateTtsScript: (story, scenePlan, provider = 'fal', model, systemPrompt, cinemaOptions) =>
    api.post('/claude/tts-script', {
      story, scenePlan, provider, model,
      systemPrompt: systemPrompt || undefined,
      cinemaOptions: cinemaOptions || undefined,
    }).then(r => r.data),

  generateExpressiveScript: (sceneBreakdown, provider = 'fal', model) =>
    api.post('/claude/expressive-script', { sceneBreakdown, provider, model }).then(r => r.data),

  // Whisper-based full-audio split — can take minutes for long recordings.
  // Slices are stored server-side; the response carries small URLs only.
  splitFullAudio: (audio, sceneScripts, sessionId) =>
    api.post('/audio/split', { audio, scenes: sceneScripts, sessionId }, { timeout: 1800000 }).then(r => r.data),

  auditFullAudio: (audio, sceneScripts, sessionId, name) =>
    api.post('/audio/audit', {
      audio,
      scenes: sceneScripts,
      sessionId,
      name,
    }, { timeout: 1800000 }).then(r => r.data),

  validateAudioMarker: (sessionId, auditId, marker) =>
    api.post('/audio/audit/validate-marker', {
      sessionId,
      auditId,
      ...marker,
    }, { timeout: 300000 }).then(r => r.data),

  repairFullAudio: (sessionId, auditId, issueIds) =>
    api.post('/audio/audit/repair', {
      sessionId,
      auditId,
      issueIds,
    }, { timeout: 1800000 }).then(r => r.data),

  approveFullAudio: (sessionId, auditId) =>
    api.post('/audio/audit/approve', {
      sessionId,
      auditId,
    }, { timeout: 1800000 }).then(r => r.data),

  // Store one audio blob server-side, get back a small URL. Audio must never
  // live as base64 in app state — it breaks persistence.
  storeAudio: (sessionId, sceneId, audio) =>
    api.post('/audio/store', { sessionId, sceneId, audio }, { timeout: 300000 }).then(r => r.data),
  
  generateMetadata: (story, scenePlan, ttsScript, provider = 'fal', model, systemPrompt) =>
    api.post('/claude/metadata', { story, scenePlan, ttsScript, provider, model, systemPrompt: systemPrompt || undefined }).then(r => r.data),
  
  generateThumbnailPrompts: (story, selectedTitle, thumbnailConcept, provider = 'fal', model, systemPrompt) =>
    api.post('/claude/thumbnail-prompts', { story, selectedTitle, thumbnailConcept, provider, model, systemPrompt: systemPrompt || undefined }).then(r => r.data),
  
  generateImages: (prompts, provider, model, aspectRatio, characterImages, characterDescription, characterReference) => {
    const charImgs = characterImages?.filter(Boolean) ?? []
    console.log('API generateImages request:', { promptCount: prompts?.length, provider, model, aspectRatio, charImgCount: charImgs.length, characterDescription: characterDescription || '(none)' })
    return api.post('/images/generate', {
      prompts,
      provider,
      model,
      aspectRatio,
      ...(charImgs.length ? { characterImages: charImgs } : {}),
      ...(characterDescription ? { characterDescription } : {}),
      ...(characterReference?.name ? {
        characterReference: {
          name: characterReference.name,
          role: characterReference.role,
          description: characterReference.description,
          character_type: characterReference.character_type,
        },
      } : {}),
    }).then(r => {
      console.log('API generateImages response:', r.data)
      return r.data
    })
  },
  
  regenerateImage: (prompt, provider, model, aspectRatio, characterImages, characterDescription) => {
    const charImgs = characterImages?.filter(Boolean) ?? []
    console.log('API regenerateImage request:', { provider, model, aspectRatio, charImgCount: charImgs.length, characterDescription: characterDescription || '(none)' })
    return api.post('/images/regenerate', {
      prompt,
      provider,
      model,
      aspectRatio,
      ...(charImgs.length ? { characterImages: charImgs } : {}),
      ...(characterDescription ? { characterDescription } : {}),
    }).then(r => {
      console.log('API regenerateImage response:', r.data)
      return r.data
    })
  },
  
  generateVideos: (scenes, provider = 'fal', resolution = '1080p', aspectRatio = '16:9', videoModel, sessionId) =>
    api.post('/videos/generate', { scenes, provider, resolution, aspectRatio, videoModel, sessionId }).then(r => r.data),
  
  getVideoStatus: (jobId, provider = 'fal', falEndpoint, sessionId) => {
    const params = new URLSearchParams({ provider });
    if (falEndpoint) params.set('falEndpoint', falEndpoint);
    if (sessionId) params.set('sessionId', sessionId);
    return api.get(`/videos/status/${jobId}?${params}`).then(r => r.data);
  },
  
  regenerateVideo: (
    sceneNumber,
    videoPrompt,
    durationSeconds,
    imageUrl,
    provider = 'fal',
    resolution = '1080p',
    aspectRatio = '16:9',
    videoModel,
    negativePrompt,
    motionPromptVersion,
    sourceFrameLocked,
    sessionId
  ) =>
    api.post('/videos/regenerate', {
      scene_number: sceneNumber,
      video_prompt: videoPrompt,
      negative_prompt: negativePrompt,
      motion_prompt_version: motionPromptVersion,
      source_frame_locked: sourceFrameLocked,
      duration_seconds: durationSeconds,
      image_url: imageUrl,
      provider,
      resolution,
      aspectRatio,
      videoModel,
      sessionId
    }).then(r => r.data),

  // Windows generation is asynchronous. ContentMachine persists project
  // intent while StoryForge remains the shared broker/control plane.
  generateWindowsVideos: (sessionId, unitIds, sessionToken) =>
    api.post(WINDOWS_VIDEO_API_ROUTES.generate, { sessionId, unitIds }, {
      headers: { 'X-Content-Machine-Session-Token': sessionToken },
    }).then(r => r.data),

  getWindowsVideoStatus: (sessionId, sessionToken) =>
    api.get(WINDOWS_VIDEO_API_ROUTES.status(sessionId), {
      headers: { 'X-Content-Machine-Session-Token': sessionToken },
    }).then(r => r.data),

  pauseWindowsVideos: (sessionId, sessionToken) =>
    api.post(WINDOWS_VIDEO_API_ROUTES.pause, { sessionId }, {
      headers: { 'X-Content-Machine-Session-Token': sessionToken },
    }).then(r => r.data),

  resumeWindowsVideos: (sessionId, sessionToken) =>
    api.post(WINDOWS_VIDEO_API_ROUTES.resume, { sessionId }, {
      headers: { 'X-Content-Machine-Session-Token': sessionToken },
    }).then(r => r.data),

  retryMissingWindowsVideos: (sessionId, unitIds, sessionToken) =>
    api.post(WINDOWS_VIDEO_API_ROUTES.retryMissing, { sessionId, unitIds }, {
      headers: { 'X-Content-Machine-Session-Token': sessionToken },
    }).then(r => r.data),

  cancelWindowsVideos: (sessionId, unitIds, sessionToken) =>
    api.post(WINDOWS_VIDEO_API_ROUTES.cancel, { sessionId, unitIds }, {
      headers: { 'X-Content-Machine-Session-Token': sessionToken },
    }).then(r => r.data),

  attachWindowsVideo: (sessionId, unitId, file, sessionToken) => {
    const form = new FormData()
    form.append('sessionId', sessionId)
    form.append('unitId', unitId)
    form.append('file', file)
    return api.post(WINDOWS_VIDEO_API_ROUTES.manualAttach, form, {
      headers: {
        'Content-Type': 'multipart/form-data',
        'X-Content-Machine-Session-Token': sessionToken,
      },
      timeout: 1000000,
    }).then(r => r.data)
  },
  
  generateThumbnails: (prompts, provider, aspectRatio) =>
    api.post('/thumbnail/generate', { prompts, provider, aspectRatio }).then(r => r.data),
  
  regenerateThumbnail: (prompt, provider, aspectRatio) =>
    api.post('/thumbnail/regenerate', { prompt, provider, aspectRatio }).then(r => r.data),
  
  getElevenLabsVoices: () =>
    api.get('/elevenlabs/voices').then(r => r.data),
  
  generateTts: (text, voiceId, modelId) =>
    api.post('/elevenlabs/tts', { text, voiceId, modelId }).then(r => r.data),
  
  generateSceneTts: (lines, voiceId, modelId) =>
    api.post('/elevenlabs/tts/scene', { lines, voiceId, modelId }).then(r => r.data),
  
  generateSfx: (text, durationSeconds) =>
    api.post('/elevenlabs/sfx', { text, durationSeconds }).then(r => r.data),
  
  // 10-min cap: a big project legitimately takes minutes to zip, but a dead
  // backend must surface as an error, not a 16-minute spinner
  exportZip: (project) =>
    api.post('/export/zip', project, { responseType: 'blob', timeout: 600000 }).then(r => {
      const url = window.URL.createObjectURL(new Blob([r.data]))
      const link = document.createElement('a')
      link.href = url
      const disposition = r.headers['content-disposition']
      let filename = 'project.zip'
      if (disposition) {
        const match = disposition.match(/filename="(.+)"/)
        if (match) filename = match[1]
      }
      link.setAttribute('download', filename)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
    })
}

exportedApi.saveSession = (sessionId, project) =>
  api.post('/session/save', { sessionId, project }, { timeout: 300000 }).then(r => {
    sessionCache.delete(sessionId)
    return r.data
  })

exportedApi.listSessions = () =>
  api.get('/session/list').then(r => r.data)

// Preview proxies: local short-GOP re-encodes of remote master clips so the
// editor never streams from provider CDNs during playback.
exportedApi.startPreviewProxies = (sessionId, items) =>
  api.post(`/session/${sessionId}/preview-proxies`, { items }, { timeout: 30000 }).then(r => r.data)

exportedApi.getPreviewProxies = (sessionId) =>
  api.get(`/session/${sessionId}/preview-proxies`).then(r => r.data)

exportedApi.loadSession = (sessionId, options) => fetchSession(sessionId, options)

// Projects are local, so warm their compact JSON snapshots as soon as the
// Projects view appears. Clicking Open then resolves from memory.
exportedApi.prefetchSession = (sessionId) => {
  fetchSession(sessionId).catch(() => {})
}

exportedApi.deleteSession = (sessionId) =>
  api.delete(`/session/${sessionId}`).then(r => {
    sessionCache.delete(sessionId)
    return r.data
  })

exportedApi.renameSession = (sessionId, name) =>
  api.patch(`/session/${sessionId}/name`, { name }).then(r => {
    sessionCache.delete(sessionId)
    return r.data
  })

// ─── Director (cinema placement plan + map segments) ─────────────────────────

exportedApi.directorPlan = (payload) =>
  api.post('/director/plan', payload, { timeout: 210000 }).then(r => r.data)

exportedApi.directorSfxMaterialize = (payload) =>
  api.post('/director/sfx/materialize', payload, { timeout: 900000 }).then(r => r.data)

exportedApi.directorMapStart = (payload) =>
  api.post('/director/map/start', payload).then(r => r.data)

exportedApi.directorMapStatus = (jobId) =>
  api.get(`/director/map/status/${jobId}`).then(r => r.data)

exportedApi.directorMapHistory = (sessionId, mapId) =>
  api.get(`/director/map/history/${encodeURIComponent(sessionId)}/${encodeURIComponent(mapId)}`).then(r => r.data)

// ─── Final film render (Remotion via StoryForge) ─────────────────────────────

exportedApi.renderStart = (payload) =>
  api.post('/render/start', payload, { timeout: 600000 }).then(r => r.data)

exportedApi.renderStatus = (jobId) =>
  api.get(`/render/status/${jobId}`).then(r => r.data)

exportedApi.renderCancel = (jobId) =>
  api.post(`/render/cancel/${jobId}`).then(r => r.data)

exportedApi.renderHistory = (sessionId) =>
  api.get(`/render/history/${encodeURIComponent(sessionId)}`).then(r => r.data)

exportedApi.deleteRender = (sessionId, fileName) =>
  api.delete(`/render/history/${encodeURIComponent(sessionId)}/${encodeURIComponent(fileName)}`).then(r => r.data)

exportedApi.deleteAllRenders = (sessionId) =>
  api.delete(`/render/history/${encodeURIComponent(sessionId)}`).then(r => r.data)

export default exportedApi
