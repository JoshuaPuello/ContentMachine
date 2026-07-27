import { useEffect, useRef } from 'react'

const issueColor = (issue) => {
  if (issue.type === 'short_gap') return '#f59e0b'
  if (issue.severity === 'high') return '#ef4444'
  return '#fb7185'
}

export default function AudioWaveform({
  peaks = [],
  duration = 0,
  currentTime = 0,
  issues = [],
  boundaries = [],
  onSeek,
  onInspect,
}) {
  const canvasRef = useRef(null)
  const interactionRef = useRef({ down: false, moved: false, x: 0 })

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks.length) return
    const rect = canvas.getBoundingClientRect()
    const ratio = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(rect.width * ratio))
    canvas.height = Math.max(1, Math.round(rect.height * ratio))
    const ctx = canvas.getContext('2d')
    ctx.scale(ratio, ratio)
    const width = rect.width
    const height = rect.height
    const middle = height / 2
    ctx.clearRect(0, 0, width, height)

    ctx.fillStyle = 'rgba(124, 109, 255, 0.08)'
    ctx.fillRect(0, 0, width, height)

    for (const boundary of boundaries) {
      const x = (boundary.timeSeconds / Math.max(0.001, duration)) * width
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)'
      ctx.beginPath()
      ctx.moveTo(x, 8)
      ctx.lineTo(x, height - 8)
      ctx.stroke()
    }

    for (const issue of issues) {
      const start = Number.isFinite(issue.startSeconds) ? issue.startSeconds : issue.timeSeconds - 0.12
      const end = Number.isFinite(issue.endSeconds) ? issue.endSeconds : issue.timeSeconds + 0.12
      const x = (Math.max(0, start) / Math.max(0.001, duration)) * width
      const w = Math.max(3, ((Math.max(start, end) - Math.max(0, start)) / Math.max(0.001, duration)) * width)
      ctx.fillStyle = `${issueColor(issue)}28`
      ctx.fillRect(x, 0, w, height)
    }

    const step = width / peaks.length
    ctx.strokeStyle = 'rgba(196, 188, 255, 0.82)'
    ctx.lineWidth = Math.max(1, step * 0.58)
    ctx.beginPath()
    peaks.forEach((peak, index) => {
      const x = index * step + step / 2
      const amplitude = Math.max(1, Number(peak) * (height * 0.42))
      ctx.moveTo(x, middle - amplitude)
      ctx.lineTo(x, middle + amplitude)
    })
    ctx.stroke()

    const playedX = (currentTime / Math.max(0.001, duration)) * width
    ctx.fillStyle = 'rgba(124, 109, 255, 0.16)'
    ctx.fillRect(0, 0, playedX, height)
    ctx.strokeStyle = '#9b8cff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(playedX, 0)
    ctx.lineTo(playedX, height)
    ctx.stroke()

    for (const issue of issues) {
      const x = (issue.timeSeconds / Math.max(0.001, duration)) * width
      ctx.fillStyle = issueColor(issue)
      ctx.beginPath()
      ctx.arc(x, 10, issue.severity === 'high' ? 5 : 4, 0, Math.PI * 2)
      ctx.fill()
    }
  }, [peaks, duration, currentTime, issues, boundaries])

  const timeForPointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(duration, ((event.clientX - rect.left) / rect.width) * duration))
  }

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-36 rounded-xl cursor-crosshair border border-border bg-black/15 touch-none"
      onPointerDown={(event) => {
        interactionRef.current = { down: true, moved: false, x: event.clientX }
        event.currentTarget.setPointerCapture(event.pointerId)
        onSeek?.(timeForPointer(event))
      }}
      onPointerMove={(event) => {
        if (!interactionRef.current.down) return
        if (Math.abs(event.clientX - interactionRef.current.x) > 4) interactionRef.current.moved = true
        onSeek?.(timeForPointer(event))
      }}
      onPointerUp={(event) => {
        const time = timeForPointer(event)
        onSeek?.(time)
        if (!interactionRef.current.moved) onInspect?.(time)
        interactionRef.current.down = false
      }}
      aria-label="Narration waveform. Click to seek and flag a quality issue."
    />
  )
}
