import { useState, useRef, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { usePipelineStore } from '../store/pipelineStore'
import { usesWindowsVideoBackend } from '../lib/windowsVideoWorker'
import api from '../services/api'
import toast from 'react-hot-toast'
import ActivityFeed from './ActivityFeed'

// Offload ZIP extraction to a worker so the UI never freezes on large projects
const importZipViaWorker = (file) => new Promise((resolve, reject) => {
  const worker = new Worker(
    new URL('../workers/zipImporter.worker.js', import.meta.url),
    { type: 'module' }
  )
  worker.onmessage = (e) => {
    worker.terminate()
    if (e.data.ok) resolve(e.data.project)
    else reject(new Error(e.data.error))
  }
  worker.onerror = (err) => {
    worker.terminate()
    reject(new Error(err.message))
  }
  worker.postMessage(file)
})

// Audio precedes images/videos: measured narration length per scene decides
// how many shots (images + clips) each scene needs
const steps = [
  { id: 'story', label: 'Story', path: '/' },
  { id: 'audio', label: 'Audio', path: '/audio' },
  { id: 'images', label: 'Images', path: '/images' },
  { id: 'videos', label: 'Videos', path: '/videos' },
  { id: 'editor', label: 'Editor', path: '/editor' },
  { id: 'metadata', label: 'Thumbnail / Metadata', path: '/metadata' },
  { id: 'export', label: 'Export', path: '/export' }
]

const resumePathForProject = (project) => {
  if (project?.timeline?.built) {
    const hasMetadata = !!(
      project.metadata?.selected_title
      || project.metadata?.description
      || project.metadata?.all_titles?.length
    )
    return hasMetadata || project.thumbnail?.selected_url ? '/export' : '/metadata'
  }
  if (Object.keys(project?.selected_videos || {}).length > 0) return '/editor'
  if (Object.keys(project?.selected_images || {}).length > 0 || Object.keys(project?.images || {}).length > 0) return '/videos'
  if (project?.tts_script || Object.keys(project?.audio?.sceneAudio || {}).length > 0) return '/images'
  if (project?.story) return '/audio'
  return '/'
}

const LS_KEYS_KEY = 'cm-api-keys'
const loadKeysFromStorage = () => {
  try { return JSON.parse(localStorage.getItem(LS_KEYS_KEY) || '{}') } catch { return {} }
}
const saveKeysToStorage = (keys) => {
  try { localStorage.setItem(LS_KEYS_KEY, JSON.stringify(keys)) } catch {}
}

function Layout({ children }) {
  const navigate = useNavigate()
  const location = useLocation()
  const fileInputRef = useRef(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessions, setSessions] = useState([])
  const [sessionsLoading, setSessionsLoading] = useState(false)

  // On mount: push any localStorage-cached API keys to the backend, and pull
  // back the heavy assets (audio, images) that localStorage persistence
  // strips — until this runs, auto-save is blocked so a fresh reload can
  // never overwrite a good session with empty state.
  useEffect(() => {
    usePipelineStore.getState().restoreSessionAssets()
    const stored = loadKeysFromStorage()
    if (Object.values(stored).some(v => v)) {
      api.saveSettings({
        falKey: stored.fal || undefined,
        replicateKey: stored.replicate || undefined,
        geminiKey: stored.gemini || undefined,
        elevenlabsKey: stored.elevenlabs || undefined,
        geminigenKey: stored.geminigen || undefined
      }).catch(() => {})
    }
  }, [])

  // Routes share one document scroller. Never carry a deep scroll position
  // into the Editor, where its fixed control row must attach to this header.
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' })
  }, [location.pathname])

  const {
    selectedStory,
    selectedImages,
    selectedVideos,
    timeline,
    selectedThumbnail,
    youtubeMetadata,
    generationState,
    generationPhase,
    imageProgress,
    videoProgress,
    videoPrompts,
    videoJobs,
    settings,
    pauseGeneration,
    resumeGeneration,
    stopGeneration,
    resumeImageGeneration,
    resumeVideoGeneration,
    pauseWindowsVideoGeneration,
    resumeWindowsVideoGeneration,
    cancelWindowsVideoGeneration,
    loadProject,
    autoSaveSession,
    discardDeletedProject,
  } = usePipelineStore()

  // 60s auto-save fallback — catches anything not covered by event triggers
  useEffect(() => {
    const interval = setInterval(() => {
      autoSaveSession()
    }, 60_000)
    return () => clearInterval(interval)
  }, [autoSaveSession])

  const isRunning  = generationState === 'running'
  const isPaused   = generationState === 'paused'
  const isActive   = isRunning || isPaused   // show controls

  const hasPendingImages = imageProgress.pending.length > 0
  const hasPendingVideos = videoProgress.pending.length > 0 || videoPrompts.some(prompt => {
    const job = videoJobs[`${prompt.scene_number}_${prompt.segment_index ?? 0}`]
    return !['completed', 'failed'].includes(job?.status)
  })
  const isWindowsVideoRun = generationPhase === 'videos' && usesWindowsVideoBackend(settings)

  // Progress label shown in header when active
  const progressLabel = (() => {
    if (generationPhase === 'scenePlan') return 'Planning scenes...'
    if (generationPhase === 'images') {
      const done = imageProgress.completed.length
      const total = imageProgress.total
      return `Images ${done}/${total}`
    }
    if (generationPhase === 'videoPrompts') return 'Writing video prompts...'
    if (generationPhase === 'videos') {
      const done = videoProgress.completed.length
      const total = videoProgress.total
      return `Videos ${done}/${total}`
    }
    return null
  })()

  const handleResume = () => {
    if (isWindowsVideoRun) {
      resumeWindowsVideoGeneration().catch(error => {
        toast.error(`Resume failed: ${error.message}`)
      })
    } else if (generationPhase === 'images' && hasPendingImages) {
      resumeImageGeneration()
    } else if (generationPhase === 'videos' && hasPendingVideos) {
      resumeVideoGeneration()
    } else {
      resumeGeneration()
    }
  }

  const handlePause = () => {
    if (isWindowsVideoRun) {
      pauseWindowsVideoGeneration().catch(error => {
        toast.error(`Pause failed: ${error.message}`)
      })
      return
    }
    pauseGeneration()
  }

  const handleStop = () => {
    if (isWindowsVideoRun) {
      cancelWindowsVideoGeneration().catch(error => {
        toast.error(`Stop failed: ${error.message}`)
      })
      return
    }
    stopGeneration()
  }

  const currentStepIndex = steps.findIndex(s => s.path === location.pathname)


  const getStepState = (index) => {
    // Order: Story → Audio → Images → Videos → Editor → Thumbnail/Metadata → Export
    if (index === 0) return selectedStory ? 'completed' : currentStepIndex === 0 ? 'active' : 'upcoming'
    if (index === 1) return selectedStory ? 'completed' : currentStepIndex === 1 ? 'active' : 'upcoming'
    if (index === 2) return Object.keys(selectedImages).length > 0 ? 'completed' : currentStepIndex === 2 ? 'active' : 'upcoming'
    if (index === 3) return Object.keys(selectedVideos).length > 0 ? 'completed' : currentStepIndex === 3 ? 'active' : 'upcoming'
    if (index === 4) return timeline?.built ? 'completed' : currentStepIndex === 4 ? 'active' : 'upcoming'
    if (index === 5) return (selectedThumbnail || youtubeMetadata || currentStepIndex > 5) ? 'completed' : currentStepIndex === 5 ? 'active' : 'upcoming'
    if (index >= 6) return currentStepIndex === index ? 'active' : timeline?.built ? 'available' : 'upcoming'
    return 'upcoming'
  }

  const handleStepClick = (index) => {
    const state = getStepState(index)
    if (state === 'completed' || state === 'available') navigate(steps[index].path)
  }

  const handleOpenSessions = async () => {
    setSessionsOpen(true)
    setSessionsLoading(true)
    try {
      const data = await api.listSessions()
      setSessions(data.sessions || [])
    } catch {
      toast.error('Failed to load sessions')
    }
    setSessionsLoading(false)
  }

  const handleLoadSession = async (sessionId) => {
    const toastId = 'load-session'
    setSessionsOpen(false)
    try {
      toast.loading('Loading session...', { id: toastId })
      const project = await api.loadSession(sessionId)
      loadProject(project)
      toast.success('Session loaded', { id: toastId })
      navigate(resumePathForProject(project))
    } catch (err) {
      toast.error(`Failed to load session: ${err.message}`, { id: toastId })
    }
  }

  const handleDeleteSession = async (e, sessionId) => {
    e.stopPropagation()
    try {
      await api.deleteSession(sessionId)
      if (sessionId === sessionStorage.getItem('pipeline_session_id')) {
        discardDeletedProject(sessionId)
        navigate('/projects')
      }
      setSessions(prev => prev.filter(s => s.id !== sessionId))
      toast.success('Session deleted')
    } catch (error) {
      toast.error(`Failed to delete session: ${error.response?.data?.error || error.message}`)
    }
  }

  const handleLoadProject = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return

    const isZip = file.name.endsWith('.zip') || file.type === 'application/zip'
    const toastId = 'load-project'

    try {
      toast.loading(isZip ? 'Importing ZIP...' : 'Loading project...', { id: toastId })

      let project
      if (isZip) {
        project = await importZipViaWorker(file)
      } else {
        project = JSON.parse(await file.text())
      }

      loadProject(project)
      toast.success('Project loaded', { id: toastId })

      navigate(resumePathForProject(project))
    } catch (err) {
      console.error('Load project error:', err)
      toast.error(`Failed to load project: ${err.message}`, { id: toastId })
    }

    e.target.value = ''
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="fixed top-0 left-0 right-0 h-14 bg-surface/95 backdrop-blur-sm border-b border-border z-50 flex items-center px-5">

        {/* Left — projects link + generation controls */}
        <div className="w-52 flex items-center gap-2 shrink-0">
          <button
            onClick={() => navigate('/projects')}
            title="Projects"
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors shrink-0 ${
              location.pathname === '/projects'
                ? 'bg-accent/10 text-accent'
                : 'hover:bg-surface-raised text-text-secondary hover:text-text-primary'
            }`}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
            </svg>
          </button>
      {/* Sessions browser */}
      <AnimatePresence>
        {sessionsOpen && (
          <SessionsPanel
            sessions={sessions}
            loading={sessionsLoading}
            onLoad={handleLoadSession}
            onDelete={handleDeleteSession}
            onClose={() => setSessionsOpen(false)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
            {isActive && (
              <motion.div
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -8 }}
                className="flex items-center gap-1.5"
              >
                {isPaused ? (
                  <button
                    onClick={handleResume}
                    title="Resume generation"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z"/>
                    </svg>
                    Resume
                  </button>
                ) : (
                  <button
                    onClick={handlePause}
                    title="Pause generation"
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-warning/15 text-warning border border-warning/30 text-xs font-medium hover:bg-warning/25 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
                    </svg>
                    Pause
                  </button>
                )}
                <button
                  onClick={handleStop}
                  title="Stop generation"
                  className="w-7 h-7 flex items-center justify-center rounded-md bg-error/10 text-error border border-error/20 hover:bg-error/20 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M6 6h12v12H6z"/>
                  </svg>
                </button>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Progress text when generating */}
          {isActive && progressLabel && (
            <motion.span
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-xs text-text-secondary hidden xl:block truncate"
            >
              {progressLabel}
            </motion.span>
          )}

          {/* App name + current project name when idle */}
          {!isActive && (
            <div className="flex flex-col min-w-0 leading-tight">
              <span className="text-sm font-semibold text-text-primary tracking-tight">ContentMachine</span>
              <ProjectNameLabel />
            </div>
          )}
        </div>

        {/* Centre — step nav */}
        <div className="flex-1 flex items-center justify-center">
          <div className="flex items-center gap-1">
            {steps.map((step, index) => {
              const state = getStepState(index)
              const isLast = index === steps.length - 1
              return (
                <div key={step.id} className="flex items-center">
                  <button
                    onClick={() => handleStepClick(index)}
                    disabled={state !== 'completed' && state !== 'active' && state !== 'available'}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg transition-all text-sm ${
                      state === 'active'
                        ? 'bg-accent/10 text-accent font-medium cursor-default'
                        : state === 'completed' || state === 'available'
                        ? 'hover:bg-surface-raised text-text-secondary hover:text-text-primary cursor-pointer'
                        : 'opacity-35 cursor-default text-text-secondary'
                    }`}
                  >
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 ${
                      state === 'completed'
                        ? 'bg-accent text-white'
                        : state === 'active'
                        ? 'bg-accent text-white'
                        : state === 'available'
                        ? 'bg-surface-raised border border-accent/50 text-accent'
                        : 'bg-surface-raised border border-border text-text-disabled'
                    }`}>
                      {state === 'completed' ? (
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        index + 1
                      )}
                    </div>
                    <span className="hidden lg:block">{step.label}</span>
                    {(step.id === 'audio' || step.id === 'export') && (
                      <span className="text-[9px] text-text-disabled hidden xl:block">(opt)</span>
                    )}
                  </button>

                  {!isLast && (
                    <div className={`w-6 h-px mx-0.5 ${state === 'completed' ? 'bg-accent/40' : 'bg-border'}`} />
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Right — actions */}
        <div className="w-52 flex items-center justify-end gap-1 shrink-0">
          <input ref={fileInputRef} type="file" accept=".json,.zip" onChange={handleLoadProject} className="hidden" />


          <button
            onClick={() => fileInputRef.current?.click()}
            title="Load project (JSON or ZIP)"
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-raised text-text-secondary hover:text-text-primary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          </button>

          <button
            onClick={handleOpenSessions}
            title="Browse auto-saved sessions"
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-raised text-text-secondary hover:text-text-primary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </button>

          <button
            onClick={() => setSettingsOpen(true)}
            title="Settings"
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-raised text-text-secondary hover:text-text-primary transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          <a
            href="https://github.com/Saganaki22/ContentMachine"
            target="_blank"
            rel="noopener noreferrer"
            title="GitHub"
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-raised text-text-secondary hover:text-text-primary transition-colors"
          >
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
            </svg>
          </a>
        </div>
      </header>

      <main className="pt-14 min-h-screen">
        {children}
      </main>

      <footer className="flex items-center justify-center py-4 border-t border-border bg-surface/50">
        <a
          href="https://github.com/Saganaki22/ContentMachine"
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-text-disabled hover:text-text-secondary transition-colors text-xs"
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/>
          </svg>
          GitHub
        </a>
      </footer>

      <AnimatePresence>
        {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
      </AnimatePresence>

      {/* Real-time generation activity feed */}
      <ActivityFeed />
    </div>
  )
}

// ── Current project name — small subtitle under the logo, click-to-rename ──
function ProjectNameLabel() {
  const { projectName, renameProject } = usePipelineStore()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const inputRef = useRef(null)

  const fallback = sessionStorage.getItem('pipeline_session_id') || 'Untitled project'
  const display = projectName || fallback

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const commit = () => {
    setEditing(false)
    const trimmed = draft.trim()
    if (trimmed && trimmed !== display) renameProject(trimmed)
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        className="!w-36 !py-0 !px-1 !text-[10px] leading-tight"
      />
    )
  }

  return (
    <button
      onClick={() => { setDraft(projectName || ''); setEditing(true) }}
      title="Rename project"
      className="text-[10px] text-text-disabled hover:text-text-secondary truncate max-w-[9.5rem] text-left transition-colors"
    >
      {display}
    </button>
  )
}

// ─── Settings Drawer ─────────────────────────────────────────────────────────

const PROVIDERS = [
  { id: 'fal', name: 'fal.ai', description: 'AI media generation', link: 'https://fal.ai/dashboard/keys' },
  { id: 'replicate', name: 'Replicate', description: 'AI model hosting', link: 'https://replicate.com/account/api-tokens' },
  { id: 'gemini', name: 'Gemini', description: 'Google AI', link: 'https://aistudio.google.com/api-keys' },
  { id: 'elevenlabs', name: 'ElevenLabs', description: 'Voice & audio', link: 'https://elevenlabs.io/app/settings/api-keys' },
  { id: 'geminigen', name: 'GeminiGen', description: 'Veo/Omni video (snapgen.ai)', link: 'https://geminigen.ai' }
]

const FAL_IMAGE_MODELS = [
  { value: 'fal-ai/flux-pro', label: 'Flux Pro' },
  { value: 'fal-ai/flux-2-pro', label: 'Flux 2 Pro' },
  { value: 'fal-ai/flux/schnell', label: 'Flux Schnell (fast)' },
  { value: 'fal-ai/nano-banana-pro', label: 'Nano Banana Pro (Gemini)' },
  { value: 'fal-ai/qwen-image-2512', label: 'Qwen Image 2512' },
  { value: 'fal-ai/z-image/base', label: 'Z-Image Base' },
  { value: 'fal-ai/ideogram/v3', label: 'Ideogram V3' },
  { value: 'fal-ai/stable-diffusion-3.5-large', label: 'SD 3.5 Large' },
]

const REPLICATE_IMAGE_MODELS = [
  { value: 'black-forest-labs/flux-2-pro', label: 'Flux 2 Pro' },
  { value: 'black-forest-labs/flux-1.1-pro', label: 'Flux 1.1 Pro' },
  { value: 'stability-ai/stable-diffusion-3.5-large', label: 'SD 3.5 Large' },
  { value: 'ideogram-ai/ideogram-v3-balanced', label: 'Ideogram V3' },
  { value: 'google/nano-banana-pro', label: 'Nano Banana Pro (Gemini)' },
  { value: 'google/imagen-4', label: 'Imagen 4 (Google · 2K)' },
]

const GEMINI_IMAGE_MODELS = [
  { value: 'gemini-3-pro-image-preview', label: 'Gemini 3 Pro Image (2K)' },
]

// Vertex AI image models — same set Storyforge exposes. Auth comes from the
// service-account JSON files configured in backend/.env, not a UI key.
const VERTEX_IMAGE_MODELS = [
  { value: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image (fast, 1024px)' },
  { value: 'gemini-3.1-flash-lite-image', label: 'Gemini 3.1 Flash Lite Image (fastest)' },
  { value: 'gemini-3-pro-image-preview', label: 'Gemini 3 Pro Image (up to 4K)' },
  { value: 'gemini-3.1-flash-image-preview', label: 'Gemini 3.1 Flash Image (4K, best value)' },
]

const CLAUDE_CLI_MODELS = [
  { value: 'sonnet', label: 'Claude Sonnet (Recommended)' },
  { value: 'opus', label: 'Claude Opus (highest quality)' },
  { value: 'haiku', label: 'Claude Haiku (fastest)' },
]

const REPLICATE_VIDEO_MODELS = [
  { value: 'lightricks/ltx-2-pro', label: 'LTX-2 Pro (best quality)' },
  { value: 'lightricks/ltx-2-fast', label: 'LTX-2 Fast (cheaper · 6–20s)' },
  { value: 'kwaivgi/kling-v3-video', label: 'Kling v3 (cinematic · up to 15s)' },
  { value: 'kwaivgi/kling-v2.5-turbo-pro', label: 'Kling 2.5 Turbo Pro (5s or 10s)' },
]

// GeminiGen (snapgen.ai) models
const GEMINIGEN_VIDEO_MODELS = [
  { value: 'veo-3.1-fast', label: 'Veo 3.1 Fast (fixed 8s clips)' },
  { value: 'grok-3', label: 'Grok (6s / 10s / 15s clips)' },
]

// Minimum playback rate when a clip is stretched over longer audio
const SPEED_FACTOR_OPTIONS = [
  { value: 1,    label: 'Off — never slow down' },
  { value: 0.95, label: 'Up to 95% speed (subtle)' },
  { value: 0.9,  label: 'Up to 90% speed' },
  { value: 0.85, label: 'Up to 85% speed' },
  { value: 0.8,  label: 'Up to 80% speed (recommended)' },
]

function SettingsDrawer({ onClose }) {
  const stored = loadKeysFromStorage()
  const [keys, setKeys] = useState({
    fal: stored.fal || '',
    replicate: stored.replicate || '',
    gemini: stored.gemini || '',
    elevenlabs: stored.elevenlabs || '',
    geminigen: stored.geminigen || ''
  })
  const [validationState, setValidationState] = useState({
    fal: 'unknown', replicate: 'unknown', gemini: 'unknown', elevenlabs: 'unknown', geminigen: 'unknown'
  })
  // Backend-environment capabilities (not UI keys): Vertex service accounts and
  // the local Claude Code CLI.
  const [envStatus, setEnvStatus] = useState({
    vertex: false,
    claudeCli: false,
    vertexError: null,
    windowsWorker: null,
    windowsImage: false,
    windowsNano: false,
  })
  const [validating, setValidating] = useState({})
  const [saving, setSaving] = useState(false)

  const {
    settings,
    setProvider, setModel,
    setClaudeProvider, setClaudeModel,
    setVideoProvider, setVideoModel,
    setVideoClipDuration, setVideoSpeedFactor, setImageVariations, setSceneSheetEnabled,
    setWindowsImageOutputs, setWindowsNanoResolution,
    setSoundEffectsVolume, setBackgroundMusicEnabled, setBackgroundMusicVolume,
    setFilmGrainEnabled, setFilmGrainAmount,
    setAtmosphericGradeEnabled, setAtmosphericGradeAmount,
    setVignetteEnabled, setVignetteAmount,
    setKeysConfigured
  } = usePipelineStore()

  // On open: push any stored keys to the backend and get status
  useEffect(() => {
    const stored = loadKeysFromStorage()
    const hasStored = Object.values(stored).some(v => v)
    if (hasStored) {
      // Push stored keys to backend silently
      api.saveSettings({
        falKey: stored.fal || undefined,
        replicateKey: stored.replicate || undefined,
        geminiKey: stored.gemini || undefined,
        elevenlabsKey: stored.elevenlabs || undefined,
        geminigenKey: stored.geminigen || undefined
      }).catch(() => {})
    }
    api.getSettings().then(status => {
      setValidationState({
        fal: status.fal ? 'valid' : 'unknown',
        replicate: status.replicate ? 'valid' : 'unknown',
        gemini: status.gemini ? 'valid' : 'unknown',
        elevenlabs: status.elevenlabs ? 'valid' : 'unknown',
        geminigen: status.geminigen ? 'valid' : 'unknown'
      })
      setEnvStatus({
        vertex: !!status.vertex,
        claudeCli: !!status.claudeCli,
        vertexError: status.vertexError || null,
        windowsWorker: status.windowsWorker?.configured
          ?? status.windows_worker?.configured
          ?? status.windowsWorker
          ?? null,
        windowsImage: !!status.windowsImage,
        windowsNano: !!status.windowsNano,
      })
      setKeysConfigured({
        fal: !!status.fal,
        replicate: !!status.replicate,
        gemini: !!status.gemini,
        elevenlabs: !!status.elevenlabs,
        geminigen: !!status.geminigen,
        vertex: !!status.vertex,
        claudeCli: !!status.claudeCli,
        whisper: !!status.whisper
      })
    }).catch(() => {})
  }, [])

  const handleKeyChange = (provider, value) => {
    setKeys(prev => ({ ...prev, [provider]: value }))
    if (validationState[provider] !== 'unknown') {
      setValidationState(prev => ({ ...prev, [provider]: 'unknown' }))
    }
  }

  const handleValidate = async (provider) => {
    const key = keys[provider]
    if (!key?.trim()) { toast.error('Enter an API key first'); return }

    setValidating(prev => ({ ...prev, [provider]: true }))
    try {
      const result = await api.validateApiKey(provider, key)
      setValidationState(prev => ({ ...prev, [provider]: result.valid ? 'valid' : 'invalid' }))
      if (result.valid) {
        toast.success(`${PROVIDERS.find(p => p.id === provider)?.name} key validated`)
        setKeysConfigured({ [provider]: true })
        // Save validated key to localStorage
        const stored = loadKeysFromStorage()
        saveKeysToStorage({ ...stored, [provider]: key })
        if (result.warning) toast(result.warning, { icon: '⚠️' })
      } else {
        toast.error(result.error || 'Invalid API key')
      }
    } catch {
      setValidationState(prev => ({ ...prev, [provider]: 'invalid' }))
      toast.error('Validation failed')
    }
    setValidating(prev => ({ ...prev, [provider]: false }))
  }

  const handleClearKey = (provider) => {
    setKeys(prev => ({ ...prev, [provider]: '' }))
    setValidationState(prev => ({ ...prev, [provider]: 'unknown' }))
    setKeysConfigured({ [provider]: false })
    // Clear from localStorage
    const stored = loadKeysFromStorage()
    delete stored[provider]
    saveKeysToStorage(stored)
    // Clear from backend too
    api.saveSettings({ [`${provider}Key`]: '' }).catch(() => {})
    toast.success(`${PROVIDERS.find(p => p.id === provider)?.name} key cleared`)
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await api.saveSettings({
        falKey: keys.fal || undefined,
        replicateKey: keys.replicate || undefined,
        geminiKey: keys.gemini || undefined,
        elevenlabsKey: keys.elevenlabs || undefined,
        geminigenKey: keys.geminigen || undefined
      })
      // Save all non-empty keys to localStorage
      const stored = loadKeysFromStorage()
      const updated = { ...stored }
      if (keys.fal) updated.fal = keys.fal
      if (keys.replicate) updated.replicate = keys.replicate
      if (keys.gemini) updated.gemini = keys.gemini
      if (keys.elevenlabs) updated.elevenlabs = keys.elevenlabs
      if (keys.geminigen) updated.geminigen = keys.geminigen
      saveKeysToStorage(updated)

      const status = await api.getSettings()
      setValidationState({
        fal: status.fal ? 'valid' : 'unknown',
        replicate: status.replicate ? 'valid' : 'unknown',
        gemini: status.gemini ? 'valid' : 'unknown',
        elevenlabs: status.elevenlabs ? 'valid' : 'unknown',
        geminigen: status.geminigen ? 'valid' : 'unknown'
      })
      setEnvStatus({
        vertex: !!status.vertex,
        claudeCli: !!status.claudeCli,
        vertexError: status.vertexError || null,
        windowsWorker: status.windowsWorker?.configured
          ?? status.windows_worker?.configured
          ?? status.windowsWorker
          ?? null,
        windowsImage: !!status.windowsImage,
        windowsNano: !!status.windowsNano,
      })
      setKeysConfigured({ fal: !!status.fal, replicate: !!status.replicate, gemini: !!status.gemini, elevenlabs: !!status.elevenlabs, geminigen: !!status.geminigen, vertex: !!status.vertex, claudeCli: !!status.claudeCli, whisper: !!status.whisper })
      // Refresh displayed keys from storage
      const refreshed = loadKeysFromStorage()
      setKeys({ fal: refreshed.fal || '', replicate: refreshed.replicate || '', gemini: refreshed.gemini || '', elevenlabs: refreshed.elevenlabs || '', geminigen: refreshed.geminigen || '' })
      toast.success('Settings saved')
    } catch {
      toast.error('Failed to save settings')
    }
    setSaving(false)
  }

  const isValid = (p) => validationState[p] === 'valid'

  const StatusDot = ({ provider }) => {
    const state = validationState[provider]
    if (state === 'valid') return (
      <span className="w-2 h-2 rounded-full bg-success shrink-0" />
    )
    if (state === 'invalid') return (
      <span className="w-2 h-2 rounded-full bg-error shrink-0" />
    )
    return <span className="w-2 h-2 rounded-full bg-border shrink-0" />
  }

  const imageModels = settings.imageProvider === 'fal'
    ? FAL_IMAGE_MODELS
    : settings.imageProvider === 'replicate'
    ? REPLICATE_IMAGE_MODELS
    : settings.imageProvider === 'vertex'
    ? VERTEX_IMAGE_MODELS
    : settings.imageProvider === 'windows-image'
    ? [{ value: 'extra-high', label: 'Extra High (Windows Chrome)' }]
    : settings.imageProvider === 'windows-nano-banana'
    ? [{ value: 'Nano Banana 2', label: 'Nano Banana 2 (Windows Veo)' }]
    : GEMINI_IMAGE_MODELS

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50"
        onClick={onClose}
      />
      <motion.div
        initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
        transition={{ type: 'tween', duration: 0.22 }}
        className="fixed right-0 top-0 bottom-0 w-full max-w-[440px] bg-surface border-l border-border z-50 flex flex-col shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">Settings</h2>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-raised text-text-secondary transition-colors">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-7">

          {/* API Keys */}
          <section>
            <h3 className="text-xs font-semibold text-text-disabled uppercase tracking-wider mb-3">API Keys</h3>
            <div className="space-y-3">
              {PROVIDERS.map(provider => (
                <div key={provider.id} className="bg-surface-raised rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2 text-sm font-medium text-text-primary">
                      <StatusDot provider={provider.id} />
                      {provider.name}
                      <span className="text-xs text-text-disabled font-normal">— {provider.description}</span>
                    </label>
                    {isValid(provider.id) && !keys[provider.id] && (
                      <span className="text-xs text-success font-medium">Active</span>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <input
                        type="password"
                        value={keys[provider.id]}
                        onChange={(e) => handleKeyChange(provider.id, e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && keys[provider.id]?.trim() && handleValidate(provider.id)}
                        placeholder={`Paste ${provider.name} key`}
                        className={`w-full pr-8 text-sm ${validationState[provider.id] === 'invalid' ? 'border-error' : ''}`}
                      />
                      {keys[provider.id] && (
                        <button onClick={() => setKeys(prev => ({ ...prev, [provider.id]: '' }))}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-text-disabled hover:text-text-secondary">
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => handleValidate(provider.id)}
                      disabled={!keys[provider.id]?.trim() || validating[provider.id]}
                      className="btn-secondary px-3 text-xs whitespace-nowrap disabled:opacity-40"
                    >
                      {validating[provider.id]
                        ? <div className="w-3.5 h-3.5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                        : 'Test'}
                    </button>
                    {isValid(provider.id) && (
                      <button
                        onClick={() => handleClearKey(provider.id)}
                        title="Clear saved key"
                        className="px-2.5 text-xs rounded-lg border border-error/40 text-error hover:bg-error/10 transition-colors whitespace-nowrap"
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <a
                    href={provider.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-accent hover:text-accent-hover flex items-center gap-1"
                  >
                    Get {provider.name} API
                    <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                  </a>
                </div>
              ))}
            </div>
          </section>

          {/* Documentary underscore — project-level master mix */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-text-disabled uppercase tracking-wider">
                Background Score
              </h3>
              <span className="text-xs font-mono text-text-secondary tabular-nums">
                {settings.backgroundMusicEnabled === false
                  ? 'Off'
                  : `${Math.round((settings.backgroundMusicVolume ?? 1) * 100)}%`}
              </span>
            </div>
            <div className="bg-surface-raised rounded-lg p-3">
              <label className="flex items-center justify-between gap-3 text-xs font-medium text-text-primary">
                <span>Director-selected underscore</span>
                <input
                  type="checkbox"
                  checked={settings.backgroundMusicEnabled !== false}
                  onChange={event => setBackgroundMusicEnabled(event.target.checked)}
                  className="accent-accent"
                />
              </label>
              <input
                type="range"
                min="0"
                max="1.5"
                step="0.05"
                disabled={settings.backgroundMusicEnabled === false}
                value={settings.backgroundMusicVolume ?? 1}
                onChange={event => setBackgroundMusicVolume(Number(event.target.value))}
                className="mt-4 w-full accent-accent disabled:opacity-40"
              />
              <div className="flex justify-between mt-2 text-[10px] text-text-disabled">
                <span>Muted</span>
                <span>Authored 100%</span>
                <span>Boost 150%</span>
              </div>
              <p className="text-[10px] text-text-disabled leading-relaxed mt-2">
                Scales the loudness-normalized score independently from narration and sound effects.
                Changes are saved with this project and used in Editor playback and final render.
              </p>
            </div>
          </section>

          {/* Final-film optical treatment — persisted per project */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-text-disabled uppercase tracking-wider">
                Film Treatment
              </h3>
              <span className="text-[10px] text-text-disabled">Editor + final render</span>
            </div>
            <div className="bg-surface-raised rounded-lg p-3 space-y-5">
              <div>
                <label className="flex items-center justify-between gap-3 text-xs font-medium text-text-primary">
                  <span>
                    Film grain
                    <span className="ml-2 font-mono text-text-secondary">
                      {Math.round((settings.filmGrainAmount ?? 0.32) * 100)}%
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.filmGrainEnabled !== false}
                    onChange={event => setFilmGrainEnabled(event.target.checked)}
                    className="accent-accent"
                  />
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  disabled={settings.filmGrainEnabled === false}
                  value={settings.filmGrainAmount ?? 0.32}
                  onChange={event => setFilmGrainAmount(Number(event.target.value))}
                  className="mt-2 w-full accent-accent disabled:opacity-40"
                />
                <p className="text-[10px] text-text-disabled leading-relaxed mt-1">
                  Fine, animated analog texture—never scratches or heavy VHS damage.
                </p>
              </div>

              <div className="border-t border-border/70 pt-4">
                <label className="flex items-center justify-between gap-3 text-xs font-medium text-text-primary">
                  <span>
                    Cold atmospheric grade
                    <span className="ml-2 font-mono text-text-secondary">
                      {Math.round((settings.atmosphericGradeAmount ?? 0.42) * 100)}%
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.atmosphericGradeEnabled ?? true}
                    onChange={event => setAtmosphericGradeEnabled(event.target.checked)}
                    className="accent-accent"
                  />
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  disabled={settings.atmosphericGradeEnabled === false}
                  value={settings.atmosphericGradeAmount ?? 0.42}
                  onChange={event => setAtmosphericGradeAmount(Number(event.target.value))}
                  className="mt-2 w-full accent-accent disabled:opacity-40"
                />
                <div className="grid grid-cols-3 gap-1.5 mt-2">
                  {[
                    { label: 'Subtle', value: 0.24 },
                    { label: 'Cinema', value: 0.42 },
                    { label: 'Deep', value: 0.62 },
                  ].map(preset => (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() => {
                        setAtmosphericGradeEnabled(true)
                        setAtmosphericGradeAmount(preset.value)
                      }}
                      className={`py-1.5 rounded-md text-[10px] border transition-colors ${
                        (settings.atmosphericGradeEnabled ?? true)
                        && Math.abs((settings.atmosphericGradeAmount ?? 0.42) - preset.value) < 0.005
                          ? 'border-accent/60 bg-accent/10 text-accent'
                          : 'border-border text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] text-text-disabled leading-relaxed mt-2">
                  Low-key blue-gray shadows, restrained desaturation and soft optical haze.
                </p>
              </div>

              <div className="border-t border-border/70 pt-4">
                <label className="flex items-center justify-between gap-3 text-xs font-medium text-text-primary">
                  <span>
                    Four-corner vignette
                    <span className="ml-2 font-mono text-text-secondary">
                      {Math.round((settings.vignetteAmount ?? 0.70) * 100)}%
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    checked={settings.vignetteEnabled !== false}
                    onChange={event => setVignetteEnabled(event.target.checked)}
                    className="accent-accent"
                  />
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  disabled={settings.vignetteEnabled === false}
                  value={settings.vignetteAmount ?? 0.70}
                  onChange={event => setVignetteAmount(Number(event.target.value))}
                  className="mt-2 w-full accent-accent disabled:opacity-40"
                />
                <p className="text-[10px] text-text-disabled leading-relaxed mt-1">
                  Gradually darkens every edge and corner without obscuring the focal subject.
                </p>
              </div>
            </div>
          </section>

          {/* LLM Model */}
          <section>
            <h3 className="text-xs font-semibold text-text-disabled uppercase tracking-wider mb-3">LLM Model</h3>
            <div className="space-y-2">
              <div className="grid grid-cols-5 gap-1.5 bg-surface-raised rounded-lg p-1">
                {[
                  { id: 'fal', label: 'fal.ai', enabled: isValid('fal') },
                  { id: 'replicate', label: 'Replicate', enabled: isValid('replicate') },
                  { id: 'gemini', label: 'Gemini', enabled: isValid('gemini') },
                  { id: 'claude-cli', label: 'Claude (local)', enabled: envStatus.claudeCli }
                ].map(p => (
                  <button key={p.id}
                    onClick={() => setClaudeProvider(p.id)}
                    disabled={!p.enabled}
                    title={p.id === 'claude-cli' && !p.enabled ? 'Claude Code CLI not found on this machine' : undefined}
                    className={`py-1.5 rounded-md text-xs font-medium transition-all disabled:opacity-40 ${
                      settings.claudeProvider === p.id
                        ? 'bg-surface text-text-primary shadow-sm'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >{p.label}</button>
                ))}
              </div>

              {settings.claudeProvider === 'claude-cli' && (
                <>
                  <select value={settings.claudeModel} onChange={e => setClaudeModel(e.target.value)} className="w-full text-sm">
                    {CLAUDE_CLI_MODELS.map(m => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <p className="text-[10px] text-text-disabled leading-relaxed">
                    Runs <span className="font-mono">claude -p</span> on this machine using your Claude subscription — no API key needed.
                  </p>
                </>
              )}
              {settings.claudeProvider === 'gemini' && (
                <select value={settings.claudeModel} onChange={e => setClaudeModel(e.target.value)} className="w-full text-sm">
                  <option value="gemini-3-flash">Gemini 3 Flash (Recommended)</option>
                  <option value="gemini-3.1-pro">Gemini 3.1 Pro</option>
                  <option value="gemini-3-pro">Gemini 3 Pro</option>
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                  <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                </select>
              )}
              {settings.claudeProvider === 'replicate' && (
                <select value={settings.claudeModel} onChange={e => setClaudeModel(e.target.value)} className="w-full text-sm">
                  <option value="google/gemini-2.5-flash">Gemini 2.5 Flash</option>
                  <option value="google/gemini-3-flash">Gemini 3 Flash</option>
                  <option value="google/gemini-3.1-pro">Gemini 3.1 Pro</option>
                  <option value="anthropic/claude-3.5-sonnet">Claude 3.5 Sonnet</option>
                </select>
              )}
              {settings.claudeProvider === 'fal' && (
                <select value={settings.claudeModel} onChange={e => setClaudeModel(e.target.value)} className="w-full text-sm">
                  <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
                </select>
              )}
            </div>
          </section>

          {/* Image Generation */}
          <section>
            <h3 className="text-xs font-semibold text-text-disabled uppercase tracking-wider mb-3">Image Generation</h3>
            <div className="space-y-2">
              <div className="grid grid-cols-3 gap-1.5 bg-surface-raised rounded-lg p-1">
                {[
                  { id: 'fal', label: 'fal.ai', enabled: isValid('fal') },
                  { id: 'replicate', label: 'Replicate', enabled: isValid('replicate') },
                  { id: 'gemini', label: 'Gemini', enabled: isValid('gemini') },
                  { id: 'vertex', label: 'Vertex', enabled: envStatus.vertex },
                  { id: 'windows-image', label: 'Windows', enabled: envStatus.windowsImage },
                  { id: 'windows-nano-banana', label: 'Nano Win', enabled: envStatus.windowsNano },
                ].map(p => (
                  <button key={p.id}
                    onClick={() => setProvider(p.id)}
                    disabled={!p.enabled}
                    title={p.id === 'vertex' && !p.enabled ? (envStatus.vertexError || 'Vertex AI not configured in backend/.env') : undefined}
                    className={`py-1.5 rounded-md text-xs font-medium transition-all disabled:opacity-40 ${
                      settings.imageProvider === p.id
                        ? 'bg-surface text-text-primary shadow-sm'
                        : 'text-text-secondary hover:text-text-primary'
                    }`}
                  >{p.label}</button>
                ))}
              </div>

              <select value={settings.imageModel} onChange={e => setModel(e.target.value)} className="w-full text-sm">
                {imageModels.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
              {settings.imageProvider === 'vertex' && (
                <p className="text-[10px] text-text-disabled leading-relaxed">
                  Uses the GCP service accounts configured in backend/.env — billed to GCP credits, rotates accounts on rate limits.
                </p>
              )}
              {settings.imageProvider === 'windows-image' && (
                <div className="rounded-lg border border-accent/20 bg-accent/[0.06] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-medium text-text-primary">Alternatives per task</p>
                      <p className="text-[9px] text-text-disabled mt-0.5">Windows returns 1–3 unique validated images.</p>
                    </div>
                    <select
                      value={settings.windowsImageOutputs || 3}
                      onChange={event => setWindowsImageOutputs(event.target.value)}
                      className="text-xs w-20"
                    >
                      {[1, 2, 3].map(count => <option key={count} value={count}>{count}</option>)}
                    </select>
                  </div>
                </div>
              )}
              {settings.imageProvider === 'windows-nano-banana' && (
                <div className="rounded-lg border border-accent/20 bg-accent/[0.06] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[10px] font-medium text-text-primary">Windows Veo image queue</p>
                      <p className="text-[9px] text-text-disabled mt-0.5">Queues up to 80 independent images. Prompts can run with one continuity reference or without one.</p>
                    </div>
                    <select
                      value={settings.windowsNanoResolution || '1K'}
                      onChange={event => setWindowsNanoResolution(event.target.value)}
                      className="text-xs w-20"
                      aria-label="Nano Banana resolution"
                    >
                      {['1K', '2K', '4K'].map(value => <option key={value} value={value}>{value}</option>)}
                    </select>
                  </div>
                </div>
              )}
              <label
                className="mt-3 flex items-start gap-3 rounded-xl border border-border bg-surface-raised/60 p-3 cursor-pointer hover:border-accent/35 transition-colors"
                title="Groups 2–6 compatible shots into a continuity sheet. You copy the complete prompt and ordered references, generate the sheet with your preferred provider, upload it, then Content Machine expands each panel into a selectable 16:9 frame. Isolated shots continue through normal image generation."
              >
                <input
                  type="checkbox"
                  checked={!!settings.sceneSheetEnabled}
                  onChange={event => setSceneSheetEnabled(event.target.checked)}
                  className="mt-0.5 accent-accent"
                />
                <span>
                  <span className="flex items-center gap-2 text-xs font-medium text-text-primary">
                    Continuity scene sheets
                    <span className="rounded-full border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[8px] uppercase tracking-wider text-accent">Experimental</span>
                  </span>
                  <span className="block text-[10px] text-text-disabled leading-relaxed mt-1">
                    Author shared environments as multi-shot sheets, upload them manually, then expand and approve each panel. Hover for the full workflow.
                  </span>
                </span>
              </label>
            </div>
          </section>

          {/* Video Generation */}
          <section>
            <h3 className="text-xs font-semibold text-text-disabled uppercase tracking-wider mb-3">Video Generation</h3>
            <div className="grid grid-cols-2 gap-1.5 bg-surface-raised rounded-lg p-1 mb-2">
              {[
                { id: 'fal', label: 'fal.ai (LTX-2)', enabled: isValid('fal') },
                { id: 'replicate', label: 'Replicate', enabled: isValid('replicate') },
                { id: 'geminigen', label: 'Gemini Omni', enabled: isValid('geminigen') },
                {
                  id: 'windows-worker',
                  label: 'Windows Worker',
                  enabled: envStatus.windowsWorker === true,
                }
              ].map(p => (
                <button key={p.id}
                  onClick={() => setVideoProvider(p.id)}
                  disabled={!p.enabled}
                  title={
                    p.id === 'geminigen' && !p.enabled
                      ? 'Add and test a GeminiGen API key above'
                      : p.id === 'windows-worker' && !p.enabled
                        ? 'The shared StoryForge worker broker is not configured'
                        : undefined
                  }
                  className={`py-1.5 rounded-md text-xs font-medium transition-all disabled:opacity-40 ${
                    settings.videoProvider === p.id
                      ? 'bg-surface text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  }`}
                >{p.label}</button>
              ))}
            </div>
            {settings.videoProvider === 'replicate' && (
              <select
                value={settings.videoModel || 'lightricks/ltx-2-pro'}
                onChange={e => setVideoModel(e.target.value)}
                className="w-full text-sm"
              >
                {REPLICATE_VIDEO_MODELS.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            )}
            {settings.videoProvider === 'geminigen' && (
              <div className="space-y-2">
                <select
                  value={settings.videoModel || 'veo-3.1-fast'}
                  onChange={e => {
                    setVideoModel(e.target.value)
                    setVideoClipDuration(null)  // reset to the new model's default
                  }}
                  className="w-full text-sm"
                >
                  {GEMINIGEN_VIDEO_MODELS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
                {settings.videoModel === 'grok-3' && (
                  <div>
                    <label className="text-[10px] text-text-secondary block mb-1">Max clip length</label>
                    <div className="grid grid-cols-3 gap-1.5 bg-surface-raised rounded-lg p-1">
                      {[6, 10, 15].map(d => (
                        <button key={d}
                          onClick={() => setVideoClipDuration(d)}
                          className={`py-1.5 rounded-md text-xs font-medium transition-all ${
                            (settings.videoClipDuration || 15) === d
                              ? 'bg-surface text-text-primary shadow-sm'
                              : 'text-text-secondary hover:text-text-primary'
                          }`}
                        >{d}s</button>
                      ))}
                    </div>
                  </div>
                )}
                <p className="text-[10px] text-text-disabled leading-relaxed">
                  {settings.videoModel === 'grok-3'
                    ? 'Grok via GeminiGen (snapgen.ai) — clips of 6/10/15s. Shots are sized to each scene\'s audio.'
                    : 'Veo 3.1 Fast via GeminiGen (snapgen.ai) — 720p, fixed 8s clips. Scenes with longer audio automatically get multiple sequential shots.'}
                </p>
              </div>
            )}
            {settings.videoProvider === 'windows-worker' && (
              <div className="rounded-lg border border-accent/20 bg-accent/5 p-3">
                <div className="flex items-center justify-between gap-3 mb-1">
                  <span className="text-xs font-medium text-text-primary">StoryForge shared worker</span>
                  <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
                    envStatus.windowsWorker !== true
                      ? 'text-error border-error/20 bg-error/10'
                      : 'text-success border-success/20 bg-success/10'
                  }`}>
                    {envStatus.windowsWorker === true ? 'Configured' : 'Not configured'}
                  </span>
                </div>
                <p className="text-[10px] text-text-secondary leading-relaxed">
                  Generates fixed 8-second, 16:9 silent clips on the external Windows machine.
                  ContentMachine queues durable work through StoryForge; narration and the final
                  audio mix remain independent in this project.
                </p>
              </div>
            )}
          </section>

          {/* Video Timing — how shots are fitted to the narration audio */}
          <section>
            <h3 className="text-xs font-semibold text-text-disabled uppercase tracking-wider mb-3">Video Timing</h3>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-text-secondary block mb-1">Slow-down allowance</label>
                <select
                  value={settings.videoSpeedFactor ?? 0.8}
                  onChange={e => setVideoSpeedFactor(parseFloat(e.target.value))}
                  className="w-full text-sm"
                >
                  {SPEED_FACTOR_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
                <p className="text-[10px] text-text-disabled leading-relaxed mt-1">
                  Lets a clip be played slower to cover more narration — e.g. at 80% an 8s clip covers 10s of audio,
                  so fewer extra shots are needed. Segments under 5s are never created; the audio is split evenly instead.
                </p>
              </div>
              <div>
                <label className="text-[10px] text-text-secondary block mb-1">Image variations per shot</label>
                <div className="grid grid-cols-4 gap-1.5 bg-surface-raised rounded-lg p-1">
                  {[1, 2, 3, 4].map(n => (
                    <button key={n}
                      onClick={() => setImageVariations(n)}
                      className={`py-1.5 rounded-md text-xs font-medium transition-all ${
                        (settings.imageVariations ?? 4) === n
                          ? 'bg-surface text-text-primary shadow-sm'
                          : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >{n}</button>
                  ))}
                </div>
                <p className="text-[10px] text-text-disabled leading-relaxed mt-1">
                  How many image options are generated for each shot — you still pick exactly one.
                </p>
              </div>
            </div>
          </section>

          {/* Director sound effects — project-level master mix */}
          <section>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-text-disabled uppercase tracking-wider">
                Director Sound
              </h3>
              <span className="text-xs font-mono text-text-secondary tabular-nums">
                {Math.round((settings.soundEffectsVolume ?? 1) * 100)}%
              </span>
            </div>
            <div className="bg-surface-raised rounded-lg p-3">
              <label className="text-xs font-medium text-text-primary block mb-2">
                Sound effects level
              </label>
              <input
                type="range"
                min="0"
                max="1.5"
                step="0.05"
                value={settings.soundEffectsVolume ?? 1}
                onChange={event => setSoundEffectsVolume(Number(event.target.value))}
                className="w-full accent-accent"
              />
              <div className="flex justify-between mt-2 text-[10px] text-text-disabled">
                <span>Muted</span>
                <span>Authored 100%</span>
                <span>Boost 150%</span>
              </div>
              <p className="text-[10px] text-text-disabled leading-relaxed mt-2">
                Scales waveform-aligned Director effects only. Narration and music are unchanged.
                The level is saved with this project and used by both Editor playback and final render.
              </p>
            </div>
          </section>
        </div>

        {/* Save footer */}
        <div className="px-5 py-4 border-t border-border">
          <button onClick={handleSave} disabled={saving} className="w-full btn-primary py-2.5 text-sm font-medium">
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </motion.div>
    </>
  )
}

// ── Sessions browser panel ──────────────────────────────────────────────────
function SessionsPanel({ sessions, loading, onLoad, onDelete, onClose }) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const fmt = (iso) => {
    if (!iso) return '—'
    const d = new Date(iso)
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.15 }}
        className="fixed top-16 right-4 z-50 w-96 bg-surface border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Auto-saved Sessions</h2>
            <p className="text-[10px] text-text-disabled mt-0.5">Saved automatically to the output/ folder</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-raised text-text-secondary">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="p-6 text-center text-sm text-text-disabled">Loading...</div>
          ) : sessions.length === 0 ? (
            <div className="p-6 text-center text-sm text-text-disabled">
              No saved sessions yet.<br />
              <span className="text-[10px]">Sessions save automatically as you generate content.</span>
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {sessions.map(s => (
                <li
                  key={s.id}
                  onClick={() => onLoad(s.id)}
                  className="flex items-start gap-3 px-4 py-3 hover:bg-surface-raised cursor-pointer transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-text-primary truncate">{s.title}</p>
                    <p className="text-[10px] text-text-disabled mt-0.5">{fmt(s.saved_at)}</p>
                    <div className="flex gap-2 mt-1">
                      {s.scene_count > 0 && (
                        <span className="text-[9px] bg-surface-raised border border-border rounded px-1.5 py-0.5 text-text-secondary">
                          {s.scene_count} scenes
                        </span>
                      )}
                      {s.has_images && (
                        <span className="text-[9px] bg-surface-raised border border-border rounded px-1.5 py-0.5 text-text-secondary">
                          images
                        </span>
                      )}
                      {s.has_videos && (
                        <span className="text-[9px] bg-surface-raised border border-border rounded px-1.5 py-0.5 text-text-secondary">
                          videos
                        </span>
                      )}
                      {s.has_thumbnail && (
                        <span className="text-[9px] bg-surface-raised border border-border rounded px-1.5 py-0.5 text-text-secondary">
                          thumbnail
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={(e) => onDelete(e, s.id)}
                    className="opacity-0 group-hover:opacity-100 w-6 h-6 flex items-center justify-center rounded text-error hover:bg-error/10 transition-all shrink-0 mt-0.5"
                    title="Delete session"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </motion.div>
    </>
  )
}

export default Layout
