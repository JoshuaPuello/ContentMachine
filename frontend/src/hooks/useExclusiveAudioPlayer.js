import { useCallback, useEffect, useRef, useState } from 'react'

const initialState = {
  activeId: null,
  source: null,
  playing: false,
  currentTime: 0,
  duration: 0,
}

export function useExclusiveAudioPlayer() {
  const elementRef = useRef(null)
  const [state, setState] = useState(initialState)

  if (!elementRef.current && typeof Audio !== 'undefined') {
    const element = new Audio()
    element.preload = 'metadata'
    elementRef.current = element
  }

  useEffect(() => {
    const element = elementRef.current
    if (!element) return undefined
    const update = () => setState(previous => ({
      ...previous,
      currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
      duration: Number.isFinite(element.duration) ? element.duration : previous.duration,
      playing: !element.paused && !element.ended,
    }))
    const ended = () => setState(previous => ({ ...previous, playing: false, currentTime: previous.duration }))
    const errored = () => setState(previous => ({ ...previous, playing: false }))
    element.addEventListener('timeupdate', update)
    element.addEventListener('durationchange', update)
    element.addEventListener('loadedmetadata', update)
    element.addEventListener('play', update)
    element.addEventListener('pause', update)
    element.addEventListener('ended', ended)
    element.addEventListener('error', errored)
    return () => {
      element.pause()
      element.removeAttribute('src')
      element.load()
      element.removeEventListener('timeupdate', update)
      element.removeEventListener('durationchange', update)
      element.removeEventListener('loadedmetadata', update)
      element.removeEventListener('play', update)
      element.removeEventListener('pause', update)
      element.removeEventListener('ended', ended)
      element.removeEventListener('error', errored)
    }
  }, [])

  const toggle = useCallback(async ({ id, source, startAt }) => {
    const element = elementRef.current
    if (!element || !source) return
    const same = state.activeId === id && state.source === source
    if (same && !element.paused) {
      element.pause()
      return
    }
    if (!same) {
      element.pause()
      element.src = source
      element.currentTime = Number.isFinite(startAt) ? Math.max(0, startAt) : 0
      setState({
        activeId: id,
        source,
        playing: false,
        currentTime: element.currentTime,
        duration: 0,
      })
    } else if (Number.isFinite(startAt)) {
      element.currentTime = Math.max(0, startAt)
    }
    await element.play()
  }, [state.activeId, state.source])

  const seek = useCallback((seconds) => {
    const element = elementRef.current
    if (!element) return
    const duration = Number.isFinite(element.duration) ? element.duration : state.duration
    element.currentTime = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, Number(seconds) || 0))
    setState(previous => ({ ...previous, currentTime: element.currentTime }))
  }, [state.duration])

  const stop = useCallback(() => {
    const element = elementRef.current
    if (!element) return
    element.pause()
    element.currentTime = 0
    setState(previous => ({ ...previous, playing: false, currentTime: 0 }))
  }, [])

  const switchSource = useCallback(async ({ id, source }) => {
    const element = elementRef.current
    if (!element || !source) return
    const position = element.currentTime || state.currentTime || 0
    const wasPlaying = !element.paused
    element.pause()
    element.src = source
    element.currentTime = position
    setState(previous => ({ ...previous, activeId: id, source, currentTime: position, playing: false }))
    if (wasPlaying) await element.play()
  }, [state.currentTime])

  return {
    ...state,
    toggle,
    seek,
    stop,
    switchSource,
    isActive: (id) => state.activeId === id,
  }
}
