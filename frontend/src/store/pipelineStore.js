import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import api from '../services/api'
import {
  buildScenePacingContext,
  planSceneSegments,
  getClipOptions,
  unitKey,
  MIN_SEGMENT_SECONDS,
} from '../lib/segmentation'
import { deriveBaseTimeline, applyDirectorPlan, buildNarrationSfxItems, newItemId, normalizeTimeline, trackOf } from '../lib/timeline'
import { transitionDefinition } from '../lib/transitionLibrary'
import {
  buildContinuityContext,
  derivePreviousEndingState,
  preserveProtectedMotionPrompt,
  splitNarrationAcrossSegments,
} from '../lib/motionPrompts'
import { projectHydrationDecision } from '../lib/projectIsolation'
import {
  missingAuthoredPromptUnits,
  missingSelectedImageUnits,
  videoPromptFailureMessage,
} from '../lib/videoPromptBatches'
import { replanPendingImageVariations } from '../lib/imageVariationQueue'
import {
  enrichedVideoPromptTiming,
  selectedVideoTargetDuration,
  videoRequestTimingFields,
} from '../lib/videoEditorialTiming'
import {
  MAX_CONCURRENT_VIDEO_REQUESTS,
  activeVideoRequestCount,
  takeVideoSubmissionSlots,
} from '../lib/videoConcurrency'
import {
  PROMPT_AUTHOR_BATCH_SIZE,
  PROMPT_AUTHOR_CONCURRENCY,
  PROMPT_AUTHOR_MODEL,
  PROMPT_AUTHOR_PROVIDER,
  runPromptBatchWorkers,
} from '../lib/promptBatchWorkers'
import {
  DEFAULT_FILM_TREATMENT,
  clampFilmAmount,
  effectiveFilmTreatment,
} from '../lib/filmTreatment'
import { buildBulkImageSelection } from '../lib/imageSelection'
import {
  compactPipelineState,
  createQuotaResilientStorage,
} from '../lib/projectPersistence'
import {
  WINDOWS_VIDEO_MODEL,
  WINDOWS_VIDEO_PROVIDER,
  isPromptCompatibleWithVideoSettings,
  isWindowsVideoActive,
  mergeWindowsTasksIntoJobs,
  normalizeWindowsVideoStatus,
  usesWindowsVideoBackend,
} from '../lib/windowsVideoWorker'
import { reconcileTimelineVideoSelections } from '../lib/videoSelectionTimeline'
import { runSceneSheetMutationWithTokenRecovery } from '../lib/sceneSheetSession'
import { hydrateSceneSheetReferences } from '../lib/sceneSheets'

const emptyWindowsVideoStatus = () => ({
  paused: false,
  brokerAvailable: false,
  workerConnected: false,
  workerName: null,
  occupiedSlots: 0,
  maxSlots: 0,
  tasks: [],
  updatedAt: null,
  error: null,
})

// One session ID per browser tab — survives refresh but not tab close.
// Format: session_YYYY-MM-DD_<random> so output folders are human-readable.
const generateSessionId = () => {
  const date = new Date().toISOString().slice(0, 10)
  const rand = Math.random().toString(36).slice(2, 8)
  return `session_${date}_${rand}`
}
const getSessionId = () => {
  let id = sessionStorage.getItem('pipeline_session_id')
  if (!id) {
    id = generateSessionId()
    sessionStorage.setItem('pipeline_session_id', id)
  }
  return id
}

const captureProjectScope = (get) => ({
  sessionId: getSessionId(),
  epoch: get().projectEpoch,
})

const isProjectScopeCurrent = (get, scope) => (
  getSessionId() === scope.sessionId
  && get().activeSessionId === scope.sessionId
  && get().projectEpoch === scope.epoch
)

// Auto-saves are ordered per project. Each invocation captures its own state
// snapshot, then waits for the prior save and injects the newest server-issued
// revision token immediately before sending. This prevents an older request
// from finishing after a newer one and rolling the project backwards.
const sessionSaveSchedulers = new Map()
const sessionWriteTokens = new Map()
const abandonedSessionIds = new Set()
const withoutRecordKeys = (record = {}, keys = []) => {
  if (!keys?.length) return record
  const next = { ...record }
  keys.forEach(key => delete next[key])
  return next
}
// Three bounded Opus authoring attempts plus proof/final Remotion renders.
// The backend emits live authoring/render progress throughout this window.
// Three ten-minute executor ceilings plus optional ideation/review/rendering.
// Normal runs are far shorter; this guard only catches a truly abandoned job.
const MAP_JOB_TIMEOUT_MS = 40 * 60_000
const MAP_POLL_MAX_CONSECUTIVE_ERRORS = 5

const mergeMapOptions = (existing = [], incoming = []) => {
  const byId = new Map()
  for (const option of [...existing, ...incoming]) {
    if (option?.id && option?.url) byId.set(option.id, option)
  }
  return [...byId.values()]
}

const rememberSessionWriteToken = (sessionId, token) => {
  if (sessionId && token) sessionWriteTokens.set(sessionId, token)
}

const executeSceneSheetMutation = async ({ sessionId, get, set, operation }) => {
  // Finish any settings/project autosave that was already queued. It may
  // rotate the optimistic token, and the mutation must use the resulting one.
  await get().autoSaveSession()
  return runSceneSheetMutationWithTokenRecovery({
    getToken: () => get().sessionWriteToken,
    operation,
    refresh: async () => {
      const refreshed = await api.getSceneSheets(sessionId)
      if (getSessionId() !== sessionId) return refreshed
      if (refreshed?.writeToken) rememberSessionWriteToken(sessionId, refreshed.writeToken)
      set({
        sceneSheetWorkflow: refreshed?.workflow || refreshed?.scene_sheet_workflow || null,
        ...(refreshed?.writeToken ? { sessionWriteToken: refreshed.writeToken } : {}),
      })
      return refreshed
    },
  })
}

const drainSessionSaves = async (sessionId, scheduler) => {
  if (scheduler.running) return
  scheduler.running = true
  try {
    while (scheduler.pending) {
      const pending = scheduler.pending
      scheduler.pending = null
      if (abandonedSessionIds.has(sessionId)) {
        const error = new Error('Project was deleted')
        pending.waiters.forEach(({ reject }) => reject(error))
        continue
      }
      try {
        const latestToken = sessionWriteTokens.get(sessionId)
        const payload = {
          ...pending.snapshot,
          session_write_token: latestToken || pending.snapshot.session_write_token || undefined,
        }
        const result = await api.saveSession(sessionId, payload)
        if (result?.writeToken) sessionWriteTokens.set(sessionId, result.writeToken)
        pending.waiters.forEach(({ resolve }) => resolve(result))
      } catch (error) {
        pending.waiters.forEach(({ reject }) => reject(error))
      }
    }
  } finally {
    scheduler.running = false
    if (!scheduler.pending && sessionSaveSchedulers.get(sessionId) === scheduler) {
      sessionSaveSchedulers.delete(sessionId)
    } else if (scheduler.pending) {
      void drainSessionSaves(sessionId, scheduler)
    }
  }
}

const enqueueSessionSave = (sessionId, snapshot, initialToken) => {
  if (abandonedSessionIds.has(sessionId)) {
    return Promise.reject(new Error('Project was deleted'))
  }
  if (!sessionWriteTokens.has(sessionId) && initialToken) {
    sessionWriteTokens.set(sessionId, initialToken)
  }
  let scheduler = sessionSaveSchedulers.get(sessionId)
  if (!scheduler) {
    scheduler = { running: false, pending: null }
    sessionSaveSchedulers.set(sessionId, scheduler)
  }
  return new Promise((resolve, reject) => {
    if (scheduler.pending) {
      // A save is already in flight or queued. Keep every caller attached to
      // the result, but only write the newest pending snapshot.
      scheduler.pending.snapshot = snapshot
      scheduler.pending.waiters.push({ resolve, reject })
    } else {
      scheduler.pending = { snapshot, waiters: [{ resolve, reject }] }
    }
    void drainSessionSaves(sessionId, scheduler)
  })
}

const abandonSessionSaves = (sessionId) => {
  if (!sessionId) return
  abandonedSessionIds.add(sessionId)
  sessionWriteTokens.delete(sessionId)
  const scheduler = sessionSaveSchedulers.get(sessionId)
  if (scheduler?.pending) {
    const error = new Error('Project was deleted')
    scheduler.pending.waiters.forEach(({ reject }) => reject(error))
    scheduler.pending = null
  }
  sessionSaveSchedulers.delete(sessionId)
}

// Convert any image URL to a base64 data URI so it survives in the saved JSON
// even after CDN URLs (fal.ai, Replicate) expire. Gemini already returns base64.
const toBase64DataUri = async (url) => {
  if (!url || url.startsWith('data:')) return url  // already base64
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result)
      reader.onerror = reject
      reader.readAsDataURL(blob)
    })
  } catch {
    return url  // fall back to URL if fetch fails
  }
}

// One-time carry-over of user settings from the pre-segment store (v5).
// The persist key changed (v5 → v6) because the data shapes are incompatible,
// but settings (providers, models, keysConfigured, custom prompts) are safe
// to keep — without this, provider selections silently reset to defaults.
const migrateLegacySettings = () => {
  try {
    // Runs as long as the old v5 key exists — it's removed right after the
    // carry-over is applied, so this is effectively once
    const raw = localStorage.getItem('content-pipeline-state-v5')
    if (!raw) return null
    const legacy = JSON.parse(raw)?.state
    if (!legacy?.settings) return null
    return {
      settings: legacy.settings,
      customPrompts: legacy.customPrompts,
      topic: legacy.topic,
      maxMinutes: legacy.maxMinutes,
    }
  } catch {
    return null
  }
}
const legacyCarryOver = migrateLegacySettings()

const narrationTextForScene = (ttsScript, planScene, audio) => {
  const breakdown = ttsScript?.scene_breakdown?.find(scene => scene.scene_id === planScene?.scene_id)
  if (breakdown) {
    return (breakdown.lines || []).filter(line => !line.startsWith('[')).join(' ').replace(/\s+/g, ' ').trim()
  }
  const audioParts = audio?.sceneAudio?.[planScene?.scene_id]?.parts || []
  return audioParts
    .filter(part => part?.type === 'audio' && part.text)
    .map(part => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const characterReferencesForScene = (state, sceneNumber) => {
  const linkedIds = state.characterSceneLinks?.[String(sceneNumber)]?.character_ids || []
  const linked = linkedIds
    .map(id => state.characters?.find(character => character.id === id))
    .filter(character => character?.approved && character?.image)
  if (linked.length > 0) {
    return {
      images: linked.map(character => character.image),
      description: linked.map(character => `${character.name}: ${character.description}`).join('; ').slice(0, 200),
    }
  }
  return {
    images: Object.values(state.characterImages || {}).filter(Boolean),
    description: state.characterDescription || '',
  }
}

// Migrate a project saved before segment support: keys were scene-scoped
// ("12" for selections/jobs, "12_3" for image variations). Convert everything
// to unit keys ("12_0", "12_0_3") so old sessions load cleanly.
const migrateProjectToSegments = (project) => {
  const scenes = project.scenes || []
  const isLegacy = scenes.length > 0
    ? scenes.some(s => s.segment_index === undefined || s.segment_index === null)
    : Object.keys(project.images || {}).some(k => String(k).split('_').length === 2)

  if (!isLegacy) return project

  const remapImageKey = (k) => {
    const parts = String(k).split('_')
    return parts.length === 2 ? `${parts[0]}_0_${parts[1]}` : k
  }
  const remapUnitKey = (k) => {
    const parts = String(k).split('_')
    return parts.length === 1 ? `${parts[0]}_0` : k
  }
  const remapObj = (obj, remap) => Object.fromEntries(
    Object.entries(obj || {}).map(([k, v]) => [remap(k), v])
  )

  return {
    ...project,
    scenes: scenes.map(s => ({
      ...s,
      segment_index: s.segment_index ?? 0,
      segment_count: s.segment_count ?? 1,
    })),
    images: remapObj(project.images, remapImageKey),
    image_history: remapObj(project.image_history, remapImageKey),
    selected_images: remapObj(project.selected_images, remapUnitKey),
    video_jobs: remapObj(project.video_jobs, remapUnitKey),
    video_history: remapObj(project.video_history, remapUnitKey),
    selected_videos: remapObj(project.selected_videos, remapUnitKey),
    video_prompts: (project.video_prompts || []).map(vp => ({
      ...vp,
      segment_index: vp.segment_index ?? 0,
      segment_count: vp.segment_count ?? 1,
    })),
    // Progress keys are stale under the new scheme — reset (loadProject
    // clears live progress anyway)
    image_progress: { total: 0, completed: [], pending: [] },
  }
}

export const usePipelineStore = create(
  persist(
    (set, get) => ({
      settings: {
        imageProvider: 'fal',
        imageModel: 'fal-ai/flux-pro',
        claudeProvider: 'fal',
        claudeModel: 'claude-3-5-sonnet',
        videoProvider: WINDOWS_VIDEO_PROVIDER,
        videoModel: WINDOWS_VIDEO_MODEL,
        videoGenerationBackend: 'windows-worker',
        videoResolution: '1080p',
        aspectRatio: '16:9',
        audioMode: 'manual',
        // ── Segmentation knobs ──
        // Max clip length to request from the video model (null = model default/max)
        videoClipDuration: 8,
        // Minimum playback rate when stretching a clip over longer audio
        // (0.8 = clip may be slowed to 80% speed; 1 = never slow down)
        videoSpeedFactor: 0.8,
        // Image variations generated per segment (1-4)
        imageVariations: 4,
        // Number of distinct Extra High alternatives requested for each
        // Windows image task. The v1 desktop worker supports exactly 1-3.
        windowsImageOutputs: 3,
        // Experimental continuity-first image workflow: compatible shots are
        // authored as manually generated scene sheets, then expanded here.
        sceneSheetEnabled: false,
        // Full-script copy format on the audio step: 'plain' | 'expressive'
        audioScriptFormat: 'plain',
        // ── Cinema / Director ──
        // Structure the film into chapters with portrait stingers
        chaptersEnabled: false,
        // Movie-trailer cold open built from peak shots
        trailerIntroEnabled: false,
        // Map/overlay style variant: 'chronicle' | 'heritage' | 'nocturne'
        cinemaStyle: 'chronicle',
        // Master multiplier for Director SFX. 1 = the authored narration-safe level.
        soundEffectsVolume: 1,
        // Director-library typography defaults. These remain in persisted
        // settings across projects and can be promoted from any Inspector.
        lowerThirdScale: 1.18,
        dateChipScale: 1.22,
        // Continuous Director underscore. Volume is a master multiplier over
        // each track's loudness-normalized authored level.
        backgroundMusicEnabled: true,
        backgroundMusicVolume: 1,
        // ── Project-level final-film finish ──
        ...DEFAULT_FILM_TREATMENT,
        keysConfigured: { fal: false, replicate: false, gemini: false, elevenlabs: false, geminigen: false, vertex: false, claudeCli: false, whisper: false }
      },

      generationState: 'idle',   // idle | running | paused | stopped
      generationPhase: null,     // null | 'scenePlan' | 'images' | 'videoPrompts' | 'videos'

      imageProgress: { total: 0, completed: [], pending: [] },
      videoProgress: { total: 0, completed: [], pending: [] },

      topic: '',
      maxMinutes: null,
      storyInputMode: 'discover',
      storyTitle: '',
      storyContext: '',
      suppliedVoiceover: '',
      stories: [],
      selectedStory: null,
      storiesLoading: false,
      storiesError: null,

      scenePlan: null,
      scenePlanLoading: false,
      scenePlanError: null,

      // scenes: one entry PER SEGMENT — { scene_number, segment_index,
      // segment_count, target_duration, clip_duration, playback_rate,
      // scene_title, scene_description, prompts: [...], continuity_checklist }
      scenes: [],
      // sceneSegments: { [sceneNumber]: [{ segmentIndex, targetDuration,
      //   clipDuration, playbackRate }] } — computed from audio durations
      sceneSegments: {},
      images: {},        // keyed `${scene}_${segment}_${promptIndex}`
      selectedImages: {},  // keyed `${scene}_${segment}`
      imagesLoading: {},
      imagesError: null,
      imageBatches: [],        // [{ batchIndex, sceneNumbers, status: 'pending'|'running'|'done'|'failed', error }]
      // imageHistory: keyed same as images ("sceneNum_promptIndex"), each value is
      // an array of { url, prompt } entries oldest-first. The current images[key]
      // is always the latest; history lets the user browse and re-select prior versions.
      imageHistory: {},
      sceneSheetWorkflow: null,
      downstreamResetRevision: null,

      // videoPrompts: one entry per segment — includes scene_number + segment_index
      videoPrompts: [],
      videoPromptsLoading: false,
      videoPromptsError: null,
      videoBatches: [],        // [{ batchIndex, sceneNumbers, status: 'pending'|'running'|'done'|'failed', error }]
      videoJobs: {},           // keyed `${scene}_${segment}`
      selectedVideos: {},      // keyed `${scene}_${segment}`
      // videoHistory: keyed `${scene}_${segment}`, array of { url, prompt } oldest-first
      videoHistory: {},
      windowsVideoStatus: emptyWindowsVideoStatus(),
      ttsScript: null,
      ttsLoading: false,
      ttsError: null,
      // Expressive narration script (ElevenLabs v3 audio-tag format) — optional
      // extra Claude pass over the plain script
      expressiveScript: null,
      expressiveLoading: false,
      expressiveError: null,
      // Whisper full-audio split state: null | 'uploading' | 'transcribing' | 'done' | 'error'
      whisperStatus: null,
      whisperError: null,

      youtubeMetadata: null,
      selectedTitle: null,
      thumbnailPrompts: [],
      thumbnails: {},
      selectedThumbnail: null,
      metadataLoading: false,
      metadataError: null,
      thumbnailLoading: false,
      // thumbnailHistory: keyed by thumbnail index, each value is array of { url, prompt } oldest-first
      thumbnailHistory: {},

      // sceneAudio/sfxAudio hold base64 blobs — too heavy for localStorage, so
      // they are NOT persisted there. They live in the backend session
      // auto-save and are restored on refresh via restoreSessionAssets().
      // fullAudio: the complete uploaded narration { dataUri, name, durationSeconds }
      audio: { sceneAudio: {}, sfxAudio: {}, fullAudio: null },

      // True once the mount-time restore from the backend session has run.
      // autoSaveSession() is a no-op before then — otherwise a fresh reload
      // (which starts with empty audio/images) would overwrite the good save.
      sessionRestoreDone: false,

      // Project-scoped local state is valid only for this session. Persisting
      // this identity prevents one tab's global Zustand snapshot from being
      // reused after the tab switches to a different/new project.
      activeSessionId: getSessionId(),
      projectEpoch: 0,

      // Stable server-issued token prevents an old browser tab from
      // overwriting a project that has since been repaired or reopened.
      sessionWriteToken: null,

      // User-given project name for the current session (null = unnamed;
      // UI falls back to the story title / session id). Persisted, and
      // mirrored to the backend session via PATCH /api/session/:id/name.
      projectName: null,

      // Live activity feed — real-time per-item generation events shown in the
      // ActivityFeed panel. Not persisted; resets on reload.
      activityLog: [],

      includeThumbnail: true,
      includeMetadata: true,

      // Custom system prompt overrides — empty string = use backend default
      customPrompts: {
        story: '',
        scenePlanning: '',
        imagePrompts: '',
        videoPrompts: '',
        ttsScript: '',
        metadata: '',
        thumbnailPrompts: '',
      },

      // Base character reference images (base64 data URIs) for consistent character generation
      // Users can optionally upload a male and/or female reference figure.
      // These are sent as image_input to the model so it can apply scene-appropriate
      // clothing, accessories, and styling while preserving the character likeness.
      characterImages: {
        male: null,   // base64 data URI or null
        female: null, // base64 data URI or null
      },

      // Optional free-text description of the character style (e.g. "porcelain mannequin",
      // "realistic human", "anime character"). Sent alongside character images so the model
      // knows how to interpret and replicate the reference.
      characterDescription: '',

      // Story-specific cast pipeline: Sonnet extracts and links, the configured
      // image model creates references, and generation waits for human approval.
      characters: [],
      characterSceneLinks: {},
      characterAudit: null,
      characterStatus: 'idle', // idle | extracting | generating | review | linking | ready | error
      characterError: null,

      // ─── Studio timeline (Editor step) ────────────────────────────────────
      // items: TimelineItem[] (see lib/timeline.js) — the editable film plan.
      // sceneWindows: { [sceneNumber]: { start, end } } — scene spans (seconds).
      // directorPlan/chapters: last Director output (chapters carry portraits).
      timeline: { items: [], sceneWindows: {}, directorPlan: null, chapters: null, built: false },
      // src → local proxy URL for editor playback (derived, rebuilt on mount;
      // never persisted — final renders always use the original payload.src).
      previewProxies: {},
      // True once the user hand-edited the timeline (guards destructive rebuilds)
      timelineDirty: false,
      // Undo/redo stacks of { items, dirty } snapshots for editor edits.
      // Cleared whenever the timeline is wholesale-replaced (build, director,
      // project load) so undo never crosses into another timeline's state.
      timelineHistory: { past: [], future: [] },
      directorRunning: false,
      directorStage: null,
      mapQueueRunning: false,
      mapQueueProgress: null,
      // Final-film render job: { jobId, status, progress, stage, log, output, error }
      renderJob: null,
      renderHistory: [],

      // ─── Settings ─────────────────────────────────────────────────────────
      setTopic: (topic) => set({ topic }),
      setMaxMinutes: (maxMinutes) => set({ maxMinutes }),
      setStoryInputMode: (storyInputMode) => set({
        storyInputMode,
        // Intake modes are mutually exclusive. Never leave another mode's
        // candidates visible while the new request is being prepared.
        stories: [],
        storiesError: null,
      }),
      setStoryTitle: (storyTitle) => set({ storyTitle }),
      setStoryContext: (storyContext) => set({ storyContext }),
      setSuppliedVoiceover: (suppliedVoiceover) => set({ suppliedVoiceover }),

      setProvider: (provider) => {
        const defaultModels = {
          fal: 'fal-ai/flux-pro',
          replicate: 'black-forest-labs/flux-1.1-pro',
          gemini: 'gemini-3-pro-image-preview',
          vertex: 'gemini-2.5-flash-image',
          'windows-image': 'extra-high',
        }
        set((state) => ({
          settings: {
            ...state.settings,
            imageProvider: provider,
            imageModel: defaultModels[provider] || state.settings.imageModel
          }
        }))
      },

      setModel: (model) => set((state) => ({
        settings: { ...state.settings, imageModel: model }
      })),

      setClaudeProvider: (provider) => {
        const defaultModels = {
          fal: 'claude-3-5-sonnet',
          replicate: 'google/gemini-2.5-flash',
          gemini: 'gemini-3-flash',
          'claude-cli': 'sonnet'
        }
        set((state) => ({
          settings: {
            ...state.settings,
            claudeProvider: provider,
            claudeModel: defaultModels[provider] || state.settings.claudeModel
          }
        }))
      },

      setClaudeModel: (model) => set((state) => ({
        settings: { ...state.settings, claudeModel: model }
      })),

      setVideoProvider: (provider) => set((state) => ({
        settings: {
          ...state.settings,
          videoProvider: provider,
          videoGenerationBackend: provider === WINDOWS_VIDEO_PROVIDER
            ? 'windows-worker'
            : 'hosted-provider',
          // Reset model to default for the chosen provider
          videoModel: provider === 'replicate' ? 'lightricks/ltx-2-pro'
            : provider === 'geminigen' ? 'veo-3.1-fast'
            : provider === WINDOWS_VIDEO_PROVIDER ? WINDOWS_VIDEO_MODEL
            : 'lightricks/ltx-2-pro',
          videoClipDuration: provider === WINDOWS_VIDEO_PROVIDER ? 8 : null,
          aspectRatio: provider === WINDOWS_VIDEO_PROVIDER ? '16:9' : state.settings.aspectRatio,
        }
      })),

      setVideoModel: (model) => set((state) => ({
        settings: { ...state.settings, videoModel: model }
      })),

      setVideoResolution: (resolution) => set((state) => ({
        settings: { ...state.settings, videoResolution: resolution }
      })),

      setAspectRatio: (ratio) => set((state) => ({
        settings: {
          ...state.settings,
          aspectRatio: usesWindowsVideoBackend(state.settings) ? '16:9' : ratio,
        }
      })),

      setAudioMode: (mode) => set((state) => ({
        settings: { ...state.settings, audioMode: mode }
      })),

      setVideoClipDuration: (seconds) => set((state) => ({
        settings: { ...state.settings, videoClipDuration: seconds }
      })),

      setVideoSpeedFactor: (factor) => set((state) => ({
        settings: { ...state.settings, videoSpeedFactor: factor }
      })),

      setImageVariations: (count) => {
        const target = Math.min(4, Math.max(1, Number(count) || 1))
        let replanResult = null
        set((state) => {
          const hasActiveImageQueue =
            state.imageProgress.pending.length > 0
            && state.scenes.length > 0

          if (hasActiveImageQueue) {
            replanResult = replanPendingImageVariations({
              scenes: state.scenes,
              images: state.images,
              imagesLoading: state.imagesLoading,
              imageProgress: state.imageProgress,
              requestedCount: target,
            })
          }

          return {
            settings: { ...state.settings, imageVariations: target },
            ...(replanResult ? {
              scenes: replanResult.scenes,
              imageProgress: replanResult.imageProgress,
            } : {}),
          }
        })

        if (replanResult?.replannedShots > 0) {
          get().logActivity(
            `Pending image plan updated — ${replanResult.replannedShots} untouched shot${replanResult.replannedShots === 1 ? '' : 's'} now use ${target} variation${target === 1 ? '' : 's'}`,
            'success'
          )
          if (replanResult.limitedShots > 0) {
            get().logActivity(
              `${replanResult.limitedShots} pending shot${replanResult.limitedShots === 1 ? '' : 's'} only had ${replanResult.scenes.find(scene => scene.prompt_pool?.length < target)?.prompt_pool?.length || 1} authored variation(s); higher counts apply fully to new projects`,
              'info'
            )
          }
          void get().autoSaveSession()
        }
      },

      setSceneSheetEnabled: (value) => {
        set((state) => ({
          settings: { ...state.settings, sceneSheetEnabled: !!value },
        }))
        void get().autoSaveSession()
      },

      setWindowsImageOutputs: (count) => {
        const value = Math.max(1, Math.min(3, Number(count) || 1))
        set((state) => ({
          settings: { ...state.settings, windowsImageOutputs: value },
        }))
        void get().autoSaveSession()
      },

      prepareSceneSheets: async () => {
        const sessionId = getSessionId()
        const result = await executeSceneSheetMutation({
          sessionId,
          get,
          set,
          operation: writeToken => api.planSceneSheets(sessionId, writeToken),
        })
        if (getSessionId() !== sessionId) return null
        const workflow = result?.workflow || result?.scene_sheet_workflow || result
        if (result?.writeToken) rememberSessionWriteToken(sessionId, result.writeToken)
        set(state => ({
          sceneSheetWorkflow: workflow,
          selectedImages: withoutRecordKeys(state.selectedImages, result?.invalidatedUnitIds),
          ...(result?.writeToken ? { sessionWriteToken: result.writeToken } : {}),
        }))
        return workflow
      },

      refreshSceneSheets: async () => {
        const sessionId = getSessionId()
        const result = await api.getSceneSheets(sessionId)
        if (getSessionId() !== sessionId) return null
        const workflow = result?.workflow || result?.scene_sheet_workflow || result
        if (result?.writeToken) rememberSessionWriteToken(sessionId, result.writeToken)
        set(state => ({
          sceneSheetWorkflow: workflow,
          selectedImages: withoutRecordKeys(state.selectedImages, result?.invalidatedUnitIds),
          ...(result?.writeToken ? { sessionWriteToken: result.writeToken } : {}),
        }))
        return workflow
      },

      uploadSceneSheet: async (groupId, file) => {
        const sessionId = getSessionId()
        const result = await executeSceneSheetMutation({
          sessionId,
          get,
          set,
          operation: writeToken => api.uploadSceneSheet(sessionId, groupId, file, writeToken),
        })
        if (getSessionId() !== sessionId) return null
        const workflow = result?.workflow || result?.scene_sheet_workflow || result
        if (result?.writeToken) rememberSessionWriteToken(sessionId, result.writeToken)
        set(state => ({
          sceneSheetWorkflow: workflow,
          selectedImages: withoutRecordKeys(state.selectedImages, result?.invalidatedUnitIds),
          ...(result?.writeToken ? { sessionWriteToken: result.writeToken } : {}),
        }))
        return workflow
      },

      beginWindowsImageGeneration: async () => {
        const sessionId = getSessionId()
        const result = await api.beginWindowsImageGeneration(sessionId)
        if (getSessionId() !== sessionId) return null
        return result.runId
      },

      cancelWindowsImageGeneration: async () => {
        const sessionId = getSessionId()
        const result = await api.cancelWindowsImageGeneration(
          sessionId,
          'Canceled by user from Content Machine',
        )
        if (getSessionId() !== sessionId) return null
        set(state => ({
          generationState: state.settings.imageProvider === 'windows-image'
            ? 'stopped'
            : state.generationState,
          sceneSheetWorkflow: state.sceneSheetWorkflow
            ? {
                ...state.sceneSheetWorkflow,
                groups: (state.sceneSheetWorkflow.groups || []).map(group => {
                  const job = result.jobs?.[`scene-sheet-${group.id}`]
                  return job
                    ? { ...group, windowsGeneration: job }
                    : group
                }),
              }
            : state.sceneSheetWorkflow,
        }))
        get().logActivity(
          `Canceled ${result.broker?.canceled || 0} Windows image task${result.broker?.canceled === 1 ? '' : 's'}`,
          'info',
        )
        return result
      },

      generateWindowsSceneSheet: async (groupId, outputCount = null, retry = false, runId = null) => {
        const sessionId = getSessionId()
        const effectiveOutputCount = Math.max(
          1,
          Math.min(3, Number(outputCount ?? get().settings.windowsImageOutputs) || 1),
        )
        const result = await executeSceneSheetMutation({
          sessionId,
          get,
          set,
          operation: writeToken => api.generateWindowsSceneSheet(
            sessionId,
            groupId,
            effectiveOutputCount,
            writeToken,
            retry,
            runId,
          ),
        })
        if (getSessionId() !== sessionId) return null
        set(state => ({
          sceneSheetWorkflow: {
            ...state.sceneSheetWorkflow,
            groups: (state.sceneSheetWorkflow?.groups || []).map(group =>
              group.id === groupId
                ? { ...group, windowsGeneration: result.job }
                : group
            ),
          },
        }))
        return result.job
      },

      refreshWindowsSceneSheet: async (groupId) => {
        const sessionId = getSessionId()
        const result = await api.getWindowsSceneSheetStatus(sessionId, groupId)
        if (getSessionId() !== sessionId) return null
        set(state => ({
          sceneSheetWorkflow: {
            ...state.sceneSheetWorkflow,
            groups: (state.sceneSheetWorkflow?.groups || []).map(group =>
              group.id === groupId
                ? { ...group, windowsGeneration: result.job }
                : group
            ),
          },
        }))
        return result.job
      },

      selectWindowsSceneSheetOption: async (groupId, ordinal) => {
        const sessionId = getSessionId()
        const result = await executeSceneSheetMutation({
          sessionId,
          get,
          set,
          operation: writeToken => api.selectWindowsSceneSheetOption(
            sessionId,
            groupId,
            ordinal,
            writeToken,
          ),
        })
        if (getSessionId() !== sessionId) return null
        const workflow = result?.workflow || result?.scene_sheet_workflow || result
        if (result?.writeToken) rememberSessionWriteToken(sessionId, result.writeToken)
        set(state => ({
          sceneSheetWorkflow: workflow,
          selectedImages: withoutRecordKeys(state.selectedImages, result?.invalidatedUnitIds),
          ...(result?.writeToken ? { sessionWriteToken: result.writeToken } : {}),
        }))
        return workflow
      },

      expandSceneSheet: async (groupId, panelOrdinals) => {
        const sessionId = getSessionId()
        const result = await executeSceneSheetMutation({
          sessionId,
          get,
          set,
          operation: writeToken => api.expandSceneSheet(
            sessionId,
            groupId,
            panelOrdinals,
            writeToken,
          ),
        })
        if (getSessionId() !== sessionId) return null
        const workflow = result?.workflow || result?.scene_sheet_workflow || result
        if (result?.writeToken) rememberSessionWriteToken(sessionId, result.writeToken)
        set(state => ({
          sceneSheetWorkflow: workflow,
          selectedImages: {
            ...withoutRecordKeys(state.selectedImages, result?.invalidatedUnitIds),
            ...(result?.selectedImages || result?.selected_images || {}),
          },
          ...(result?.writeToken ? { sessionWriteToken: result.writeToken } : {}),
        }))
        return workflow
      },

      selectSceneSheetPanel: (groupId, unitId) => {
        const group = get().sceneSheetWorkflow?.groups?.find(item => item.id === groupId)
        const panel = group?.panels?.find(item => item.unitId === unitId)
        const url = panel?.expandedUrl || panel?.expanded_url || panel?.cropUrl || panel?.crop_url
        if (!url) throw new Error('Expand this panel before selecting it')
        set((state) => ({
          selectedImages: {
            ...state.selectedImages,
            [unitId]: {
              url,
              prompt: panel.prompt,
              promptIndex: 'scene-sheet',
              source: 'scene-sheet',
              sceneSheetGroupId: groupId,
              panelOrdinal: panel.ordinal,
            },
          },
        }))
        void get().autoSaveSession()
      },

      selectAllExpandedSceneSheetPanels: () => {
        const workflow = get().sceneSheetWorkflow
        const expandedSelections = {}
        for (const group of workflow?.groups || []) {
          for (const panel of group.panels || []) {
            const url = panel.expandedUrl || panel.expanded_url
            if (!url) continue
            expandedSelections[panel.unitId] = {
              url,
              prompt: panel.prompt,
              promptIndex: 'scene-sheet',
              source: 'scene-sheet',
              sceneSheetGroupId: group.id,
              panelOrdinal: panel.ordinal,
            }
          }
        }
        if (!Object.keys(expandedSelections).length) {
          throw new Error('No expanded scene-sheet frames are available')
        }
        set((state) => ({
          selectedImages: {
            ...state.selectedImages,
            ...expandedSelections,
          },
        }))
        void get().autoSaveSession()
        return expandedSelections
      },

      resetToImages: async () => {
        const sessionId = getSessionId()
        // Drain any older queued snapshot before the backend rotates the write
        // token. The backend's reset revision then blocks stale resurrection.
        await get().autoSaveSession()
        let result
        try {
          result = await api.resetSessionToImages(sessionId, get().sessionWriteToken)
        } catch (error) {
          const writeToken = error?.response?.data?.writeToken
          if (writeToken && getSessionId() === sessionId) {
            rememberSessionWriteToken(sessionId, writeToken)
            set({ sessionWriteToken: writeToken })
          }
          throw error
        }
        if (getSessionId() !== sessionId) return null
        const project = result?.project || result?.session || result
        get().loadProject(project)
        return result
      },

      setAudioScriptFormat: (format) => set((state) => ({
        settings: { ...state.settings, audioScriptFormat: format }
      })),

      setChaptersEnabled: (value) => set((state) => ({
        settings: { ...state.settings, chaptersEnabled: !!value }
      })),

      setTrailerIntroEnabled: (value) => set((state) => ({
        settings: { ...state.settings, trailerIntroEnabled: !!value }
      })),

      setCinemaStyle: (style) => set((state) => ({
        settings: { ...state.settings, cinemaStyle: style }
      })),

      setSoundEffectsVolume: (value) => {
        const parsed = Number(value)
        const soundEffectsVolume = Number.isFinite(parsed)
          ? Math.min(1.5, Math.max(0, parsed))
          : 1
        set((state) => ({
          settings: { ...state.settings, soundEffectsVolume }
        }))
        get().autoSaveSession()
      },

      setBackgroundMusicEnabled: (value) => {
        set((state) => ({
          settings: { ...state.settings, backgroundMusicEnabled: !!value }
        }))
        get().autoSaveSession()
      },

      setBackgroundMusicVolume: (value) => {
        const parsed = Number(value)
        const backgroundMusicVolume = Number.isFinite(parsed)
          ? Math.min(1.5, Math.max(0, parsed))
          : 1
        set((state) => ({
          settings: { ...state.settings, backgroundMusicVolume }
        }))
        get().autoSaveSession()
      },

      setFilmGrainEnabled: (value) => {
        set((state) => ({
          settings: { ...state.settings, filmGrainEnabled: !!value }
        }))
        get().autoSaveSession()
      },

      setFilmGrainAmount: (value) => {
        set((state) => ({
          settings: {
            ...state.settings,
            filmGrainAmount: clampFilmAmount(
              value,
              DEFAULT_FILM_TREATMENT.filmGrainAmount
            ),
          }
        }))
        get().autoSaveSession()
      },

      setAtmosphericGradeEnabled: (value) => {
        set((state) => ({
          settings: { ...state.settings, atmosphericGradeEnabled: !!value }
        }))
        get().autoSaveSession()
      },

      setAtmosphericGradeAmount: (value) => {
        set((state) => ({
          settings: {
            ...state.settings,
            atmosphericGradeAmount: clampFilmAmount(
              value,
              DEFAULT_FILM_TREATMENT.atmosphericGradeAmount
            ),
          }
        }))
        get().autoSaveSession()
      },

      setVignetteEnabled: (value) => {
        set((state) => ({
          settings: { ...state.settings, vignetteEnabled: !!value }
        }))
        get().autoSaveSession()
      },

      setVignetteAmount: (value) => {
        set((state) => ({
          settings: {
            ...state.settings,
            vignetteAmount: clampFilmAmount(
              value,
              DEFAULT_FILM_TREATMENT.vignetteAmount
            ),
          }
        }))
        get().autoSaveSession()
      },

      // ─── Segmentation ─────────────────────────────────────────────────────
      // Compute per-scene video segments from measured audio durations.
      // Falls back to the scene plan's duration when a scene has no audio yet.
      computeSceneSegments: () => {
        const { scenePlan, audio, settings, ttsScript, scenes } = get()
        if (!scenePlan?.scenes) return {}

        const clipOptions = getClipOptions(settings.videoModel, settings.videoClipDuration)
        const speedFactor = settings.videoSpeedFactor || 1
        const narrationUnits = ttsScript?.narration_sequence || ttsScript?.scene_breakdown || []

        const sceneSegments = {}
        for (const planScene of scenePlan.scenes) {
          const sceneAudio = audio.sceneAudio?.[planScene.scene_id]
          const narrationUnit = narrationUnits.find(unit =>
            unit.scene_id === planScene.scene_id
            || unit.scene_number === planScene.scene_number
          )
          const generatedScene = scenes.find(unit =>
            unit.scene_number === planScene.scene_number
          )
          const audioDuration = sceneAudio?.durationSeconds
            || planScene.duration_seconds
            || null
          sceneSegments[planScene.scene_number] = planSceneSegments(
            audioDuration,
            clipOptions,
            speedFactor,
            buildScenePacingContext(planScene, narrationUnit, generatedScene)
          )
        }
        set({ sceneSegments })
        return sceneSegments
      },

      setKeysConfigured: (keys) => set((state) => ({
        settings: { ...state.settings, keysConfigured: { ...state.settings.keysConfigured, ...keys } }
      })),

      setCustomPrompt: (key, value) => set((state) => ({
        customPrompts: { ...state.customPrompts, [key]: value }
      })),

      setCharacterImage: (gender, dataUri) => set((state) => ({
        characterImages: { ...state.characterImages, [gender]: dataUri }
      })),

      clearCharacterImage: (gender) => set((state) => ({
        characterImages: { ...state.characterImages, [gender]: null }
      })),

      setCharacterDescription: (description) => set({ characterDescription: description }),

      // ─── Activity feed ────────────────────────────────────────────────────
      // status: 'info' | 'running' | 'success' | 'error'
      logActivity: (message, status = 'info') => set((state) => {
        const entry = {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          message,
          status,
        }
        // If the previous entry was a 'running' entry for the same message stem,
        // keep the log compact by capping to the last 200 entries.
        return { activityLog: [...state.activityLog.slice(-199), entry] }
      }),

      clearActivityLog: () => set({ activityLog: [] }),

      // ─── Generation control ───────────────────────────────────────────────
      setGenerationState: (generationState) => set({ generationState }),

      pauseGeneration: () => {
        get().logActivity('Generation paused', 'info')
        set({ generationState: 'paused' })
        // Persist the exact completed/pending boundary immediately. Completed
        // image files are already saved after every unit; this saves the queue
        // metadata as well so a refresh always offers an explicit Resume.
        void get().autoSaveSession()
      },

      resumeGeneration: () => set({ generationState: 'running' }),

      stopGeneration: () => set((state) => {
        // Only log when a run was actually interrupted (this is also called
        // internally when all video jobs finish)
        if (state.generationState === 'running') {
          get().logActivity('Generation stopped', 'info')
        }
        return { generationState: 'stopped' }
      }),

      resetGeneration: () => set({
        generationState: 'idle',
        generationPhase: null,
        imageProgress: { total: 0, completed: [], pending: [] },
        videoProgress: { total: 0, completed: [], pending: [] },
        imagesError: null,
        videoPromptsError: null,
        scenePlanError: null,
        ttsError: null,
        imageBatches: [],
        videoBatches: [],
      }),

      checkShouldStop: () => {
        const state = get()
        return state.generationState === 'paused' || state.generationState === 'stopped'
      },

      // ─── Stories ──────────────────────────────────────────────────────────
      fetchStories: async () => {
        const scope = captureProjectScope(get)
        const {
          topic, maxMinutes, settings, storyInputMode, storyTitle, storyContext, suppliedVoiceover,
        } = get()
        set({ storiesLoading: true, storiesError: null })
        try {
          if (storyInputMode === 'script') {
            const title = storyTitle.trim()
            const voiceover = suppliedVoiceover.trim()
            if (!title || !voiceover) throw new Error('Title and main voiceover are required')
            const words = voiceover.split(/\s+/).filter(Boolean).length
            const story = {
              id: `script-${Date.now().toString(36)}`,
              input_mode: 'script',
              title,
              summary: storyContext.trim() || voiceover.slice(0, 420),
              source_context: storyContext.trim(),
              provided_voiceover: voiceover,
              era: 'From supplied script',
              location: 'From supplied script',
              estimated_scenes: Math.max(1, Math.round(words / 24)),
              narrative_beats: ['supplied_voiceover'],
              why_compelling: 'User-authored documentary voiceover',
            }
            if (!isProjectScopeCurrent(get, scope)) return null
            set({ stories: [story], storiesLoading: false })
            return [story]
          }
          const stories = await api.generateStories(
            topic,
            maxMinutes,
            settings.claudeProvider,
            settings.claudeModel,
            get().customPrompts.story,
            storyInputMode === 'guided'
              ? { mode: 'guided', title: storyTitle, context: storyContext }
              : { mode: 'discover' }
          )
          if (!isProjectScopeCurrent(get, scope)) return null
          set({ stories, storiesLoading: false })
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          set({ storiesError: error.message, storiesLoading: false })
          throw error
        }
      },

      selectStory: (story) => {
        set((state) => ({
          selectedStory: story,
          projectEpoch: state.projectEpoch + 1,
          scenePlan: null,
          scenePlanError: null,
          scenes: [],
          sceneSegments: {},
          images: {},
          imageHistory: {},
          selectedImages: {},
          imagesLoading: {},
          imagesError: null,
          imageBatches: [],
          imageProgress: { total: 0, completed: [], pending: [] },
          videoPrompts: [],
          videoBatches: [],
          videoJobs: {},
          videoHistory: {},
          selectedVideos: {},
          windowsVideoStatus: emptyWindowsVideoStatus(),
          videoProgress: { total: 0, completed: [], pending: [] },
          ttsScript: null,
          expressiveScript: null,
          audio: { sceneAudio: {}, sfxAudio: {}, fullAudio: null },
          youtubeMetadata: null,
          selectedTitle: null,
          thumbnailPrompts: [],
          thumbnails: {},
          thumbnailHistory: {},
          selectedThumbnail: null,
          timeline: { items: [], sceneWindows: {}, directorPlan: null, chapters: null, built: false },
          timelineDirty: false,
          timelineHistory: { past: [], future: [] },
          renderJob: null,
          characters: [],
          characterSceneLinks: {},
          characterAudit: null,
          characterStatus: 'idle',
          characterError: null,
        }))
        get().fetchScenePlan(story)
      },

      prepareCharacters: async () => {
        const { selectedStory, scenePlan, settings, ttsScript } = get()
        if (!selectedStory || !scenePlan?.scenes?.length) return []
        if (['extracting', 'generating', 'linking'].includes(get().characterStatus)) return get().characters
        const scope = captureProjectScope(get)
        set({ characterStatus: 'extracting', characterError: null })
        try {
          const extracted = await api.extractCharacters(selectedStory, scenePlan, ttsScript)
          if (!isProjectScopeCurrent(get, scope)) return []
          const characters = extracted.characters || []
          if (characters.length === 0) {
            set({
              characters: [],
              characterSceneLinks: {},
              characterAudit: extracted.audit || null,
              characterStatus: 'ready',
              characterError: null,
            })
            await get().autoSaveSession()
            return []
          }
          set({
            characters,
            characterAudit: extracted.audit || null,
            characterStatus: 'generating',
            characterError: null,
          })
          // Persist extraction before portrait generation. A provider failure
          // must not discard Sonnet's completed cast audit.
          await get().autoSaveSession()
          const generated = []
          for (const character of characters) {
            let generatedCharacter
            try {
              const result = await api.generateImages(
                [character.visual_prompt],
                settings.imageProvider,
                settings.imageModel,
                '9:16',
                [],
                character.description,
                character,
                {
                  sessionId: getSessionId(),
                  itemIds: [`character-${character.id}`],
                  outputCount: settings.windowsImageOutputs || 1,
                },
              )
              if (!isProjectScopeCurrent(get, scope)) return []
              const option = result?.[0]
              const rawOptions = settings.imageProvider === 'windows-image'
                ? (option?.alternatives?.length ? option.alternatives : (option?.url ? [option] : []))
                : (option?.url ? [option] : [])
              const imageOptions = await Promise.all(rawOptions.map(async candidate => ({
                url: await toBase64DataUri(candidate.url),
                prompt: character.visual_prompt,
              })))
              const image = imageOptions[0]?.url || null
              generatedCharacter = {
                ...character,
                image,
                image_options: imageOptions,
                error: option?.error || (!image ? 'No image returned' : null),
              }
            } catch (error) {
              if (!isProjectScopeCurrent(get, scope)) return []
              generatedCharacter = {
                ...character,
                image: null,
                image_options: [],
                error: error.message || 'Character portrait generation failed',
              }
            }
            generated.push(generatedCharacter)
            set({ characters: [...generated, ...characters.slice(generated.length)] })
            await get().autoSaveSession()
          }
          set({ characters: generated, characterStatus: 'review' })
          await get().autoSaveSession()
          return generated
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return []
          set({ characterStatus: 'error', characterError: error.message })
          await get().autoSaveSession()
          throw error
        }
      },

      regenerateCharacter: async (characterId, prompt, optionCount = 1, useCurrentReference = false) => {
        const state = get()
        const character = state.characters.find(item => item.id === characterId)
        if (!character) return []
        const count = Math.max(1, Math.min(2, Number(optionCount) || 1))
        set({ characters: state.characters.map(item => item.id === characterId ? { ...item, generating: true, error: null } : item) })
        try {
          const prompts = Array.from(
            { length: state.settings.imageProvider === 'windows-image' ? 1 : count },
            () => prompt || character.visual_prompt,
          )
          const useVertexEdit = !!(useCurrentReference && character.image && state.settings.keysConfigured?.vertex)
          const editProvider = useVertexEdit ? 'vertex' : state.settings.imageProvider
          const editModel = useVertexEdit && state.settings.imageProvider !== 'vertex'
            ? 'gemini-2.5-flash-image'
            : state.settings.imageModel
          const result = await api.generateImages(
            prompts,
            editProvider,
            editModel,
            '9:16',
            useCurrentReference && character.image ? [character.image] : [],
            character.description,
            character,
            {
              sessionId: getSessionId(),
              itemIds: [`character-${character.id}-regenerate`],
              outputCount: count,
              retry: true,
            },
          )
          const rawOptions = state.settings.imageProvider === 'windows-image'
            ? (result[0]?.alternatives || [])
            : result
          const options = await Promise.all(rawOptions.filter(item => item?.url).map(async item => ({
            url: await toBase64DataUri(item.url),
            prompt: item.prompt || prompts[0],
          })))
          set(current => ({
            characters: current.characters.map(item => item.id === characterId ? {
              ...item,
              generating: false,
              image: options[0]?.url || item.image,
              image_options: (() => {
                const candidates = [
                  ...(item.image ? [{ url: item.image, prompt: item.visual_prompt }] : []),
                  ...(item.image_options || []),
                  ...options,
                ]
                const seen = new Set()
                return candidates.filter(option => {
                  if (!option?.url || seen.has(option.url)) return false
                  seen.add(option.url)
                  return true
                })
              })(),
              approved: false,
              error: options.length ? null : 'No image returned',
            } : item),
          }))
          get().autoSaveSession()
          return options
        } catch (error) {
          set(current => ({
            characters: current.characters.map(item => item.id === characterId ? { ...item, generating: false, error: error.message } : item),
          }))
          throw error
        }
      },

      selectCharacterOption: (characterId, option) => {
        set(state => ({
          characters: state.characters.map(character => character.id === characterId
            ? { ...character, image: option.url, approved: false }
            : character),
        }))
        get().autoSaveSession()
      },

      approveCharacters: async () => {
        const approved = get().characters.map(character => ({ ...character, approved: !!character.image }))
        set({ characters: approved, characterStatus: 'linking', characterError: null })
        try {
          const result = await api.linkCharacters(approved, get().scenePlan, get().ttsScript)
          set({ characterSceneLinks: result.links || {}, characterStatus: 'ready' })
          get().autoSaveSession()
          return result.links || {}
        } catch (error) {
          set({ characterStatus: 'error', characterError: error.message })
          await get().autoSaveSession()
          throw error
        }
      },

      setSceneCharacters: (sceneNumber, characterIds) => {
        set(state => ({
          characterSceneLinks: {
            ...state.characterSceneLinks,
            [String(sceneNumber)]: {
              ...(state.characterSceneLinks[String(sceneNumber)] || {}),
              character_ids: [...new Set(characterIds)],
              manual: true,
            },
          },
        }))
        get().autoSaveSession()
      },

      // ─── Scene Plan ───────────────────────────────────────────────────────
      fetchScenePlan: async (story) => {
        const storyToUse = story || get().selectedStory
        const { maxMinutes, settings } = get()
        if (!storyToUse) return
        const scope = captureProjectScope(get)

        set({
          scenePlanLoading: true,
          scenePlanError: null,
          generationState: 'running',
          generationPhase: 'scenePlan'
        })
        try {
          const suppliedWordCount = String(storyToUse.provided_voiceover || '').trim().split(/\s+/).filter(Boolean).length
          const effectiveMaxMinutes = maxMinutes || (
            storyToUse.input_mode === 'script' && suppliedWordCount
              ? Math.max(1, Math.round((suppliedWordCount / 145) * 10) / 10)
              : null
          )
          const scenePlan = await api.generateScenePlan(
            storyToUse, effectiveMaxMinutes, settings.claudeProvider, settings.claudeModel, get().customPrompts.scenePlanning, settings.videoModel
          )
          if (!isProjectScopeCurrent(get, scope)) return null
          // Audio comes BEFORE images now: stop here, kick off the narration
          // script so the Audio step has per-scene text ready. Images/videos
          // start later, once audio durations are known.
          set({ scenePlan, scenePlanLoading: false, generationState: 'idle', generationPhase: null })
          get().logActivity(`Scene plan ready — ${scenePlan.scenes?.length || 0} scenes. Writing narration script...`, 'running')
          get().fetchTtsScript()
            .then(() => get().logActivity('Narration script ready — record or upload audio next', 'success'))
            .catch(() => {})
          get().autoSaveSession()
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          console.error('Failed to fetch scene plan:', error)
          set({
            scenePlanLoading: false,
            scenePlanError: error.message,
            generationState: 'stopped',
            generationPhase: null
          })
          throw error
        }
      },

      retryScenePlan: () => {
        set({ scenePlanError: null })
        get().fetchScenePlan()
      },

      // ─── Image Prompts & Generation ───────────────────────────────────────
      fetchImagePrompts: async (scenePlan, resumeFromPending = false) => {
        const plan = scenePlan || get().scenePlan
        const { settings, ttsScript, audio } = get()
        if (!plan) return
        if (get().characterStatus !== 'ready') {
          throw new Error('Approve the project characters before generating scene images')
        }
        const scope = captureProjectScope(get)

        if (!resumeFromPending) {
          set({
            scenes: [],
            images: {},
            selectedImages: {},
            imagesError: null,
            imageBatches: [],
            imageHistory: {},
            sceneSheetWorkflow: null,
            videoPrompts: [],
            videoBatches: [],
            videoJobs: {},
            videoHistory: {},
            selectedVideos: {},
            windowsVideoStatus: emptyWindowsVideoStatus(),
            videoProgress: { total: 0, completed: [], pending: [] },
            timeline: { items: [], sceneWindows: {}, directorPlan: null, chapters: null, built: false },
            timelineDirty: false,
            timelineHistory: { past: [], future: [] },
            renderJob: null,
            thumbnails: {},
            thumbnailHistory: {},
            selectedThumbnail: null,
            generationPhase: 'images'
          })
        }

        // Segments are derived from the (audio-first) measured durations —
        // recompute on fresh runs, reuse on resume so keys stay stable
        const sceneSegments = resumeFromPending && Object.keys(get().sceneSegments).length > 0
          ? get().sceneSegments
          : get().computeSceneSegments()

        try {
          // ── Step 1: Generate image prompts from Claude (batched by scene) ──────
        let scenes = get().scenes
        // If resuming but scenes are empty (all batches failed), fall back to full fetch
        if (resumeFromPending && scenes.length === 0) {
          return get().fetchImagePrompts(plan, false)
        }
        if (!resumeFromPending && scenes.length === 0) {
            const planScenes = (plan.scenes || []).map(ps => {
              const timings = sceneSegments[ps.scene_number] || [{ segmentIndex: 0 }]
              const fullNarration = narrationTextForScene(ttsScript, ps, audio)
              const segmentNarrations = splitNarrationAcrossSegments(
                fullNarration,
                timings.map(seg => seg.targetDuration || seg.clipDuration || ps.duration_seconds || 1)
              )
              return {
                ...ps,
                segments: timings.map((seg, index) => ({
                  segment_index: seg.segmentIndex,
                  target_duration: seg.targetDuration,
                  narration: segmentNarrations[index] || fullNarration || undefined,
                }))
              }
            })
            {
              const multi = planScenes.filter(ps => ps.segments.length > 1).length
              if (multi > 0) {
                get().logActivity(`${multi} scene${multi > 1 ? 's' : ''} need multiple shots to cover their audio`, 'info')
              }
            }
            // Prompt authoring is intentionally isolated from the project's
            // general LLM setting: three independent Claude CLI Sonnet workers.
            const batchSize = PROMPT_AUTHOR_BATCH_SIZE
            const batches = []
            for (let i = 0; i < planScenes.length; i += batchSize) {
              batches.push(planScenes.slice(i, i + batchSize))
            }

            // Initialise batch status tracking
            const batchStatuses = batches.map((b, i) => ({
              batchIndex: i,
              sceneNumbers: b.map(s => s.scene_number),
              status: 'pending',
              error: null,
            }))
            set({ imageBatches: batchStatuses })

            get().logActivity(
              `Writing image prompts with ${PROMPT_AUTHOR_CONCURRENCY} parallel Claude Sonnet sessions...`,
              'running'
            )
            const authored = await runPromptBatchWorkers({
              batches,
              shouldStop: () => get().checkShouldStop(),
              onStart: (batch, bi) => {
                set(state => ({
                  imageBatches: state.imageBatches.map(b =>
                    b.batchIndex === bi ? { ...b, status: 'running' } : b
                  )
                }))
                get().logActivity(`Writing image prompts — batch ${bi + 1}/${batches.length} (${batch.length} scenes, Sonnet)...`, 'running')
              },
              processBatch: (batch) => api.generateImagePrompts(
                null,
                settings.aspectRatio,
                PROMPT_AUTHOR_PROVIDER,
                PROMPT_AUTHOR_MODEL,
                get().customPrompts.imagePrompts,
                batch,
                settings.imageVariations
              ),
              onSuccess: (_rawScenes, _batch, bi) => {
                if (!isProjectScopeCurrent(get, scope)) return
                set(state => ({
                  imageBatches: state.imageBatches.map(b =>
                    b.batchIndex === bi ? { ...b, status: 'done' } : b
                  )
                }))
                get().logActivity(`Image prompts batch ${bi + 1}/${batches.length} complete`, 'success')
              },
              onError: (batchErr, _batch, bi) => {
                if (!isProjectScopeCurrent(get, scope)) return
                set(state => ({
                  imageBatches: state.imageBatches.map(b =>
                    b.batchIndex === bi ? { ...b, status: 'failed', error: batchErr.message } : b
                  )
                }))
                get().logActivity(`Image prompts batch ${bi + 1}/${batches.length} failed: ${batchErr.message}`, 'error')
              },
            })
            if (!isProjectScopeCurrent(get, scope)) return null
            if (authored.interrupted) {
              get().logActivity('Image prompt writing interrupted — remaining batches can be retried', 'info')
            }
            const allRawScenes = authored.results.flatMap(result =>
              result?.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []
            )

            // Flatten to one entry per (scene, segment) — the whole downstream
            // pipeline (images, video prompts, video jobs) works on these units
            scenes = allRawScenes.flatMap(scene => {
              const segs = Array.isArray(scene.segments) && scene.segments.length > 0
                ? scene.segments
                : [{ segment_index: 0, variations: scene.variations || [] }]
              const timing = sceneSegments[scene.scene_number] || []
              const planScene = plan.scenes?.find(candidate => candidate.scene_number === scene.scene_number)
              const fullNarration = narrationTextForScene(ttsScript, planScene, audio)
              const segmentNarrations = splitNarrationAcrossSegments(
                fullNarration,
                timing.map(seg => seg.targetDuration || seg.clipDuration || planScene?.duration_seconds || 1)
              )
              return segs.map((seg, i) => {
                const segIndex = seg.segment_index ?? i
                const t = timing.find(s => s.segmentIndex === segIndex) || timing[i] || {}
                return {
                  scene_number: scene.scene_number,
                  segment_index: segIndex,
                  segment_count: segs.length,
                  scene_title: seg.variations?.[0]?.type || `Scene ${scene.scene_number}`,
                  scene_description: seg.variations?.[0]?.prompt?.substring(0, 100) || '',
                  prompts: seg.variations?.map(v => v.prompt) || [],
                  continuity_checklist: scene.continuity_checklist || [],
                  narration: segmentNarrations[segIndex] || segmentNarrations[i] || fullNarration || '',
                  full_scene_narration: fullNarration,
                  target_duration: t.targetDuration ?? null,
                  clip_duration: t.clipDuration ?? null,
                  playback_rate: t.playbackRate ?? 1,
                  scenario_id: planScene?.scenario_id || scene.scenario_id || null,
                  scenario_continuity: planScene?.scenario_continuity || scene.scenario_continuity || '',
                  environment_family_id: planScene?.environment_family_id || scene.environment_family_id || null,
                  environment_family_continuity: planScene?.environment_family_continuity || scene.environment_family_continuity || '',
                }
              })
            })

            set({ scenes })
            await get().autoSaveSession()  // canonical units must exist before sheet planning
          }

          // ── Step 2: Generate the actual images unit-by-unit (scene+segment) ───
          let sheetWorkflow = get().sceneSheetWorkflow
          if (settings.sceneSheetEnabled) {
            if (!sheetWorkflow || !resumeFromPending) {
              get().logActivity('Planning continuity scene sheets with Claude Sonnet…', 'running')
              sheetWorkflow = await get().prepareSceneSheets()
              get().logActivity(
                `${sheetWorkflow?.groups?.length || 0} continuity sheet${sheetWorkflow?.groups?.length === 1 ? '' : 's'} planned · ${(sheetWorkflow?.isolatedUnitIds || []).length} isolated shot${(sheetWorkflow?.isolatedUnitIds || []).length === 1 ? '' : 's'}`,
                'success'
              )
            }
          }
          const isolatedUnitIds = settings.sceneSheetEnabled
            ? new Set(sheetWorkflow?.isolatedUnitIds || sheetWorkflow?.isolated_unit_ids || [])
            : null
          const unitsForDirectGeneration = isolatedUnitIds
            ? scenes.filter(unit => isolatedUnitIds.has(`${unit.scene_number}_${unit.segment_index ?? 0}`))
            : scenes
          const allPrompts = unitsForDirectGeneration.flatMap(unit =>
            unit.prompts.map((prompt, idx) => ({
              sceneNumber: unit.scene_number,
              segmentIndex: unit.segment_index ?? 0,
              segmentCount: unit.segment_count ?? 1,
              promptIndex: idx,
              prompt
            }))
          )
          const keyOf = (p) => `${p.sceneNumber}_${p.segmentIndex}_${p.promptIndex}`

          const { imageProgress } = get()
          let promptsToProcess = allPrompts

          if (resumeFromPending && imageProgress.pending.length > 0) {
            promptsToProcess = imageProgress.pending
              .map(key => allPrompts.find(p => keyOf(p) === key))
              .filter(Boolean)
          } else {
            const existingImages = get().images
            const initialCompleted = Object.keys(existingImages).filter(k => existingImages[k]?.url)
            set({
              imageProgress: {
                total: allPrompts.length,
                completed: initialCompleted,
                pending: allPrompts
                  .map(keyOf)
                  .filter(k => !initialCompleted.includes(k))
              }
            })
          }

          // Mark loading state for all pending
          const loadingUpdate = {}
          promptsToProcess.forEach(p => { loadingUpdate[keyOf(p)] = true })
          set({ imagesLoading: loadingUpdate })

          // Group prompts by unit (scene + segment) — one API call per unit
          const promptsByUnit = {}
          promptsToProcess.forEach(p => {
            const uk = `${p.sceneNumber}_${p.segmentIndex}`
            if (!promptsByUnit[uk]) promptsByUnit[uk] = []
            promptsByUnit[uk].push(p)
          })
          const unitKeys = Object.keys(promptsByUnit).sort((a, b) => {
            const [sa, ga] = a.split('_').map(Number)
            const [sb, gb] = b.split('_').map(Number)
            return sa - sb || ga - gb
          })

          const processImageUnit = async (uk) => {
            const unitPrompts = promptsByUnit[uk]
            const unitPromptTexts = unitPrompts.map(p => p.prompt)
            const { sceneNumber: sceneNum, segmentIndex: segIdx, segmentCount: segCount } = unitPrompts[0]
            const unitLabel = segCount > 1
              ? `scene ${sceneNum} · shot ${segIdx + 1}/${segCount}`
              : `scene ${sceneNum}`
            get().logActivity(`Generating ${unitLabel} images (${unitPrompts.length} variation${unitPrompts.length > 1 ? 's' : ''})...`, 'running')

            try {
              const references = characterReferencesForScene(get(), sceneNum)
              const results = await api.generateImages(
                unitPromptTexts,
                settings.imageProvider,
                settings.imageModel,
                settings.aspectRatio,
                references.images,
                references.description,
                null,
                {
                  sessionId: getSessionId(),
                  itemIds: unitPrompts.map(keyOf),
                  outputCount: settings.windowsImageOutputs || 1,
                }
              )
              if (!isProjectScopeCurrent(get, scope)) return null

              const base64Urls = await Promise.all(
                results.map(r => r?.url ? toBase64DataUri(r.url) : Promise.resolve(null))
              )

              const imageUpdates = {}
              const completedKeys = []
              unitPrompts.forEach((p, idx) => {
                const key = keyOf(p)
                const result = results[idx]
                imageUpdates[key] = {
                  url: base64Urls[idx] || result?.url || null,
                  prompt: result?.prompt || unitPromptTexts[idx],
                  error: result?.error || null,
                  alternatives: result?.alternatives || [],
                  taskId: result?.taskId || null,
                  loading: false
                }
                completedKeys.push(key)
              })

              set(state => {
                const newLoading = { ...state.imagesLoading }
                completedKeys.forEach(k => delete newLoading[k])
                return {
                  images: { ...state.images, ...imageUpdates },
                  imagesLoading: newLoading,
                  imageProgress: {
                    ...state.imageProgress,
                    completed: [...state.imageProgress.completed, ...completedKeys],
                    pending: state.imageProgress.pending.filter(k => !completedKeys.includes(k))
                  }
                }
              })
              get().autoSaveSession()  // save after each unit's images complete
              {
                const failed = results.filter(r => r?.error).length
                get().logActivity(
                  failed > 0
                    ? `${unitLabel[0].toUpperCase() + unitLabel.slice(1)} images done (${unitPrompts.length - failed} ok, ${failed} failed)`
                    : `${unitLabel[0].toUpperCase() + unitLabel.slice(1)} images ready ✓`,
                  failed > 0 ? 'error' : 'success'
                )
              }
            } catch (error) {
              get().logActivity(`${unitLabel[0].toUpperCase() + unitLabel.slice(1)} image generation failed: ${error.message}`, 'error')
              const imageUpdates = {}
              const keys = []
              unitPrompts.forEach(p => {
                const key = keyOf(p)
                keys.push(key)
                imageUpdates[key] = { url: null, prompt: p.prompt, error: error.message, loading: false }
              })
              set(state => {
                const newLoading = { ...state.imagesLoading }
                keys.forEach(k => delete newLoading[k])
                return {
                  images: { ...state.images, ...imageUpdates },
                  imagesLoading: newLoading
                }
              })
            }

            if (settings.imageProvider !== 'windows-image') {
              await new Promise(r => setTimeout(r, 800))
            }
          }

          if (settings.imageProvider === 'windows-image') {
            // Queue five independent jobs before waiting for results. The
            // Windows worker owns its persistent Chrome execution slot; serial
            // browser-side awaits would starve four of them.
            let nextUnitIndex = 0
            const worker = async () => {
              while (nextUnitIndex < unitKeys.length && !get().checkShouldStop()) {
                const uk = unitKeys[nextUnitIndex]
                nextUnitIndex += 1
                await processImageUnit(uk)
              }
            }
            await Promise.all(
              Array.from({ length: Math.min(5, unitKeys.length) }, worker),
            )
          } else {
            for (const uk of unitKeys) {
              if (get().checkShouldStop()) break
              await processImageUnit(uk)
            }
          }

          if (get().checkShouldStop()) {
            const remaining = get().imageProgress.pending
            set({ imagesLoading: {} })
            get().logActivity(`Image generation interrupted — ${remaining.length} images pending, resume anytime`, 'info')
            return
          }

          set({ imagesLoading: {} })

        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          console.error('Failed to fetch image prompts:', error)
          set({
            imagesError: error.message,
            imagesLoading: {},
            generationState: 'stopped'
          })
          throw error
        }
      },

      // Retry a single failed batch (re-runs just those scenes through the LLM + image generation)
      retryImageBatch: async (batchIndex) => {
        const scope = captureProjectScope(get)
        const { scenePlan, imageBatches, settings, ttsScript, audio } = get()
        const batch = imageBatches[batchIndex]
        if (!batch || !scenePlan) return

        // Attach the same segment metadata the original run used
        const sceneSegments = Object.keys(get().sceneSegments).length > 0
          ? get().sceneSegments
          : get().computeSceneSegments()

        const batchScenes = scenePlan.scenes
          .filter(s => batch.sceneNumbers.includes(s.scene_number))
          .map(ps => {
            const timings = sceneSegments[ps.scene_number] || [{ segmentIndex: 0 }]
            const fullNarration = narrationTextForScene(ttsScript, ps, audio)
            const segmentNarrations = splitNarrationAcrossSegments(
              fullNarration,
              timings.map(seg => seg.targetDuration || seg.clipDuration || ps.duration_seconds || 1)
            )
            return {
              ...ps,
              segments: timings.map((seg, index) => ({
                segment_index: seg.segmentIndex,
                target_duration: seg.targetDuration,
                narration: segmentNarrations[index] || fullNarration || undefined,
              }))
            }
          })

        if (batchScenes.length === 0) {
          console.warn(`retryImageBatch: no scenes found for batch ${batchIndex} (numbers: ${batch.sceneNumbers})`)
          return
        }

        set(state => ({
          imageBatches: state.imageBatches.map(b =>
            b.batchIndex === batchIndex ? { ...b, status: 'running', error: null } : b
          )
        }))

        try {
          const rawScenes = await api.generateImagePrompts(
            null,
            settings.aspectRatio,
            PROMPT_AUTHOR_PROVIDER,
            PROMPT_AUTHOR_MODEL,
            get().customPrompts.imagePrompts,
            batchScenes,
            settings.imageVariations
          )
          if (!isProjectScopeCurrent(get, scope)) return null

          const newSceneData = rawScenes.flatMap(scene => {
            const segs = Array.isArray(scene.segments) && scene.segments.length > 0
              ? scene.segments
              : [{ segment_index: 0, variations: scene.variations || [] }]
            const timing = sceneSegments[scene.scene_number] || []
            const planScene = scenePlan.scenes?.find(candidate => candidate.scene_number === scene.scene_number)
            const fullNarration = narrationTextForScene(ttsScript, planScene, audio)
            const segmentNarrations = splitNarrationAcrossSegments(
              fullNarration,
              timing.map(seg => seg.targetDuration || seg.clipDuration || planScene?.duration_seconds || 1)
            )
            return segs.map((seg, i) => {
              const segIndex = seg.segment_index ?? i
              const t = timing.find(s => s.segmentIndex === segIndex) || timing[i] || {}
              return {
                scene_number: scene.scene_number,
                segment_index: segIndex,
                segment_count: segs.length,
                scene_title: seg.variations?.[0]?.type || `Scene ${scene.scene_number}`,
                scene_description: seg.variations?.[0]?.prompt?.substring(0, 100) || '',
                prompts: seg.variations?.map(v => v.prompt) || [],
                continuity_checklist: scene.continuity_checklist || [],
                narration: segmentNarrations[segIndex] || segmentNarrations[i] || fullNarration || '',
                full_scene_narration: fullNarration,
                target_duration: t.targetDuration ?? null,
                clip_duration: t.clipDuration ?? null,
                playback_rate: t.playbackRate ?? 1,
              }
            })
          })

          // Merge into existing scenes (match on scene + segment)
          set(state => {
            const mergedScenes = [...state.scenes]
            newSceneData.forEach(ns => {
              const idx = mergedScenes.findIndex(s =>
                s.scene_number === ns.scene_number && (s.segment_index ?? 0) === ns.segment_index
              )
              if (idx >= 0) mergedScenes[idx] = ns
              else mergedScenes.push(ns)
            })
            mergedScenes.sort((a, b) =>
              a.scene_number - b.scene_number || (a.segment_index ?? 0) - (b.segment_index ?? 0)
            )
            return {
              scenes: mergedScenes,
              imageBatches: state.imageBatches.map(b =>
                b.batchIndex === batchIndex ? { ...b, status: 'done', error: null } : b
              )
            }
          })

          // Now generate the images for those units
          const allPrompts = newSceneData.flatMap(unit =>
            unit.prompts.map((prompt, idx) => ({
              sceneNumber: unit.scene_number,
              segmentIndex: unit.segment_index ?? 0,
              promptIndex: idx,
              prompt
            }))
          )

          // Ensure these keys are tracked in imageProgress (they may have been absent
          // if the batch failed before images were ever queued on the first attempt)
          const retryKeys = allPrompts.map(p => `${p.sceneNumber}_${p.segmentIndex}_${p.promptIndex}`)
          set(state => {
            const existingCompleted = new Set(state.imageProgress.completed)
            const newPendingKeys = retryKeys.filter(k => !existingCompleted.has(k))
            const existingPending = new Set(state.imageProgress.pending)
            const mergedPending = [...existingPending, ...newPendingKeys.filter(k => !existingPending.has(k))]
            // Use the canonical total from scenes store rather than growing Math.max
            const canonicalTotal = get().scenes.reduce((sum, s) => sum + (s.prompts?.length || 0), 0)
            const total = canonicalTotal > 0 ? canonicalTotal : existingCompleted.size + mergedPending.length
            return {
              imageProgress: {
                total,
                completed: state.imageProgress.completed,
                pending: mergedPending
              }
            }
          })

          for (const { sceneNumber, segmentIndex, promptIndex, prompt } of allPrompts) {
            const key = `${sceneNumber}_${segmentIndex}_${promptIndex}`
            set(state => ({ imagesLoading: { ...state.imagesLoading, [key]: true } }))
            try {
              const references = characterReferencesForScene(get(), sceneNumber)
              const results = await api.generateImages(
                [prompt],
                settings.imageProvider,
                settings.imageModel,
                settings.aspectRatio,
                references.images,
                references.description,
                null,
                {
                  sessionId: getSessionId(),
                  itemIds: [key],
                  outputCount: settings.windowsImageOutputs || 1,
                  retry: true,
                },
              )
              if (!isProjectScopeCurrent(get, scope)) return null
              const base64Url = results[0]?.url ? await toBase64DataUri(results[0].url) : null
              set(state => {
                const newLoading = { ...state.imagesLoading }
                delete newLoading[key]
                return {
                  images: {
                    ...state.images,
                    [key]: {
                      url: base64Url || results[0]?.url || null,
                      prompt,
                      error: results[0]?.error || null,
                      loading: false,
                      alternatives: results[0]?.alternatives || [],
                      taskId: results[0]?.taskId || null,
                    },
                  },
                  imagesLoading: newLoading,
                  imageProgress: {
                    ...state.imageProgress,
                    completed: [...new Set([...state.imageProgress.completed, key])],
                    pending: state.imageProgress.pending.filter(k => k !== key)
                  }
                }
              })
            } catch (err) {
              set(state => {
                const newLoading = { ...state.imagesLoading }
                delete newLoading[key]
                return {
                  images: { ...state.images, [key]: { url: null, prompt, error: err.message, loading: false } },
                  imagesLoading: newLoading,
                  // Remove from pending even on error — it's done (failed), not still waiting
                  imageProgress: {
                    ...state.imageProgress,
                    pending: state.imageProgress.pending.filter(k => k !== key)
                  }
                }
              })
            }
            await new Promise(r => setTimeout(r, 500))
          }
        } catch (err) {
          set(state => ({
            imageBatches: state.imageBatches.map(b =>
              b.batchIndex === batchIndex ? { ...b, status: 'failed', error: err.message } : b
            )
          }))
        }
      },

      retryImagePrompts: () => {
        // Reset generationState to 'running' so checkShouldStop() returns false
        // inside fetchImagePrompts — without this the image loop exits immediately
        set({ imagesError: null, imageBatches: [], generationState: 'running', generationPhase: 'images' })
        get().fetchImagePrompts(null, false)
      },

      resumeImageGeneration: () => {
        const { imageProgress } = get()
        if (imageProgress.pending.length > 0) {
          get().logActivity(`Resuming image generation — ${imageProgress.pending.length} images remaining`, 'info')
          set({ generationState: 'running', generationPhase: 'images' })
          get().fetchImagePrompts(null, true)
        }
      },

      regenerateImage: async (sceneNumber, segmentIndex, promptIndex, newPrompt) => {
        const scope = captureProjectScope(get)
        const key = `${sceneNumber}_${segmentIndex}_${promptIndex}`
        const selKey = unitKey(sceneNumber, segmentIndex)
        const { images, settings } = get()
        const references = characterReferencesForScene(get(), sceneNumber)
        const prompt = newPrompt || images[key]?.prompt
        if (!prompt) return

        set((state) => ({
          imagesLoading: { ...state.imagesLoading, [key]: true }
        }))

        try {
          const result = await api.regenerateImage(
            prompt,
            settings.imageProvider,
            settings.imageModel,
            settings.aspectRatio,
            references.images,
            references.description,
            {
              sessionId: getSessionId(),
              itemIds: [key],
              outputCount: settings.windowsImageOutputs || 1,
              retry: true,
            },
          )
          const b64url = await toBase64DataUri(result.url)
          if (!isProjectScopeCurrent(get, scope)) return null
          set((state) => {
            // Push old image into history before overwriting
            const oldEntry = state.images[key]
            const prevHistory = state.imageHistory[key] || []
            const newHistory = oldEntry?.url
              ? [...prevHistory, { url: oldEntry.url, prompt: oldEntry.prompt }]
              : prevHistory

            const updatedImages = {
              ...state.images,
              [key]: {
                url: b64url,
                prompt,
                error: null,
                loading: false,
                alternatives: result.alternatives || [],
                taskId: result.taskId || null,
              }
            }
            // If this image is currently selected for its unit, update selectedImages too
            const updatedSelectedImages = { ...state.selectedImages }
            const existing = updatedSelectedImages[selKey]
            if (existing && existing.promptIndex === promptIndex) {
              updatedSelectedImages[selKey] = { url: b64url, prompt, promptIndex }
            }
            // Save altered prompt back into scenes so it round-trips on export
            const updatedScenes = state.scenes.map(s => {
              if (s.scene_number !== sceneNumber || (s.segment_index ?? 0) !== segmentIndex) return s
              const prompts = [...(s.prompts || [])]
              prompts[promptIndex] = prompt
              return { ...s, prompts }
            })
            return {
              images: updatedImages,
              imageHistory: { ...state.imageHistory, [key]: newHistory },
              selectedImages: updatedSelectedImages,
              scenes: updatedScenes,
              imagesLoading: { ...state.imagesLoading, [key]: false }
            }
          })
        } catch (error) {
          set((state) => ({
            images: {
              ...state.images,
              [key]: { ...state.images[key], error: error.message, loading: false }
            },
            imagesLoading: { ...state.imagesLoading, [key]: false }
          }))
          throw error
        }
      },

      editSceneImageWithAi: async (sceneNumber, segmentIndex, promptIndex, instruction, optionCount = 1) => {
        const scope = captureProjectScope(get)
        const key = `${sceneNumber}_${segmentIndex}_${promptIndex}`
        const source = get().images[key]
        if (!source?.url || !String(instruction || '').trim()) {
          throw new Error('An existing image and edit instruction are required')
        }
        const count = Math.max(1, Math.min(2, Number(optionCount) || 1))
        const references = characterReferencesForScene(get(), sceneNumber)
        const prompt = `EDIT THE FIRST REFERENCE IMAGE. Preserve its composition, subject identities, period, camera position, and visual language unless the instruction explicitly changes them. Apply only this requested change: ${String(instruction).trim()}`
        set(state => ({ imagesLoading: { ...state.imagesLoading, [key]: true } }))
        try {
          const useVertexEdit = !!get().settings.keysConfigured?.vertex
          const editProvider = useVertexEdit ? 'vertex' : get().settings.imageProvider
          const editModel = useVertexEdit && get().settings.imageProvider !== 'vertex'
            ? 'gemini-2.5-flash-image'
            : get().settings.imageModel
          const results = await api.generateImages(
            Array.from(
              { length: editProvider === 'windows-image' ? 1 : count },
              () => prompt,
            ),
            editProvider,
            editModel,
            get().settings.aspectRatio,
            [source.url, ...references.images],
            references.description,
            null,
            {
              sessionId: getSessionId(),
              itemIds: [`${key}-edit`],
              outputCount: count,
              retry: true,
            },
          )
          const rawOptions = editProvider === 'windows-image'
            ? (results[0]?.alternatives || [])
            : results
          const options = await Promise.all(rawOptions.filter(result => result?.url).map(async result => ({
            url: await toBase64DataUri(result.url),
            prompt,
          })))
          if (!options.length) throw new Error(results?.[0]?.error || 'No edited image returned')
          if (!isProjectScopeCurrent(get, scope)) return []
          // Generation is non-destructive. The modal previews every option
          // and applySceneImageEdit commits only the user's explicit choice.
          set(state => ({ imagesLoading: { ...state.imagesLoading, [key]: false } }))
          return options
        } catch (error) {
          set(state => ({ imagesLoading: { ...state.imagesLoading, [key]: false } }))
          throw error
        }
      },

      applySceneImageEdit: (sceneNumber, segmentIndex, promptIndex, option) => {
        if (!option?.url) return
        const key = `${sceneNumber}_${segmentIndex}_${promptIndex}`
        const selectedKey = unitKey(sceneNumber, segmentIndex)
        set(state => {
          const previous = state.images[key]
          const history = previous?.url
            ? [...(state.imageHistory[key] || []), { url: previous.url, prompt: previous.prompt }]
            : state.imageHistory[key] || []
          const selected = state.selectedImages[selectedKey]
          return {
            images: {
              ...state.images,
              [key]: { url: option.url, prompt: option.prompt, error: null, loading: false },
            },
            imageHistory: { ...state.imageHistory, [key]: history },
            selectedImages: selected?.promptIndex === promptIndex
              ? {
                  ...state.selectedImages,
                  [selectedKey]: {
                    url: option.url,
                    prompt: option.prompt,
                    promptIndex,
                  },
                }
              : state.selectedImages,
          }
        })
        get().autoSaveSession()
      },

      regenerateAllImages: async () => {
        const scope = captureProjectScope(get)
        const { scenes, settings, characterImages, characterDescription, sceneSheetWorkflow } = get()
        const charImgList = Object.values(characterImages || {}).filter(Boolean)
        if (!scenes.length) return

        // Build list of all prompts grouped by unit (scene + segment)
        const promptsByUnit = {}
        const isolatedUnitIds = settings.sceneSheetEnabled
          ? new Set(sceneSheetWorkflow?.isolatedUnitIds || sceneSheetWorkflow?.isolated_unit_ids || [])
          : null
        scenes.forEach(unit => {
          const uk = `${unit.scene_number}_${unit.segment_index ?? 0}`
          if (isolatedUnitIds && !isolatedUnitIds.has(uk)) return
          const prompts = unit.prompts || []
          prompts.forEach((prompt, idx) => {
            if (!promptsByUnit[uk]) promptsByUnit[uk] = []
            promptsByUnit[uk].push({
              sceneNumber: unit.scene_number,
              segmentIndex: unit.segment_index ?? 0,
              promptIndex: idx,
              prompt
            })
          })
        })

        const keyOf = (p) => `${p.sceneNumber}_${p.segmentIndex}_${p.promptIndex}`
        const unitKeys = Object.keys(promptsByUnit).sort((a, b) => {
          const [sa, ga] = a.split('_').map(Number)
          const [sb, gb] = b.split('_').map(Number)
          return sa - sb || ga - gb
        })

        // Mark all as loading
        const loadingUpdate = {}
        unitKeys.forEach(uk => {
          promptsByUnit[uk].forEach(p => { loadingUpdate[keyOf(p)] = true })
        })
        set({ imagesLoading: loadingUpdate })

        // Reset progress and set state to running so checkShouldStop() returns false
        const allKeys = unitKeys.flatMap(uk => promptsByUnit[uk].map(keyOf))
        set({
          imageProgress: { total: allKeys.length, completed: [], pending: allKeys },
          generationState: 'running',
          generationPhase: 'images'
        })

        // Process each unit
        for (const uk of unitKeys) {
          if (get().checkShouldStop()) {
            const remaining = unitKeys
              .slice(unitKeys.indexOf(uk))
              .flatMap(u => promptsByUnit[u].map(keyOf))
            set(state => ({
              imageProgress: { ...state.imageProgress, pending: remaining },
              imagesLoading: {}
            }))
            return
          }

          const unitPrompts = promptsByUnit[uk]
          const unitPromptTexts = unitPrompts.map(p => p.prompt)

          try {
            const results = await api.generateImages(
              unitPromptTexts,
              settings.imageProvider,
              settings.imageModel,
              settings.aspectRatio,
              charImgList,
              characterDescription,
              null,
              {
                sessionId: getSessionId(),
                itemIds: unitPrompts.map(keyOf),
                outputCount: settings.windowsImageOutputs || 1,
              },
            )
            if (!isProjectScopeCurrent(get, scope)) return null

            const base64Urls = await Promise.all(
              results.map(r => r?.url ? toBase64DataUri(r.url) : Promise.resolve(null))
            )

            const imageUpdates = {}
            const completedKeys = []
            unitPrompts.forEach((p, idx) => {
              const key = keyOf(p)
              const result = results[idx]
              imageUpdates[key] = {
                url: base64Urls[idx] || result?.url || null,
                prompt: result?.prompt || unitPromptTexts[idx],
                error: result?.error || null,
                loading: false,
                alternatives: result?.alternatives || [],
                taskId: result?.taskId || null,
              }
              completedKeys.push(key)
            })

            set(state => {
              const newLoading = { ...state.imagesLoading }
              completedKeys.forEach(k => delete newLoading[k])
              const selectedImages = { ...state.selectedImages }
              unitPrompts.forEach((promptItem, idx) => {
                const selectedKey = `${promptItem.sceneNumber}_${promptItem.segmentIndex}`
                const selected = selectedImages[selectedKey]
                if (selected?.source === 'scene-sheet' || selected?.promptIndex !== promptItem.promptIndex) return
                const replacement = imageUpdates[keyOf(promptItem)]
                if (replacement?.url) selectedImages[selectedKey] = {
                  ...selected,
                  url: replacement.url,
                  prompt: replacement.prompt,
                }
              })
              return {
                images: { ...state.images, ...imageUpdates },
                selectedImages,
                imagesLoading: newLoading,
                imageProgress: {
                  ...state.imageProgress,
                  completed: [...state.imageProgress.completed, ...completedKeys],
                  pending: state.imageProgress.pending.filter(k => !completedKeys.includes(k))
                }
              }
            })
          } catch (error) {
            const imageUpdates = {}
            const keys = []
            unitPrompts.forEach(p => {
              const key = keyOf(p)
              keys.push(key)
              imageUpdates[key] = { url: null, prompt: p.prompt, error: error.message, loading: false }
            })
            set(state => {
              const newLoading = { ...state.imagesLoading }
              keys.forEach(k => delete newLoading[k])
              return {
                images: { ...state.images, ...imageUpdates },
                imagesLoading: newLoading
              }
            })
          }

          await new Promise(r => setTimeout(r, 800))
        }

        set({ imagesLoading: {} })
      },

      // urlOverride / promptOverride: used when user selects a historical version
      // from the modal (not the current latest image[key])
      selectImage: (sceneNumber, segmentIndex, promptIndex, urlOverride, promptOverride) => {
        const key = `${sceneNumber}_${segmentIndex}_${promptIndex}`
        const { images } = get()
        const image = images[key]
        const url    = urlOverride    ?? image?.url
        const prompt = promptOverride ?? image?.prompt
        if (url) {
          set((state) => ({
            selectedImages: {
              ...state.selectedImages,
              [unitKey(sceneNumber, segmentIndex)]: { url, prompt, promptIndex }
            }
          }))
        }
      },

      selectAllImages: () => {
        const { scenes, images, selectedImages } = get()
        const nextSelections = buildBulkImageSelection(scenes, images, selectedImages)
        set({ selectedImages: nextSelections })
        void get().autoSaveSession()
      },

      deselectAllImages: () => {
        set({ selectedImages: {} })
        void get().autoSaveSession()
      },

      // ─── Video Prompts ────────────────────────────────────────────────────
      fetchVideoPrompts: async () => {
        const { scenePlan, selectedImages, settings, scenes, ttsScript } = get()
        if (!scenePlan) return
        const scope = captureProjectScope(get)

        const selectedImagesArray = Object.entries(selectedImages).map(([uk, img]) => {
          const [sceneNum, segIdx] = String(uk).split('_').map(Number)
          return {
            scene_number: sceneNum,
            segment_index: segIdx || 0,
            prompt: img.prompt
            // url intentionally excluded — base64 data would exceed Express body limit
          }
        })

        // One request entry per (scene, segment) unit — plan fields joined with
        // the unit's segment timing so the LLM directs for the exact clip length
        const planScenes = scenePlan.scenes || []
        const currentAudio = get().audio
        const clipOptions = getClipOptions(settings.videoModel, settings.videoClipDuration)
        const speedFactor = settings.videoSpeedFactor || 1
        const narrationUnits = ttsScript?.narration_sequence || ttsScript?.scene_breakdown || []
        const plannedSegments = Object.fromEntries(planScenes.map(ps => {
          const audioDuration = currentAudio.sceneAudio?.[ps.scene_id]?.durationSeconds
            || ps.duration_seconds
            || null
          const narrationUnit = narrationUnits.find(unit =>
            unit.scene_id === ps.scene_id || unit.scene_number === ps.scene_number
          )
          const generatedScene = scenes.find(unit => unit.scene_number === ps.scene_number)
          return [ps.scene_number, planSceneSegments(
            audioDuration,
            clipOptions,
            speedFactor,
            buildScenePacingContext(ps, narrationUnit, generatedScene)
          )]
        }))
        if (scenes.length > 0) {
          for (const ps of planScenes) {
            const existingCount = scenes.filter(unit => unit.scene_number === ps.scene_number).length
            const plannedCount = plannedSegments[ps.scene_number]?.length || 1
            if (existingCount !== plannedCount) {
              throw new Error(`The selected video model changes Scene ${ps.scene_number} from ${existingCount} to ${plannedCount} shot${plannedCount === 1 ? '' : 's'}. Return to Images and regenerate that scene's shot plan before writing motion prompts.`)
            }
          }
        }
        const sourceUnits = (scenes.length > 0
          ? scenes.map(unit => {
              const timing = plannedSegments[unit.scene_number]?.find(seg => seg.segmentIndex === (unit.segment_index ?? 0))
              return timing ? {
                ...unit,
                target_duration: timing.targetDuration,
                clip_duration: timing.clipDuration,
                playback_rate: timing.playbackRate,
              } : unit
            })
          : planScenes.flatMap(ps => (plannedSegments[ps.scene_number] || [{ segmentIndex: 0 }]).map((timing, index, all) => ({
              scene_number: ps.scene_number,
              segment_index: timing.segmentIndex ?? index,
              segment_count: all.length,
              target_duration: timing.targetDuration,
              clip_duration: timing.clipDuration,
              playback_rate: timing.playbackRate,
            })))
        ).slice().sort((a, b) =>
          a.scene_number - b.scene_number || (a.segment_index ?? 0) - (b.segment_index ?? 0)
        )
        const missingSelections = missingSelectedImageUnits(sourceUnits, selectedImages)
        if (missingSelections.length > 0) {
          const message = `Select an image for every shot before generating video prompts. Missing shot${missingSelections.length === 1 ? '' : 's'}: ${missingSelections.join(', ')}.`
          set({ videoPromptsLoading: false, videoPromptsError: message, generationPhase: null })
          throw new Error(message)
        }
        set({ sceneSegments: plannedSegments, ...(scenes.length > 0 ? { scenes: sourceUnits } : {}) })
        const units = sourceUnits.map((unit, unitIndex) => {
          const ps = planScenes.find(p => p.scene_number === unit.scene_number) || {}
          const previousUnit = sourceUnits[unitIndex - 1]
          const previousPlanScene = previousUnit
            ? planScenes.find(p => p.scene_number === previousUnit.scene_number)
            : null
          const previousSelectedPrompt = previousUnit
            ? selectedImages[unitKey(previousUnit.scene_number, previousUnit.segment_index ?? 0)]?.prompt
            : ''
          const previousEndingState = previousUnit
            ? (get().videoPrompts.find(prompt =>
                prompt.scene_number === previousUnit.scene_number
                && (prompt.segment_index ?? 0) === (previousUnit.segment_index ?? 0)
              )?.video_prompt?.ending_state || derivePreviousEndingState({
                previousUnit,
                previousPlanScene,
                previousSelectedPrompt,
              }))
            : ''
          const fullNarration = unit.full_scene_narration || narrationTextForScene(get().ttsScript, ps, get().audio)
          const siblingUnits = sourceUnits.filter(candidate => candidate.scene_number === unit.scene_number)
          const fallbackNarrations = splitNarrationAcrossSegments(
            fullNarration,
            siblingUnits.map(candidate => candidate.target_duration || candidate.clip_duration || ps.duration_seconds || 1)
          )
          const siblingIndex = siblingUnits.findIndex(candidate =>
            (candidate.segment_index ?? 0) === (unit.segment_index ?? 0)
          )
          return {
            scene_id: ps.scene_id,
            scene_number: unit.scene_number,
            segment_index: unit.segment_index ?? 0,
            segment_count: unit.segment_count ?? 1,
            ...videoRequestTimingFields(unit, {}, ps.duration_seconds),
            visual_description: ps.visual_description,
            camera_intent: ps.camera_intent,
            mannequin_details: ps.mannequin_details,
            environment: ps.environment,
            narration: unit.narration || fallbackNarrations[siblingIndex] || fullNarration || '',
            full_scene_narration: fullNarration,
            continuity_context: buildContinuityContext({
              previousUnit,
              previousPlanScene,
              previousSelectedPrompt,
              previousEndingState,
              currentUnit: unit,
            }),
            previous_selected_prompt: previousSelectedPrompt || undefined,
            previous_ending_state: previousEndingState || undefined,
          }
        })

        const batchSize = PROMPT_AUTHOR_BATCH_SIZE
        const batches = []
        for (let i = 0; i < units.length; i += batchSize) {
          batches.push(units.slice(i, i + batchSize))
        }

        const batchStatuses = batches.map((b, i) => ({
          batchIndex: i,
          sceneNumbers: b.map(s => s.scene_number),
          unitKeys: b.map(s => `${s.scene_number}_${s.segment_index ?? 0}`),
          status: 'pending',
          error: null,
        }))

        set({
          videoPromptsLoading: true,
          videoPromptsError: null,
          videoBatches: batchStatuses,
          videoPrompts: [],
          videoJobs: {},
          videoHistory: {},
          selectedVideos: {},
          windowsVideoStatus: emptyWindowsVideoStatus(),
          videoProgress: { total: 0, completed: [], pending: [] },
          timeline: { items: [], sceneWindows: {}, directorPlan: null, chapters: null, built: false },
          timelineDirty: false,
          timelineHistory: { past: [], future: [] },
          renderJob: null,
          // The Images stage may have been paused before the user continued.
          // Video prompt authoring is a new explicit run and must not inherit
          // that stale pause flag.
          generationState: 'running',
          generationPhase: 'videoPrompts'
        })

        try {
          get().logActivity(
            `Writing video prompts with ${PROMPT_AUTHOR_CONCURRENCY} parallel Claude Sonnet sessions...`,
            'running'
          )
          const authored = await runPromptBatchWorkers({
            batches,
            shouldStop: () => get().checkShouldStop(),
            onStart: (batch, bi) => {
              set(state => ({
                videoBatches: state.videoBatches.map(b =>
                  b.batchIndex === bi ? { ...b, status: 'running' } : b
                )
              }))
              get().logActivity(`Writing video prompts — batch ${bi + 1}/${batches.length} (${batch.length} shots, Sonnet)...`, 'running')
            },
            processBatch: async (batchScenes) => {
              const batchPrompts = await api.generateVideoPrompts(
                null,
                selectedImagesArray,
                PROMPT_AUTHOR_PROVIDER,
                PROMPT_AUTHOR_MODEL,
                get().customPrompts.videoPrompts,
                batchScenes
              )
              const arr = Array.isArray(batchPrompts) ? batchPrompts : []
              if (arr.length === 0) {
                throw new Error('The motion author returned no prompts for this batch.')
              }
              return arr
            },
            onSuccess: (arr, _batch, bi) => {
              if (!isProjectScopeCurrent(get, scope)) return
              const fallbackCount = arr.filter(prompt => prompt.authoring_source === 'protected-local-fallback').length
              if (fallbackCount > 0) {
                get().logActivity(`Protected local motion author recovered ${fallbackCount} shot${fallbackCount === 1 ? '' : 's'} in batch ${bi + 1}`, 'warning')
              }
              set(state => ({
                videoBatches: state.videoBatches.map(b =>
                  b.batchIndex === bi ? { ...b, status: 'done' } : b
                )
              }))
              get().logActivity(`Video prompts batch ${bi + 1}/${batches.length} complete`, 'success')
            },
            onError: (batchErr, _batch, bi) => {
              if (!isProjectScopeCurrent(get, scope)) return
              set(state => ({
                videoBatches: state.videoBatches.map(b =>
                  b.batchIndex === bi ? { ...b, status: 'failed', error: batchErr.message } : b
                )
              }))
              get().logActivity(`Video prompts batch ${bi + 1}/${batches.length} failed: ${batchErr.message}`, 'error')
            },
          })

          if (!isProjectScopeCurrent(get, scope)) return null
          if (authored.interrupted) {
            throw new Error('Video prompt writing was paused. Press Retry when you are ready to continue.')
          }
          const allRawPrompts = authored.results.flatMap(result =>
            result?.status === 'fulfilled' && Array.isArray(result.value) ? result.value : []
          )

          const missingPrompts = missingAuthoredPromptUnits(units, allRawPrompts)
          const failedBatches = get().videoBatches.filter(batch => batch.status === 'failed')
          if (failedBatches.length > 0 || missingPrompts.length > 0) {
            throw new Error(videoPromptFailureMessage(get().videoBatches, missingPrompts))
          }

          const enrichedPrompts = allRawPrompts.map(vp => {
            const segIdx = vp.segment_index ?? 0
            const unit = units.find(u => u.scene_number === vp.scene_number && (u.segment_index ?? 0) === segIdx)
            const storeUnit = scenes.find(s => s.scene_number === vp.scene_number && (s.segment_index ?? 0) === segIdx)
            const sceneFromPlan = planScenes.find(s => s.scene_number === vp.scene_number)
            return {
              ...vp,
              segment_index: segIdx,
              segment_count: unit?.segment_count ?? storeUnit?.segment_count ?? 1,
              ...enrichedVideoPromptTiming(
                vp,
                unit,
                storeUnit,
                sceneFromPlan?.duration_seconds || 6
              ),
              visual_description: sceneFromPlan?.visual_description,
              video_model: settings.videoModel,
              video_provider: settings.videoProvider,
              full_prompt_string: vp.full_prompt_string
                || (typeof vp.video_prompt?.full_prompt_string === 'string' ? vp.video_prompt.full_prompt_string : '')
                || (typeof vp.video_prompt === 'string' ? vp.video_prompt : '')
            }
          }).sort((a, b) =>
            a.scene_number - b.scene_number || (a.segment_index ?? 0) - (b.segment_index ?? 0)
          )

          set({
            videoPrompts: enrichedPrompts,
            videoPromptsLoading: false,
            videoPromptsError: null,
            generationState: 'running',
            generationPhase: null,
          })
          return enrichedPrompts
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          set({
            videoPromptsLoading: false,
            videoPromptsError: error.message,
            generationState: 'stopped',
            generationPhase: null,
          })
          throw error
        }
      },

      retryVideoPrompts: () => {
        set({ videoPromptsError: null, videoBatches: [], videoPrompts: [] })
        return get().fetchVideoPrompts()
      },

      retryVideoBatch: async (batchIndex) => {
        const scope = captureProjectScope(get)
        const { scenePlan, selectedImages, videoBatches, settings, scenes } = get()
        const batch = videoBatches[batchIndex]
        if (!batch || !scenePlan) return

        // Rebuild the unit payloads for just this batch
        const planScenes = scenePlan.scenes || []
        const batchUnitKeys = batch.unitKeys
          || batch.sceneNumbers.map(n => `${n}_0`)  // legacy batches: segment 0
        const batchUnits = batchUnitKeys.map(uk => {
          const [sceneNum, segIdx] = uk.split('_').map(Number)
          const storeUnit = scenes.find(s => s.scene_number === sceneNum && (s.segment_index ?? 0) === (segIdx || 0))
          const ps = planScenes.find(p => p.scene_number === sceneNum) || {}
          const orderedUnits = scenes.slice().sort((a, b) =>
            a.scene_number - b.scene_number || (a.segment_index ?? 0) - (b.segment_index ?? 0)
          )
          const storeIndex = orderedUnits.findIndex(s =>
            s.scene_number === sceneNum && (s.segment_index ?? 0) === (segIdx || 0)
          )
          const previousUnit = storeIndex > 0 ? orderedUnits[storeIndex - 1] : null
          const previousPlanScene = previousUnit
            ? planScenes.find(p => p.scene_number === previousUnit.scene_number)
            : null
          const previousSelectedPrompt = previousUnit
            ? selectedImages[unitKey(previousUnit.scene_number, previousUnit.segment_index ?? 0)]?.prompt
            : ''
          const previousEndingState = previousUnit
            ? (get().videoPrompts.find(prompt =>
                prompt.scene_number === previousUnit.scene_number
                && (prompt.segment_index ?? 0) === (previousUnit.segment_index ?? 0)
              )?.video_prompt?.ending_state || derivePreviousEndingState({
                previousUnit,
                previousPlanScene,
                previousSelectedPrompt,
              }))
            : ''
          const fullNarration = storeUnit?.full_scene_narration || narrationTextForScene(get().ttsScript, ps, get().audio)
          return {
            scene_id: ps.scene_id,
            scene_number: sceneNum,
            segment_index: segIdx || 0,
            segment_count: storeUnit?.segment_count ?? 1,
            ...videoRequestTimingFields(storeUnit, {}, ps.duration_seconds),
            visual_description: ps.visual_description,
            camera_intent: ps.camera_intent,
            mannequin_details: ps.mannequin_details,
            environment: ps.environment,
            narration: storeUnit?.narration || fullNarration || '',
            full_scene_narration: fullNarration,
            continuity_context: buildContinuityContext({
              previousUnit,
              previousPlanScene,
              previousSelectedPrompt,
              previousEndingState,
              currentUnit: storeUnit,
            }),
            previous_selected_prompt: previousSelectedPrompt || undefined,
            previous_ending_state: previousEndingState || undefined,
          }
        }).filter(u => u.scene_id !== undefined || u.visual_description !== undefined)

        if (batchUnits.length === 0) {
          console.warn(`retryVideoBatch: no scenes found for batch ${batchIndex}`)
          return
        }

        const selectedImagesArray = Object.entries(selectedImages).map(([uk, img]) => {
          const [sceneNum, segIdx] = String(uk).split('_').map(Number)
          return { scene_number: sceneNum, segment_index: segIdx || 0, prompt: img.prompt }
        })

        set(state => ({
          videoBatches: state.videoBatches.map(b =>
            b.batchIndex === batchIndex ? { ...b, status: 'running', error: null } : b
          )
        }))

        try {
          const batchPrompts = await api.generateVideoPrompts(
            null,
            selectedImagesArray,
            PROMPT_AUTHOR_PROVIDER,
            PROMPT_AUTHOR_MODEL,
            get().customPrompts.videoPrompts,
            batchUnits
          )
          if (!isProjectScopeCurrent(get, scope)) return null
          const arr = Array.isArray(batchPrompts) ? batchPrompts : []

          const enriched = arr.map(vp => {
            const segIdx = vp.segment_index ?? 0
            const unit = batchUnits.find(u => u.scene_number === vp.scene_number && (u.segment_index ?? 0) === segIdx)
            const storeUnit = scenes.find(s => s.scene_number === vp.scene_number && (s.segment_index ?? 0) === segIdx)
            const sceneFromPlan = planScenes.find(s => s.scene_number === vp.scene_number)
            return {
              ...vp,
              segment_index: segIdx,
              segment_count: unit?.segment_count ?? 1,
              ...enrichedVideoPromptTiming(
                vp,
                unit,
                storeUnit,
                sceneFromPlan?.duration_seconds || 6
              ),
              visual_description: sceneFromPlan?.visual_description,
              video_model: settings.videoModel,
              video_provider: settings.videoProvider,
              full_prompt_string: vp.full_prompt_string
                || (typeof vp.video_prompt?.full_prompt_string === 'string' ? vp.video_prompt.full_prompt_string : '')
                || (typeof vp.video_prompt === 'string' ? vp.video_prompt : '')
            }
          })

          // Merge into existing videoPrompts (match scene + segment)
          set(state => {
            const merged = [...state.videoPrompts]
            enriched.forEach(vp => {
              const idx = merged.findIndex(v =>
                v.scene_number === vp.scene_number && (v.segment_index ?? 0) === (vp.segment_index ?? 0)
              )
              if (idx >= 0) merged[idx] = vp
              else merged.push(vp)
            })
            merged.sort((a, b) =>
              a.scene_number - b.scene_number || (a.segment_index ?? 0) - (b.segment_index ?? 0)
            )
            return {
              videoPrompts: merged,
              videoBatches: state.videoBatches.map(b =>
                b.batchIndex === batchIndex ? { ...b, status: 'done', error: null } : b
              )
            }
          })
        } catch (err) {
          set(state => ({
            videoBatches: state.videoBatches.map(b =>
              b.batchIndex === batchIndex ? { ...b, status: 'failed', error: err.message } : b
            )
          }))
          // Don't re-throw — UI already shows the batch error; re-throwing causes unhandled
          // rejections in callers that don't have a try/catch. Consistent with retryImageBatch.
        }
      },

      // ─── Video Generation ─────────────────────────────────────────────────
      startVideoGeneration: async (videoPrompts, resumeFromPending = false) => {
        const scope = captureProjectScope(get)
        const { selectedImages, images, settings, videoProgress } = get()
        // Don't snapshot videoJobs here — read it fresh after the async API call
        // to avoid overwriting concurrent store mutations (e.g. regenerateVideo)

        if (
          !usesWindowsVideoBackend(settings)
          && videoPrompts.some(prompt => prompt.motion_prompt_version !== 'seedance-2-0-v1')
        ) {
          throw new Error('These motion prompts predate the Seedance continuity safeguards. Regenerate Video Prompts before submitting new video jobs.')
        }
        const mismatchedPrompt = videoPrompts.find(prompt =>
          !isPromptCompatibleWithVideoSettings(prompt, settings)
        )
        if (mismatchedPrompt) {
          throw new Error(`Motion prompts were authored for ${mismatchedPrompt.video_model}, but ${settings.videoModel} is selected. Regenerate Video Prompts so shot timing and motion match the active model.`)
        }

        let scenesToProcess = videoPrompts.map(vp => {
          const uk = unitKey(vp.scene_number, vp.segment_index ?? 0)
          // selectedImages[uk].url is stripped from localStorage persist (base64 blobs
          // would blow out the storage limit). Fall back to the images store which
          // retains the full URL/base64 via a separate persist entry.
          const selectedImg = selectedImages[uk]
          const imageKey = selectedImg
            ? `${vp.scene_number}_${vp.segment_index ?? 0}_${selectedImg.promptIndex ?? 0}`
            : null
          const image_url = selectedImg?.url
            || (imageKey && images[imageKey]?.url)
            || null
          return {
            // The backend treats scene_number as an opaque job identifier —
            // send the composite unit key so segments track independently
            scene_number: uk,
            video_prompt: vp.full_prompt_string || '',
            negative_prompt: vp.negative_prompt || '',
            motion_prompt_version: vp.motion_prompt_version,
            source_frame_locked: vp.source_frame_locked === true,
            ...videoRequestTimingFields(vp, {}, vp.duration_seconds || 6),
            image_url
          }
        })

        if (resumeFromPending && videoProgress.pending.length > 0) {
          const currentJobs = get().videoJobs
          scenesToProcess = scenesToProcess.filter(s =>
            videoProgress.pending.includes(String(s.scene_number)) &&
            // Don't resubmit units whose job is already in flight — resuming
            // should only restart polling for those, not create duplicate jobs
            currentJobs[s.scene_number]?.status !== 'submitting' &&
            !(currentJobs[s.scene_number]?.jobId && currentJobs[s.scene_number]?.status === 'pending')
          )
        }

        if (scenesToProcess.length === 0) {
          if (resumeFromPending) {
            // Nothing to resubmit, but pending jobs may still be processing —
            // flip state back to running so the poll loop restarts
            set({ generationState: 'running', generationPhase: 'videos' })
            get().logActivity('Resumed — polling in-flight video jobs', 'info')
          }
          return []
        }

        if (usesWindowsVideoBackend(settings)) {
          // scene_number is already the opaque composite unit ID ("12_1")
          // created above. Appending another segment would queue "12_1_0".
          const unitIds = scenesToProcess.map(scene => String(scene.scene_number))
          const allUnitKeys = videoPrompts.map(vp =>
            unitKey(vp.scene_number, vp.segment_index ?? 0)
          )
          set(state => ({
            videoJobs: {
              ...state.videoJobs,
              ...Object.fromEntries(unitIds.map(unitId => [
                unitId,
                {
                  ...state.videoJobs[unitId],
                  jobId: state.videoJobs[unitId]?.jobId || null,
                  provider: WINDOWS_VIDEO_PROVIDER,
                  status: 'queued',
                  url: state.videoJobs[unitId]?.url || null,
                  error: null,
                },
              ])),
            },
            generationState: 'running',
            generationPhase: 'videos',
            ...(!resumeFromPending ? {
              videoProgress: {
                total: allUnitKeys.length,
                completed: allUnitKeys.filter(key => state.videoJobs[key]?.status === 'completed'),
                pending: allUnitKeys.filter(key => state.videoJobs[key]?.status !== 'completed'),
              },
            } : {}),
          }))
          get().logActivity(
            `Queued ${unitIds.length} shot${unitIds.length === 1 ? '' : 's'} for the Windows video worker`,
            'running'
          )
          try {
            // The ContentMachine backend builds broker tasks from the durable
            // project snapshot, so persist selected images/prompts first.
            await get().autoSaveSession()
            const response = await api.generateWindowsVideos(scope.sessionId, unitIds, get().sessionWriteToken)
            if (!isProjectScopeCurrent(get, scope)) return []
            const queueErrors = (response.results || []).filter(result => result?.error)
            if (queueErrors.length > 0) {
              const messages = queueErrors.map(result =>
                `${result.unitId}: ${result.error.message || 'Queue failed'}`
              )
              set(state => ({
                videoJobs: {
                  ...state.videoJobs,
                  ...Object.fromEntries(queueErrors.map(result => [
                    result.unitId,
                    {
                      ...state.videoJobs[result.unitId],
                      provider: WINDOWS_VIDEO_PROVIDER,
                      status: 'failed',
                      error: result.error.message || 'Queue failed',
                    },
                  ])),
                },
              }))
              get().logActivity(`Windows queue rejected ${queueErrors.length} shot${queueErrors.length === 1 ? '' : 's'}: ${messages.join('; ')}`, 'error')
              if (queueErrors.length === response.results.length) throw new Error(messages.join('; '))
            }
            const snapshot = normalizeWindowsVideoStatus(response)
            if (snapshot.tasks.length > 0) {
              set(state => ({
                videoJobs: mergeWindowsTasksIntoJobs(state.videoJobs, snapshot),
                windowsVideoStatus: snapshot,
              }))
            }
            await get().refreshWindowsVideoStatus()
            void get().autoSaveSession()
            return snapshot.tasks
          } catch (error) {
            if (!isProjectScopeCurrent(get, scope)) return []
            set(state => ({
              videoJobs: {
                ...state.videoJobs,
                ...Object.fromEntries(unitIds.map(unitId => [
                  unitId,
                  {
                    ...state.videoJobs[unitId],
                    provider: WINDOWS_VIDEO_PROVIDER,
                    status: 'failed',
                    error: error.message,
                  },
                ])),
              },
              generationState: 'stopped',
              windowsVideoStatus: {
                ...state.windowsVideoStatus,
                error: error.message,
              },
            }))
            get().logActivity(`Windows worker queue failed: ${error.message}`, 'error')
            throw error
          }
        }

        const currentJobs = get().videoJobs
        const activeRequests = activeVideoRequestCount(currentJobs)
        scenesToProcess = takeVideoSubmissionSlots(
          scenesToProcess,
          currentJobs,
          MAX_CONCURRENT_VIDEO_REQUESTS
        )

        if (scenesToProcess.length === 0) {
          // All ten slots are occupied. The poll loop will call this method
          // again as soon as a completed/failed request frees a slot.
          set({ generationState: 'running', generationPhase: 'videos' })
          return []
        }

        const submissionToken = crypto.randomUUID()
        const submittedUnitIds = scenesToProcess.map(scene => String(scene.scene_number))
        const batchLabel = submittedUnitIds.length <= 3
          ? submittedUnitIds.join(', ')
          : `${submittedUnitIds[0]}–${submittedUnitIds[submittedUnitIds.length - 1]}`
        const reservationEntries = Object.fromEntries(scenesToProcess.map(scene => [
          scene.scene_number,
          {
            jobId: null,
            status: 'submitting',
            url: null,
            error: null,
            provider: settings.videoProvider,
            submissionToken,
          },
        ]))

        // Reserve every slot synchronously before the HTTP request starts.
        // Polling and React effects can otherwise observe an empty videoJobs
        // object and submit this exact batch a second time while R2 preparation
        // is still running.
        set(state => {
          const allUnitKeys = videoPrompts.map(vp => unitKey(vp.scene_number, vp.segment_index ?? 0))
          const alreadyCompleted = Object.keys(state.videoJobs)
            .filter(key => state.videoJobs[key]?.status === 'completed')
          return {
            videoJobs: { ...state.videoJobs, ...reservationEntries },
            generationState: 'running',
            generationPhase: 'videos',
            ...(!resumeFromPending ? {
              videoProgress: {
                total: videoPrompts.length,
                completed: alreadyCompleted,
                pending: allUnitKeys.filter(key => !alreadyCompleted.includes(key)),
              },
            } : {}),
          }
        })

        get().logActivity(
          `Submitting ${scenesToProcess.length} video job${scenesToProcess.length > 1 ? 's' : ''} [${batchLabel}] (${activeRequests + scenesToProcess.length}/${MAX_CONCURRENT_VIDEO_REQUESTS} provider slots)...`,
          'running'
        )
        let jobs
        try {
          jobs = await api.generateVideos(
            scenesToProcess, settings.videoProvider, settings.videoResolution, settings.aspectRatio, settings.videoModel, scope.sessionId
          )
        } catch (error) {
          set(state => {
            const videoJobs = { ...state.videoJobs }
            for (const scene of scenesToProcess) {
              if (videoJobs[scene.scene_number]?.submissionToken === submissionToken) {
                delete videoJobs[scene.scene_number]
              }
            }
            return { videoJobs, generationState: 'stopped' }
          })
          get().logActivity(
            `Video batch [${batchLabel}] failed before provider acceptance: ${error.message}`,
            'error'
          )
          throw error
        }
        if (!isProjectScopeCurrent(get, scope)) return []
        {
          const submitted = jobs.filter(j => j.job_id).length
          const failed = jobs.length - submitted
          const reused = jobs.filter(j => j.job_id && j.reused).length
          get().logActivity(
            failed > 0
              ? `Batch [${batchLabel}]: ${submitted} accepted, ${failed} rejected`
              : reused > 0
                ? `Batch [${batchLabel}]: ${submitted} provider jobs active (${reused} safely recovered)`
                : `Batch [${batchLabel}]: ${submitted} provider jobs accepted — generating...`,
            failed > 0 ? 'error' : 'success'
          )
          jobs.filter(j => !j.job_id).forEach(j =>
            get().logActivity(`Scene ${j.scene_number} submit failed: ${j.error || 'unknown error'}`, 'error')
          )
        }

        // Use functional updater so we merge into the *current* videoJobs, not a
        // stale snapshot captured before the async API call
        const newEntries = {}
        jobs.forEach(job => {
          newEntries[job.scene_number] = job.job_id
            ? {
              jobId: job.job_id,
              status: job.status,
              url: null,
              error: job.error || null,
              provider: settings.videoProvider,
              falEndpoint: job.fal_endpoint || null,
              submissionToken: null,
            }
            : {
              jobId: null,
              status: 'failed',
              url: null,
              error: job.error || 'Video provider rejected the submission',
              provider: settings.videoProvider,
              submissionToken: null,
            }
        })

        set(state => {
          const videoJobs = { ...state.videoJobs }
          for (const [unitId, entry] of Object.entries(newEntries)) {
            if (videoJobs[unitId]?.submissionToken === submissionToken) {
              videoJobs[unitId] = entry
            }
          }
          return {
            videoJobs,
            generationState: 'running',
            generationPhase: 'videos',
          }
        })
        void get().autoSaveSession()

        return jobs
      },

      // Restore generationState/Phase after a page reload so polling useEffect fires
      resumeVideoPolling: () => {
        set({ generationState: 'running', generationPhase: 'videos' })
      },

      refreshWindowsVideoStatus: async () => {
        const scope = captureProjectScope(get)
        try {
          const response = await api.getWindowsVideoStatus(scope.sessionId, get().sessionWriteToken)
          if (!isProjectScopeCurrent(get, scope)) return null
          const snapshot = normalizeWindowsVideoStatus(response)
          const previousJobs = get().videoJobs
          const allUnitIds = get().videoPrompts.map(prompt =>
            unitKey(prompt.scene_number, prompt.segment_index ?? 0)
          )
          const mergedJobs = mergeWindowsTasksIntoJobs(previousJobs, snapshot)
          const completed = allUnitIds.filter(unitId => mergedJobs[unitId]?.status === 'completed')
          const pending = allUnitIds.filter(unitId => !completed.includes(unitId))
          const hasActiveTasks = snapshot.tasks.some(task =>
            isWindowsVideoActive(task.status)
          )
          const newlyTerminal = snapshot.tasks.some(task => {
            const before = previousJobs[task.unitId]?.status
            return ['completed', 'failed', 'canceled', 'superseded'].includes(task.status)
              && before !== task.status
          })

          set(state => ({
            videoJobs: mergedJobs,
            windowsVideoStatus: snapshot,
            videoProgress: {
              total: allUnitIds.length,
              completed,
              pending,
            },
            generationPhase: pending.length > 0 ? 'videos' : state.generationPhase,
            generationState: snapshot.paused
              ? 'paused'
              : hasActiveTasks
                ? 'running'
                : pending.length === 0 && allUnitIds.length > 0
                  ? 'stopped'
                  : state.generationState,
          }))

          if (newlyTerminal) void get().autoSaveSession()
          return snapshot
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          set(state => ({
            windowsVideoStatus: {
              ...state.windowsVideoStatus,
              error: error.message,
              updatedAt: new Date().toISOString(),
            },
          }))
          return null
        }
      },

      pauseWindowsVideoGeneration: async () => {
        const scope = captureProjectScope(get)
        const response = await api.pauseWindowsVideos(scope.sessionId, get().sessionWriteToken)
        if (!isProjectScopeCurrent(get, scope)) return null
        const snapshot = normalizeWindowsVideoStatus(response)
        set(state => ({
          generationState: 'paused',
          generationPhase: 'videos',
          windowsVideoStatus: snapshot.tasks.length
            ? snapshot
            : { ...state.windowsVideoStatus, ...snapshot, paused: true },
          videoJobs: snapshot.tasks.length
            ? mergeWindowsTasksIntoJobs(state.videoJobs, snapshot)
            : state.videoJobs,
        }))
        get().logActivity('Windows video queue paused; active worker operations will stop safely', 'info')
        void get().autoSaveSession()
        return snapshot
      },

      resumeWindowsVideoGeneration: async () => {
        const scope = captureProjectScope(get)
        const response = await api.resumeWindowsVideos(scope.sessionId, get().sessionWriteToken)
        if (!isProjectScopeCurrent(get, scope)) return null
        const snapshot = normalizeWindowsVideoStatus(response)
        set(state => ({
          generationState: 'running',
          generationPhase: 'videos',
          windowsVideoStatus: snapshot.tasks.length
            ? snapshot
            : { ...state.windowsVideoStatus, ...snapshot, paused: false },
          videoJobs: snapshot.tasks.length
            ? mergeWindowsTasksIntoJobs(state.videoJobs, snapshot)
            : state.videoJobs,
        }))
        get().logActivity('Windows video queue resumed', 'info')
        await get().refreshWindowsVideoStatus()
        return snapshot
      },

      retryMissingWindowsVideos: async (unitIds) => {
        const scope = captureProjectScope(get)
        const allUnitIds = get().videoPrompts.map(prompt =>
          unitKey(prompt.scene_number, prompt.segment_index ?? 0)
        )
        const requested = (unitIds?.length ? unitIds : allUnitIds.filter(unitId =>
          get().videoJobs[unitId]?.status !== 'completed'
        )).map(String)
        if (requested.length === 0) return null
        const response = await api.retryMissingWindowsVideos(scope.sessionId, requested, get().sessionWriteToken)
        if (!isProjectScopeCurrent(get, scope)) return null
        const canonicalNoMissing = Array.isArray(response?.missing)
          && response.missing.length === 0
        const queueErrors = (response.results || []).filter(result => result?.error)
        const queuedResults = (response.results || []).filter(result => !result?.error)
        if (queueErrors.length > 0) {
          const messages = queueErrors.map(result =>
            `${result.unitId}: ${result.error.message || 'Queue failed'}`
          )
          set(state => ({
            videoJobs: {
              ...state.videoJobs,
              ...Object.fromEntries(queueErrors.map(result => [
                result.unitId,
                {
                  ...state.videoJobs[result.unitId],
                  provider: WINDOWS_VIDEO_PROVIDER,
                  status: 'failed',
                  error: result.error.message || 'Queue failed',
                },
              ])),
            },
          }))
          get().logActivity(`Windows retry rejected ${queueErrors.length} shot${queueErrors.length === 1 ? '' : 's'}: ${messages.join('; ')}`, 'error')
          if (queuedResults.length === 0) throw new Error(messages.join('; '))
        }
        const snapshot = normalizeWindowsVideoStatus(response)
        set(state => ({
          generationState: 'running',
          generationPhase: 'videos',
          windowsVideoStatus: snapshot.tasks.length
            ? snapshot
            : { ...state.windowsVideoStatus, paused: false, error: null },
          videoJobs: snapshot.tasks.length
            ? mergeWindowsTasksIntoJobs(state.videoJobs, snapshot)
            : {
                ...state.videoJobs,
                ...Object.fromEntries(requested.map(unitId => [
                  unitId,
                  {
                    ...state.videoJobs[unitId],
                    provider: WINDOWS_VIDEO_PROVIDER,
                    status: 'queued',
                    error: null,
                  },
                ])),
              },
        }))
        get().logActivity(`Retrying ${requested.length} missing Windows video${requested.length === 1 ? '' : 's'}`, 'running')
        await get().refreshWindowsVideoStatus()
        return canonicalNoMissing ? { ...snapshot, noMissing: true } : snapshot
      },

      cancelWindowsVideoGeneration: async (unitIds) => {
        const scope = captureProjectScope(get)
        const requested = (unitIds?.length
          ? unitIds
          : Object.entries(get().videoJobs)
            .filter(([, job]) => job.provider === WINDOWS_VIDEO_PROVIDER && isWindowsVideoActive(job.status))
            .map(([unitId]) => unitId)
        ).map(String)
        const response = await api.cancelWindowsVideos(scope.sessionId, requested, get().sessionWriteToken)
        if (!isProjectScopeCurrent(get, scope)) return null
        const snapshot = normalizeWindowsVideoStatus(response)
        set(state => ({
          generationState: 'stopped',
          generationPhase: 'videos',
          windowsVideoStatus: snapshot.tasks.length
            ? snapshot
            : { ...state.windowsVideoStatus, paused: false },
          videoJobs: snapshot.tasks.length
            ? mergeWindowsTasksIntoJobs(state.videoJobs, snapshot)
            : {
                ...state.videoJobs,
                ...Object.fromEntries(requested.map(unitId => [
                  unitId,
                  {
                    ...state.videoJobs[unitId],
                    provider: WINDOWS_VIDEO_PROVIDER,
                    status: 'canceled',
                    error: null,
                  },
                ])),
              },
        }))
        get().logActivity(`Canceled ${requested.length} Windows video task${requested.length === 1 ? '' : 's'}`, 'info')
        void get().autoSaveSession()
        return snapshot
      },

      attachWindowsVideo: async (unitId, file) => {
        if (
          !file
          || (file.type && file.type !== 'video/mp4')
          || !String(file.name || '').toLowerCase().endsWith('.mp4')
        ) {
          throw new Error('Choose an MP4 video file')
        }
        const scope = captureProjectScope(get)
        const response = await api.attachWindowsVideo(scope.sessionId, String(unitId), file, get().sessionWriteToken)
        if (!isProjectScopeCurrent(get, scope)) return null
        const snapshot = normalizeWindowsVideoStatus(response)
        if (snapshot.tasks.length > 0) {
          set(state => ({
            videoJobs: mergeWindowsTasksIntoJobs(state.videoJobs, snapshot),
            windowsVideoStatus: snapshot,
          }))
        }
        await get().refreshWindowsVideoStatus()
        void get().autoSaveSession()
        return response
      },

      resumeVideoGeneration: async () => {
        const { videoPrompts, videoJobs, settings } = get()
        if (usesWindowsVideoBackend(settings)) {
          return get().resumeWindowsVideoGeneration()
        }
        if (videoPrompts.length > 0) {
          // Rebuild progress from the source-of-truth jobs. Older runs could
          // display jobless cards as "generating" even though their progress
          // metadata had drifted; those units must return to the real queue.
          const allUnitIds = videoPrompts.map(prompt =>
            unitKey(prompt.scene_number, prompt.segment_index ?? 0)
          )
          const completed = allUnitIds.filter(unitId =>
            ['completed', 'failed'].includes(videoJobs[unitId]?.status)
          )
          const pending = allUnitIds.filter(unitId =>
            !['completed', 'failed'].includes(videoJobs[unitId]?.status)
          )
          if (pending.length === 0) return
          set({
            videoProgress: {
              total: allUnitIds.length,
              completed,
              pending,
            },
            generationState: 'running',
            generationPhase: 'videos',
          })
          await get().startVideoGeneration(videoPrompts, true)
        }
      },

      // unitId: `${scene}_${segment}` composite key
      pollVideoStatus: async (unitId) => {
        const scope = captureProjectScope(get)
        const { videoJobs } = get()
        const job = videoJobs[unitId]
        if (job?.provider === WINDOWS_VIDEO_PROVIDER) {
          const snapshot = await get().refreshWindowsVideoStatus()
          return snapshot?.tasks.find(task => task.unitId === String(unitId))
            || get().videoJobs[unitId]
            || null
        }
        if (!job?.jobId) return null

        const [sceneNum, segIdx] = String(unitId).split('_').map(Number)
        const vpForLabel = get().videoPrompts.find(v =>
          v.scene_number === sceneNum && (v.segment_index ?? 0) === (segIdx || 0)
        )
        const label = (vpForLabel?.segment_count ?? 1) > 1
          ? `Scene ${sceneNum} · shot ${(segIdx || 0) + 1}/${vpForLabel.segment_count}`
          : `Scene ${sceneNum}`

        try {
          const result = await api.getVideoStatus(
            job.jobId,
            job.provider || 'fal',
            job.falEndpoint,
            scope.sessionId
          )
          if (!isProjectScopeCurrent(get, scope)) return null

          set((state) => ({
            videoJobs: {
              ...state.videoJobs,
              [unitId]: {
                ...state.videoJobs[unitId],
                status: result.status,
                url: result.url || state.videoJobs[unitId]?.url,
                error: result.error || null
              }
            }
          }))

          if (result.status === 'completed' || result.status === 'failed') {
            get().logActivity(
              result.status === 'completed'
                ? `${label} video complete ✓`
                : `${label} video failed: ${result.error || 'unknown error'}`,
              result.status === 'completed' ? 'success' : 'error'
            )
            set(state => {
              const keyStr = String(unitId)
              // Track both completed AND failed in the completed set so that
              // progress.completed.length + progress.pending.length === progress.total
              // is always true and the progress bar reaches 100% even with failures.
              const newCompleted = [...new Set([...state.videoProgress.completed, keyStr])]
              const newPending = state.videoProgress.pending.filter(p => p !== keyStr)
              return {
                videoProgress: {
                  ...state.videoProgress,
                  completed: newCompleted,
                  pending: newPending
                }
              }
            })
            get().autoSaveSession()  // save when each video finishes
          }

          return result
        } catch (error) {
          console.error('Poll error:', error)
          return { status: 'error', error: error.message }
        }
      },

      selectVideo: (unitId) => {
        const { videoJobs, videoPrompts } = get()
        const job = videoJobs[unitId]
        const [sceneNum, segIdx] = String(unitId).split('_').map(Number)
        const vp = videoPrompts.find(v =>
          v.scene_number === sceneNum && (v.segment_index ?? 0) === (segIdx || 0)
        )

        if (job?.url) {
          set((state) => {
            const selectedVideos = {
              ...state.selectedVideos,
              [unitId]: {
                url: job.url,
                prompt: vp?.full_prompt_string || '',
                duration: vp?.duration_seconds,
                target_duration: selectedVideoTargetDuration(vp),
                playback_rate: vp?.playback_rate ?? 1,
                scene_number: sceneNum,
                segment_index: segIdx || 0,
              }
            }
            const timelineItems = state.timeline?.built
              ? reconcileTimelineVideoSelections(state.timeline.items, selectedVideos)
              : state.timeline?.items
            return {
              selectedVideos,
              ...(state.timeline?.built && timelineItems !== state.timeline.items ? {
                timeline: { ...state.timeline, items: timelineItems },
                timelineDirty: true,
              } : {}),
            }
          })
          void get().autoSaveSession()
        }
      },

      deselectVideo: (unitId) => {
        set((state) => {
          const { [unitId]: _, ...rest } = state.selectedVideos
          return { selectedVideos: rest }
        })
      },

      // Select a specific historical video version (url) as the active selected video
      selectVideoVersion: (unitId, url) => {
        const { videoPrompts } = get()
        const [sceneNum, segIdx] = String(unitId).split('_').map(Number)
        const vp = videoPrompts.find(v =>
          v.scene_number === sceneNum && (v.segment_index ?? 0) === (segIdx || 0)
        )
        if (url) {
          set((state) => {
            const selectedVideos = {
              ...state.selectedVideos,
              [unitId]: {
                url,
                prompt: vp?.full_prompt_string || '',
                duration: vp?.duration_seconds,
                target_duration: selectedVideoTargetDuration(vp),
                playback_rate: vp?.playback_rate ?? 1,
                scene_number: sceneNum,
                segment_index: segIdx || 0,
              }
            }
            const timelineItems = state.timeline?.built
              ? reconcileTimelineVideoSelections(state.timeline.items, selectedVideos)
              : state.timeline?.items
            return {
              selectedVideos,
              ...(state.timeline?.built && timelineItems !== state.timeline.items ? {
                timeline: { ...state.timeline, items: timelineItems },
                timelineDirty: true,
              } : {}),
            }
          })
          void get().autoSaveSession()
        }
      },

      regenerateVideo: async (unitId, newPrompt) => {
        const scope = captureProjectScope(get)
        const { selectedImages, images, videoPrompts, settings } = get()
        if (
          !usesWindowsVideoBackend(settings)
          && activeVideoRequestCount(get().videoJobs) >= MAX_CONCURRENT_VIDEO_REQUESTS
        ) {
          throw new Error(`All ${MAX_CONCURRENT_VIDEO_REQUESTS} video provider slots are currently in use. Try again when one finishes.`)
        }
        const [sceneNum, segIdx] = String(unitId).split('_').map(Number)
        const vp = videoPrompts.find(v =>
          v.scene_number === sceneNum && (v.segment_index ?? 0) === (segIdx || 0)
        )
        if (!vp) {
          throw new Error('This shot has no video prompt. Regenerate Video Prompts first.')
        }
        if (
          !usesWindowsVideoBackend(settings)
          && vp.motion_prompt_version !== 'seedance-2-0-v1'
        ) {
          throw new Error('Regenerate this scene\'s Video Prompt first so the Seedance identity and style locks are applied.')
        }
        if (!isPromptCompatibleWithVideoSettings(vp, settings)) {
          throw new Error(`This prompt targets ${vp.video_model}; regenerate it for ${settings.videoModel} before creating another video.`)
        }
        const prompt = newPrompt
          ? usesWindowsVideoBackend(settings)
            ? newPrompt.trim()
            : preserveProtectedMotionPrompt(vp?.full_prompt_string || '', newPrompt)
          : vp?.full_prompt_string || ''

        if (usesWindowsVideoBackend(settings)) {
          set(state => {
            const oldJob = state.videoJobs[unitId]
            const prevHistory = state.videoHistory[unitId] || []
            const newHistory = oldJob?.url
              ? [...prevHistory, { url: oldJob.url, prompt: vp?.full_prompt_string || '' }]
              : prevHistory
            return {
              videoHistory: { ...state.videoHistory, [unitId]: newHistory },
              videoPrompts: state.videoPrompts.map(candidate =>
                candidate.scene_number === sceneNum
                  && (candidate.segment_index ?? 0) === (segIdx || 0)
                  && prompt
                  ? { ...candidate, full_prompt_string: prompt }
                  : candidate
              ),
              videoJobs: {
                ...state.videoJobs,
                [unitId]: {
                  ...oldJob,
                  provider: WINDOWS_VIDEO_PROVIDER,
                  status: 'queued',
                  url: null,
                  error: null,
                },
              },
              generationState: 'running',
              generationPhase: 'videos',
            }
          })
          let response
          try {
            response = await api.regenerateWindowsVideo(
              scope.sessionId,
              unitId,
              prompt,
              get().sessionWriteToken,
            )
          } catch (error) {
            const payload = error.response?.data || {}
            const code = payload.code || 'WINDOWS_REGENERATE_FAILED'
            const message = payload.message || payload.error?.message || error.message || 'Windows regeneration failed'
            if (isProjectScopeCurrent(get, scope)) {
              set(state => ({
                generationState: 'stopped',
                videoJobs: {
                  ...state.videoJobs,
                  [unitId]: {
                    ...state.videoJobs[unitId],
                    provider: WINDOWS_VIDEO_PROVIDER,
                    status: 'failed',
                    url: null,
                    error: message,
                    errorCode: code,
                    errorRetryable: payload.retryable !== false,
                  },
                },
              }))
              get().logActivity(`Windows retry ${unitId} failed [${code}]: ${message}`, 'error')
            }
            const surfaced = new Error(`[${code}] ${message}`)
            surfaced.code = code
            surfaced.cause = error
            throw surfaced
          }
          if (!isProjectScopeCurrent(get, scope)) return null
          const generationRevision = response?.result?.generationRevision
          const snapshot = normalizeWindowsVideoStatus(response)
          set(state => ({
            generationState: 'running',
            generationPhase: 'videos',
            windowsVideoStatus: snapshot.tasks.length
              ? snapshot
              : { ...state.windowsVideoStatus, paused: false, error: null },
            videoJobs: snapshot.tasks.length
              ? mergeWindowsTasksIntoJobs(state.videoJobs, snapshot)
              : state.videoJobs,
            videoPrompts: state.videoPrompts.map(candidate =>
              candidate.scene_number === sceneNum
                && (candidate.segment_index ?? 0) === (segIdx || 0)
                && generationRevision
                ? { ...candidate, generation_revision: generationRevision }
                : candidate
            ),
          }))
          get().logActivity(`Fresh Windows video queued for ${unitId}`, 'running')
          return snapshot
        }

        // selectedImages[unitId].url is stripped from localStorage persist —
        // fall back to the images store which holds the full URL/base64
        const selectedImg = selectedImages[unitId]
        const imageKey = selectedImg
          ? `${sceneNum}_${segIdx || 0}_${selectedImg.promptIndex ?? 0}`
          : null
        const imageUrl = selectedImg?.url
          || (imageKey && images[imageKey]?.url)
          || null

        // Push the current completed video into history before overwriting the job
        set((state) => {
          const oldJob = state.videoJobs[unitId]
          const prevHistory = state.videoHistory[unitId] || []
          const newHistory = oldJob?.url
            ? [...prevHistory, { url: oldJob.url, prompt: vp?.full_prompt_string || '' }]
            : prevHistory
          return {
            videoHistory: { ...state.videoHistory, [unitId]: newHistory },
            videoJobs: {
              ...state.videoJobs,
              [unitId]: {
                jobId: null,
                status: 'submitting',
                url: null,
                error: null,
                provider: settings.videoProvider
              }
            }
          }
        })

        try {
          const result = await api.regenerateVideo(
            unitId,
            prompt,
            vp?.duration_seconds || 6,
            imageUrl,
            settings.videoProvider,
            settings.videoResolution,
            settings.aspectRatio,
            settings.videoModel,
            vp?.negative_prompt || '',
            vp?.motion_prompt_version,
            vp?.source_frame_locked === true,
            scope.sessionId,
            {
              target_duration: vp?.target_duration,
              action_duration_seconds: vp?.action_duration_seconds
                ?? vp?.editorial_timing?.action_duration_seconds,
              editorial_duration_seconds: vp?.editorial_duration_seconds,
              clip_duration: vp?.clip_duration ?? vp?.duration_seconds,
              playback_rate: vp?.playback_rate,
            }
          )
          if (!isProjectScopeCurrent(get, scope)) return null

          set((state) => {
            // Save altered prompt back into videoPrompts so it round-trips on export
            const updatedVideoPrompts = state.videoPrompts.map(v =>
              v.scene_number === sceneNum && (v.segment_index ?? 0) === (segIdx || 0) && prompt
                ? { ...v, full_prompt_string: prompt }
                : v
            )
            return {
              videoJobs: {
                ...state.videoJobs,
                [unitId]: {
                  jobId: result.job_id,
                  status: 'pending',
                  url: null,
                  error: null,
                  provider: settings.videoProvider,
                  falEndpoint: result.fal_endpoint || null,
                }
              },
              videoPrompts: updatedVideoPrompts,
              // Ensure polling useEffect fires
              generationState: 'running',
              generationPhase: 'videos'
            }
          })
          get().logActivity(`Scene ${sceneNum}${segIdx ? ` · shot ${segIdx + 1}` : ''} submitted as a fresh provider attempt`, 'info')
          get().autoSaveSession()

          return result
        } catch (error) {
          const response = error?.response?.data
          const backendDetails = Array.isArray(response?.issues)
            ? response.issues.join('; ')
            : Array.isArray(response?.scenes)
              ? response.scenes
                .flatMap(scene => (scene.issues || []).map(issue => `${scene.scene_number}: ${issue}`))
                .join('; ')
              : ''
          const failureMessage = [
            response?.message,
            backendDetails,
          ].filter(Boolean).join(' ') || error.message
          set((state) => ({
            videoJobs: {
              ...state.videoJobs,
              [unitId]: {
                ...state.videoJobs[unitId],
                status: 'failed',
                error: failureMessage
              }
            }
          }))
          throw new Error(failureMessage)
        }
      },

      // ─── TTS Script ───────────────────────────────────────────────────────
      fetchTtsScript: async () => {
        const { selectedStory, scenePlan, settings } = get()
        if (!selectedStory || !scenePlan) return
        const scope = captureProjectScope(get)

        set({
          ttsLoading: true,
          ttsError: null,
          ttsScript: null,
          expressiveScript: null,
          audio: { sceneAudio: {}, sfxAudio: {}, fullAudio: null },
          sceneSegments: {},
          scenes: [],
          images: {},
          imageHistory: {},
          selectedImages: {},
          imageBatches: [],
          imageProgress: { total: 0, completed: [], pending: [] },
          videoPrompts: [],
          videoBatches: [],
          videoJobs: {},
          videoHistory: {},
          selectedVideos: {},
          windowsVideoStatus: emptyWindowsVideoStatus(),
          videoProgress: { total: 0, completed: [], pending: [] },
          timeline: { items: [], sceneWindows: {}, directorPlan: null, chapters: null, built: false },
          timelineDirty: false,
          timelineHistory: { past: [], future: [] },
          renderJob: null,
          youtubeMetadata: null,
          selectedTitle: null,
          thumbnailPrompts: [],
          thumbnails: {},
          thumbnailHistory: {},
          selectedThumbnail: null,
        })
        try {
          const result = await api.generateTtsScript(
            selectedStory,
            scenePlan,
            settings.claudeProvider,
            settings.claudeModel,
            get().customPrompts.ttsScript,
            {
              chaptersEnabled: !!settings.chaptersEnabled,
              trailerEnabled: !!settings.trailerIntroEnabled,
            }
          )
          if (!isProjectScopeCurrent(get, scope)) return null
          set({
            ttsScript: result,
            ttsLoading: false,
            expressiveScript: null,
          })
          return result
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          set({ ttsLoading: false, ttsError: error.message })
          throw error
        }
      },

      retryTtsScript: () => {
        set({ ttsError: null })
        return get().fetchTtsScript()
      },

      // ─── Metadata ─────────────────────────────────────────────────────────
      fetchMetadata: async () => {
        const scope = captureProjectScope(get)
        const { selectedStory, scenePlan, ttsScript, settings } = get()
        if (!selectedStory) return

        set({
          metadataLoading: true,
          metadataError: null,
          youtubeMetadata: null,
          selectedTitle: null,
        })
        try {
          const metadata = await api.generateMetadata(
            selectedStory, scenePlan, ttsScript, settings.claudeProvider, settings.claudeModel, get().customPrompts.metadata
          )
          if (!isProjectScopeCurrent(get, scope)) return null
          set({ youtubeMetadata: metadata, metadataLoading: false })
          return metadata
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          set({ metadataLoading: false, metadataError: error.message })
          throw error
        }
      },

      retryMetadata: () => {
        set({ metadataError: null })
        return get().fetchMetadata()
      },

      setSelectedTitle: (title) => set({ selectedTitle: title }),

      // ─── Thumbnails ───────────────────────────────────────────────────────
      fetchThumbnailPrompts: async () => {
        const scope = captureProjectScope(get)
        const { selectedStory, selectedTitle, youtubeMetadata, settings } = get()
        // Fall back to story title when metadata was skipped
        const title = selectedTitle || youtubeMetadata?.titles?.[0] || selectedStory?.title
        if (!selectedStory || !title) return

        set({
          thumbnailLoading: true,
          thumbnailPrompts: [],
          thumbnails: {},
          thumbnailHistory: {},
          selectedThumbnail: null,
        })
        try {
          const result = await api.generateThumbnailPrompts(
            selectedStory, title, youtubeMetadata?.thumbnail_prompt,
            settings.claudeProvider, settings.claudeModel, get().customPrompts.thumbnailPrompts
          )
          if (!isProjectScopeCurrent(get, scope)) return null
          set({ thumbnailPrompts: result.prompts || [], thumbnailLoading: false })
          return result.prompts || []
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          set({ thumbnailLoading: false })
          throw error
        }
      },

      generateThumbnails: async (provider) => {
        const scope = captureProjectScope(get)
        const { thumbnailPrompts, settings } = get()
        if (!thumbnailPrompts.length) return

        const loading = {}
        thumbnailPrompts.forEach((_, i) => {
          loading[i] = { url: null, loading: true, error: null }
        })
        set({ thumbnails: loading })

        try {
          const results = await api.generateThumbnails(thumbnailPrompts, provider, settings.aspectRatio)
          if (!isProjectScopeCurrent(get, scope)) return null
          const newThumbnails = {}
          results.forEach((result, i) => {
            newThumbnails[i] = {
              url: result.url || null,
              prompt: result.prompt || thumbnailPrompts[i],
              error: result.error || null,
              loading: false
            }
          })
          set({ thumbnails: newThumbnails })
          get().autoSaveSession()  // save after thumbnails generated
        } catch (error) {
          // Mark all as failed
          const failed = {}
          thumbnailPrompts.forEach((_, i) => {
            failed[i] = { url: null, prompt: thumbnailPrompts[i], error: error.message, loading: false }
          })
          set({ thumbnails: failed })
          throw error
        }
      },

      regenerateThumbnail: async (index, newPrompt, provider) => {
        const scope = captureProjectScope(get)
        // Push old thumbnail into history before marking loading
        set((state) => {
          const old = state.thumbnails[index]
          const prevHistory = state.thumbnailHistory[index] || []
          const newHistory = old?.url
            ? [...prevHistory, { url: old.url, prompt: old.prompt || '' }]
            : prevHistory
          return {
            thumbnailHistory: { ...state.thumbnailHistory, [index]: newHistory },
            thumbnails: {
              ...state.thumbnails,
              [index]: { ...old, loading: true, error: null }
            }
          }
        })

        try {
          const { thumbnails, thumbnailPrompts, settings } = get()
          const prompt = newPrompt || thumbnails[index]?.prompt || thumbnailPrompts[index]
          const result = await api.regenerateThumbnail(prompt, provider, settings.aspectRatio)
          if (!isProjectScopeCurrent(get, scope)) return null

          set((state) => ({
            thumbnails: {
              ...state.thumbnails,
              [index]: { url: result.url, prompt, error: null, loading: false }
            }
          }))
        } catch (error) {
          set((state) => ({
            thumbnails: {
              ...state.thumbnails,
              [index]: { ...state.thumbnails[index], error: error.message, loading: false }
            }
          }))
          throw error
        }
      },

      selectThumbnail: (index) => {
        const { thumbnails, selectedThumbnail } = get()
        const thumb = thumbnails[index]
        if (!thumb?.url) return
        // Toggle: if already selected remove it, otherwise add it
        const current = Array.isArray(selectedThumbnail) ? selectedThumbnail : (selectedThumbnail ? [selectedThumbnail] : [])
        const exists = current.find(t => t.index === index)
        if (exists) {
          set({ selectedThumbnail: current.filter(t => t.index !== index) })
        } else {
          set({ selectedThumbnail: [...current, { url: thumb.url, prompt: thumb.prompt, index }] })
        }
      },

      // ─── Metadata editing ─────────────────────────────────────────────────
      updateDescription: (description) => {
        const { youtubeMetadata } = get()
        if (youtubeMetadata) {
          set({ youtubeMetadata: { ...youtubeMetadata, description } })
        }
      },

      updateTags: (tags) => {
        const { youtubeMetadata } = get()
        if (youtubeMetadata) {
          set({ youtubeMetadata: { ...youtubeMetadata, tags } })
        }
      },

      updateChapters: (chapters) => {
        const { youtubeMetadata } = get()
        if (youtubeMetadata) {
          set({ youtubeMetadata: { ...youtubeMetadata, chapters } })
        }
      },

      // ─── Audio ────────────────────────────────────────────────────────────
      setSceneAudio: (sceneId, data) => set((state) => ({
        audio: {
          ...state.audio,
          sceneAudio: { ...state.audio.sceneAudio, [sceneId]: data }
        }
      })),

      // Extra Claude pass that rewrites the narration with expressive audio
      // tags (pauses, emotion, emphasis) for advanced TTS models
      fetchExpressiveScript: async () => {
        const scope = captureProjectScope(get)
        const { ttsScript, settings } = get()
        if (!ttsScript?.scene_breakdown) return null

        set({ expressiveLoading: true, expressiveError: null })
        get().logActivity('Writing expressive narration script (audio tags)...', 'running')
        try {
          const result = await api.generateExpressiveScript(
            ttsScript.narration_sequence || ttsScript.scene_breakdown,
            settings.claudeProvider,
            settings.claudeModel
          )
          if (!isProjectScopeCurrent(get, scope)) return null
          set({ expressiveScript: result, expressiveLoading: false })
          get().logActivity('Expressive script ready ✓', 'success')
          return result
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          set({ expressiveLoading: false, expressiveError: error.message })
          get().logActivity(`Expressive script failed: ${error.message}`, 'error')
          throw error
        }
      },

      // Split a full narration recording into per-scene audio using local
      // Whisper alignment, then assign each slice to its scene.
      // The backend stores the recording + slices as FILES in the session
      // folder and returns URLs — nothing heavy ever sits in app state.
      splitFullAudio: async (audioDataUri, meta = {}) => {
        const scope = captureProjectScope(get)
        const { ttsScript } = get()
        if (!ttsScript?.scene_breakdown) throw new Error('No narration script — generate the script first')

        const narrationUnits = ttsScript.narration_sequence || ttsScript.scene_breakdown
        const sceneScripts = narrationUnits.map(unit => ({
          scene_id: unit.unit_id || unit.scene_id,
          kind: unit.cinema_type || 'scene',
          text: (unit.lines || []).filter(line => !line.startsWith('[')).join(' ')
        }))

        set({ whisperStatus: 'transcribing', whisperError: null })
        get().logActivity('Transcribing full audio with Whisper (local)...', 'running')
        try {
          const result = await api.splitFullAudio(audioDataUri, sceneScripts, getSessionId())
          if (!isProjectScopeCurrent(get, scope)) return null
          const slices = result.scenes || []
          get().logActivity(`Whisper alignment done — assigning ${slices.length} scene audio slices...`, 'running')

          for (const slice of slices) {
            const breakdown = narrationUnits.find(unit => (unit.unit_id || unit.scene_id) === slice.scene_id)
            const parts = [
              ...((breakdown?.lines || []).filter(l => l.startsWith('[')).map(l => ({ type: 'cue', content: l }))),
              {
                type: 'audio',
                content: slice.url,   // small server URL, never base64
                text: sceneScripts.find(unit => unit.scene_id === slice.scene_id)?.text || '',
                manual: true,
                whisper: true,
                cinemaType: breakdown?.cinema_type || 'scene',
              },
            ]
            get().setSceneAudio(slice.scene_id, {
              parts,
              loading: false,
              durationSeconds: slice.durationSeconds,
              startSeconds: slice.startSeconds,
              endSeconds: slice.endSeconds,
              speechStartSeconds: slice.speechStartSeconds,
              speechEndSeconds: slice.speechEndSeconds,
              matchRatio: slice.matchRatio,
              lowConfidence: slice.lowConfidence,
              wordTimings: slice.wordTimings || [],
            })
          }

          get().setFullAudio({
            url: result.fullAudioUrl,
            name: meta.name || 'full-audio',
            durationSeconds: meta.durationSeconds ?? result.totalDuration ?? null,
          })

          set({ whisperStatus: 'done' })
          get().logActivity(`Full audio split into ${slices.length} scenes ✓`, 'success')
          get().autoSaveSession()
          return slices
        } catch (error) {
          set({ whisperStatus: 'error', whisperError: error.message })
          get().logActivity(`Whisper split failed: ${error.message}`, 'error')
          throw error
        }
      },

      // Stage 1 of the professional full-audio workflow. The immutable source
      // is stored and audited, but existing scene slices remain untouched until
      // the user explicitly approves a source or repaired version.
      analyzeFullAudio: async (audioDataUri, meta = {}) => {
        const scope = captureProjectScope(get)
        const { ttsScript } = get()
        if (!ttsScript?.scene_breakdown) throw new Error('No narration script — generate the script first')
        const narrationUnits = ttsScript.narration_sequence || ttsScript.scene_breakdown
        const sceneScripts = narrationUnits.map(unit => ({
          scene_id: unit.unit_id || unit.scene_id,
          kind: unit.cinema_type || 'scene',
          text: (unit.lines || []).filter(line => !line.startsWith('[')).join(' '),
        }))
        set((state) => ({
          whisperStatus: 'auditing',
          whisperError: null,
          audio: {
            ...state.audio,
            fullAudio: {
              name: meta.name || 'full-audio',
              durationSeconds: meta.durationSeconds || null,
              status: 'auditing',
              previousSceneAudioCount: Object.keys(state.audio.sceneAudio || {}).length,
            },
          },
        }))
        get().logActivity('Auditing full narration before scene splitting...', 'running')
        try {
          const result = await api.auditFullAudio(
            audioDataUri,
            sceneScripts,
            getSessionId(),
            meta.name || 'full-audio',
          )
          if (!isProjectScopeCurrent(get, scope)) return null
          const audit = result.audit
          const status = audit.summary?.overallStatus === 'clean' ? 'ready' : 'review-required'
          set((state) => ({
            whisperStatus: 'review',
            audio: {
              ...state.audio,
              fullAudio: {
                url: audit.sourceUrl,
                sourceUrl: audit.sourceUrl,
                name: meta.name || audit.originalName || 'full-audio',
                durationSeconds: audit.durationSeconds,
                auditId: audit.auditId,
                status,
                audit,
                previousSceneAudioCount: Object.keys(state.audio.sceneAudio || {}).length,
              },
            },
          }))
          get().logActivity(
            audit.summary?.issueCount
              ? `Audio audit found ${audit.summary.issueCount} item${audit.summary.issueCount === 1 ? '' : 's'} to review`
              : 'Audio passed the quality audit ✓',
            audit.summary?.issueCount ? 'warning' : 'success',
          )
          get().autoSaveSession()
          return audit
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          set((state) => ({
            whisperStatus: 'error',
            whisperError: error.message,
            audio: {
              ...state.audio,
              fullAudio: { ...state.audio.fullAudio, status: 'error', error: error.message },
            },
          }))
          get().logActivity(`Audio audit failed: ${error.message}`, 'error')
          throw error
        }
      },

      validateFullAudioMarker: async (marker) => {
        const scope = captureProjectScope(get)
        const fullAudio = get().audio.fullAudio
        const activeAuditId = fullAudio?.previewVariant === 'repaired'
          ? fullAudio.repair?.auditId
          : fullAudio?.auditId
        if (!activeAuditId) throw new Error('No audited full audio is available')
        const result = await api.validateAudioMarker(
          getSessionId(),
          activeAuditId,
          marker,
        )
        if (!isProjectScopeCurrent(get, scope)) return null
        set((state) => {
          const current = state.audio.fullAudio
          const repaired = current?.previewVariant === 'repaired'
          return {
            audio: {
              ...state.audio,
              fullAudio: repaired
                ? { ...current, repair: { ...current.repair, audit: result.audit }, status: 'review-required' }
                : { ...current, audit: result.audit, status: 'review-required' },
            },
          }
        })
        get().autoSaveSession()
        return result
      },

      repairAuditedFullAudio: async (issueIds) => {
        const scope = captureProjectScope(get)
        const fullAudio = get().audio.fullAudio
        if (!fullAudio?.auditId) throw new Error('No audited full audio is available')
        set((state) => ({
          whisperStatus: 'repairing',
          whisperError: null,
          audio: {
            ...state.audio,
            fullAudio: { ...state.audio.fullAudio, status: 'repairing' },
          },
        }))
        get().logActivity('Creating a non-destructive improved narration master...', 'running')
        try {
          const result = await api.repairFullAudio(
            getSessionId(),
            fullAudio.auditId,
            issueIds,
          )
          if (!isProjectScopeCurrent(get, scope)) return null
          set((state) => ({
            whisperStatus: 'review',
            audio: {
              ...state.audio,
              fullAudio: {
                ...state.audio.fullAudio,
                repairedUrl: result.repairedUrl,
                repair: {
                  url: result.repairedUrl,
                  auditId: result.repairAuditId,
                  audit: result.audit,
                  appliedFixes: result.appliedFixes,
                },
                previewVariant: 'repaired',
                status: 'repaired',
              },
            },
          }))
          get().logActivity(`Improved master ready — ${result.appliedFixes.length} repair${result.appliedFixes.length === 1 ? '' : 's'} applied`, 'success')
          get().autoSaveSession()
          return result
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          set((state) => ({
            whisperStatus: 'error',
            whisperError: error.message,
            audio: {
              ...state.audio,
              fullAudio: { ...state.audio.fullAudio, status: 'review-required', error: error.message },
            },
          }))
          get().logActivity(`Audio repair failed: ${error.message}`, 'error')
          throw error
        }
      },

      setFullAudioPreviewVariant: (previewVariant) => set((state) => ({
        audio: {
          ...state.audio,
          fullAudio: { ...state.audio.fullAudio, previewVariant },
        },
      })),

      approveAuditedFullAudio: async (variant = 'source') => {
        const scope = captureProjectScope(get)
        const { ttsScript, audio } = get()
        const fullAudio = audio.fullAudio
        const approvedAuditId = variant === 'repaired'
          ? fullAudio?.repair?.auditId
          : fullAudio?.auditId
        if (!approvedAuditId) throw new Error(`The ${variant} audio version is not available`)
        const narrationUnits = ttsScript?.narration_sequence || ttsScript?.scene_breakdown || []
        set((state) => ({
          whisperStatus: 'splitting',
          whisperError: null,
          audio: {
            ...state.audio,
            fullAudio: { ...state.audio.fullAudio, status: 'splitting' },
          },
        }))
        get().logActivity(`Approving ${variant} master and creating scene narration slices...`, 'running')
        try {
          const result = await api.approveFullAudio(getSessionId(), approvedAuditId)
          if (!isProjectScopeCurrent(get, scope)) return null
          const nextSceneAudio = {}
          for (const slice of result.scenes || []) {
            const breakdown = narrationUnits.find(unit => (unit.unit_id || unit.scene_id) === slice.scene_id)
            nextSceneAudio[slice.scene_id] = {
              parts: [
                ...((breakdown?.lines || []).filter(line => line.startsWith('[')).map(line => ({ type: 'cue', content: line }))),
                {
                  type: 'audio',
                  content: slice.url,
                  text: (breakdown?.lines || []).filter(line => !line.startsWith('[')).join(' '),
                  manual: true,
                  whisper: true,
                  cinemaType: breakdown?.cinema_type || 'scene',
                },
              ],
              loading: false,
              durationSeconds: slice.durationSeconds,
              startSeconds: slice.startSeconds,
              endSeconds: slice.endSeconds,
              speechStartSeconds: slice.speechStartSeconds,
              speechEndSeconds: slice.speechEndSeconds,
              matchRatio: slice.matchRatio,
              lowConfidence: slice.lowConfidence,
              wordTimings: slice.wordTimings || [],
            }
          }
          set((state) => ({
            whisperStatus: 'done',
            audio: {
              ...state.audio,
              sceneAudio: nextSceneAudio,
              fullAudio: {
                ...state.audio.fullAudio,
                url: result.approvedUrl,
                approvedUrl: result.approvedUrl,
                approvedAuditId: result.approvedAuditId,
                approvedVariant: variant,
                status: 'split',
                audit: variant === 'source' ? result.audit : state.audio.fullAudio.audit,
                repair: variant === 'repaired'
                  ? { ...state.audio.fullAudio.repair, audit: result.audit }
                  : state.audio.fullAudio.repair,
              },
            },
          }))
          get().logActivity(`Approved audio split into ${result.scenes.length} narration units ✓`, 'success')
          get().autoSaveSession()
          return result.scenes
        } catch (error) {
          if (!isProjectScopeCurrent(get, scope)) return null
          set((state) => ({
            whisperStatus: 'error',
            whisperError: error.message,
            audio: {
              ...state.audio,
              fullAudio: { ...state.audio.fullAudio, status: 'review-required', error: error.message },
            },
          }))
          get().logActivity(`Audio approval failed: ${error.message}`, 'error')
          throw error
        }
      },

      setSfxAudio: (cue, data) => set((state) => {
        const sfxAudio = { ...state.audio.sfxAudio, [cue]: data }
        const narrationSfx = state.timeline.built
          ? buildNarrationSfxItems({
              ttsScript: state.ttsScript,
              scenePlan: state.scenePlan,
              sceneWindows: state.timeline.sceneWindows,
              sfxAudio,
              sceneAudio: state.audio.sceneAudio,
            })
          : []
        return {
          audio: { ...state.audio, sfxAudio },
          ...(state.timeline.built ? {
            timeline: {
              ...state.timeline,
              items: [
                ...state.timeline.items.filter(item => item.payload?.source !== 'narration-cue'),
                ...narrationSfx,
              ],
            },
          } : {}),
        }
      }),

      clearAudio: () => set({ audio: { sceneAudio: {}, sfxAudio: {}, fullAudio: null } }),

      // ─── Export toggles ───────────────────────────────────────────────────
      setIncludeThumbnail: (value) => set({ includeThumbnail: value }),
      setIncludeMetadata: (value) => set({ includeMetadata: value }),

      // ─── Studio timeline / Director / Render ──────────────────────────────

      // Map scene_number → { url, durationSeconds } from the audio store,
      // which is keyed by scene_id ('s01'). Resolves by scene_id first, then
      // by raw scene number for older sessions.
      _sceneAudioBySceneNumber: () => {
        const { scenePlan, audio } = get()
        const out = {}
        for (const ps of scenePlan?.scenes || []) {
          const entry = audio.sceneAudio?.[ps.scene_id]
            ?? audio.sceneAudio?.[String(ps.scene_number)]
            ?? audio.sceneAudio?.[ps.scene_number]
          if (!entry) continue
          const audioPart = (entry.parts || []).find(p => p.type === 'audio' && p.content)
          const audioParts = (entry.parts || [])
            .filter(p => p.type === 'audio' && p.content)
            .map(p => ({
              src: p.content,
              durationSeconds: p.durationSeconds || null,
              text: p.text || '',
            }))
          out[ps.scene_number] = {
            url: audioPart?.content || null,
            durationSeconds: entry.durationSeconds || null,
            parts: audioParts,
          }
        }
        return out
      },

      _cinemaAudioByUnit: () => {
        const { audio } = get()
        const out = {}
        for (const [unitId, entry] of Object.entries(audio.sceneAudio || {})) {
          if (!unitId.startsWith('cinema:')) continue
          const audioParts = (entry.parts || [])
            .filter(part => part.type === 'audio' && part.content)
            .map(part => ({
              src: part.content,
              durationSeconds: part.durationSeconds || null,
              text: part.text || '',
            }))
          const audioPart = audioParts[0]
          if (!audioPart?.src || !entry.durationSeconds) continue
          out[unitId] = {
            src: audioPart.src,
            parts: audioParts,
            durationSeconds: entry.durationSeconds,
            speechStartSeconds: entry.speechStartSeconds || 0,
            speechEndSeconds: entry.speechEndSeconds || entry.durationSeconds,
          }
        }
        return out
      },

      // Derive the base film (clips + narration) from the pipeline selections.
      buildTimeline: () => {
        const { scenePlan, sceneSegments, selectedVideos } = get()
        if (!scenePlan?.scenes?.length) return null

        const sceneOrder = scenePlan.scenes.map(s => s.scene_number)
        const sceneAudioBySceneNumber = get()._sceneAudioBySceneNumber()
        const segments = Object.keys(sceneSegments).length > 0
          ? sceneSegments
          : get().computeSceneSegments()

        const base = deriveBaseTimeline({
          sceneOrder,
          sceneAudioBySceneNumber,
          sceneSegments: segments,
          selectedVideos,
        })
        const narrationSfx = buildNarrationSfxItems({
          ttsScript: get().ttsScript,
          scenePlan,
          sceneWindows: base.sceneWindows,
          sfxAudio: get().audio.sfxAudio,
          sceneAudio: get().audio.sceneAudio,
        })
        base.items.push(...narrationSfx)

        set({
          timeline: {
            items: base.items,
            sceneWindows: base.sceneWindows,
            directorPlan: null,
            chapters: null,
            built: true,
          },
          timelineDirty: false,
          timelineHistory: { past: [], future: [] },
        })
        get().logActivity(
          `Timeline built — ${base.items.length} items · ${Math.round(base.totalDuration)}s`,
          'success'
        )
        get().autoSaveSession()
        return base
      },

      // One portrait per chapter via the configured image provider. Returns a
      // new chapters array with `image` set (base64 data URI) or null.
      generateChapterPortraits: async (planChapters) => {
        const scope = captureProjectScope(get)
        const { settings } = get()
        const chapters = planChapters.map(c => ({ ...c }))
        let nextIndex = 0
        const worker = async () => {
          while (nextIndex < chapters.length) {
            const i = nextIndex++
            const ch = chapters[i]
            get().logActivity(`Director: chapter portrait ${i + 1}/${chapters.length} — ${ch.title}`, 'running')
            try {
              const results = await api.generateImages(
                [ch.portrait_prompt],
                settings.imageProvider,
                settings.imageModel,
                '9:16',
                [],
                '',
                null,
                {
                  sessionId: getSessionId(),
                  itemIds: [`director-chapter-${ch.start_scene}-${i}`],
                  outputCount: 1,
                },
              )
              if (!isProjectScopeCurrent(get, scope)) return
              if (results?.[0]?.error) throw new Error(results[0].error)
              const url = results?.[0]?.url || null
              ch.image = url ? await toBase64DataUri(url) : null
              get().logActivity(`Chapter portrait ready — ${ch.title} ✓`, 'success')
            } catch (err) {
              // A portrait provider problem must not strand the entire film.
              // Use the selected opening shot for this chapter as a coherent,
              // project-owned fallback and keep the Director moving.
              ch.image = get().selectedImages[unitKey(ch.start_scene, 0)]?.url || null
              get().logActivity(
                `Chapter portrait fallback (${ch.title}): ${err.message}`,
                ch.image ? 'info' : 'error'
              )
            }
          }
        }
        const concurrency = Math.min(2, Math.max(1, chapters.length))
        await Promise.all(Array.from({ length: concurrency }, worker))
        return isProjectScopeCurrent(get, scope) ? chapters : []
      },

      // Start one map job and poll it to completion, patching the timeline
      // item's payload as it progresses. Sequential by design — the map agent
      // is heavyweight (claude -p + Remotion renders).
      _runMapJob: async (itemId, request, durationSeconds, stageLabel = null, { interactive = false } = {}) => {
        const scope = captureProjectScope(get)
        const { settings } = get()
        const currentItem = get().timeline.items.find(it => it.id === itemId)
        const models = {
          ideation: currentItem?.payload?.mapModels?.ideation || 'opus',
          executor: currentItem?.payload?.mapModels?.executor || 'opus',
        }
        const patchPayload = (patch) => set((state) => ({
          timeline: {
            ...state.timeline,
            items: state.timeline.items.map(it =>
              it.id === itemId ? { ...it, payload: { ...it.payload, ...patch } } : it
            ),
          },
        }))
        patchPayload({
          status: 'rendering',
          error: null,
          awaitingDecision: null,
          progressMessage: `Starting ${models.ideation} ideation → ${models.executor} execution`,
          mapModels: models,
        })
        const { jobId } = await api.directorMapStart({
          request,
          durationSeconds,
          style: settings.cinemaStyle || 'chronicle',
          sessionId: getSessionId(),
          model: models.executor,
          models,
          mapId: itemId,
          interactive,
        })
        patchPayload({ mapJobId: jobId })
        if (!isProjectScopeCurrent(get, scope)) return null
        let startedAt = Date.now()
        let consecutiveErrors = 0
        let lastProgress = ''
        try {
          // Poll every 2s so streamed Claude output feels live in the Inspector.
          // Backend restarts and persistent network failures are
          // terminal instead of being swallowed forever.
          for (;;) {
            await new Promise(r => setTimeout(r, 2000))
            if (!isProjectScopeCurrent(get, scope)) return null
            if (!get().timeline.items.some(it => it.id === itemId)) return null
            if (Date.now() - startedAt > MAP_JOB_TIMEOUT_MS) {
              throw new Error(
                `Map generation exceeded ${Math.round(MAP_JOB_TIMEOUT_MS / 60_000)} minutes and was stopped. ` +
                'Retry this map from the Inspector.'
              )
            }
            let status
            try {
              status = await api.directorMapStatus(jobId)
              consecutiveErrors = 0
            } catch (error) {
              const code = error.response?.data?.code
              if (code === 'MAP_JOB_LOST' || error.response?.status === 410 || error.response?.status === 404) {
                throw new Error(error.response?.data?.error || 'Map job was interrupted by a backend restart. Run the Director again.')
              }
              consecutiveErrors++
              if (consecutiveErrors >= MAP_POLL_MAX_CONSECUTIVE_ERRORS) {
                throw new Error('Map status could not be reached after five attempts. Check the backend and retry the map.')
              }
              continue
            }
            const progress = status.log?.[status.log.length - 1]
            if (status.trace) {
              const latestItem = get().timeline.items.find(it => it.id === itemId)
              patchPayload({
                mapTrace: status.trace,
                mapOptions: mergeMapOptions(latestItem?.payload?.mapOptions, status.trace.options),
              })
            }
            if (progress && progress !== lastProgress) {
              lastProgress = progress
              patchPayload({ progressMessage: progress })
              if (stageLabel) set({ directorStage: `${stageLabel} · ${progress}` })
            }
            // Interactive runs pause after each rendered attempt; surface the
            // pending decision so the Inspector can offer accept/continue.
            {
              const latestItem = get().timeline.items.find(it => it.id === itemId)
              if (status.status === 'awaiting-decision') {
                if (latestItem?.payload?.status !== 'awaiting-decision') {
                  patchPayload({ status: 'awaiting-decision' })
                }
                patchPayload({ awaitingDecision: status.awaitingDecision || null })
                // Waiting on the human doesn't count against the job budget.
                startedAt = Date.now()
                continue
              }
              if (status.status === 'running' && latestItem?.payload?.status === 'awaiting-decision') {
                patchPayload({ status: 'rendering', awaitingDecision: null })
              }
            }
            if (status.status === 'completed') {
              const latestItem = get().timeline.items.find(it => it.id === itemId)
              patchPayload({
                src: status.result?.url || null,
                posterUrl: status.result?.posterUrl || null,
                status: 'ready',
                mapOptions: mergeMapOptions(latestItem?.payload?.mapOptions, status.result?.options),
                selectedOptionId: status.result?.selectedOptionId || null,
                mapTrace: status.result?.trace || status.trace || null,
                // The editor's explicit choice always wins; otherwise take
                // the agent's suggestion; otherwise split — a full-frame
                // takeover is the deliberate exception, never the default.
                presentation: latestItem?.payload?.presentation || status.result?.suggestedPresentation || 'split',
                suggestedPresentation: status.result?.suggestedPresentation || latestItem?.payload?.suggestedPresentation || null,
                complexity: status.result?.complexity || null,
                awaitingDecision: null,
                progressMessage: null,
                error: null,
              })
              get().autoSaveSession()
              return status.result
            }
            if (status.status === 'needs-selection') {
              const latestItem = get().timeline.items.find(it => it.id === itemId)
              patchPayload({
                status: 'needs-selection',
                mapOptions: mergeMapOptions(latestItem?.payload?.mapOptions, status.result?.options),
                mapTrace: status.result?.trace || status.trace || null,
                awaitingDecision: null,
                progressMessage: null,
                error: status.result?.error || status.error || 'Review the retained map options.',
              })
              get().autoSaveSession()
              return status.result
            }
            if (status.status === 'failed') {
              const message = status.error || 'map generation failed'
              const latestItem = get().timeline.items.find(it => it.id === itemId)
              patchPayload({
                status: 'failed',
                progressMessage: null,
                error: message,
                awaitingDecision: null,
                mapTrace: status.trace || latestItem?.payload?.mapTrace || null,
                mapOptions: mergeMapOptions(latestItem?.payload?.mapOptions, status.trace?.options),
              })
              get().autoSaveSession()
              throw new Error(message)
            }
          }
        } catch (error) {
          patchPayload({ status: 'failed', progressMessage: null, awaitingDecision: null, error: error.message })
          throw error
        }
      },

      // Resolve a paused interactive map run from the Inspector.
      decideMapAttempt: async (itemId, action) => {
        const item = get().timeline.items.find(it => it.id === itemId)
        const jobId = item?.payload?.mapJobId
        if (!jobId) return
        try {
          await api.directorMapDecision(jobId, action)
          get().logActivity(
            action === 'accept'
              ? 'Map attempt accepted ✓'
              : action === 'continue'
                ? 'Trying another map attempt…'
                : 'Map run stopped — options retained',
            action === 'accept' ? 'success' : 'info'
          )
        } catch (err) {
          get().logActivity(`Map decision failed: ${err.message}`, 'error')
        }
      },

      // Full Director pass: plan placements, generate chapter portraits,
      // resolve trailer shots, merge into the timeline, render maps.
      runDirector: async () => {
        const scope = captureProjectScope(get)
        if (get().directorRunning) return null
        const { scenePlan, ttsScript, selectedStory, settings } = get()
        if (!scenePlan?.scenes?.length) throw new Error('No scene plan — plan the story first')

        const scriptedOptions = ttsScript?.cinema_options || {}
        if (
          !!scriptedOptions.chaptersEnabled !== !!settings.chaptersEnabled
          || !!scriptedOptions.trailerEnabled !== !!settings.trailerIntroEnabled
        ) {
          throw new Error('Cinema options changed after narration was written. Regenerate the narration script and audio first.')
        }
        const cinemaAudio = get()._cinemaAudioByUnit()
        if (settings.trailerIntroEnabled && !cinemaAudio['cinema:trailer']) {
          throw new Error('Trailer voiceover is missing. Generate or split the cinematic narration on the Audio step first.')
        }
        if (settings.chaptersEnabled) {
          const scriptedChapters = ttsScript?.cinema?.chapters || []
          const requiredUnits = [
            ...scriptedChapters.map((_, index) => `cinema:overview:${index + 1}`),
            ...scriptedChapters.map((_, index) => `cinema:transition:${index + 1}`),
          ]
          const missing = requiredUnits.filter(unitId => !cinemaAudio[unitId])
          if (!scriptedChapters.length || missing.length) {
            throw new Error(`Chapter voiceover is incomplete${missing.length ? ` (${missing.join(', ')})` : ''}. Complete the Audio step before running Director.`)
          }
        }

        set({ directorRunning: true, directorStage: 'Building timeline' })
        try {
          // Always start from a fresh base so a re-run never stacks overlays
          const base = get().buildTimeline()
          if (!base) throw new Error('Could not build the base timeline')

          const sceneAudio = get()._sceneAudioBySceneNumber()
          const audioDurations = {}
          for (const [num, a] of Object.entries(sceneAudio)) {
            if (a?.durationSeconds) audioDurations[num] = a.durationSeconds
          }

          set({ directorStage: 'Planning placements' })
          get().logActivity('Director: planning cinema placements...', 'running')
          const { plan } = await api.directorPlan({
            provider: settings.claudeProvider,
            model: settings.claudeModel,
            scenePlan,
            sceneBreakdown: ttsScript?.scene_breakdown || [],
            audioDurations,
            storyTitle: selectedStory?.title,
            cinemaBlueprint: ttsScript?.cinema || null,
            options: {
              chaptersEnabled: !!settings.chaptersEnabled,
              trailerEnabled: !!settings.trailerIntroEnabled,
              style: settings.cinemaStyle || 'chronicle',
              backgroundMusicEnabled: settings.backgroundMusicEnabled !== false,
            },
          })
          if (!isProjectScopeCurrent(get, scope)) return null
          if (!plan) throw new Error('Director returned no plan')
          get().logActivity(
            `Director plan: ${plan.maps?.length || 0} maps · ${plan.lower_thirds?.length || 0} lower thirds · ` +
            `${plan.date_chips?.length || 0} date chips · ${plan.motion_graphics?.length || 0} motion graphics · ` +
            `${plan.chapters?.length || 0} chapters` +
            `${plan.trailer ? ' · trailer' : ''}`,
            'success'
          )
          for (const warning of plan.director_warnings || []) {
            get().logActivity(`Director note: ${warning}`, 'error')
          }

          // Turn the Director's authored cue intentions into real, analyzed
          // assets before the timeline is assembled. ACE-Step may place a
          // requested transient several seconds into its ten-second output;
          // the backend detects that actual onset, trims the event, preserves
          // alternatives, and stores an alignment anchor for the renderer.
          const plannedSoundOwners = [
            ...(plan.motion_graphics || []),
            ...(plan.lower_thirds || []),
            ...(plan.date_chips || []),
            ...(plan.title_cards || []),
            ...(plan.trailer ? [plan.trailer] : []),
            ...(plan.chapters || []),
            ...(plan.chapter_overview_sound_design
              ? [{ sound_design: plan.chapter_overview_sound_design }]
              : []),
          ]
          if (plannedSoundOwners.some(owner => owner.sound_design?.cues?.length)) {
            set({ directorStage: 'Sound design' })
            get().logActivity('Director: generating and waveform-aligning element sound...', 'running')
            try {
              const soundResult = await api.directorSfxMaterialize({
                sessionId: scope.sessionId,
                plan,
                optionCount: 1,
              })
              if (!isProjectScopeCurrent(get, scope)) return null
              Object.assign(plan, soundResult.plan || {})
              for (const line of soundResult.logs || []) {
                get().logActivity(line, /rejected|failed|skipped/i.test(line) ? 'error' : 'success')
              }
              const readyCues = [
                ...(plan.motion_graphics || []),
                ...(plan.lower_thirds || []),
                ...(plan.date_chips || []),
                ...(plan.title_cards || []),
                ...(plan.trailer ? [plan.trailer] : []),
                ...(plan.chapters || []),
                ...(plan.chapter_overview_sound_design
                  ? [{ sound_design: plan.chapter_overview_sound_design }]
                  : []),
              ]
                .flatMap(owner => owner.sound_design?.cues || [])
                .filter(cue => cue.status === 'ready').length
              get().logActivity(
                readyCues
                  ? `Director sound design: ${readyCues} analyzed cue${readyCues === 1 ? '' : 's'} ready`
                  : 'Director sound design: no usable cues were accepted',
                readyCues ? 'success' : 'error'
              )
            } catch (soundError) {
              get().logActivity(`Director sound design unavailable: ${soundError.message}`, 'error')
            }
          }

          // Persist the expensive planning result before optional portraits or
          // maps begin. A provider timeout can no longer erase completed work.
          set((state) => ({
            timeline: { ...state.timeline, directorPlan: plan },
          }))
          get().autoSaveSession()

          // (a) Chapter portraits via the configured image provider
          let chapters = null
          if (settings.chaptersEnabled && plan.chapters?.length) {
            set({ directorStage: 'Chapter portraits' })
            chapters = await get().generateChapterPortraits(plan.chapters)
            if (!isProjectScopeCurrent(get, scope)) return null
          }

          // (b) Trailer shots → real selected clip URLs (skip missing)
          if (settings.trailerIntroEnabled && plan.trailer?.shots?.length) {
            const available = []
            const usedUrls = new Set()
            for (const shot of plan.trailer.shots) {
              const candidates = Object.entries(get().selectedVideos)
                .filter(([key, video]) => key.startsWith(`${shot.scene_number}_`) && video?.url)
                .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
              const selected = candidates.find(([, video]) => !usedUrls.has(video.url))
              if (!selected) continue
              usedUrls.add(selected[1].url)
              available.push({ src: selected[1].url, sceneNumber: shot.scene_number })
            }
            const voiceDuration = cinemaAudio['cinema:trailer'].durationSeconds
            const desiredCount = Math.min(6, Math.max(4, Math.round(voiceDuration / 2)))
            const chosen = available.slice(0, desiredCount)
            if (chosen.length < 3) throw new Error('Trailer needs at least three selected peak clips')
            const shotDuration = voiceDuration / chosen.length
            plan.trailerItems = chosen.map(shot => ({ ...shot, duration: shotDuration }))
          }

          // Give each map a stable id up-front so its timeline item and its
          // render job can be correlated later
          for (const m of plan.maps || []) m.id = m.id || newItemId('map')

          // (c) Merge the plan into the base timeline
          set({ directorStage: 'Applying plan' })
          const applied = applyDirectorPlan({
            baseItems: base.items,
            sceneWindows: { ...base.sceneWindows },
            plan,
            chapters,
            storyTitle: selectedStory?.title,
            cinemaAudio,
            graphicTextScales: {
              lowerThird: settings.lowerThirdScale ?? 1.18,
              dateChip: settings.dateChipScale ?? 1.22,
            },
          })
          set({
            timeline: {
              items: applied.items,
              sceneWindows: applied.sceneWindows,
              directorPlan: plan,
              chapters,
              built: true,
            },
            timelineDirty: false,
            timelineHistory: { past: [], future: [] },
          })
          get().autoSaveSession()

          // (d) Render each map SEQUENTIALLY (heavyweight agent jobs)
          const maps = plan.maps || []
          let mapsReady = 0
          let mapFailures = 0
          for (let i = 0; i < maps.length; i++) {
            const m = maps[i]
            set({ directorStage: `Map ${i + 1}/${maps.length}` })
            get().logActivity(
              `Director: rendering map ${i + 1}/${maps.length} — ${m.request?.subject || 'segment'}`, 'running'
            )
            try {
              const result = await get()._runMapJob(
                m.id,
                m.request,
                m.duration_seconds,
                `Map ${i + 1}/${maps.length}`
              )
              const ready = !!result?.url
              get().logActivity(
                ready
                  ? `Map ${i + 1}/${maps.length} ready ✓`
                  : `Map ${i + 1}/${maps.length} needs a selection (${result?.options?.length || 0} options retained)`,
                ready ? 'success' : 'error'
              )
              if (ready) mapsReady += 1
              else mapFailures += 1
            } catch (err) {
              mapFailures += 1
              get().logActivity(`Map ${i + 1}/${maps.length} failed: ${err.message}`, 'error')
            }
          }

          if (mapFailures > 0) {
            get().logActivity(
              `Director pass finished with map failures — ${mapsReady}/${maps.length} maps ready · ${mapFailures} failed`,
              'error'
            )
          } else {
            get().logActivity('Director pass complete ✓', 'success')
          }
          get().autoSaveSession()
          return plan
        } catch (err) {
          if (!isProjectScopeCurrent(get, scope)) return null
          get().logActivity(`Director failed: ${err.message}`, 'error')
          throw err
        } finally {
          if (isProjectScopeCurrent(get, scope)) set({ directorRunning: false, directorStage: null })
        }
      },

      // Re-run a single map item's generation job (Inspector → Regenerate)
      regenerateMapItem: async (itemId) => {
        const item = get().timeline.items.find(it => it.id === itemId)
        if (!item || item.kind !== 'map' || !item.payload?.request) return null
        get().logActivity(`Regenerating map — ${item.payload.request?.subject || item.label}`, 'running')
        try {
          // Individual regenerations are interactive (pause after each
          // rendered attempt); the batch queue stays autonomous.
          const result = await get()._runMapJob(
            itemId, item.payload.request, item.endTime - item.startTime,
            null, { interactive: !get().mapQueueRunning }
          )
          const ready = !!result?.url
          get().logActivity(
            ready
              ? 'Map regenerated ✓'
              : `Map options retained — choose one or retry (${result?.options?.length || 0} available)`,
            ready ? 'success' : 'info'
          )
          return result
        } catch (err) {
          get().logActivity(`Map regeneration failed: ${err.message}`, 'error')
          return null
        }
      },

      loadMapHistory: async (itemId) => {
        const item = get().timeline.items.find(it => it.id === itemId)
        if (!item || item.kind !== 'map') return null
        try {
          const history = await api.directorMapHistory(getSessionId(), itemId)
          set((state) => ({
            timeline: {
              ...state.timeline,
              items: state.timeline.items.map(it => it.id === itemId
                ? {
                    ...it,
                    payload: {
                      ...it.payload,
                      mapTrace: history.trace || it.payload?.mapTrace || null,
                      mapHistories: history.histories || [],
                      mapOptions: mergeMapOptions(it.payload?.mapOptions, history.options),
                    },
                  }
                : it),
            },
          }))
          return history
        } catch (error) {
          if (error.response?.status !== 404) {
            get().logActivity(`Could not load map history: ${error.message}`, 'error')
          }
          return null
        }
      },

      selectMapOption: (itemId, optionId) => {
        set((state) => ({
          timeline: {
            ...state.timeline,
            items: state.timeline.items.map(it => {
              if (it.id !== itemId || it.kind !== 'map') return it
              const options = it.payload?.mapOptions || []
              const option = options.find(candidate => candidate.id === optionId)
              if (!option?.url) return it
              return {
                ...it,
                payload: {
                  ...it.payload,
                  src: option.url,
                  posterUrl: option.posterUrl || it.payload?.posterUrl || null,
                  selectedOptionId: option.id,
                  status: 'ready',
                  error: null,
                },
              }
            }),
          },
        }))
        get().logActivity('Map option selected ✓', 'success')
        get().autoSaveSession()
      },

      generateAllMaps: async () => {
        if (get().mapQueueRunning) return
        const candidates = get().timeline.items.filter(item => (
          item.kind === 'map'
          && item.payload?.request
          && item.payload?.status !== 'rendering'
          && item.payload?.status !== 'ready'
        ))
        if (!candidates.length) {
          get().logActivity('All map segments already have a selected result', 'info')
          return
        }
        set({ mapQueueRunning: true, mapQueueProgress: { current: 0, total: candidates.length } })
        try {
          for (let index = 0; index < candidates.length; index++) {
            const item = candidates[index]
            set({ mapQueueProgress: { current: index + 1, total: candidates.length, itemId: item.id } })
            await get().regenerateMapItem(item.id)
          }
        } finally {
          set({ mapQueueRunning: false, mapQueueProgress: null })
        }
      },

      // ── Timeline item editing (Editor UI) ──
      // Push the current items onto the undo stack (called before every edit;
      // items are treated immutably by all mutators so sharing refs is safe).
      _snapshotTimeline: () => set((state) => ({
        timelineHistory: {
          past: [
            ...state.timelineHistory.past.slice(-49),
            { items: state.timeline.items, dirty: state.timelineDirty },
          ],
          future: [],
        },
      })),

      undoTimelineEdit: () => set((state) => {
        const { past, future } = state.timelineHistory
        if (!past.length) return {}
        const previous = past[past.length - 1]
        return {
          timeline: { ...state.timeline, items: previous.items },
          timelineDirty: previous.dirty,
          timelineHistory: {
            past: past.slice(0, -1),
            future: [
              { items: state.timeline.items, dirty: state.timelineDirty },
              ...future,
            ].slice(0, 50),
          },
        }
      }),

      redoTimelineEdit: () => set((state) => {
        const { past, future } = state.timelineHistory
        if (!future.length) return {}
        const next = future[0]
        return {
          timeline: { ...state.timeline, items: next.items },
          timelineDirty: next.dirty,
          timelineHistory: {
            past: [
              ...past.slice(-49),
              { items: state.timeline.items, dirty: state.timelineDirty },
            ],
            future: future.slice(1),
          },
        }
      }),

      saveTimelineEdits: async () => {
        await get().autoSaveSession()
        get().logActivity('Timeline saved ✓', 'success')
      },

      // Build (or attach to) the backend preview-proxy job for every remote
      // clip/map on the timeline, then poll until the src→proxyUrl map is
      // complete. The editor plays these local short-GOP proxies; payload.src
      // stays canonical so final renders still stage the master files.
      ensurePreviewProxies: async () => {
        const sessionId = getSessionId()
        const scope = captureProjectScope(get)
        const items = (get().timeline.items || [])
          .filter(item =>
            (item.kind === 'clip' || item.kind === 'map')
            && typeof item.payload?.src === 'string'
            && /^https?:\/\//i.test(item.payload.src))
          .map(item => ({
            src: item.payload.src,
            sceneNumber: item.payload.sceneNumber,
            segmentIndex: item.payload.segmentIndex,
          }))
        if (!items.length) return
        const applyMap = (map) => {
          if (!map) return
          const current = get().previewProxies
          const fresh = Object.keys(map).some(key => !current[key])
          if (!fresh) return
          set({ previewProxies: { ...current, ...map } })
        }
        try {
          let status = await api.startPreviewProxies(sessionId, items)
          for (let attempt = 0; attempt < 240; attempt++) {
            if (!isProjectScopeCurrent(get, scope)) return
            applyMap(status?.map)
            if (status && !status.running && status.done >= status.total) break
            await new Promise(resolve => setTimeout(resolve, 1500))
            status = await api.getPreviewProxies(sessionId)
          }
          applyMap(status?.map)
          if (status?.errors?.length) {
            console.warn('[preview-proxy] some clips could not be proxied:', status.errors.slice(0, 3))
          }
        } catch (err) {
          console.warn('[preview-proxy] unavailable, playing original sources:', err.message)
        }
      },

      updateTimelineItem: (id, patch) => {
        get()._snapshotTimeline()
        set((state) => ({
          timelineDirty: true,
          timeline: {
            ...state.timeline,
            items: state.timeline.items.map(it => it.id === id
              ? {
                  ...it,
                  ...patch,
                  payload: patch.payload ? { ...it.payload, ...patch.payload } : it.payload,
                }
              : it),
          },
        }))
      },

      setTimelineGraphicScale: (itemId, kind, value, applyToAll = false) => {
        if (kind !== 'lower-third' && kind !== 'date-chip') return
        const scale = Math.min(2, Math.max(0.75, Number(value) || 1))
        get()._snapshotTimeline()
        set((state) => {
          const settingKey = kind === 'lower-third' ? 'lowerThirdScale' : 'dateChipScale'
          return {
            timelineDirty: true,
            ...(applyToAll
              ? { settings: { ...state.settings, [settingKey]: scale } }
              : {}),
            timeline: {
              ...state.timeline,
              items: state.timeline.items.map(item => (
                item.kind === kind && (applyToAll || item.id === itemId)
                  ? { ...item, payload: { ...item.payload, textScale: scale } }
                  : item
              )),
            },
          }
        })
        if (applyToAll) void get().autoSaveSession()
      },

      setTimelineTrackMuted: (trackId, muted) => {
        get()._snapshotTimeline()
        set(state => ({
          timelineDirty: true,
          timeline: {
            ...state.timeline,
            items: state.timeline.items.map(item => {
              if (trackOf(item.kind) !== trackId) return item
              const volume = Number(item.payload?.volume)
              return {
                ...item,
                payload: {
                  ...item.payload,
                  muted,
                  soundMuted: muted,
                  ...(muted
                    ? {
                        previousVolume: Number.isFinite(volume) && volume > 0
                          ? volume
                          : item.payload?.previousVolume,
                      }
                    : {
                        volume: Number.isFinite(item.payload?.previousVolume)
                          ? item.payload.previousVolume
                          : item.kind === 'music' ? 0.5 : 1,
                      }),
                },
              }
            }),
          },
        }))
      },

      moveTimelineItem: (id, newStart) => {
        get()._snapshotTimeline()
        set((state) => {
          const item = state.timeline.items.find(it => it.id === id)
          if (!item || item.locked) return {}
          const dur = item.endTime - item.startTime
          let start = Math.max(0, newStart)
          let payload = item.payload
          if (item.kind === 'transition') {
            const clips = state.timeline.items
              .filter(candidate => candidate.kind === 'clip' && candidate.payload?.src)
              .sort((a, b) => a.startTime - b.startTime)
            const toIndex = clips.reduce((best, clip, index) => (
              index > 0 && Math.abs(clip.startTime - start) < Math.abs(clips[best]?.startTime - start)
                ? index
                : best
            ), clips.length > 1 ? 1 : 0)
            if (toIndex > 0) {
              start = clips[toIndex].startTime
              payload = { ...payload, fromClipId: clips[toIndex - 1].id, toClipId: clips[toIndex].id }
            }
          }
          return {
            timelineDirty: true,
            timeline: {
              ...state.timeline,
              items: state.timeline.items.map(it => it.id === id
                ? { ...it, startTime: start, endTime: start + dur, payload }
                : it),
            },
          }
        })
      },

      resizeTimelineItem: (id, newStart, newEnd) => {
        get()._snapshotTimeline()
        set((state) => {
          const item = state.timeline.items.find(it => it.id === id)
          if (!item || item.locked) return {}
          const transitionDuration = Math.max(0.25, Math.min(1.2, newEnd - newStart))
          const start = item.kind === 'transition'
            ? item.startTime
            : Math.max(0, Math.min(newStart, newEnd - 0.5))
          const end = item.kind === 'transition'
            ? start + transitionDuration
            : Math.max(start + 0.5, newEnd)
          return {
            timelineDirty: true,
            timeline: {
              ...state.timeline,
              items: state.timeline.items.map(it => it.id === id
                ? { ...it, startTime: start, endTime: end }
                : it),
            },
          }
        })
      },

      deleteTimelineItem: (id) => {
        get()._snapshotTimeline()
        set((state) => ({
          timelineDirty: true,
          timeline: {
            ...state.timeline,
            items: state.timeline.items.filter(it => it.id !== id),
          },
        }))
      },

      addTimelineItem: (item) => {
        get()._snapshotTimeline()
        set((state) => ({
          timelineDirty: true,
          timeline: {
            ...state.timeline,
            items: [...state.timeline.items, item],
          },
        }))
      },

      // Manual transition at a clip boundary. Editor-authored transitions
      // share the Director's item model, so preview and render treat them
      // identically; the type is edited afterwards in the Inspector.
      addTransitionBeforeClip: (clipId, typeId = 'cross-dissolve') => {
        const items = get().timeline.items
        const clips = items
          .filter(it => it.kind === 'clip' && it.payload?.src)
          .sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime)
        const toIndex = clips.findIndex(clip => clip.id === clipId)
        if (toIndex < 0) return
        if (toIndex === 0) {
          get().logActivity('The first clip has no preceding clip — a transition needs a boundary', 'info')
          return
        }
        const fromClip = clips[toIndex - 1]
        const toClip = clips[toIndex]
        const existing = items.find(it =>
          it.kind === 'transition'
          && (it.payload?.toClipId === toClip.id || Math.abs(it.startTime - toClip.startTime) < 0.04)
        )
        if (existing) {
          get().logActivity('This boundary already has a transition — select it to change the type', 'info')
          return
        }
        const definition = transitionDefinition(typeId)
        const duration = Math.max(
          0.25,
          Math.min(1.2, definition.defaultDuration, (toClip.endTime - toClip.startTime) * 0.45)
        )
        get().addTimelineItem({
          id: newItemId('tr'),
          kind: 'transition',
          startTime: toClip.startTime,
          endTime: toClip.startTime + duration,
          label: definition.label,
          payload: {
            type: definition.id,
            fromClipId: fromClip.id,
            toClipId: toClip.id,
            reason: 'Editor-authored transition',
            authoredBy: 'editor',
          },
        })
        get().logActivity(`Transition added — ${definition.label}`, 'success')
        get().autoSaveSession()
      },

      // ── Final film render ──
      loadRenderHistory: async () => {
        const sessionId = getSessionId()
        const result = await api.renderHistory(sessionId)
        if (getSessionId() === sessionId) set({ renderHistory: result.history || [] })
        return result.history || []
      },

      deleteRenderVersion: async (fileName) => {
        await api.deleteRender(getSessionId(), fileName)
        set(state => ({ renderHistory: state.renderHistory.filter(item => item.name !== fileName) }))
      },

      deleteAllRenderVersions: async () => {
        await api.deleteAllRenders(getSessionId())
        set({ renderHistory: [] })
      },

      renderFilm: async () => {
        const scope = captureProjectScope(get)
        const { timeline, settings, selectedStory, selectedTitle, selectedVideos } = get()
        if (!timeline.built || !timeline.items.length) {
          throw new Error('Build the timeline in the Editor first')
        }
        // The timeline may have been built before a shot was regenerated and
        // re-selected. Reconcile again at the render boundary so an old MP4
        // can never leak into the final film even if the editor stayed open.
        const currentTimelineItems = reconcileTimelineVideoSelections(
          timeline.items,
          selectedVideos,
        )
        if (currentTimelineItems !== timeline.items) {
          set({
            timeline: { ...timeline, items: currentTimelineItems },
            timelineDirty: true,
          })
          void get().autoSaveSession()
        }
        const normalized = normalizeTimeline(currentTimelineItems)
        // Maps still rendering/failed have no video yet — render without them
        const items = normalized.filter(it => it.kind !== 'map' || it.payload?.src)
        if (items.length < normalized.length) {
          get().logActivity(`${normalized.length - items.length} unfinished map segment(s) skipped`, 'info')
        }
        const title = selectedTitle || selectedStory?.title || 'documentary'
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60)
          || 'documentary'

        get().logActivity('Render: starting final film...', 'running')
        const { jobId } = await api.renderStart({
          sessionId: getSessionId(),
          timeline: { items },
          style: settings.cinemaStyle || 'chronicle',
          soundEffectsVolume: settings.soundEffectsVolume ?? 1,
          backgroundMusicVolume: settings.backgroundMusicVolume ?? 1,
          filmTreatment: effectiveFilmTreatment(settings),
          slug,
        })
        if (!isProjectScopeCurrent(get, scope)) return null
        set({ renderJob: { jobId, status: 'running', progress: 0, stage: 'queued', log: [], output: null, error: null } })

        // Poll every 3s until the job leaves 'running'
        const poll = async () => {
          for (;;) {
            await new Promise(r => setTimeout(r, 3000))
            if (!isProjectScopeCurrent(get, scope)) return
            const cur = get().renderJob
            if (!cur || cur.jobId !== jobId || cur.status !== 'running') return
            try {
              const s = await api.renderStatus(jobId)
              if (!isProjectScopeCurrent(get, scope)) return
              set({
                renderJob: {
                  jobId,
                  status: s.status,
                  progress: s.progress ?? 0,
                  stage: s.stage || null,
                  log: s.log || [],
                  output: s.output || null,
                  error: s.error || null,
                },
              })
              if (s.status === 'completed') {
                get().logActivity('Final film rendered ✓', 'success')
                await get().loadRenderHistory()
                get().autoSaveSession()
                return
              }
              if (s.status === 'failed') {
                get().logActivity(`Final film render failed: ${s.error || 'unknown error'}`, 'error')
                return
              }
              if (s.status === 'canceled') return
            } catch {
              // transient poll error — keep trying
            }
          }
        }
        poll()
        return jobId
      },

      cancelRender: async () => {
        const job = get().renderJob
        if (!job?.jobId) return
        try { await api.renderCancel(job.jobId) } catch { /* already gone */ }
        set({ renderJob: { ...job, status: 'canceled', stage: 'canceled' } })
        get().logActivity('Final film render canceled', 'info')
      },

      // ─── Project load/save ────────────────────────────────────────────────
      loadProject: (rawProject) => {
        if (rawProject.version !== 1) {
          throw new Error('Unsupported project version')
        }

        // Migrate pre-segment projects: scene-level keys become unit keys
        // ("12" → "12_0", image "12_3" → "12_0_3", scenes gain segment_index 0)
        const project = migrateProjectToSegments(rawProject)
        const loadedCharacters = project.characters || []
        const loadedSceneSheetWorkflow = hydrateSceneSheetReferences(
          project.scene_sheet_workflow || null,
          loadedCharacters,
        )
        rememberSessionWriteToken(getSessionId(), project._session?.write_token)
        const savedImageProgress = project.image_progress || { total: 0, completed: [], pending: [] }
        const hasPendingImages = savedImageProgress.pending.length > 0

        const selectedVideos = project.selected_videos || {}

        // Reconstruct videoJobs from selected_videos if no jobs are saved.
        // This prevents the init useEffect from thinking generation hasn't run yet
        // and firing a new batch of API requests.
        let videoJobs = project.video_jobs || {}
        if (Object.keys(videoJobs).length === 0 && Object.keys(selectedVideos).length > 0) {
          videoJobs = Object.fromEntries(
            Object.entries(selectedVideos).map(([sceneNum, v]) => [
              sceneNum,
              { jobId: null, status: 'completed', url: v.url, error: null, provider: project.settings?.video_provider || 'replicate' }
            ])
          )
        }
        const loadedTtsScript = project.tts_script ? {
          script: project.tts_script,
          scene_breakdown: project.tts_scene_breakdown || null,
          cinema: project.tts_cinema || null,
          narration_sequence: project.tts_narration_sequence || project.tts_scene_breakdown || null,
          cinema_options: project.tts_cinema_options || null,
          writing_profile: project.tts_writing_profile || null,
          word_count: null,
          estimated_duration_seconds: null,
        } : null
        let loadedTimeline = project.timeline && Array.isArray(project.timeline.items)
          ? {
              items: project.timeline.items,
              sceneWindows: project.timeline.sceneWindows || {},
              directorPlan: project.timeline.directorPlan || null,
              chapters: project.timeline.chapters || null,
              built: project.timeline.built !== false,
            }
          : { items: [], sceneWindows: {}, directorPlan: null, chapters: null, built: false }
        let timelineSelectionRepaired = false
        if (loadedTimeline.built) {
          const narrationSfx = buildNarrationSfxItems({
            ttsScript: loadedTtsScript,
            scenePlan: project.scene_plan,
            sceneWindows: loadedTimeline.sceneWindows,
            sfxAudio: project.audio?.sfxAudio || {},
            sceneAudio: project.audio?.sceneAudio || {},
          })
          loadedTimeline = {
            ...loadedTimeline,
            items: [
              ...loadedTimeline.items.filter(item => item.payload?.source !== 'narration-cue'),
              ...narrationSfx,
            ],
          }
          const reconciledItems = reconcileTimelineVideoSelections(
            loadedTimeline.items,
            selectedVideos,
          )
          timelineSelectionRepaired = reconciledItems !== loadedTimeline.items
          if (timelineSelectionRepaired) {
            loadedTimeline = { ...loadedTimeline, items: reconciledItems }
          }
        }

        set((state) => ({
          activeSessionId: getSessionId(),
          projectEpoch: state.projectEpoch + 1,
          topic: project.topic || '',
          maxMinutes: project.max_minutes || null,
          storyInputMode: project.story_input_mode || project.story?.input_mode || 'discover',
          storyTitle: project.story_title || project.story?.title || '',
          storyContext: project.story_context || project.story?.source_context || '',
          suppliedVoiceover: project.supplied_voiceover || project.story?.provided_voiceover || '',
          selectedStory: project.story || null,
          scenePlan: project.scene_plan || null,
          scenes: project.scenes || [],
          sceneSegments: project.scene_segments || {},
          expressiveScript: project.expressive_script || null,
          audio: project.audio || { sceneAudio: {}, sfxAudio: {}, fullAudio: null },
          images: project.images || {},
          imageHistory: project.image_history || {},
          selectedImages: project.selected_images || {},
          sceneSheetWorkflow: loadedSceneSheetWorkflow,
          downstreamResetRevision: project.downstream_reset_revision
            || project._session?.downstream_reset_revision
            || null,
          characters: loadedCharacters,
          characterSceneLinks: project.character_scene_links || {},
          characterAudit: project.character_audit || null,
          characterStatus: project.character_status
            || ((project.characters || []).length ? 'ready' : 'idle'),
          characterError: project.character_error || null,
          videoPrompts: project.video_prompts || [],
          videoJobs,
          videoHistory: project.video_history || {},
          selectedVideos,
          windowsVideoStatus: emptyWindowsVideoStatus(),
          imageBatches: project.image_batches || [],
          imageProgress: savedImageProgress,
          ttsScript: loadedTtsScript,
          youtubeMetadata: project.metadata || null,
          selectedTitle: project.metadata?.selected_title || null,
          // Restore selectedThumbnail as the [{ url, prompt, index }] array
          // shape that selectThumbnail() produces. exportProject() serialises
          // it as { selected_urls, selected_prompt, ... } so convert back.
          thumbnailHistory: project.thumbnail_history || {},
          // Restore thumbnails grid from all_thumbnails array so Export page
          // shows the generated options, not a blank grid.
          thumbnails: (() => {
            const all = project.all_thumbnails || []
            return Object.fromEntries(all.map((t, i) => [i, { url: t.url, prompt: t.prompt, loading: false, error: null }]))
          })(),
          // Restore selectedThumbnail as the [{ url, prompt, index }] array
          // shape that selectThumbnail() produces. exportProject() serialises
          // it as { selected_urls, selected_prompt, ... } so convert back.
          selectedThumbnail: (() => {
            const t = project.thumbnail
            if (!t) return null
            const urls = t.selected_urls || (t.selected_url ? [t.selected_url] : [])
            if (!urls.length) return null
            return urls.map((url, i) => ({ url, prompt: t.selected_prompt || '', index: i }))
          })(),
          // Studio timeline — version-tolerant: older projects have none
          timeline: loadedTimeline,
          timelineDirty: timelineSelectionRepaired,
          timelineHistory: { past: [], future: [] },
          renderJob: null,
          renderHistory: [],
          // Loading/reloading cannot restore the old browser's async worker.
          // If this project still has queued images, expose it as paused so
          // the user can explicitly resume without losing the saved boundary.
          generationState: hasPendingImages ? 'paused' : 'idle',
          generationPhase: hasPendingImages ? 'images' : null,
          videoProgress: { total: 0, completed: [], pending: [] },
          imagesError: null,
          videoPromptsError: null,
          scenePlanError: null,
          ttsError: null,
          metadataError: null,
          // An explicit project load supersedes the mount-time restore —
          // unblock auto-save so this loaded state starts persisting
          sessionRestoreDone: true,
          sessionWriteToken: project._session?.write_token || null,
          projectName: project.project_name || project._session?.name || null,
          settings: {
            ...get().settings,
            // This experimental workflow is project-scoped. A legacy project
            // without the persisted key must never inherit it from the
            // previously opened project in the same tab.
            sceneSheetEnabled: project.settings?.scene_sheet_enabled === true,
            // Optical finishing is project-scoped. Older projects without
            // these keys receive the restrained defaults instead of leaking
            // whichever treatment was active in the previously opened film.
            filmGrainEnabled: project.settings?.film_grain_enabled
              ?? DEFAULT_FILM_TREATMENT.filmGrainEnabled,
            filmGrainAmount: clampFilmAmount(
              project.settings?.film_grain_amount,
              DEFAULT_FILM_TREATMENT.filmGrainAmount
            ),
            atmosphericGradeEnabled: project.settings?.atmospheric_grade_enabled
              ?? DEFAULT_FILM_TREATMENT.atmosphericGradeEnabled,
            atmosphericGradeAmount: clampFilmAmount(
              project.settings?.atmospheric_grade_amount,
              DEFAULT_FILM_TREATMENT.atmosphericGradeAmount
            ),
            vignetteEnabled: project.settings?.vignette_enabled
              ?? DEFAULT_FILM_TREATMENT.vignetteEnabled,
            vignetteAmount: clampFilmAmount(
              project.settings?.vignette_amount,
              DEFAULT_FILM_TREATMENT.vignetteAmount
            ),
            // exportProject() serialises settings in snake_case; map back to camelCase
            ...(project.settings ? {
              ...(project.settings.image_provider   ? { imageProvider:   project.settings.image_provider   } : {}),
              ...(project.settings.image_model      ? { imageModel:      project.settings.image_model      } : {}),
              ...(project.settings.claude_provider  ? { claudeProvider:  project.settings.claude_provider  } : {}),
              ...(project.settings.claude_model     ? { claudeModel:     project.settings.claude_model     } : {}),
              ...(project.settings.video_provider   ? { videoProvider:   project.settings.video_provider   } : {}),
              ...(project.settings.video_model      ? { videoModel:      project.settings.video_model      } : {}),
              videoGenerationBackend:
                project.settings.video_generation_backend
                || (project.settings.video_provider === WINDOWS_VIDEO_PROVIDER
                  ? 'windows-worker'
                  : 'hosted-provider'),
              ...(project.settings.video_resolution ? { videoResolution: project.settings.video_resolution } : {}),
              ...(project.settings.aspect_ratio     ? { aspectRatio:     project.settings.aspect_ratio     } : {}),
              ...(project.settings.chapters_enabled != null ? { chaptersEnabled: !!project.settings.chapters_enabled } : {}),
              ...(project.settings.trailer_intro_enabled != null ? { trailerIntroEnabled: !!project.settings.trailer_intro_enabled } : {}),
              ...(project.settings.cinema_style ? { cinemaStyle: project.settings.cinema_style } : {}),
              ...(project.settings.sound_effects_volume != null
                ? {
                    soundEffectsVolume: Math.min(
                      1.5,
                      Math.max(0, Number(project.settings.sound_effects_volume) || 0)
                    ),
                  }
                : {}),
              ...(project.settings.background_music_enabled != null
                ? { backgroundMusicEnabled: !!project.settings.background_music_enabled }
                : {}),
              ...(project.settings.background_music_volume != null
                ? {
                    backgroundMusicVolume: Math.min(
                      1.5,
                      Math.max(0, Number(project.settings.background_music_volume) || 0)
                    ),
                  }
                : {}),
              ...(project.settings.lower_third_scale != null
                ? { lowerThirdScale: Math.min(2, Math.max(0.75, Number(project.settings.lower_third_scale) || 1.18)) }
                : {}),
              ...(project.settings.date_chip_scale != null
                ? { dateChipScale: Math.min(2, Math.max(0.75, Number(project.settings.date_chip_scale) || 1.22)) }
                : {}),
            } : {})
          }
        }))
      },

      exportProject: () => {
        const state = get()
        return {
          version: 1,
          exported_at: new Date().toISOString(),
          session_write_token: state.sessionWriteToken || undefined,
          project_name: state.projectName || undefined,
          topic: state.topic,
          max_minutes: state.maxMinutes,
          story_input_mode: state.storyInputMode,
          story_title: state.storyTitle,
          story_context: state.storyContext,
          supplied_voiceover: state.suppliedVoiceover,
          story: state.selectedStory,
          scene_plan: state.scenePlan,
          scenes: state.scenes,
          scene_segments: state.sceneSegments,
          expressive_script: state.expressiveScript,
          images: state.images,
          image_history: state.imageHistory,
          selected_images: state.selectedImages,
          scene_sheet_workflow: state.sceneSheetWorkflow,
          downstream_reset_revision: state.downstreamResetRevision || undefined,
          characters: state.characters,
          character_scene_links: state.characterSceneLinks,
          character_audit: state.characterAudit,
          character_status: state.characterStatus,
          character_error: state.characterError,
          video_prompts: state.videoPrompts,
          video_jobs: state.videoJobs,
          video_history: state.videoHistory,
          selected_videos: state.selectedVideos,
          image_batches: state.imageBatches,
          image_progress: state.imageProgress,
          tts_script: state.ttsScript?.script,
          tts_scene_breakdown: state.ttsScript?.scene_breakdown,
          tts_cinema: state.ttsScript?.cinema,
          tts_narration_sequence: state.ttsScript?.narration_sequence,
          tts_cinema_options: state.ttsScript?.cinema_options,
          tts_writing_profile: state.ttsScript?.writing_profile,
          audio: state.audio,
          // Studio timeline (Editor step) — chapters carry portrait images so
          // the session save is the source of truth for them
          timeline: state.timeline?.built ? {
            items: state.timeline.items,
            sceneWindows: state.timeline.sceneWindows,
            directorPlan: state.timeline.directorPlan,
            chapters: state.timeline.chapters,
            built: true,
          } : null,
          all_thumbnails: Object.values(state.thumbnails).filter(t => t?.url),
          thumbnail_history: state.thumbnailHistory,
          metadata: state.includeMetadata ? {
            selected_title: state.selectedTitle,
            all_titles: state.youtubeMetadata?.titles,
            description: state.youtubeMetadata?.description,
            tags: state.youtubeMetadata?.tags,
            chapters: state.youtubeMetadata?.chapters
          } : null,
          thumbnail: (() => {
            if (!state.includeThumbnail || !state.selectedThumbnail) return null
            const sel = Array.isArray(state.selectedThumbnail) ? state.selectedThumbnail : [state.selectedThumbnail]
            if (!sel.length) return null
            return {
              selected_url: sel[0].url,
              selected_prompt: sel[0].prompt,
              selected_urls: sel.map(t => t.url),
              provider: state.settings.imageProvider
            }
          })(),
          settings: {
            image_provider:   state.settings.imageProvider,
            image_model:      state.settings.imageModel,
            claude_provider:  state.settings.claudeProvider,
            claude_model:     state.settings.claudeModel,
            video_provider:   state.settings.videoProvider,
            video_model:      state.settings.videoModel,
            video_generation_backend: state.settings.videoGenerationBackend
              || (state.settings.videoProvider === WINDOWS_VIDEO_PROVIDER
                ? 'windows-worker'
                : 'hosted-provider'),
            video_resolution: state.settings.videoResolution,
            aspect_ratio:     state.settings.aspectRatio,
            scene_sheet_enabled: !!state.settings.sceneSheetEnabled,
            chapters_enabled: state.settings.chaptersEnabled,
            trailer_intro_enabled: state.settings.trailerIntroEnabled,
            cinema_style: state.settings.cinemaStyle,
            sound_effects_volume: state.settings.soundEffectsVolume ?? 1,
            lower_third_scale: state.settings.lowerThirdScale ?? 1.18,
            date_chip_scale: state.settings.dateChipScale ?? 1.22,
            background_music_enabled: state.settings.backgroundMusicEnabled !== false,
            background_music_volume: state.settings.backgroundMusicVolume ?? 1,
            film_grain_enabled: state.settings.filmGrainEnabled !== false,
            film_grain_amount: state.settings.filmGrainAmount ?? DEFAULT_FILM_TREATMENT.filmGrainAmount,
            atmospheric_grade_enabled: !!state.settings.atmosphericGradeEnabled,
            atmospheric_grade_amount: state.settings.atmosphericGradeAmount ?? DEFAULT_FILM_TREATMENT.atmosphericGradeAmount,
            vignette_enabled: state.settings.vignetteEnabled !== false,
            vignette_amount: state.settings.vignetteAmount ?? DEFAULT_FILM_TREATMENT.vignetteAmount,
          }
        }
      },

      // Auto-save the current session to the backend output folder.
      // Silent — never throws to the caller; logs errors only.
      autoSaveSession: async () => {
        // Never save before the mount-time restore ran: a fresh reload starts
        // with empty audio/images, and saving that would clobber the good data
        if (!get().sessionRestoreDone) return
        if (get().activeSessionId !== getSessionId()) {
          console.warn('[session] skipped auto-save because local state belongs to a different project')
          return
        }
        try {
          const sessionId = getSessionId()
          const project = get().exportProject()
          const result = await enqueueSessionSave(sessionId, project, get().sessionWriteToken)
          if (result?.writeToken && getSessionId() === sessionId) {
            set({ sessionWriteToken: result.writeToken })
          }
        } catch (err) {
          console.warn('Auto-save session failed (non-fatal):', err.message)
        }
      },

      // On page load, pull back the heavy assets (audio, images, thumbnails,
      // video history) that localStorage persistence deliberately strips.
      // Merges ONLY fields the rehydrated store is missing — anything the
      // user changed since the last save is never overwritten.
      restoreSessionAssets: async () => {
        const sessionId = getSessionId()
        try {
          const raw = await api.loadSession(sessionId, { force: true, optional: true })
          // Ignore a mount-time response if the user opened another project
          // while this request was in flight.
          if (getSessionId() !== sessionId) return
          if (!raw) {
            // The persisted browser session no longer exists (most commonly
            // because it was deleted in this or another tab). Do not retain
            // its project data or allow a delayed autosave to recreate it.
            get().discardDeletedProject(sessionId)
            return
          }
          const project = migrateProjectToSegments(raw)
          rememberSessionWriteToken(sessionId, project._session?.write_token)
          const localState = get()
          const hydrationDecision = projectHydrationDecision({
            sessionId,
            activeSessionId: localState.activeSessionId,
            backendProject: project,
            localState,
          })
          if (hydrationDecision === 'clear-local') {
            get().clearProject()
            set({
              activeSessionId: sessionId,
              sessionRestoreDone: true,
              sessionWriteToken: project._session?.write_token || null,
            })
            return
          }
          if (hydrationDecision === 'load-backend') {
            console.warn('[session] restoring the complete backend project before auto-save')
            get().loadProject(raw)
            return
          }

          set(state => {
            const updates = {}

            // Character portraits are durable backend assets and scene-sheet
            // groups persist only their IDs. Always restore both together so
            // a refresh cannot leave valid references without previews.
            const restoredCharacters = project.characters?.length
              ? project.characters
              : state.characters
            if (project.characters?.length) {
              updates.characters = project.characters
            }
            if (project.scene_sheet_workflow || state.sceneSheetWorkflow) {
              updates.sceneSheetWorkflow = hydrateSceneSheetReferences(
                project.scene_sheet_workflow || state.sceneSheetWorkflow,
                restoredCharacters,
              )
            }

            const savedSceneAudio = project.audio?.sceneAudio || {}
            const savedSfxAudio = project.audio?.sfxAudio || {}
            // Like the timeline, backend audio metadata is authoritative.
            // localStorage may still point at superseded Whisper slices.
            if (Object.keys(savedSceneAudio).length > 0 || Object.keys(savedSfxAudio).length > 0 || project.audio?.fullAudio) {
              updates.audio = {
                sceneAudio: savedSceneAudio,
                sfxAudio: savedSfxAudio,
                fullAudio: project.audio?.fullAudio || null,
              }
            }

            if (project.images && Object.keys(project.images).length > 0) {
              updates.images = { ...state.images, ...project.images }
              updates.imageHistory = project.image_history || {}
            }

            // selectedImages persist without urls — merge the saved urls back in
            if (project.selected_images) {
              const merged = { ...state.selectedImages }
              let changed = false
              for (const [k, v] of Object.entries(project.selected_images)) {
                if (v?.url && merged[k]) {
                  merged[k] = { ...merged[k], ...v, url: v.url }
                  changed = true
                } else if (v?.url && !merged[k]) {
                  merged[k] = v
                  changed = true
                }
              }
              if (changed) updates.selectedImages = merged
            }

            if (Object.keys(state.thumbnails).length === 0 && Array.isArray(project.all_thumbnails) && project.all_thumbnails.length > 0) {
              updates.thumbnails = Object.fromEntries(
                project.all_thumbnails.map((t, i) => [i, { url: t.url, prompt: t.prompt, loading: false, error: null }])
              )
              updates.thumbnailHistory = project.thumbnail_history || {}
            }

            if (Object.keys(state.videoHistory).length === 0 && project.video_history && Object.keys(project.video_history).length > 0) {
              updates.videoHistory = project.video_history
            }

            // The backend session is the durable timeline source of truth.
            // localStorage deliberately strips portraits and may represent an
            // older pre-repair timeline, so restoring only its missing images
            // can re-save stale timing over a corrected project.
            const savedTl = project.timeline
            if (savedTl?.items?.length) {
              updates.timeline = {
                items: savedTl.items,
                sceneWindows: savedTl.sceneWindows || {},
                directorPlan: savedTl.directorPlan || null,
                chapters: savedTl.chapters || null,
                built: true,
              }
            }

            const restoredAnything = Object.keys(updates).length > 0
            if (restoredAnything) {
              console.log('[session] restored heavy assets after reload:', Object.keys(updates).join(', '))
            }
            const hasPendingImages = state.imageProgress.pending.length > 0
            return {
              ...updates,
              activeSessionId: sessionId,
              sessionRestoreDone: true,
              sessionWriteToken: project._session?.write_token || null,
              // Older localStorage snapshots may not contain generationState,
              // but their durable pending queue still proves the run is
              // resumable. Never leave that queue hidden behind "idle".
              ...(hasPendingImages && state.generationState !== 'running'
                ? { generationState: 'paused', generationPhase: 'images' }
                : {}),
            }
          })
        } catch (err) {
          console.warn('Session asset restore failed (non-fatal):', err.message)
          if (getSessionId() === sessionId) set({ sessionRestoreDone: true })
        }
      },

      setFullAudio: (fullAudio) => set((state) => ({
        audio: { ...state.audio, fullAudio }
      })),

      // Upload one audio blob to the backend session folder, get a small URL.
      // ALL audio in the store must be URLs, never base64 — base64 blows out
      // both localStorage and the session-save payload.
      storeAudioAsset: async (sceneId, dataUri) => {
        const result = await api.storeAudio(getSessionId(), sceneId, dataUri)
        return result.url
      },

      // ─── Projects ─────────────────────────────────────────────────────────

      // Save the current session, then start a fresh one: new session id,
      // full pipeline reset. Settings (providers, models, keysConfigured) and
      // custom prompts are user-level and survive the switch.
      startNewProject: async () => {
        await get().autoSaveSession()
        const newId = generateSessionId()
        sessionStorage.setItem('pipeline_session_id', newId)
        get().clearProject()
        set({
          activeSessionId: newId,
          imageBatches: [],
          projectName: null,
          settings: {
            ...get().settings,
            videoProvider: WINDOWS_VIDEO_PROVIDER,
            videoModel: WINDOWS_VIDEO_MODEL,
            videoGenerationBackend: 'windows-worker',
            videoClipDuration: 8,
            aspectRatio: '16:9',
            sceneSheetEnabled: false,
          },
          // The fresh session has nothing to restore — unblock auto-save so
          // the new project starts persisting immediately
          sessionRestoreDone: true,
          sessionWriteToken: null,
        })
        return newId
      },

      // Move the browser off a deleted/missing project without saving its
      // stale snapshot. The backend tombstone is the final race barrier; this
      // reset also makes route guards leave pages such as /videos immediately.
      discardDeletedProject: (sessionId = getSessionId()) => {
        abandonSessionSaves(sessionId)
        const newId = generateSessionId()
        sessionStorage.setItem('pipeline_session_id', newId)
        get().clearProject()
        set({
          activeSessionId: newId,
          imageBatches: [],
          projectName: null,
          settings: {
            ...get().settings,
            videoProvider: WINDOWS_VIDEO_PROVIDER,
            videoModel: WINDOWS_VIDEO_MODEL,
            videoGenerationBackend: 'windows-worker',
            videoClipDuration: 8,
            aspectRatio: '16:9',
            sceneSheetEnabled: false,
          },
          sessionRestoreDone: true,
          sessionWriteToken: null,
        })
        return newId
      },

      // Save the current session, switch the tab to another saved session and
      // load it into state. Provider/model preferences stay user-level;
      // cinema, audio mix and final-film finishing stay project-level.
      openProject: async (sessionId) => {
        const previousSessionId = getSessionId()
        set((state) => ({
          projectEpoch: state.projectEpoch + 1,
          generationState: 'stopped',
          generationPhase: null,
          directorRunning: false,
          directorStage: null,
          mapQueueRunning: false,
          mapQueueProgress: null,
        }))
        // Auto-save already runs after edits. Do not make Open wait for a
        // redundant full-project serialization; capture the old snapshot and
        // let that safety save finish in the background while this local
        // project loads immediately.
        if (previousSessionId !== sessionId) void get().autoSaveSession()
        // Consume the Projects view's warm cache. Saves invalidate only the
        // session they changed, so this response remains authoritative.
        const project = await api.loadSession(sessionId, { force: true })
        const userSettings = get().settings
        sessionStorage.setItem('pipeline_session_id', sessionId)
        try {
          get().loadProject(project)
        } catch (error) {
          sessionStorage.setItem('pipeline_session_id', previousSessionId)
          throw error
        }
        const projectCinemaSettings = get().settings
        set({
          settings: {
            ...userSettings,
            chaptersEnabled: projectCinemaSettings.chaptersEnabled,
            trailerIntroEnabled: projectCinemaSettings.trailerIntroEnabled,
            cinemaStyle: projectCinemaSettings.cinemaStyle,
            soundEffectsVolume: projectCinemaSettings.soundEffectsVolume,
            lowerThirdScale: projectCinemaSettings.lowerThirdScale,
            dateChipScale: projectCinemaSettings.dateChipScale,
            backgroundMusicEnabled: projectCinemaSettings.backgroundMusicEnabled,
            backgroundMusicVolume: projectCinemaSettings.backgroundMusicVolume,
            filmGrainEnabled: projectCinemaSettings.filmGrainEnabled,
            filmGrainAmount: projectCinemaSettings.filmGrainAmount,
            atmosphericGradeEnabled: projectCinemaSettings.atmosphericGradeEnabled,
            atmosphericGradeAmount: projectCinemaSettings.atmosphericGradeAmount,
            vignetteEnabled: projectCinemaSettings.vignetteEnabled,
            vignetteAmount: projectCinemaSettings.vignetteAmount,
            sceneSheetEnabled: projectCinemaSettings.sceneSheetEnabled,
          },
        })
        return project
      },

      // Rename the current session. State updates first so exportProject
      // carries the name; the PATCH persists it server-side. If the session
      // was never saved yet (PATCH 404s), a full save writes it instead.
      renameProject: async (name) => {
        const trimmed = (name || '').trim()
        if (!trimmed) return
        set({ projectName: trimmed })
        try {
          await api.renameSession(getSessionId(), trimmed)
        } catch {
          await get().autoSaveSession()
        }
      },

      clearProject: () => {
        set((state) => ({
          activeSessionId: getSessionId(),
          projectEpoch: state.projectEpoch + 1,
          topic: '',
          maxMinutes: null,
          stories: [],
          storiesLoading: false,
          selectedStory: null,
          storiesError: null,
          scenePlan: null,
          scenePlanLoading: false,
          scenePlanError: null,
          scenes: [],
          sceneSegments: {},
          expressiveScript: null,
          expressiveLoading: false,
          expressiveError: null,
          whisperStatus: null,
          whisperError: null,
          images: {},
          imageHistory: {},
          selectedImages: {},
          sceneSheetWorkflow: null,
          downstreamResetRevision: null,
          imagesLoading: {},
          imagesError: null,
          videoPrompts: [],
          videoPromptsLoading: false,
          videoPromptsError: null,
          videoBatches: [],
          videoJobs: {},
          videoHistory: {},
          selectedVideos: {},
          windowsVideoStatus: emptyWindowsVideoStatus(),
          ttsScript: null,
          ttsLoading: false,
          ttsError: null,
          youtubeMetadata: null,
          metadataLoading: false,
          metadataError: null,
          selectedTitle: null,
          thumbnailPrompts: [],
          thumbnailLoading: false,
          thumbnails: {},
          thumbnailHistory: {},
          selectedThumbnail: null,
          audio: { sceneAudio: {}, sfxAudio: {}, fullAudio: null },
          timeline: { items: [], sceneWindows: {}, directorPlan: null, chapters: null, built: false },
          timelineDirty: false,
          timelineHistory: { past: [], future: [] },
          directorRunning: false,
          directorStage: null,
          mapQueueRunning: false,
          mapQueueProgress: null,
          renderJob: null,
          renderHistory: [],
          sessionWriteToken: null,
          generationState: 'idle',
          generationPhase: null,
          imageProgress: { total: 0, completed: [], pending: [] },
          videoProgress: { total: 0, completed: [], pending: [] },
          characterImages: { male: null, female: null },
          characterDescription: '',
          characters: [],
          characterSceneLinks: {},
          characterAudit: null,
          characterStatus: 'idle',
          characterError: null,
          storyInputMode: 'discover',
          storyTitle: '',
          storyContext: '',
          suppliedVoiceover: '',
          activityLog: [],
        }))
      }
    }),
    {
      name: 'content-pipeline-state-v6',
      version: 6,
      storage: createJSONStorage(() => createQuotaResilientStorage(localStorage)),
      partialize: compactPipelineState,
    }
  )
)

// Apply the one-time v5 → v6 settings carry-over AFTER rehydration so the
// user's provider/model selections survive the store upgrade. New v6-only
// settings keep their defaults; keysConfigured is re-merged so new capability
// flags (e.g. whisper) aren't lost.
if (legacyCarryOver) {
  usePipelineStore.setState((state) => ({
    settings: {
      ...state.settings,
      ...legacyCarryOver.settings,
      keysConfigured: {
        ...state.settings.keysConfigured,
        ...(legacyCarryOver.settings?.keysConfigured || {}),
      },
    },
    ...(legacyCarryOver.customPrompts ? { customPrompts: { ...state.customPrompts, ...legacyCarryOver.customPrompts } } : {}),
    ...(legacyCarryOver.topic ? { topic: legacyCarryOver.topic } : {}),
    ...(legacyCarryOver.maxMinutes != null ? { maxMinutes: legacyCarryOver.maxMinutes } : {}),
  }))
  // Drop the old key so this migration never runs again
  try { localStorage.removeItem('content-pipeline-state-v5') } catch { /* ignore */ }
}

// Dev-only escape hatch for debugging and automated performance testing.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__pipelineStore = usePipelineStore
}
