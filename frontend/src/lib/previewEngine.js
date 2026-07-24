// ─── Preview engine ──────────────────────────────────────────────────────────
// Imperative playback core for the studio editor. React renders structure
// (pool video elements, overlay components, chrome); this engine owns the
// per-frame work: which clip plays on which pooled <video>, pre-seeded swaps
// at cuts (the visible element never has its src reassigned mid-play), audio
// element lifecycle for the sliding neighborhood, volume automation
// (fades/ducking/masters), and bounded drift correction via playbackRate —
// never by seeking a playing element.
//
// The pure planning/math helpers are exported for unit tests.

const clamp01 = (v) => Math.max(0, Math.min(1, v))
const smooth = (v) => { const x = clamp01(v); return x * x * (3 - 2 * x) }

export const clipLocalTime = (item, t) =>
  (t - item.startTime) * (item.payload?.playbackRate ?? 1) + (item.payload?.startFrom || 0)

const soundDesignOf = (item) =>
  item.payload?.spec?.sound_design || item.payload?.soundDesign || null

// ── Clip planning ────────────────────────────────────────────────────────────

// Active clip = the latest-starting clip covering t (matches the previous
// player's tie-break for overlapping clips). upcoming = the next two clips
// after it in start order that still end after t.
export const planClips = (items, t) => {
  const clips = []
  for (const item of items) {
    if (item.kind === 'clip' && item.payload?.src) clips.push(item)
  }
  clips.sort((a, b) => a.startTime - b.startTime)
  let active = null
  let activeIndex = -1
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]
    if (t >= c.startTime && t < c.endTime) { active = c; activeIndex = i }
  }
  const upcoming = []
  const from = activeIndex >= 0 ? activeIndex + 1 : 0
  for (let i = from; i < clips.length && upcoming.length < 2; i++) {
    if (clips[i].endTime > t && clips[i] !== active) upcoming.push(clips[i])
  }
  return { active, upcoming }
}

// Assign {active, upcoming} onto 3 pool slots with maximum stability: a clip
// already prepared on a slot stays there (so becoming visible costs nothing),
// and only freed slots take new prep work. `locked` slots (e.g. the outgoing
// side of a crossfade) are left untouched.
export const poolAssign = (prev, plan, { locked = [] } = {}) => {
  const slots = prev.slots.map(s => ({ ...s }))
  const lockedSet = new Set(locked)
  const want = [plan.active, ...plan.upcoming].filter(Boolean).slice(0, slots.length)

  const held = new Map()
  slots.forEach((slot, index) => { if (slot.clipId) held.set(slot.clipId, index) })

  const assigned = new Map() // clipId -> slot index
  for (const clip of want) {
    if (held.has(clip.id)) assigned.set(clip.id, held.get(clip.id))
  }
  const used = new Set(assigned.values())
  const free = slots.map((_, i) => i).filter(i => !used.has(i) && !lockedSet.has(i))
  for (const clip of want) {
    if (!assigned.has(clip.id)) {
      const idx = free.shift()
      if (idx === undefined) break
      assigned.set(clip.id, idx)
    }
  }
  for (const [clipId, index] of assigned) slots[index] = { clipId }

  let visible = -1
  let coldStart = false
  if (plan.active) {
    visible = assigned.get(plan.active.id) ?? -1
    coldStart = visible >= 0 && !held.has(plan.active.id)
  }
  return { slots, visible, coldStart }
}

// ── Audio planning ───────────────────────────────────────────────────────────

// Expand narration-script sound-design cues into playable pseudo-items.
export const sfxCueItems = (items, masterVolume) => {
  const master = Math.min(1.5, Math.max(0, Number(masterVolume) || 0))
  const out = []
  for (const item of items) {
    if (item.payload?.soundMuted) continue
    const cues = soundDesignOf(item)?.cues || []
    cues.forEach((cue, index) => {
      if (!cue?.asset || cue.status === 'failed') return
      const visualBeat = item.startTime + Math.max(0, Number(cue.at_seconds) || 0)
      const anchor = Math.max(0, Number(cue.anchor_seconds) || 0)
      const startTime = Math.max(0, visualBeat - anchor)
      const duration = Math.max(0.08, Number(cue.duration_seconds) || 1)
      const gainDb = Math.max(-36, Math.min(0, Number.isFinite(Number(cue.gain_db)) ? Number(cue.gain_db) : -14))
      out.push({
        id: `${item.id}:sfx:${cue.id || index}`,
        kind: 'sound-effect',
        startTime,
        endTime: startTime + duration,
        payload: {
          src: cue.asset,
          volume: Math.min(1, (10 ** (gainDb / 20)) * master),
          masterApplied: true,
        },
      })
    })
  }
  return out
}

// Which audio items should have a mounted element around time t, and which
// of those are audible right now.
export const audioWindow = (items, t, { behind = 4, ahead = 18 } = {}) => {
  const out = []
  for (const item of items) {
    if (item.kind !== 'narration' && item.kind !== 'music' && item.kind !== 'sound-effect') continue
    if (!item.payload?.src || item.payload?.muted) continue
    if (item.endTime <= t - behind || item.startTime >= t + ahead) continue
    out.push({ item, active: t >= item.startTime && t < item.endTime })
  }
  return out
}

export const musicVolumeAt = (item, time, masterVolume, narrationActive) => {
  if (item.payload?.muted) return 0
  const local = Math.max(0, time - item.startTime)
  const duration = Math.max(0.01, item.endTime - item.startTime)
  const fadeIn = Math.max(0, Number(item.payload?.fadeInSeconds) || 0)
  const fadeOut = Math.max(0, Number(item.payload?.fadeOutSeconds) || 0)
  const inLevel = fadeIn > 0 ? smooth(local / fadeIn) : 1
  const outLevel = fadeOut > 0 ? smooth((duration - local) / fadeOut) : 1
  const duckDb = Math.max(-12, Math.min(0, Number(item.payload?.duckingDb) || -3.5))
  const duck = narrationActive ? 10 ** (duckDb / 20) : 1
  return Math.min(1, Math.max(0,
    (Number(item.payload?.volume) || 0) * Math.min(1.5, Math.max(0, Number(masterVolume) || 0))
      * inLevel * outLevel * duck
  ))
}

// ── Drift policy ─────────────────────────────────────────────────────────────
// drift = element position − expected position (seconds). Small drift is
// steered out with a bounded playbackRate nudge (±2%, invisible on muted
// picture); gross drift (a stalled element) is the only case allowed to
// request a hard resync.
export const driftAdjustedRate = (baseRate, drift) => {
  if (Math.abs(drift) > 0.6) return { rate: baseRate, resync: true }
  if (Math.abs(drift) <= 0.02) return { rate: baseRate, resync: false }
  const factor = Math.max(0.98, Math.min(1.02, 1 - drift * 0.2))
  return { rate: baseRate * factor, resync: false }
}

// ── The engine ───────────────────────────────────────────────────────────────

const CROSSFADE_S = 0.27
const DIP_S = 0.17

export class PreviewEngine {
  constructor({ resolveSrc = (s) => s, onEnded = () => {}, onActiveClipChange = () => {} } = {}) {
    this.resolveSrc = resolveSrc
    this.onEnded = onEnded
    this.onActiveClipChange = onActiveClipChange
    this.items = []
    this.audioItems = []
    this.playing = false
    this.masters = { music: 1, sfx: 1 }
    this.slotEls = []
    this.audioHost = null
    this.overlayMedia = new Map() // id -> { el, startTime }
    this.audioEls = new Map() // itemId -> audio element
    this.pool = { slots: [], visible: -1 }
    this.activeClipId = null
    this.swapLock = null // { slotIndex, until }
    this.lastMaintain = 0
    this.duration = 0
    this.disposed = false
  }

  setVideoSlots(elements) {
    this.slotEls = elements.filter(Boolean)
    if (this.pool.slots.length !== this.slotEls.length) {
      this.pool = { slots: this.slotEls.map(() => ({ clipId: null })), visible: -1 }
    }
  }

  setAudioHost(el) { this.audioHost = el }

  setOverlayMedia(id, el, startTime) {
    if (el) this.overlayMedia.set(id, { el, startTime })
    else this.overlayMedia.delete(id)
  }

  update({ items, masters, duration }) {
    if (items) {
      this.items = items
      this.audioItems = [
        ...items,
        ...sfxCueItems(items, (masters || this.masters).sfx),
      ].filter(i =>
        (i.kind === 'narration' || i.kind === 'music' || i.kind === 'sound-effect')
        && i.payload?.src && !i.payload?.muted
      )
      this.itemById = new Map(this.audioItems.map(i => [i.id, i]))
    }
    if (masters) this.masters = masters
    if (duration != null) this.duration = duration
  }

  clipById(id) {
    if (!id) return null
    for (const item of this.items) if (item.id === id) return item
    return null
  }

  // ── transport ──
  setPlaying(playing, t) {
    this.playing = playing
    const visibleEl = this.slotEls[this.pool.visible]
    if (playing) {
      if (visibleEl && this.pool.visible >= 0) {
        const clip = this.clipById(this.pool.slots[this.pool.visible]?.clipId)
        if (clip) {
          try { visibleEl.currentTime = clipLocalTime(clip, t) } catch { /* not ready */ }
          visibleEl.play().catch(() => {})
        }
      }
      for (const [id, el] of this.audioEls) {
        const item = this.itemById?.get(id)
        if (!item) continue
        if (t >= item.startTime && t < item.endTime) {
          try { el.currentTime = Math.max(0, t - item.startTime) } catch { /* not ready */ }
          el.play().catch(() => {})
        }
      }
      for (const { el, startTime } of this.overlayMedia.values()) {
        try { el.currentTime = Math.max(0, t - startTime) } catch { /* not ready */ }
        el.play().catch(() => {})
      }
    } else {
      for (const el of this.slotEls) el.pause()
      for (const el of this.audioEls.values()) el.pause()
      for (const { el } of this.overlayMedia.values()) el.pause()
    }
  }

  // Explicit user seek: authoritative for every mounted media element.
  seek(t) {
    this.swapLock = null
    this.tick(t, { force: true })
    const clip = this.clipById(this.pool.slots[this.pool.visible]?.clipId)
    const visibleEl = this.slotEls[this.pool.visible]
    if (visibleEl && clip) {
      try { visibleEl.currentTime = clipLocalTime(clip, t) } catch { /* not ready */ }
      if (this.playing) visibleEl.play().catch(() => {})
    }
    for (const [id, el] of this.audioEls) {
      const item = this.itemById?.get(id)
      if (!item) continue
      const active = t >= item.startTime && t < item.endTime
      if (!active) { el.pause(); continue }
      try { el.currentTime = Math.max(0, t - item.startTime) } catch { /* not ready */ }
      if (this.playing) el.play().catch(() => {})
    }
    for (const { el, startTime } of this.overlayMedia.values()) {
      try { el.currentTime = Math.max(0, t - startTime) } catch { /* not ready */ }
      if (this.playing) el.play().catch(() => {})
    }
  }

  // ── per-frame maintenance ──
  tick(t, { force = false } = {}) {
    if (this.disposed || !this.slotEls.length) return
    const now = performance.now()
    const due = force || now - this.lastMaintain >= 100 // ~10Hz maintenance
    this.maintainVideo(t, force)
    if (due) {
      this.lastMaintain = now
      this.maintainAudio(t)
      this.maintainOverlayMedia(t)
    }
  }

  maintainVideo(t, force) {
    const plan = planClips(this.items, t)
    if (this.swapLock && (t >= this.swapLock.until || t < this.swapLock.since)) this.swapLock = null
    // A crossfade cut must lock the outgoing slot BEFORE reassignment, so the
    // old clip's tail stays on screen underneath the incoming ramp instead of
    // being replaced by the next prep clip in the same tick.
    const currentVisibleClipId = this.pool.slots[this.pool.visible]?.clipId
    const willSwap = plan.active && currentVisibleClipId && currentVisibleClipId !== plan.active.id
    if (willSwap && plan.active.payload?.transitionIn === 'crossfade' && this.pool.visible >= 0 && !this.swapLock) {
      this.swapLock = { slotIndex: this.pool.visible, since: t, until: plan.active.startTime + CROSSFADE_S + 0.12 }
    }
    const locked = this.swapLock ? [this.swapLock.slotIndex] : []
    const next = poolAssign(this.pool, plan, { locked })

    const prevVisible = this.pool.visible
    const prevVisibleClipId = this.pool.slots[prevVisible]?.clipId
    const changedVisible = next.visible !== prevVisible
      || next.slots[next.visible]?.clipId !== prevVisibleClipId

    // Prepare slots whose assignment changed.
    next.slots.forEach((slot, index) => {
      const el = this.slotEls[index]
      if (!el) return
      const prevId = el.dataset.clipId || null
      if (slot.clipId === prevId) return
      if (!slot.clipId) { el.removeAttribute('data-clip-id'); return }
      const clip = this.clipById(slot.clipId)
      if (!clip) return
      el.dataset.clipId = slot.clipId
      const src = this.resolveSrc(clip.payload.src)
      if (el.getAttribute('src') !== src) el.src = src
      el.playbackRate = clip.payload.playbackRate ?? 1
      el.volume = clip.payload?.muted ? 0 : Math.min(1, Math.max(0, clip.payload.volume ?? 0))
      el.muted = (clip.payload.volume ?? 0) <= 0 || !!clip.payload?.muted
      const isActive = plan.active && slot.clipId === plan.active.id
      const target = isActive ? clipLocalTime(clip, t) : (clip.payload?.startFrom || 0)
      try { el.currentTime = Math.max(0, target) } catch { /* metadata pending */ }
      if (isActive && this.playing) el.play().catch(() => {})
      else el.pause()
    })

    // Visibility + cut handling.
    if (changedVisible) {
      const incoming = this.slotEls[next.visible]
      const active = plan.active
      if (incoming && active) {
        // The incoming element was pre-seeked to its in-point; nudge only if
        // the timeline entered mid-clip (seek/cold start).
        const want = clipLocalTime(active, t)
        if (Math.abs((incoming.currentTime || 0) - want) > 0.08) {
          try { incoming.currentTime = Math.max(0, want) } catch { /* pending */ }
        }
        if (this.playing) incoming.play().catch(() => {})
        // Hard cut: silence the outgoing element immediately. (Crossfades
        // already hold their outgoing slot via the swap lock set above.)
        if (prevVisible >= 0 && prevVisible !== next.visible && this.swapLock?.slotIndex !== prevVisible) {
          const out = this.slotEls[prevVisible]
          if (out) out.pause()
        }
        if (this.activeClipId !== active.id) {
          this.activeClipId = active.id
          this.onActiveClipChange(active)
        }
      }
      if (!active && this.activeClipId) {
        this.activeClipId = null
        this.onActiveClipChange(null)
      }
    }
    // Pool state always tracks what was applied to the DOM, otherwise slot
    // bookkeeping goes stale between cuts and swaps degrade to cold starts.
    this.pool = next

    // Opacity + drift every frame.
    const active = plan.active
    this.slotEls.forEach((el, index) => {
      const isVisible = index === this.pool.visible
      const isLockedOutgoing = this.swapLock && index === this.swapLock.slotIndex
      let opacity = 0
      if (isVisible && active) {
        opacity = active.payload?.transitionIn === 'crossfade'
          ? clamp01((t - active.startTime) / CROSSFADE_S)
          : 1
      } else if (isLockedOutgoing) {
        opacity = 1 // sits under the incoming layer while it fades in
      }
      const z = isVisible ? 2 : isLockedOutgoing ? 1 : 0
      if (el.style.opacity !== String(opacity)) el.style.opacity = String(opacity)
      if (el.style.zIndex !== String(z)) el.style.zIndex = String(z)
    })

    if (active && this.playing) {
      const el = this.slotEls[this.pool.visible]
      if (el && el.readyState >= 2 && !el.ended && !el.seeking) {
        const baseRate = active.payload?.playbackRate ?? 1
        const expected = clipLocalTime(active, t)
        // Past the end of the source, the freeze-on-last-frame is intended
        // (matches the final render) — leave the element alone.
        if (!(el.duration && expected > el.duration - 0.05)) {
          const drift = el.currentTime - expected
          const { rate, resync } = driftAdjustedRate(baseRate, drift)
          if (resync) {
            try { el.currentTime = Math.max(0, expected) } catch { /* pending */ }
            if (el.playbackRate !== baseRate) el.playbackRate = baseRate
          } else if (Math.abs(el.playbackRate - rate) > 0.001) {
            el.playbackRate = rate
          }
        }
      }
    }
  }

  maintainAudio(t) {
    if (!this.audioHost) return
    const windowed = audioWindow(this.audioItems, t)
    const wanted = new Map(windowed.map(w => [w.item.id, w]))

    // Drop elements that left the neighborhood.
    for (const [id, el] of this.audioEls) {
      if (!wanted.has(id)) {
        el.pause()
        el.removeAttribute('src')
        el.load()
        el.remove()
        this.audioEls.delete(id)
      }
    }

    const narrationActive = this.audioItems.some(item =>
      item.kind === 'narration' && t >= item.startTime && t < item.endTime)

    for (const { item, active } of wanted.values()) {
      let el = this.audioEls.get(item.id)
      if (!el) {
        el = document.createElement('audio')
        el.preload = 'auto'
        el.src = this.resolveSrc(item.payload.src)
        this.audioHost.appendChild(el)
        this.audioEls.set(item.id, el)
      }
      el.volume = item.kind === 'music'
        ? musicVolumeAt(item, t, this.masters.music, narrationActive)
        : item.kind === 'sound-effect'
          ? Math.min(1, Math.max(0,
              (item.payload.volume ?? 0.28)
              * (item.payload.masterApplied ? 1 : Math.min(1.5, Math.max(0, this.masters.sfx)))
            ))
          : Math.min(1, Math.max(0, item.payload.volume ?? 1))
      if (active && this.playing) {
        if (el.paused) {
          try { el.currentTime = Math.max(0, t - item.startTime) } catch { /* pending */ }
          el.play().catch(() => {})
        } else if (el.readyState >= 2) {
          // play() startup latency leaves elements running ~40-80ms late.
          // Steer it out with a bounded, pitch-preserved rate nudge — never
          // a seek. A gross desync (device wake, long stall) gets one hard
          // correction; that is an anchor, not periodic seeking.
          const drift = el.currentTime - (t - item.startTime)
          if (Math.abs(drift) > 0.25) {
            try { el.currentTime = Math.max(0, t - item.startTime) } catch { /* pending */ }
            el.playbackRate = 1
          } else if (Math.abs(drift) > 0.03) {
            el.playbackRate = Math.max(0.97, Math.min(1.03, 1 - drift * 0.5))
          } else if (el.playbackRate !== 1) {
            el.playbackRate = 1
          }
        }
      } else if (active && !this.playing) {
        const want = Math.max(0, t - item.startTime)
        if (el.readyState >= 1 && Math.abs(el.currentTime - want) > 0.04) {
          try { el.currentTime = want } catch { /* pending */ }
        }
        if (!el.paused) el.pause()
      } else if (!el.paused) {
        el.pause()
      }
    }
  }

  maintainOverlayMedia(t) {
    for (const { el, startTime } of this.overlayMedia.values()) {
      if (!el || el.readyState < 1) continue
      const want = Math.max(0, t - startTime)
      if (!this.playing && Math.abs(el.currentTime - want) > 0.04) {
        try { el.currentTime = want } catch { /* pending */ }
      }
      if (this.playing && el.paused) el.play().catch(() => {})
      if (!this.playing && !el.paused) el.pause()
    }
  }

  dispose() {
    this.disposed = true
    for (const el of this.audioEls.values()) {
      el.pause(); el.removeAttribute('src'); el.load(); el.remove()
    }
    this.audioEls.clear()
    this.overlayMedia.clear()
  }
}
