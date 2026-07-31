import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { TRACKS, trackOf } from '../../lib/timeline'

// ─── TimelineTracks ──────────────────────────────────────────────────────────
// The NLE strip: seconds ruler, draggable playhead, 5 track lanes and the
// item cards. Drag to move (except locked narration), edge-drag to resize,
// snap to other item edges + whole seconds. All positions are time * zoom.

const ROW_H = 60
const RULER_H = 28
const SNAP_SEC = 0.15
const MIN_DUR = 0.5

const KIND_STYLES = {
  transition:       'bg-cyan-950/85 border-cyan-500/70',
  clip:             'bg-slate-700/70 border-slate-500/50',
  narration:        'bg-emerald-950/85 border-emerald-700/50',
  map:              'bg-red-900/70 border-red-700/60',
  'chapter-reveal': 'bg-indigo-900/70 border-indigo-600/60',
  'chapter-active': 'bg-indigo-900/70 border-indigo-600/60',
  title:            'bg-amber-900/70 border-amber-700/60',
  'lower-third':    'bg-teal-900/70 border-teal-700/60',
  'date-chip':      'bg-zinc-800/85 border-zinc-600/60',
  'motion-graphic': 'bg-fuchsia-950/80 border-fuchsia-600/60',
  music:            'bg-purple-900/70 border-purple-700/60',
  'sound-effect':   'bg-orange-950/80 border-orange-600/60',
}

const fmtTick = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

const waveformCache = new Map()
const waveformPending = new Map()
const waveformQueue = []
let waveformWorkers = 0
let sharedAudioContext = null
const MAX_WAVEFORM_DECODERS = 2

const soundDesignOf = (item) =>
  item.payload?.spec?.sound_design || item.payload?.soundDesign || null

const audioInfo = (item) => {
  const cues = (soundDesignOf(item)?.cues || []).filter(cue => cue?.asset && cue.status !== 'failed')
  const direct = ['clip', 'narration', 'music', 'sound-effect'].includes(item.kind) && item.payload?.src
  const peaks = item.payload?.waveformPeaks
    || cues[0]?.analysis?.waveform_peaks
    || cues[0]?.selected_option?.analysis?.waveform_peaks
    || []
  const muted = cues.length
    ? !!item.payload?.soundMuted
    : !!item.payload?.muted || (item.kind === 'clip' && (item.payload?.volume ?? 0) <= 0)
  return {
    hasAudio: !!direct || cues.length > 0,
    src: item.kind === 'clip' ? null : item.payload?.src || cues[0]?.asset,
    peaks,
    muted,
    cueCount: cues.length,
  }
}

function fallbackPeaks(seed, count = 40) {
  let value = [...String(seed)].reduce((sum, character) => sum + character.charCodeAt(0), 0) || 17
  return Array.from({ length: count }, (_, index) => {
    value = (value * 9301 + 49297 + index) % 233280
    return 0.12 + (value / 233280) * 0.66
  })
}

function summarizePeaks(samples, count = 48) {
  if (!samples?.length) return []
  return Array.from({ length: count }, (_, index) => {
    const from = Math.floor((index / count) * samples.length)
    const to = Math.max(from + 1, Math.floor(((index + 1) / count) * samples.length))
    let peak = 0
    for (let sample = from; sample < to; sample += 1) {
      peak = Math.max(peak, Math.abs(samples[sample] || 0))
    }
    return Math.max(0.05, Math.min(1, peak))
  })
}

const runWaveformQueue = () => {
  while (waveformWorkers < MAX_WAVEFORM_DECODERS && waveformQueue.length) {
    waveformWorkers += 1
    const task = waveformQueue.shift()
    task().finally(() => {
      waveformWorkers -= 1
      runWaveformQueue()
    })
  }
}

const decodeWaveform = (src) => {
  if (!src) return Promise.resolve([])
  if (waveformCache.has(src)) return Promise.resolve(waveformCache.get(src))
  if (waveformPending.has(src)) return waveformPending.get(src)
  const promise = new Promise((resolve) => {
    waveformQueue.push(async () => {
      try {
        const response = await fetch(src)
        if (!response.ok) return resolve([])
        sharedAudioContext ||= new AudioContext()
        const buffer = await sharedAudioContext.decodeAudioData(await response.arrayBuffer())
        const peaks = summarizePeaks(buffer.getChannelData(0))
        waveformCache.set(src, peaks)
        resolve(peaks)
      } catch {
        resolve([])
      } finally {
        waveformPending.delete(src)
      }
    })
    runWaveformQueue()
  })
  waveformPending.set(src, promise)
  return promise
}

function WaveformStrip({ item, info }) {
  const stripRef = useRef(null)
  const canvasRef = useRef(null)
  const [decoded, setDecoded] = useState(() => (
    info.peaks?.length ? summarizePeaks(info.peaks) : waveformCache.get(info.src)
  ))

  useEffect(() => {
    if (info.peaks?.length) {
      setDecoded(summarizePeaks(info.peaks))
      return undefined
    }
    if (waveformCache.has(info.src)) {
      setDecoded(waveformCache.get(info.src))
      return undefined
    }
    setDecoded(undefined)
    return undefined
  }, [info.peaks?.length, info.src])

  useEffect(() => {
    if (decoded?.length || !info.src || !stripRef.current) return undefined
    let active = true
    const decode = () => {
      decodeWaveform(info.src).then(peaks => {
        if (active && peaks.length) setDecoded(peaks)
      })
    }
    if (typeof IntersectionObserver === 'undefined') {
      decode()
      return () => { active = false }
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect()
        decode()
      }
    }, { rootMargin: '320px' })
    observer.observe(stripRef.current)
    return () => {
      active = false
      observer.disconnect()
    }
  }, [decoded, info.src])

  const peaks = useMemo(
    () => (decoded?.length ? decoded : fallbackPeaks(item.id)),
    [decoded, item.id]
  )

  // One cached bitmap instead of ~48 DOM spans per strip: with ~160 audio
  // items that removes thousands of layout boxes from every timeline render.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const W = 192
    const H = 16
    canvas.width = W * 2
    canvas.height = H * 2
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(2, 2)
    ctx.clearRect(0, 0, W, H)
    ctx.fillStyle = 'rgba(255,255,255,0.75)'
    const bar = W / peaks.length
    for (let i = 0; i < peaks.length; i++) {
      const h = Math.max(2, peaks[i] * 14)
      ctx.fillRect(i * bar + bar * 0.15, (H - h) / 2, Math.max(0.5, bar * 0.7), h)
    }
  }, [peaks])

  return (
    <div
      ref={stripRef}
      className={`absolute left-1.5 right-1.5 bottom-1 h-4 ${info.muted ? 'opacity-25' : 'opacity-70'}`}
    >
      <canvas ref={canvasRef} className="w-full h-full" />
    </div>
  )
}

// Transform-only playhead driven by the preview clock: it never re-renders
// the lanes, and its motion is compositor-cheap during playback.
function PlayheadCursor({ clock, zoom, onPointerDown }) {
  const ref = useRef(null)
  useEffect(() => {
    const apply = (t) => {
      if (ref.current) ref.current.style.transform = `translate3d(${t * zoom}px,0,0)`
    }
    apply(clock.get())
    return clock.subscribe(apply)
  }, [clock, zoom])
  return (
    <div
      ref={ref}
      className="absolute top-0 bottom-0 z-20 w-3 -ml-1.5 cursor-ew-resize touch-none will-change-transform"
      style={{ left: 0 }}
      onPointerDown={onPointerDown}
      title="Drag playhead"
    >
      <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-accent pointer-events-none" />
      <div
        className="absolute left-1/2 -translate-x-1/2 top-0 w-0 h-0 border-l-[5px] border-r-[5px] border-t-[7px] border-l-transparent border-r-transparent border-t-accent pointer-events-none"
      />
    </div>
  )
}

function TimelineTracks({
  items, zoom, snap, duration, clock, onSeek,
  selectedId, onSelect, onOpenInspector, onMove, onResize, onDelete, onToggleMute, onToggleTrackMute,
  onAddTransition,
}) {
  const contentRef = useRef(null)
  // Temp position while dragging: { id, start, end, mode }
  const [drag, setDrag] = useState(null)
  // Right-click menu: { x, y, item } in viewport coords
  const [menu, setMenu] = useState(null)

  const contentW = Math.max(680, (duration + 20) * zoom)
  const trackViews = useMemo(() => TRACKS.map(track => {
    const entries = items
      .filter(item => trackOf(item.kind) === track.id)
      .map(item => ({ item, info: audioInfo(item) }))
    const audible = entries.filter(entry => entry.info.hasAudio)
    return {
      track,
      entries,
      audible,
      allMuted: audible.length > 0 && audible.every(entry => entry.info.muted),
    }
  }), [items])

  // Ruler ticks — major step picked so labels never crowd
  const { major, minor } = useMemo(() => {
    const majorStep = [1, 2, 5, 10, 15, 30, 60].find(s => s * zoom >= 64) || 60
    const minorStep = majorStep / 5
    return { major: majorStep, minor: minorStep * zoom >= 7 ? minorStep : null }
  }, [zoom])

  const timeFromEvent = (ev) => {
    const rect = contentRef.current.getBoundingClientRect()
    return Math.max(0, Math.min(duration, (ev.clientX - rect.left) / zoom))
  }

  // ── Playhead scrub (ruler press-drag) ──
  const beginScrub = (e) => {
    e.preventDefault()
    onSeek(timeFromEvent(e))
    const onPointerMove = (ev) => onSeek(timeFromEvent(ev))
    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  // ── Item drag: move or resize with snapping ──
  const beginDrag = (e, item, mode) => {
    e.stopPropagation()
    e.preventDefault()
    onSelect(item.id)
    if (item.locked) return

    const originX = e.clientX
    const orig = { start: item.startTime, end: item.endTime }
    const edges = items
      .filter(i => i.id !== item.id)
      .flatMap(i => [i.startTime, i.endTime])

    // Nearest snap target (other edges + whole seconds) within SNAP_SEC
    const snapAdjust = (val) => {
      if (!snap) return null
      let best = null
      let bestD = SNAP_SEC
      for (const c of [...edges, Math.round(val)]) {
        const d = Math.abs(c - val)
        if (d < bestD) { best = c; bestD = d }
      }
      return best === null ? null : best - val
    }

    let last = { start: orig.start, end: orig.end }

    const onPointerMove = (ev) => {
      const delta = (ev.clientX - originX) / zoom
      let start = orig.start
      let end = orig.end

      if (mode === 'move') {
        const dur = orig.end - orig.start
        start = Math.max(0, orig.start + delta)
        // Snap whichever edge is closest to a target
        const sAdj = snapAdjust(start)
        const eAdj = snapAdjust(start + dur)
        if (sAdj !== null && (eAdj === null || Math.abs(sAdj) <= Math.abs(eAdj))) start += sAdj
        else if (eAdj !== null) start += eAdj
        start = Math.max(0, start)
        end = start + dur
      } else if (mode === 'resize-l') {
        start = Math.max(0, orig.start + delta)
        const adj = snapAdjust(start)
        if (adj !== null) start += adj
        start = Math.max(0, Math.min(start, orig.end - MIN_DUR))
      } else if (mode === 'resize-r') {
        end = orig.end + delta
        const adj = snapAdjust(end)
        if (adj !== null) end += adj
        end = Math.max(orig.start + MIN_DUR, end)
      }

      last = { start, end }
      setDrag({ id: item.id, mode, start, end })
    }

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      setDrag(null)
      if (Math.abs(last.start - orig.start) < 1e-6 && Math.abs(last.end - orig.end) < 1e-6) return
      if (mode === 'move') onMove(item.id, last.start)
      else onResize(item.id, last.start, last.end)
    }

    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const majorTicks = []
  for (let s = 0; s <= duration + 20; s += major) majorTicks.push(s)
  const minorTicks = []
  if (minor) {
    for (let s = 0; s <= duration + 20; s += minor) {
      if (Math.abs(s / major - Math.round(s / major)) > 1e-6) minorTicks.push(s)
    }
  }

  return (
    <div className="flex border-t border-border bg-surface shrink-0">
      {/* Track labels */}
      <div className="w-24 shrink-0 border-r border-border bg-surface z-10">
        <div style={{ height: RULER_H }} className="border-b border-border" />
        {trackViews.map(({ track, audible, allMuted }) => (
          <div
            key={track.id}
            style={{ height: ROW_H }}
            className="flex items-center gap-2 px-2 border-b border-border/60"
          >
            <button
              type="button"
              disabled={audible.length === 0}
              onClick={() => onToggleTrackMute?.(track.id, !allMuted)}
              title={audible.length === 0 ? 'No audio on this layer' : allMuted ? `Unmute all ${track.label} items` : `Mute all ${track.label} items`}
              className={`w-5 h-5 shrink-0 rounded border flex items-center justify-center text-[10px] ${
                allMuted
                  ? 'border-white/15 bg-black/30 text-text-disabled'
                  : 'border-accent/30 bg-accent/10 text-accent'
              } disabled:opacity-20`}
            >
              {allMuted ? '×' : '♪'}
            </button>
            <span className="text-[8px] font-medium uppercase tracking-[0.12em] text-text-secondary truncate">
              {track.label}
            </span>
          </div>
        ))}
      </div>

      {/* Scrollable time area */}
      <div className="flex-1 overflow-x-auto overflow-y-hidden">
        <div ref={contentRef} className="relative" style={{ width: contentW }}>
          {/* Ruler */}
          <div
            style={{ height: RULER_H }}
            className="relative border-b border-border cursor-col-resize bg-surface-raised/40"
            onPointerDown={beginScrub}
          >
            {minorTicks.map(s => (
              <div
                key={`m${s}`}
                className="absolute bottom-0 w-px h-1.5 bg-border"
                style={{ left: s * zoom }}
              />
            ))}
            {majorTicks.map(s => (
              <div key={s} className="absolute bottom-0" style={{ left: s * zoom }}>
                <div className="w-px h-2.5 bg-text-disabled" />
                <span className="absolute bottom-2.5 left-1 text-[9px] font-mono text-text-secondary leading-none">
                  {fmtTick(s)}
                </span>
              </div>
            ))}
          </div>

          {/* Lanes */}
          {trackViews.map(({ track, entries }) => (
            <div
              key={track.id}
              style={{ height: ROW_H }}
              className="relative border-b border-border/60 bg-background/40"
              onPointerDown={(e) => { if (e.target === e.currentTarget) onSelect(null) }}
            >
              {entries
                .map(({ item, info }) => {
                  const isDragging = drag?.id === item.id
                  const start = isDragging ? drag.start : item.startTime
                  const end = isDragging ? drag.end : item.endTime
                  const selected = selectedId === item.id
                  const mapStatus = item.kind === 'map' ? item.payload?.status : null
                  return (
                    <div
                      key={item.id}
                      className={`absolute top-1 bottom-1 rounded border overflow-hidden select-none transition-shadow ${
                        KIND_STYLES[item.kind] || KIND_STYLES['date-chip']
                      } ${selected ? 'ring-1 ring-accent !border-accent shadow-lg shadow-accent/10' : 'hover:brightness-125'} ${
                        item.locked ? 'cursor-default' : 'cursor-grab active:cursor-grabbing'
                      }`}
                      style={{ left: start * zoom, width: Math.max(6, (end - start) * zoom) }}
                      onPointerDown={(e) => {
                        if (e.button === 2) return
                        if (item.kind === 'map') onOpenInspector(item.id)
                        beginDrag(e, item, 'move')
                      }}
                      onDoubleClick={(e) => { e.stopPropagation(); onOpenInspector(item.id) }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        onSelect(item.id)
                        setMenu({ x: e.clientX, y: e.clientY, item })
                      }}
                      title={`${item.label} · ${start.toFixed(1)}s → ${end.toFixed(1)}s`}
                    >
                      <div className={`flex items-center gap-1 px-1.5 pointer-events-none ${info.hasAudio ? 'h-8 pb-0.5' : 'h-full'}`}>
                        {item.locked && (
                          <svg className="w-2.5 h-2.5 text-white/50 shrink-0" fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 2a5 5 0 00-5 5v3H6a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-8a2 2 0 00-2-2h-1V7a5 5 0 00-5-5zm-3 8V7a3 3 0 116 0v3H9z" />
                          </svg>
                        )}
                        <span className="text-[10px] text-white/85 truncate leading-none">{item.label}</span>
                        {mapStatus && mapStatus !== 'ready' && (
                          <span className={`ml-auto shrink-0 text-[8px] uppercase tracking-wider px-1 py-px rounded-sm ${
                            mapStatus === 'failed' ? 'bg-error/30 text-error' : 'bg-white/10 text-white/60'
                          }`}>
                            {mapStatus === 'rendering' ? 'rendering' : mapStatus}
                          </span>
                        )}
                      </div>
                      {info.hasAudio && <WaveformStrip item={item} info={info} />}
                      {info.hasAudio && (
                        <button
                          type="button"
                          title={info.muted ? 'Unmute this item' : 'Mute this item'}
                          aria-label={info.muted ? 'Unmute this item' : 'Mute this item'}
                          className={`absolute right-1 top-1 z-10 w-5 h-5 rounded flex items-center justify-center border ${
                            info.muted
                              ? 'bg-black/65 border-white/20 text-white/45'
                              : 'bg-black/45 border-white/25 text-white/90'
                          }`}
                          onPointerDown={(event) => {
                            event.stopPropagation()
                            event.preventDefault()
                            onToggleMute?.(item.id)
                          }}
                        >
                          <span className="text-[10px] leading-none">{info.muted ? '×' : '♪'}</span>
                        </button>
                      )}
                      {!item.locked && (
                        <>
                          <div
                            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/25"
                            onPointerDown={(e) => beginDrag(e, item, 'resize-l')}
                          />
                          <div
                            className="absolute right-0 top-0 bottom-0 w-1.5 cursor-ew-resize hover:bg-white/25"
                            onPointerDown={(e) => beginDrag(e, item, 'resize-r')}
                          />
                        </>
                      )}
                    </div>
                  )
                })}
            </div>
          ))}

          {/* Playhead — the full-height grab target works during playback too. */}
          <PlayheadCursor clock={clock} zoom={zoom} onPointerDown={beginScrub} />
        </div>
      </div>

      {/* Right-click item menu */}
      {menu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setMenu(null)}
            onContextMenu={(e) => { e.preventDefault(); setMenu(null) }}
          />
          <div
            className="fixed z-50 w-40 bg-surface border border-border rounded-lg shadow-2xl overflow-hidden py-1"
            style={{
              left: Math.min(menu.x, window.innerWidth - 170),
              top: Math.min(menu.y, window.innerHeight - 96),
            }}
          >
            <button
              onClick={() => { onOpenInspector(menu.item.id); setMenu(null) }}
              className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors"
            >
              Inspect
            </button>
            <button
              onClick={() => {
                onToggleMute?.(menu.item.id)
                setMenu(null)
              }}
              disabled={!audioInfo(menu.item).hasAudio}
              className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary disabled:opacity-40 transition-colors"
            >
              {audioInfo(menu.item).muted ? 'Unmute audio' : 'Mute audio'}
            </button>
            {menu.item.kind === 'clip' && (
              <button
                onClick={() => {
                  onAddTransition?.(menu.item.id)
                  setMenu(null)
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-raised hover:text-text-primary transition-colors"
              >
                Add transition before
              </button>
            )}
            <button
              onClick={() => {
                if (!menu.item.locked) onDelete?.(menu.item.id)
                setMenu(null)
              }}
              disabled={menu.item.locked}
              className="w-full text-left px-3 py-1.5 text-xs text-error hover:bg-error/10 disabled:opacity-40 disabled:hover:bg-transparent transition-colors"
            >
              {menu.item.locked ? 'Delete (locked)' : 'Delete'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// Memoized: with the playhead reading the clock imperatively, the lanes only
// re-render when timeline data, zoom, selection or handlers actually change.
export default memo(TimelineTracks)
