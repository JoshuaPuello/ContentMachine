import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import toast from 'react-hot-toast'
import { usePipelineStore } from '../store/pipelineStore'
import { timelineTotalDuration, newItemId } from '../lib/timeline'
import { effectiveFilmTreatment } from '../lib/filmTreatment'
import { createPreviewClock } from '../lib/previewClock'
import SequencePlayer from '../components/editor/SequencePlayer'
import TimelineTracks from '../components/editor/TimelineTracks'
import InspectorPanel from '../components/editor/InspectorPanel'

const STYLE_NAMES = { chronicle: 'Chronicle', heritage: 'Heritage', nocturne: 'Nocturne' }

const fmtTime = (s) => {
  const m = Math.floor(s / 60)
  const sec = s - m * 60
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`
}

const fmtElapsed = (seconds) => {
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

// Live position readout: subscribes to the preview clock so the transport
// updates during playback without re-rendering the editor tree.
function TransportTime({ clock, duration }) {
  const [t, setT] = useState(clock.get())
  useEffect(() => {
    let latest = clock.get()
    const unsubscribe = clock.subscribe(value => { latest = value })
    const interval = setInterval(() => {
      setT(prev => (Math.abs(prev - latest) < 0.05 ? prev : latest))
    }, 100)
    return () => { unsubscribe(); clearInterval(interval) }
  }, [clock])
  return (
    <span className="font-mono text-[11px] text-text-secondary tabular-nums">
      {fmtTime(t)} <span className="text-text-disabled">/ {fmtTime(duration)}</span>
    </span>
  )
}

function EditorTimeline() {
  const navigate = useNavigate()
  const {
    timeline,
    timelineDirty,
    timelineHistory,
    directorRunning,
    directorStage,
    settings,
    selectedStory,
    buildTimeline,
    runDirector,
    addTimelineItem,
    deleteTimelineItem,
    moveTimelineItem,
    resizeTimelineItem,
    updateTimelineItem,
    setTimelineTrackMuted,
    undoTimelineEdit,
    redoTimelineEdit,
    saveTimelineEdits,
    storeAudioAsset,
    previewProxies,
    ensurePreviewProxies,
  } = usePipelineStore()

  const [playheadTime, setPlayheadTime] = useState(0)
  const [seekVersion, setSeekVersion] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [zoom, setZoom] = useState(12)
  const [snap, setSnap] = useState(true)
  const [selectedId, setSelectedId] = useState(null)
  const [inspectorOpen, setInspectorOpen] = useState(false)
  const [addOpen, setAddOpen] = useState(false)
  const [directorElapsedSeconds, setDirectorElapsedSeconds] = useState(0)
  const musicInputRef = useRef(null)

  // External time store: the player's rAF driver writes to it, the playhead
  // cursor / transport readout subscribe imperatively. React state only sees
  // discrete moments (seek, pause, end) via playheadTime.
  const clockRef = useRef(null)
  if (!clockRef.current) {
    clockRef.current = createPreviewClock(0)
    if (typeof window !== 'undefined') window.__previewClock = clockRef.current
  }
  const clock = clockRef.current

  const items = timeline.items
  const duration = useMemo(() => Math.max(timelineTotalDuration(items), 1), [items])
  const selectedItem = selectedId ? items.find(i => i.id === selectedId) : null
  const filmTreatment = useMemo(() => effectiveFilmTreatment(settings), [settings])

  // Kick the preview-proxy build once the timeline exists: remote master
  // clips get local short-GOP stand-ins for smooth playback and scrubbing.
  useEffect(() => {
    if (timeline.built) ensurePreviewProxies()
  }, [timeline.built, ensurePreviewProxies])

  const seek = useCallback((t) => {
    setPlayheadTime(Math.max(0, Math.min(duration, t)))
    setSeekVersion(version => version + 1)
  }, [duration])

  // ── Keyboard: space play/pause, delete removes selection,
  //    ⌘/Ctrl+Z undo, ⌘/Ctrl+Shift+Z (or Ctrl+Y) redo, ⌘/Ctrl+S save ──
  useEffect(() => {
    const onKey = (e) => {
      const tag = e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redoTimelineEdit()
        else undoTimelineEdit()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redoTimelineEdit()
        return
      }
      if (mod && (e.key === 's' || e.key === 'S')) {
        e.preventDefault()
        saveTimelineEdits().then(() => toast.success('Timeline saved'))
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        setPlaying(p => !p)
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        const it = items.find(i => i.id === selectedId)
        if (it && !it.locked) {
          deleteTimelineItem(selectedId)
          setSelectedId(null)
          setInspectorOpen(false)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedId, items, deleteTimelineItem, undoTimelineEdit, redoTimelineEdit, saveTimelineEdits])

  useEffect(() => {
    if (!directorRunning) {
      setDirectorElapsedSeconds(0)
      return undefined
    }
    const startedAt = Date.now()
    const update = () => setDirectorElapsedSeconds(Math.floor((Date.now() - startedAt) / 1000))
    update()
    const interval = window.setInterval(update, 1000)
    return () => window.clearInterval(interval)
  }, [directorRunning])

  const handleRunDirector = () => {
    setPlaying(false)
    runDirector().catch(err => toast.error(`Director failed: ${err.message}`))
  }

  const handleRebuild = () => {
    if (!window.confirm('Reset the timeline to its original state (re-derived from your selections)? Manual edits and Director placements will be discarded.')) {
      return
    }
    setPlaying(false)
    setSelectedId(null)
    setInspectorOpen(false)
    buildTimeline()
    seek(0)
  }

  // ── Add menu ──
  const addAt = (kind) => {
    setAddOpen(false)
    const t = clock.get()
    if (kind === 'title') {
      addTimelineItem({
        id: newItemId('tc'), kind: 'title', startTime: t, endTime: t + 5,
        label: 'Title', payload: { text: selectedStory?.title || 'Title', subtitle: '' },
      })
    } else if (kind === 'lower-third') {
      addTimelineItem({
        id: newItemId('lt'), kind: 'lower-third', startTime: t, endTime: t + 6,
        label: 'Lower third', payload: {
          text: 'Name',
          subtitle: '',
          textScale: settings.lowerThirdScale ?? 1.18,
        },
      })
    } else if (kind === 'date-chip') {
      addTimelineItem({
        id: newItemId('dc'), kind: 'date-chip', startTime: t, endTime: t + 5,
        label: 'Date chip', payload: {
          text: '1875',
          corner: 'tr',
          textScale: settings.dateChipScale ?? 1.22,
        },
      })
    }
  }

  const handleMusicFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    setAddOpen(false)
    if (!file) return

    const objectUrl = URL.createObjectURL(file)
    const probe = new Audio()
    probe.preload = 'metadata'
    probe.src = objectUrl
    probe.addEventListener('loadedmetadata', () => {
      const dur = Number.isFinite(probe.duration) && probe.duration > 0 ? probe.duration : 60
      const id = newItemId('mus')
      addTimelineItem({
        id, kind: 'music', startTime: 0, endTime: Math.round(dur * 100) / 100,
        label: file.name,
        payload: {
          src: objectUrl,
          volume: 0.5,
          fadeInSeconds: 1.6,
          fadeOutSeconds: 3.5,
          duckingDb: -3.5,
          muted: false,
          auto: false,
        },
      })
      // Persist the file into the session so the final render can stage it
      // (object URLs only live in this tab). Swap src once uploaded.
      const reader = new FileReader()
      reader.onload = () => {
        storeAudioAsset(`music_${Date.now().toString(36)}`, reader.result)
          .then(url => updateTimelineItem(id, { payload: { src: url } }))
          .catch(() => toast.error('Music upload failed — track will only play in this tab'))
      }
      reader.readAsDataURL(file)
    })
    probe.addEventListener('error', () => toast.error('Could not read that audio file'))
  }

  const openInspector = useCallback((id) => {
    setSelectedId(id)
    setInspectorOpen(true)
  }, [])

  const deleteFromTracks = useCallback((id) => {
    deleteTimelineItem(id)
    setSelectedId(prev => {
      if (prev === id) {
        setInspectorOpen(false)
        return null
      }
      return prev
    })
  }, [deleteTimelineItem])

  const toggleItemMute = useCallback((id) => {
    const item = usePipelineStore.getState().timeline.items.find(candidate => candidate.id === id)
    if (!item) return
    const soundDesign = item.payload?.spec?.sound_design || item.payload?.soundDesign
    const hasAttachedSound = (soundDesign?.cues || []).some(cue => cue?.asset && cue.status !== 'failed')
    if (hasAttachedSound) {
      updateTimelineItem(id, { payload: { soundMuted: !item.payload?.soundMuted } })
      return
    }
    const muted = !!item.payload?.muted || (item.kind === 'clip' && (item.payload?.volume ?? 0) <= 0)
    const currentVolume = Number(item.payload?.volume)
    updateTimelineItem(id, {
      payload: muted
        ? {
            muted: false,
            volume: Number.isFinite(item.payload?.previousVolume)
              ? item.payload.previousVolume
              : item.kind === 'music' ? 0.5 : 1,
          }
        : {
            muted: true,
            previousVolume: Number.isFinite(currentVolume) && currentVolume > 0
              ? currentVolume
              : item.kind === 'music' ? 0.5 : 1,
          },
    })
  }, [updateTimelineItem])

  const pageVariants = {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 },
  }

  // ── Empty state ──
  if (!timeline.built) {
    return (
      <motion.div
        variants={pageVariants} initial="initial" animate="animate" exit="exit"
        transition={{ duration: 0.2 }}
        className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center"
      >
        <div className="text-center max-w-md px-6">
          <div className="w-12 h-12 mx-auto mb-4 rounded-xl bg-surface-raised border border-border flex items-center justify-center">
            <svg className="w-5 h-5 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 5.25h16.5M3.75 9.75h16.5m-16.5 4.5h16.5m-16.5 4.5h9" />
            </svg>
          </div>
          <h1 className="text-base font-semibold text-text-primary mb-1.5">Studio timeline</h1>
          <p className="text-xs text-text-secondary leading-relaxed mb-5">
            Derive the film from your selected clips and scene narration, then let the
            Director place maps, chapters and titles — everything stays editable.
          </p>
          <button onClick={() => buildTimeline()} className="btn-primary px-6 py-2.5 text-sm font-medium">
            Build timeline from your selections
          </button>
        </div>
      </motion.div>
    )
  }

  return (
    <motion.div
      variants={pageVariants} initial="initial" animate="animate" exit="exit"
      transition={{ duration: 0.2 }}
      className="h-[calc(100vh-3.5rem)] pt-12 flex flex-col bg-background overflow-hidden"
    >
      {/* Fixed directly beneath the global pipeline header. Editor controls
          remain visible even if the document retained a prior scroll offset. */}
      <div className="fixed top-14 left-0 right-0 z-40 h-12 border-b border-border bg-surface/95 backdrop-blur-sm shadow-lg shadow-black/10 flex items-center gap-2.5 px-4">
        <button
          onClick={handleRunDirector}
          disabled={directorRunning}
          title={directorRunning ? `${directorStage || 'Director running'} · ${fmtElapsed(directorElapsedSeconds)} elapsed` : 'Plan and place cinematic elements'}
          className="btn-primary max-w-[24rem] px-4 py-1.5 text-xs font-medium flex items-center gap-2 disabled:opacity-60 min-w-0"
        >
          {directorRunning ? (
            <>
              <div className="w-3 h-3 shrink-0 border-2 border-white/60 border-t-white rounded-full animate-spin" />
              <span className="truncate">{directorStage || 'Director running…'}</span>
              <span className="shrink-0 font-mono text-white/75">{fmtElapsed(directorElapsedSeconds)}</span>
            </>
          ) : (
            <>
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
              Run Director
            </>
          )}
        </button>

        {/* Director options */}
        <div className="flex items-center gap-1">
          <span
            title="Configured before narration on the Story step"
            className={`px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${
              settings.chaptersEnabled
                ? 'bg-accent/10 border-accent/40 text-accent'
                : 'border-border text-text-disabled hover:text-text-secondary'
            }`}
          >
            Chapters
          </span>
          <span
            title="Configured before narration on the Story step"
            className={`px-2 py-1 rounded-md text-[10px] font-medium border transition-colors ${
              settings.trailerIntroEnabled
                ? 'bg-accent/10 border-accent/40 text-accent'
                : 'border-border text-text-disabled hover:text-text-secondary'
            }`}
          >
            Trailer
          </span>
        </div>

        {/* Style pill */}
        <span
          title="Cinema style — change on the Export page"
          className="px-2.5 py-1 rounded-full bg-surface-raised border border-border text-[10px] font-medium text-text-secondary uppercase tracking-wider"
        >
          {STYLE_NAMES[settings.cinemaStyle] || 'Chronicle'}
        </span>

        <div
          className="flex items-center text-[9px] text-text-secondary"
          title={`Full-composite finish · grain ${settings.filmGrainEnabled === false ? 'off' : `${Math.round((settings.filmGrainAmount ?? 0.32) * 100)}%`} · cold grade ${settings.atmosphericGradeEnabled === false ? 'off' : `${Math.round((settings.atmosphericGradeAmount ?? 0.42) * 100)}%`} · vignette ${settings.vignetteEnabled === false ? 'off' : `${Math.round((settings.vignetteAmount ?? 0.70) * 100)}%`}. Visible in this preview and applied after every picture, map, chapter, title and graphic layer in the final render.`}
        >
          <span className="px-2 py-1 rounded border border-border bg-surface-raised whitespace-nowrap">
            Finish · G{settings.filmGrainEnabled === false ? '–' : Math.round((settings.filmGrainAmount ?? 0.32) * 100)}
            {' '}C{settings.atmosphericGradeEnabled === false ? '–' : Math.round((settings.atmosphericGradeAmount ?? 0.42) * 100)}
            {' '}V{settings.vignetteEnabled === false ? '–' : Math.round((settings.vignetteAmount ?? 0.70) * 100)}
          </span>
        </div>

        <div className="flex-1" />

        <button
          onClick={() => navigate('/metadata')}
          className="btn-secondary px-3 py-1.5 text-xs whitespace-nowrap"
        >
          Thumbnail & Metadata →
        </button>

        {/* Zoom */}
        <div className="flex items-center gap-1.5" title="Zoom (px per second)">
          <svg className="w-3.5 h-3.5 text-text-disabled" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <input
            type="range"
            min={4} max={80} step={1}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="!w-28 !p-0 h-1 accent-[var(--accent)] cursor-pointer"
          />
        </div>

        {/* Snap */}
        <button
          onClick={() => setSnap(s => !s)}
          title="Snap to item edges + whole seconds"
          className={`px-2.5 py-1 rounded-md text-[10px] font-medium border transition-colors ${
            snap
              ? 'bg-accent/10 border-accent/40 text-accent'
              : 'border-border text-text-disabled hover:text-text-secondary'
          }`}
        >
          Snap
        </button>

        {/* Add menu */}
        <div className="relative">
          <button
            onClick={() => setAddOpen(o => !o)}
            className="btn-secondary px-2.5 py-1.5 text-xs flex items-center gap-1"
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Add
          </button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setAddOpen(false)} />
              <div className="absolute right-0 top-9 z-40 w-44 bg-surface border border-border rounded-lg shadow-2xl overflow-hidden py-1">
                {[
                  { id: 'title', label: 'Title card' },
                  { id: 'lower-third', label: 'Lower third' },
                  { id: 'date-chip', label: 'Date chip' },
                ].map(opt => (
                  <button
                    key={opt.id}
                    onClick={() => addAt(opt.id)}
                    className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors"
                  >
                    {opt.label} <span className="text-text-disabled">· at playhead</span>
                  </button>
                ))}
                <div className="h-px bg-border my-1" />
                <button
                  onClick={() => musicInputRef.current?.click()}
                  className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors"
                >
                  Music <span className="text-text-disabled">· upload file</span>
                </button>
              </div>
            </>
          )}
          <input
            ref={musicInputRef}
            type="file"
            accept="audio/*"
            onChange={handleMusicFile}
            className="hidden"
          />
        </div>

        {/* Undo / Redo */}
        <div className="flex items-center gap-1">
          <button
            onClick={undoTimelineEdit}
            disabled={!timelineHistory.past.length}
            title="Undo (⌘Z)"
            className="w-7 h-7 flex items-center justify-center rounded-md border border-border text-text-secondary hover:text-text-primary hover:border-accent/50 disabled:opacity-30 disabled:hover:border-border transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3" />
            </svg>
          </button>
          <button
            onClick={redoTimelineEdit}
            disabled={!timelineHistory.future.length}
            title="Redo (⇧⌘Z)"
            className="w-7 h-7 flex items-center justify-center rounded-md border border-border text-text-secondary hover:text-text-primary hover:border-accent/50 disabled:opacity-30 disabled:hover:border-border transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 15l6-6m0 0l-6-6m6 6H9a6 6 0 000 12h3" />
            </svg>
          </button>
        </div>

        {/* Save */}
        <button
          onClick={() => saveTimelineEdits().then(() => toast.success('Timeline saved'))}
          title="Persist the current timeline to the project (⌘S)"
          className={`px-2.5 py-1.5 text-xs rounded-md border transition-colors ${
            timelineDirty
              ? 'bg-accent/10 border-accent/50 text-accent hover:bg-accent/20'
              : 'border-border text-text-secondary hover:text-text-primary'
          }`}
        >
          Save
        </button>

        {/* Reset */}
        <button
          onClick={handleRebuild}
          title="Reset the timeline to its original state derived from your selections (manual edits and Director placements are discarded)"
          className="btn-secondary px-2.5 py-1.5 text-xs"
        >
          Reset
        </button>
      </div>

      {/* ── Preview + inspector ── */}
      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          <div className="flex-1 min-h-0 flex items-center justify-center bg-black/40 px-6 py-4 overflow-hidden">
            <SequencePlayer
              items={items}
              previewProxies={previewProxies}
              clock={clock}
              playheadTime={playheadTime}
              seekVersion={seekVersion}
              playing={playing}
              onPlayingChange={setPlaying}
              onTimeChange={setPlayheadTime}
              duration={duration}
              soundEffectsVolume={settings.soundEffectsVolume ?? 1}
              backgroundMusicVolume={settings.backgroundMusicVolume ?? 1}
              filmTreatment={filmTreatment}
            />
          </div>

          {/* Transport */}
          <div className="h-9 shrink-0 border-t border-border bg-surface flex items-center gap-3 px-4">
            <button
              onClick={() => setPlaying(p => !p)}
              title="Play/Pause (Space)"
              className="w-6 h-6 flex items-center justify-center rounded bg-surface-raised border border-border text-text-primary hover:border-accent/50 transition-colors"
            >
              {playing ? (
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" /></svg>
              ) : (
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              )}
            </button>
            <TransportTime clock={clock} duration={duration} />
            {timelineDirty && (
              <span className="text-[9px] uppercase tracking-wider text-warning border border-warning/30 bg-warning/10 rounded px-1.5 py-0.5">
                edited
              </span>
            )}
            <span className="ml-auto text-[10px] text-text-disabled hidden md:block">
              Space play · Del remove · click maps or double-click other items to inspect · drag ruler to scrub
            </span>
          </div>

          {/* ── Timeline ── */}
          <TimelineTracks
            items={items}
            zoom={zoom}
            snap={snap}
            duration={duration}
            clock={clock}
            onSeek={seek}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onOpenInspector={openInspector}
            onMove={moveTimelineItem}
            onResize={resizeTimelineItem}
            onDelete={deleteFromTracks}
            onToggleMute={toggleItemMute}
            onToggleTrackMute={setTimelineTrackMuted}
          />
        </div>

        {inspectorOpen && selectedItem && (
          <InspectorPanel
            item={selectedItem}
            onClose={() => setInspectorOpen(false)}
            onDeleted={() => { setSelectedId(null); setInspectorOpen(false) }}
          />
        )}
      </div>
    </motion.div>
  )
}

export default EditorTimeline
