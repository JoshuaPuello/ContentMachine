import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PreviewEngine, planClips } from '../../lib/previewEngine'
import { transitionDefinition } from '../../lib/transitionLibrary'
import AgenticMotionGraphicPreview from './AgenticMotionGraphicPreview'

// ─── SequencePlayer ──────────────────────────────────────────────────────────
// Preview of the studio timeline. React renders structure only: a pool of
// three stacked <video> elements, the overlay stage, the film-treatment
// finish and an off-DOM audio host. All per-frame work — clip pool
// assignment and pre-seeded swaps at cuts, drift steering via playbackRate
// (never seeks during playback), audio neighborhood lifecycle, volume
// automation — lives in lib/previewEngine. Continuous time flows through the
// external preview clock; React state changes only at discrete moments
// (seek, play/pause, end), so the editor tree does not re-render per frame.
// Motion graphics use the renderer's fixed 1920x1080 contract. Other overlays
// share the same normalized timing and geometry rules as their render peers.

const SERIF = { fontFamily: "'Cormorant Garamond', Georgia, serif" }

const OVERLAY_Z = {
  map: 10,
  'chapter-reveal': 20,
  'chapter-active': 20,
  'motion-graphic': 25,
  title: 30,
  'lower-third': 40,
  'date-chip': 50,
}

const CORNER_CLASS = {
  tl: 'top-[6%] left-[5%]',
  tr: 'top-[6%] right-[5%]',
  bl: 'bottom-[8%] left-[5%]',
  br: 'bottom-[8%] right-[5%]',
}

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (v) => { const x = clamp01(v); return x * x * (3 - 2 * x) }

// ── Chapters: cue-synced reveal + countdown connectors ──
function ChapterPanel({ item, t }) {
  const chapters = item.payload?.chapters || []
  const local = t - item.startTime
  const isReveal = item.kind === 'chapter-reveal'
  const cues = useMemo(() => (
    (item.payload?.activationCues || [])
      .filter(c => Number.isFinite(c.offset))
      .sort((a, b) => a.offset - b.offset)
  ), [item.payload?.activationCues])
  const cueFor = (i) => cues.find(c => c.index === i)

  // When a card lands: 64f (2.13s) before its cue, else on a fixed stagger.
  const t0Of = (i) => {
    const cue = cueFor(i)
    return cue ? Math.max(0, cue.offset - 2.13) : 0.67 + i * 1.83
  }

  const passed = cues.filter(c => c.offset <= local)
  const activeIndex = isReveal
    ? (passed.length ? passed[passed.length - 1].index : null)
    : (item.payload?.activeIndex ?? 0)

  return (
    <div
      className="absolute inset-0 bg-[#080810]/95 flex items-center justify-center"
      style={{ zIndex: OVERLAY_Z[item.kind] }}
    >
      <div className="flex items-start justify-center gap-[4%] px-[7%] w-full">
        {chapters.map((ch, i) => {
          const t0 = isReveal ? t0Of(i) : 0
          const cardIn = isReveal ? smooth((local - t0) / 1.4) : 1
          const dimmed = activeIndex !== null && i !== activeIndex
          // Countdown connector: fills over the real wait to the next chapter
          const connStart = isReveal ? (cueFor(i)?.offset ?? t0 + 1.4) : 0
          const connEnd = isReveal
            ? Math.max(connStart + 0.6, cueFor(i + 1)?.offset ?? t0Of(i + 1) + 1.4)
            : 1
          const connP = isReveal ? clamp01((local - connStart) / (connEnd - connStart)) : 1
          return (
            <div key={i} className="flex items-center gap-[4%] flex-1 min-w-0">
              <div
                className="flex flex-col items-center gap-2 flex-1 min-w-0"
                style={{
                  opacity: cardIn * (dimmed ? 0.28 : 1),
                  transform: `translateY(${(1 - cardIn) * 10}px)`,
                }}
              >
                <div
                  className="w-full max-w-[96px] aspect-[3/4] bg-white/5 overflow-hidden rounded-lg"
                  style={{
                    border: `1px solid rgba(254,243,199,${0.25 + 0.5 * (i === activeIndex ? 1 : 0)})`,
                    boxShadow: i === activeIndex ? '0 0 18px rgba(255,255,255,0.25)' : 'none',
                  }}
                >
                  {ch.image ? (
                    <img src={ch.image} alt="" className="w-full h-full object-cover" draggable={false} />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <span style={SERIF} className="text-white/25 text-2xl">{String(i + 1).padStart(2, '0')}</span>
                    </div>
                  )}
                </div>
                <span
                  style={SERIF}
                  className="text-amber-50/90 text-[10px] uppercase tracking-[0.22em] text-center leading-tight w-full"
                >
                  {ch.title}
                </span>
              </div>
              {i < chapters.length - 1 && (
                <div className="relative h-px flex-shrink-0 w-[9%] self-center -mt-6">
                  <div
                    className="absolute inset-y-0 left-0 border-t border-dashed border-white/50"
                    style={{ width: `${connP * 100}%` }}
                  />
                  {isReveal && connP > 0.02 && connP < 0.98 && (
                    <div
                      className="absolute w-1.5 h-1.5 -mt-[3px] rounded-full bg-white/90"
                      style={{ left: `calc(${connP * 100}% - 3px)`, boxShadow: '0 0 6px rgba(255,255,255,0.8)' }}
                    />
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Map: plays the real MP4; simple maps open as an inset card ──
// Split choreography constants — mirror the renderer's mapSplitProgress
// (22 enter / 26 exit frames at 30fps) so the preview matches the render.
export const MAP_SPLIT_ENTER_S = 22 / 30
export const MAP_SPLIT_EXIT_S = 26 / 30
export function mapSplitProgressAt(local, dur) {
  return smooth(local / MAP_SPLIT_ENTER_S) * smooth((dur - local) / MAP_SPLIT_EXIT_S)
}

function MapLayer({ item, t, registerMedia }) {
  const local = t - item.startTime
  const dur = item.endTime - item.startTime
  const src = item.payload?.src || null
  const presentation = item.payload?.presentation || 'split'
  const inset = presentation === 'inset'

  // Inset choreography mirrors the renderer: card in 0.47s, hold to 2.8s,
  // expand over 0.8s to full frame.
  const cardIn = smooth(local / 0.47)
  const e = inset ? smooth((local - 2.8) / 0.8) : 1
  const fadeOut = clamp01((dur - local) / 0.33)
  const fadeIn = inset ? 1 : clamp01(local / 0.33)

  const w0 = 58
  const left = (100 - w0 - 6) * (1 - e)
  const width = w0 + (100 - w0) * e
  const sourceStart = Number(item.payload?.sourceStart) || 0
  const mediaRef = useCallback(
    element => registerMedia(item.id, element, item.startTime - sourceStart),
    [item.id, item.startTime, sourceStart, registerMedia]
  )

  const media = src ? (
    <video
      ref={mediaRef}
      muted
      playsInline
      preload="auto"
      className="w-full h-full object-cover"
    />
  ) : (
    <div className="w-full h-full bg-[#0b0b10] flex flex-col items-center justify-center gap-3">
      {item.payload?.status !== 'failed' && (
        <div className="w-5 h-5 border-2 border-white/25 border-t-white/75 rounded-full animate-spin" />
      )}
      <span style={SERIF} className="text-white/55 text-base uppercase tracking-[0.3em]">
        {item.payload?.status === 'failed' ? 'map failed' : 'map rendering…'}
      </span>
    </div>
  )

  if (presentation === 'split') {
    // The clip stage narrows in lockstep (SplitStageDriver); the map panel
    // slides in from the right so both edges meet at the seam.
    const p = mapSplitProgressAt(local, dur)
    if (p <= 0.001) return null
    return (
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: OVERLAY_Z.map }}>
        <div
          className="absolute inset-y-0 right-0 overflow-hidden bg-black"
          style={{
            width: '50%',
            transform: `translateX(${(1 - p) * 100}%)`,
            borderLeft: '2px solid rgba(236,228,210,0.28)',
            boxShadow: '-18px 0 40px rgba(0,0,0,0.45)',
          }}
        >
          {media}
        </div>
      </div>
    )
  }

  if (presentation === 'corner') {
    const enter = smooth(local / 0.4)
    return (
      <div className="absolute inset-0 pointer-events-none" style={{ zIndex: OVERLAY_Z.map }}>
        <div
          className="absolute overflow-hidden bg-black"
          style={{
            top: '4.5%',
            right: '4%',
            width: '31%',
            aspectRatio: '16 / 9',
            opacity: enter * fadeOut,
            transform: `translateY(${(1 - enter) * -10}px)`,
            borderRadius: 8,
            border: '1px solid rgba(236,228,210,0.5)',
            boxShadow: '0 14px 40px rgba(0,0,0,0.5)',
          }}
        >
          {media}
        </div>
      </div>
    )
  }

  if (!inset) {
    return (
      <div className="absolute inset-0 bg-black" style={{ zIndex: OVERLAY_Z.map, opacity: fadeIn * fadeOut }}>
        {media}
      </div>
    )
  }
  return (
    <div className="absolute inset-0" style={{ zIndex: OVERLAY_Z.map, opacity: fadeOut }}>
      <div className="absolute inset-0 bg-black" style={{ opacity: 0.32 * cardIn * (1 - e) + e }} />
      <div
        className="absolute overflow-hidden bg-black"
        style={{
          left: `${left}%`,
          width: `${width}%`,
          top: `${21 * (1 - e)}%`,
          height: `${58 + 42 * e}%`,
          opacity: cardIn,
          transform: `translateX(${(1 - cardIn) * 24}px)`,
          borderRadius: 10 * (1 - e),
          border: `1px solid rgba(236,228,210,${0.5 * (1 - e)})`,
          boxShadow: `0 ${18 * (1 - e)}px ${44 * (1 - e)}px rgba(0,0,0,0.55)`,
        }}
      >
        {media}
      </div>
    </div>
  )
}

function MotionGraphicLayer({ item, t }) {
  const spec = item.payload?.spec || {}
  const local = t - item.startTime
  const duration = item.endTime - item.startTime
  return (
    <div className="absolute inset-0 overflow-hidden" style={{ zIndex: OVERLAY_Z['motion-graphic'] }}>
      <AgenticMotionGraphicPreview
        spec={spec}
        frame={Math.max(0, Math.round(local * 30))}
        durationInFrames={Math.max(1, Math.round(duration * 30))}
        fps={30}
      />
    </div>
  )
}

function OverlayLayer({ item, t, items, registerMedia }) {
  const z = OVERLAY_Z[item.kind]
  const local = t - item.startTime
  const dur = item.endTime - item.startTime
  switch (item.kind) {
    case 'map':
      return <MapLayer item={item} t={t} registerMedia={registerMedia} />
    case 'motion-graphic':
      return <MotionGraphicLayer item={item} t={t} />
    case 'chapter-reveal':
    case 'chapter-active':
      return <ChapterPanel item={item} t={t} />
    case 'title': {
      // Mirrors the render: footage keeps playing under a progressive dusk
      // scrim; if a dark segment follows directly, the exit deepens to black.
      const nextIsDark = items.some(i =>
        (i.kind === 'chapter-reveal' || i.kind === 'chapter-active' || i.kind === 'map') &&
        i.startTime >= item.endTime - 0.2 && i.startTime <= item.endTime + 5
      )
      const scrimIn = smooth(local / 1.7)
      const outP = nextIsDark ? 1 : clamp01((dur - local) / 0.8)
      const blackout = nextIsDark ? smooth((local - (dur - 0.9)) / 0.85) : 0
      const textIn = smooth(local / 2.2)
      const textOut = clamp01((dur - local) / 0.6)
      const tracking = 0.45 - 0.2 * textIn
      return (
        <div className="absolute inset-0" style={{ zIndex: z }}>
          <div className="absolute inset-0 bg-black" style={{ opacity: 0.58 * scrimIn * outP }} />
          <div
            className="absolute inset-0"
            style={{
              opacity: scrimIn * outP,
              background: 'radial-gradient(ellipse 74% 66% at 50% 50%, rgba(0,0,0,0.16) 0%, rgba(0,0,0,0.62) 100%)',
            }}
          />
          {blackout > 0.001 && <div className="absolute inset-0 bg-[#050505]" style={{ opacity: blackout }} />}
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2"
            style={{ opacity: textIn * textOut }}
          >
            <h2
              style={{ ...SERIF, letterSpacing: `${tracking}em` }}
              className="text-white text-3xl font-semibold uppercase text-center px-10 leading-tight"
            >
              {item.payload?.text}
            </h2>
            {item.payload?.subtitle && (
              <p
                style={{ ...SERIF, opacity: smooth((local - 1.2) / 1) }}
                className="text-white/55 text-sm uppercase tracking-[0.35em]"
              >
                {item.payload.subtitle}
              </p>
            )}
          </div>
        </div>
      )
    }
    case 'lower-third': {
      const inP = smooth(local / 0.55)
      const outP = clamp01((dur - local) / 0.45)
      const textScale = Math.min(2, Math.max(0.75, Number(item.payload?.textScale) || 1.18))
      return (
        <div
          className="absolute left-[5%] bottom-[10%] w-[88%]"
          style={{ zIndex: z, opacity: inP * outP, transform: `translateY(${(1 - inP) * 10}px)` }}
        >
          <div
            className="border-l-2 border-amber-200/70 bg-black/45 pl-3 pr-5 py-1.5"
            style={{
              width: 'fit-content',
              maxWidth: `${100 / textScale}%`,
              transform: `scale(${textScale})`,
              transformOrigin: 'left bottom',
            }}
          >
            <p style={SERIF} className="text-white text-lg font-semibold leading-tight break-words">
              {item.payload?.text}
            </p>
            {item.payload?.subtitle && (
              <p style={SERIF} className="text-white/55 text-[10px] uppercase tracking-[0.22em] mt-0.5">
                {item.payload.subtitle}
              </p>
            )}
          </div>
        </div>
      )
    }
    case 'date-chip': {
      const inP = smooth(local / 0.47)
      const outP = clamp01((dur - local) / 0.4)
      const textScale = Math.min(2, Math.max(0.75, Number(item.payload?.textScale) || 1.22))
      const corner = item.payload?.corner || 'tr'
      const origin = corner.includes('l')
        ? `${corner.includes('t') ? 'left top' : 'left bottom'}`
        : `${corner.includes('t') ? 'right top' : 'right bottom'}`
      return (
        <div
          className={`absolute ${CORNER_CLASS[corner] || CORNER_CLASS.tr}`}
          style={{ zIndex: z, opacity: inP * outP }}
        >
          <span
            style={{
              ...SERIF,
              display: 'inline-block',
              maxWidth: `${68 / textScale}vw`,
              overflowWrap: 'anywhere',
              transform: `scale(${textScale})`,
              transformOrigin: origin,
            }}
            className="px-2.5 py-1 border border-white/25 bg-black/45 text-white/85 text-xs uppercase tracking-[0.28em]"
          >
            {item.payload?.text}
          </span>
        </div>
      )
    }
    default:
      return null
  }
}

// ── Split stage driver ──
// Narrows the clip-video wrapper during split-map windows without ever
// re-rendering the pool: subscribes to the clock and writes style.width
// imperatively, matching MapLayer's slide-in curve frame for frame.
function SplitStageDriver({ items, clock, stageRef }) {
  useEffect(() => {
    const apply = (t) => {
      const stage = stageRef.current
      if (!stage) return
      let p = 0
      for (const item of items) {
        if (item.kind !== 'map') continue
        if ((item.payload?.presentation || 'split') !== 'split') continue
        if (!item.payload?.src) continue
        if (t < item.startTime || t >= item.endTime) continue
        p = Math.max(p, mapSplitProgressAt(t - item.startTime, item.endTime - item.startTime))
      }
      const width = `${100 - 50 * p}%`
      if (stage.style.width !== width) stage.style.width = width
    }
    apply(clock.get())
    let latest = clock.get()
    const unsubscribe = clock.subscribe(time => { latest = time })
    const interval = setInterval(() => apply(latest), 33)
    return () => { unsubscribe(); clearInterval(interval) }
  }, [items, clock, stageRef])
  return null
}

// ── Overlay stage ──
// The only part of the player that re-renders continuously — and only while
// its content actually changes. It subscribes to the preview clock and
// commits at most ~30 state updates/sec into a subtree that contains just
// the active overlays (usually 0–2 small components), the dip-to-black beat
// and the "no picture" placeholder. The video pool, audio host and film
// treatment live outside it and never re-render during playback.
function OverlayStage({ items, clock, registerMedia }) {
  const [t, setT] = useState(clock.get())
  useEffect(() => {
    let latest = clock.get()
    const unsubscribe = clock.subscribe(time => { latest = time })
    const interval = setInterval(() => {
      setT(prev => (prev === latest ? prev : latest))
    }, 33)
    return () => { unsubscribe(); clearInterval(interval) }
  }, [clock])

  const hasPicture = useMemo(() => !!planClips(items, t).active, [items, t])

  const activeOverlays = useMemo(() =>
    items
      .filter(i => OVERLAY_Z[i.kind] && t >= i.startTime && t < i.endTime)
      .sort((a, b) => OVERLAY_Z[a.kind] - OVERLAY_Z[b.kind]),
    [items, t])

  // Dip-to-black transition beat around the exact authored boundary.
  let dipOpacity = 0
  for (const i of items) {
    if (i.kind === 'transition' && transitionDefinition(i.payload?.type).renderType === 'dip') {
      const half = Math.max(0.1, (i.endTime - i.startTime) / 2)
      const d = Math.abs(t - i.startTime)
      if (d < half) dipOpacity = Math.max(dipOpacity, 1 - d / half)
      continue
    }
    if (i.kind !== 'clip' || i.payload?.transitionIn !== 'dip') continue
    const d = Math.abs(t - i.startTime)
    if (d < 0.17) dipOpacity = Math.max(dipOpacity, 1 - d / 0.17)
  }

  return (
    <>
      {!hasPicture && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ zIndex: 4 }}>
          <span style={SERIF} className="text-white/20 text-sm uppercase tracking-[0.4em]">no picture</span>
        </div>
      )}
      {dipOpacity > 0.001 && (
        <div className="absolute inset-0 bg-black pointer-events-none" style={{ zIndex: 5, opacity: dipOpacity }} />
      )}
      {activeOverlays.map(item => (
        <OverlayLayer
          key={item.id}
          item={item}
          t={t}
          items={items}
          registerMedia={registerMedia}
        />
      ))}
    </>
  )
}

// ── Film treatment (static during playback; only settings changes touch it) ──
const FilmTreatment = memo(function FilmTreatment({ filmTreatment }) {
  return (
    <>
      {filmTreatment.atmosphere > 0 && (
        <>
          <div
            className="absolute inset-0 pointer-events-none"
            data-testid="editor-treatment-atmosphere"
            data-treatment-amount={filmTreatment.atmosphere}
            style={{
              zIndex: 57,
              backgroundColor: '#06101a',
              mixBlendMode: 'multiply',
              opacity: filmTreatment.atmosphere * 0.48,
            }}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              zIndex: 58,
              backgroundColor: '#506778',
              mixBlendMode: 'color',
              opacity: filmTreatment.atmosphere * 0.22,
            }}
          />
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              zIndex: 58,
              background: 'radial-gradient(ellipse 68% 56% at 50% 43%, rgba(145,162,170,0.15), transparent 72%)',
              mixBlendMode: 'screen',
              opacity: filmTreatment.atmosphere * 0.26,
            }}
          />
        </>
      )}
      {filmTreatment.grain > 0 && (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          data-testid="editor-treatment-grain"
          data-treatment-amount={filmTreatment.grain}
          style={{ zIndex: 59, opacity: filmTreatment.grain * 0.085, mixBlendMode: 'overlay' }}
        >
          <filter id="editor-film-grain">
            <feTurbulence
              type="fractalNoise"
              baseFrequency="0.82"
              numOctaves="3"
              seed={11}
              stitchTiles="stitch"
            />
            <feColorMatrix type="saturate" values="0" />
          </filter>
          <rect width="100%" height="100%" filter="url(#editor-film-grain)" />
        </svg>
      )}
      {filmTreatment.vignette > 0 && (
        <div
          className="absolute inset-0 pointer-events-none"
          data-testid="editor-treatment-vignette"
          data-treatment-amount={filmTreatment.vignette}
          style={{
            zIndex: 60,
            background: `radial-gradient(ellipse 78% 68% at 50% 48%, transparent 44%, rgba(2,5,9,${filmTreatment.vignette * 0.72}) 100%)`,
          }}
        />
      )}
    </>
  )
})

function SequencePlayer({
  items,
  previewProxies = {},
  clock,
  playheadTime,
  seekVersion = 0,
  playing,
  onPlayingChange,
  onTimeChange,
  duration,
  soundEffectsVolume = 1,
  backgroundMusicVolume = 1,
  filmTreatment = { grain: 0.32, atmosphere: 0.42, vignette: 0.70 },
}) {
  const clipStageRef = useRef(null)
  const slotARef = useRef(null)
  const slotBRef = useRef(null)
  const slotCRef = useRef(null)
  const audioHostRef = useRef(null)

  const tRef = useRef(playheadTime)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const itemsRef = useRef(items)
  itemsRef.current = items
  // Local preview proxies (short-GOP re-encodes) substitute for remote master
  // clips at the media-element level only; payload.src stays canonical.
  const proxiesRef = useRef(previewProxies)
  proxiesRef.current = previewProxies
  const resolveSrc = useCallback((src) => proxiesRef.current[src] || src, [])
  const playheadTimeRef = useRef(playheadTime)
  playheadTimeRef.current = playheadTime
  const durationRef = useRef(duration)
  durationRef.current = duration

  // The engine is created per MOUNT (not per component instance): React 18
  // StrictMode mounts, cleans up, and mounts again in dev — an engine cached
  // in a ref would stay disposed after the first cleanup and silently stop
  // all media maintenance.
  const engineRef = useRef(null)
  useEffect(() => {
    const engine = new PreviewEngine({ resolveSrc })
    engineRef.current = engine
    if (typeof window !== 'undefined') window.__previewEngine = engine
    engine.setVideoSlots([slotARef.current, slotBRef.current, slotCRef.current])
    engine.setAudioHost(audioHostRef.current)
    return () => {
      engine.dispose()
      if (engineRef.current === engine) engineRef.current = null
    }
  }, [resolveSrc])

  // Data flows into the engine; a forced tick keeps the paused frame honest
  // after edits (moves/resizes/mutes/volume changes/proxy arrivals).
  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    engine.update({
      items,
      masters: { music: backgroundMusicVolume, sfx: soundEffectsVolume },
      duration,
    })
    engine.tick(tRef.current, { force: true })
  }, [items, backgroundMusicVolume, soundEffectsVolume, duration, previewProxies])

  // Explicit seeks are authoritative for every mounted media element. This
  // effect fires on seekVersion changes ONLY — routine playhead updates must
  // never re-seek media (that regression starved playback to ~12fps once).
  useEffect(() => {
    if (!seekVersion) return
    const target = Math.max(0, Math.min(durationRef.current, playheadTimeRef.current))
    tRef.current = target
    clock.set(target)
    engineRef.current?.seek(target)
  }, [seekVersion, clock])

  // Play/pause.
  useEffect(() => {
    engineRef.current?.setPlaying(playing, tRef.current)
    if (!playing) onTimeChange(tRef.current)
  }, [playing, onTimeChange])

  // ── Playback clock: one rAF driver, zero React state per frame ──
  useEffect(() => {
    if (!playing) return undefined
    let raf
    let last = performance.now()
    const step = (now) => {
      const dt = (now - last) / 1000
      last = now
      const next = tRef.current + dt
      if (next >= durationRef.current) {
        tRef.current = durationRef.current
        clock.set(durationRef.current)
        onTimeChange(durationRef.current)
        onPlayingChange(false)
        return
      }
      tRef.current = next
      clock.set(next)
      engineRef.current?.tick(next)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [playing, clock, onTimeChange, onPlayingChange])

  // Overlay media (map videos) register through the engine.
  const registerMedia = useCallback((id, el, startTime) => {
    const engine = engineRef.current
    if (!engine) return
    if (el) {
      engine.setOverlayMedia(id, el, startTime)
      if (!el.dataset.init) {
        el.dataset.init = '1'
        const item = itemsRef.current.find(i => i.id === id)
        if (item?.payload?.src) el.src = resolveSrc(item.payload.src)
        try { el.currentTime = Math.max(0, tRef.current - startTime) } catch { /* not ready */ }
        if (playingRef.current) el.play().catch(() => {})
      }
    } else {
      engine.setOverlayMedia(id, null)
    }
  }, [resolveSrc])

  const poolVideoClass = 'absolute inset-0 w-full h-full object-cover'

  return (
    <div
      className="relative w-full max-w-[880px] aspect-video bg-black overflow-hidden rounded-lg border border-border shadow-2xl select-none"
      style={{ isolation: 'isolate' }}
      onClick={() => onPlayingChange(!playing)}
    >
      {/* Picture pool: three stacked decoders; the engine flips visibility at
          cuts so the on-screen element never reloads its src mid-play. The
          wrapper narrows during split-map windows (object-fit cover keeps the
          footage centered in its panel), mirroring the renderer. */}
      <div ref={clipStageRef} className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: '100%' }}>
        <video ref={slotARef} className={poolVideoClass} style={{ zIndex: 1, opacity: 0 }} playsInline preload="auto" />
        <video ref={slotBRef} className={poolVideoClass} style={{ zIndex: 0, opacity: 0 }} playsInline preload="auto" />
        <video ref={slotCRef} className={poolVideoClass} style={{ zIndex: 0, opacity: 0 }} playsInline preload="auto" />
      </div>
      <SplitStageDriver items={items} clock={clock} stageRef={clipStageRef} />

      {/* Cinema overlays (time-driven approximations of the render) */}
      <OverlayStage items={items} clock={clock} registerMedia={registerMedia} />

      {/* Project-owned optical finish — same normalized contract as Remotion. */}
      <FilmTreatment filmTreatment={filmTreatment} />

      {/* Engine-managed audio elements mount here, outside React's tree. */}
      <div ref={audioHostRef} className="hidden" aria-hidden="true" />
    </div>
  )
}

export default SequencePlayer
