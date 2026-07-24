// ─── Preview clock ───────────────────────────────────────────────────────────
// A tiny external time store. The playback rAF driver writes to it at frame
// rate; imperative subscribers (playhead cursor, transport readout, overlay
// stage) read it without any React re-render of the editor tree. React state
// only ever sees discrete moments (seek, pause, end).

export function createPreviewClock(initial = 0) {
  let time = initial
  const subscribers = new Set()
  return {
    get: () => time,
    set: (next) => {
      time = next
      for (const fn of subscribers) fn(time)
    },
    subscribe: (fn) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
  }
}
