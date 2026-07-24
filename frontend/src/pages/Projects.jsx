import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { usePipelineStore } from '../store/pipelineStore'
import api from '../services/api'
import toast from 'react-hot-toast'

// Furthest unlocked step for a saved session, from its progress summary.
// Resume at the next real stage. Selected videos do not imply that the Editor,
// metadata, or Export work has already happened.
const furthestPath = (progress) => {
  if (!progress) return '/'
  if (progress.hasTimeline) {
    return progress.hasMetadata || progress.hasThumbnail ? '/export' : '/metadata'
  }
  if (progress.videosSelected > 0) return '/editor'
  if (progress.imagesSelected > 0) return '/videos'
  if (progress.hasAudio) return '/images'
  if (progress.hasStory) return '/audio'
  return '/'
}

const fmtDate = (iso) => {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Small progress chip — dims when the step has no content yet
function Chip({ label, active }) {
  return (
    <span className={`text-[9px] rounded px-1.5 py-0.5 border ${
      active
        ? 'bg-surface-raised border-border text-text-secondary'
        : 'bg-transparent border-border/60 text-text-disabled'
    }`}>
      {label}
    </span>
  )
}

function ProjectCard({ session, isCurrent, onOpen, onRename, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState(session.name)
  const [deleteArmed, setDeleteArmed] = useState(false)
  const [opening, setOpening] = useState(false)
  const inputRef = useRef(null)
  const disarmTimer = useRef(null)

  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  useEffect(() => () => clearTimeout(disarmTimer.current), [])

  const commitRename = async () => {
    setEditing(false)
    const trimmed = nameDraft.trim()
    if (!trimmed || trimmed === session.name) {
      setNameDraft(session.name)
      return
    }
    await onRename(session.id, trimmed)
  }

  const handleDeleteClick = () => {
    if (!deleteArmed) {
      // Two-step delete: first click arms, second click confirms.
      // Auto-disarms after 4s so an armed button never lingers.
      setDeleteArmed(true)
      clearTimeout(disarmTimer.current)
      disarmTimer.current = setTimeout(() => setDeleteArmed(false), 4000)
      return
    }
    clearTimeout(disarmTimer.current)
    onDelete(session.id)
  }

  const handleOpen = async () => {
    setOpening(true)
    try {
      await onOpen(session)
    } finally {
      setOpening(false)
    }
  }

  const p = session.progress || {}

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className={`bg-surface border rounded-lg overflow-hidden flex flex-col transition-colors ${
        isCurrent ? 'border-accent/50' : 'border-border hover:border-border-hover'
      }`}
    >
      {/* Thumbnail */}
      <div className="relative aspect-video bg-surface-raised">
        {session.thumbnailUrl ? (
          <img
            src={session.thumbnailUrl}
            alt=""
            loading="lazy"
            className="absolute inset-0 w-full h-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-surface-raised via-surface to-accent/10 flex items-center justify-center">
            <svg className="w-8 h-8 text-text-disabled" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
            </svg>
          </div>
        )}
        {isCurrent && (
          <span className="absolute top-2 left-2 flex items-center gap-1.5 bg-accent/90 text-white text-[10px] font-medium rounded-full px-2 py-0.5 backdrop-blur-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
            Open
          </span>
        )}
      </div>

      {/* Body */}
      <div className="p-3 flex flex-col gap-2 flex-1">
        {/* Name — inline editable */}
        {editing ? (
          <input
            ref={inputRef}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') { setNameDraft(session.name); setEditing(false) }
            }}
            className="text-sm font-medium !py-1 !px-2"
          />
        ) : (
          <button
            onClick={() => { setNameDraft(session.name); setEditing(true) }}
            title="Rename project"
            className="group/name flex items-center gap-1.5 text-left min-w-0"
          >
            <span className="text-sm font-medium text-text-primary truncate">{session.name}</span>
            <svg className="w-3 h-3 shrink-0 text-text-disabled opacity-0 group-hover/name:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        )}

        <p className="text-[10px] text-text-disabled">{fmtDate(session.updatedAt)}</p>

        {/* Progress chips */}
        <div className="flex flex-wrap gap-1.5">
          <Chip label={p.hasStory ? 'Story' : 'No story'} active={p.hasStory} />
          <Chip label={p.hasAudio ? 'Audio' : 'No audio'} active={p.hasAudio} />
          <Chip label={`${p.imagesSelected || 0} images`} active={(p.imagesSelected || 0) > 0} />
          <Chip label={`${p.videosSelected || 0} videos`} active={(p.videosSelected || 0) > 0} />
          {p.scenes > 0 && <Chip label={`${p.scenes} scenes`} active />}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 mt-auto pt-1">
          <button
            onClick={handleOpen}
            disabled={opening}
            className="btn-primary flex-1 !py-1.5 text-xs"
          >
            {opening ? 'Opening...' : 'Open'}
          </button>
          <button
            onClick={handleDeleteClick}
            onMouseLeave={() => { clearTimeout(disarmTimer.current); setDeleteArmed(false) }}
            title={deleteArmed ? 'Click again to permanently delete' : 'Delete project'}
            className={`px-2.5 py-1.5 text-xs rounded-lg border transition-colors whitespace-nowrap ${
              deleteArmed
                ? 'bg-error text-white border-error'
                : 'border-error/40 text-error hover:bg-error/10'
            }`}
          >
            {deleteArmed ? 'Confirm delete' : 'Delete?'}
          </button>
        </div>
      </div>
    </motion.div>
  )
}

function Projects() {
  const navigate = useNavigate()
  const [sessions, setSessions] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const { startNewProject, openProject, renameProject } = usePipelineStore()

  const currentId = sessionStorage.getItem('pipeline_session_id')

  const fetchSessions = useCallback(async () => {
    try {
      const data = await api.listSessions()
      setSessions(data.sessions || [])
    } catch {
      toast.error('Failed to load projects')
    }
    setLoading(false)
  }, [])

  useEffect(() => { fetchSessions() }, [fetchSessions])

  useEffect(() => {
    if (sessions.length === 0) return undefined
    const warm = () => sessions.forEach(session => api.prefetchSession(session.id))
    const timer = window.setTimeout(warm, 0)
    return () => window.clearTimeout(timer)
  }, [sessions])

  const handleNewProject = async () => {
    setCreating(true)
    try {
      await startNewProject()
      navigate('/')
    } catch (err) {
      toast.error(`Failed to start new project: ${err.message}`)
      setCreating(false)
    }
  }

  const handleOpen = async (session) => {
    const toastId = 'open-project'
    try {
      toast.loading('Opening project...', { id: toastId })
      await openProject(session.id)
      toast.success('Project opened', { id: toastId })
      navigate(furthestPath(session.progress))
    } catch (err) {
      toast.error(`Failed to open project: ${err.message}`, { id: toastId })
    }
  }

  const handleRename = async (id, name) => {
    try {
      if (id === currentId) {
        // Current session — keep the store's projectName in sync too
        await renameProject(name)
      } else {
        await api.renameSession(id, name)
      }
      setSessions(prev => prev.map(s => s.id === id ? { ...s, name } : s))
    } catch (err) {
      toast.error(`Rename failed: ${err.message}`)
    }
  }

  const handleDelete = async (id) => {
    try {
      await api.deleteSession(id)
      setSessions(prev => prev.filter(s => s.id !== id))
      toast.success('Project deleted')
    } catch (error) {
      toast.error(`Failed to delete project: ${error.response?.data?.error || error.message}`)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="min-h-[calc(100vh-3.5rem)] p-8"
    >
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-end justify-between mb-6">
          <div>
            <h1 className="text-xl font-semibold text-text-primary tracking-tight">Projects</h1>
            <p className="text-xs text-text-secondary mt-1">
              Auto-saved to the output/ folder — every project keeps its full pipeline state.
            </p>
          </div>
          <button
            onClick={handleNewProject}
            disabled={creating}
            className="btn-primary flex items-center gap-2 text-sm"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            {creating ? 'Creating...' : 'New Project'}
          </button>
        </div>

        {/* Grid */}
        {loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="skeleton aspect-[4/3] rounded-lg" />
            ))}
          </div>
        ) : sessions.length === 0 ? (
          <div className="border border-dashed border-border rounded-lg py-20 flex flex-col items-center justify-center text-center">
            <svg className="w-10 h-10 text-text-disabled mb-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
            <p className="text-sm text-text-secondary">No projects yet</p>
            <p className="text-xs text-text-disabled mt-1">Projects save automatically as you generate content.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {sessions.map(s => (
              <ProjectCard
                key={s.id}
                session={s}
                isCurrent={s.id === currentId}
                onOpen={handleOpen}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </div>
        )}
      </div>
    </motion.div>
  )
}

export default Projects
