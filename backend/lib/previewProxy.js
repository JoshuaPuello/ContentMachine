// ─── Preview proxy pipeline ──────────────────────────────────────────────────
// The editor must never stream master clips from remote provider CDNs during
// interactive playback: signed URLs expire, every cut pays WAN latency, and
// the AI providers emit single-GOP files (one keyframe for the whole clip) so
// every seek decodes from frame zero. This module builds local preview
// proxies — 720p-capped, bitrate-capped H.264 with ~1s keyframes — stored per
// session under preview-proxy/<contentKey>.mp4 and served with immutable
// caching. Final renders keep using the original payload.src; proxies are a
// preview-only substitution.

import { createHash } from 'crypto'
import { spawn } from 'child_process'
import fs from 'fs/promises'
import { createWriteStream } from 'fs'
import path from 'path'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

const PROXY_DIR = 'preview-proxy'
const CONCURRENCY = 2

// Stable identity for a media source: the URL path without its volatile
// query (signatures/expiries rotate while the object stays the same).
export const contentKey = (src) => {
  let base = String(src || '')
  try {
    if (/^https?:\/\//i.test(base)) {
      const u = new URL(base)
      base = `${u.origin}${u.pathname}`
    } else {
      base = base.split('?')[0]
    }
  } catch {
    base = base.split('?')[0]
  }
  return createHash('sha1').update(base).digest('hex')
}

// Session-save mirrors selected clips to videos/scene_XX[_shotN]_selected.mp4
// (see session.js unitFileLabel). When present, transcode from the local
// mirror instead of re-downloading the remote master.
export const mirrorRelFor = ({ sceneNumber, segmentIndex } = {}) => {
  const scene = Number(sceneNumber)
  if (!Number.isFinite(scene) || scene <= 0) return null
  const segment = Number(segmentIndex) || 0
  const pad = String(scene).padStart(2, '0')
  return segment > 0
    ? `videos/scene_${pad}_shot${segment + 1}_selected.mp4`
    : `videos/scene_${pad}_selected.mp4`
}

// Resolve a same-session /api/session/<id>/files/* URL to its disk path.
// Foreign sessions and path traversal resolve to null.
export const localSourceFor = (src, sessionId, sessionDir) => {
  const m = String(src || '').match(/^\/api\/session\/([^/]+)\/files\/(.+)$/)
  if (!m) return null
  if (m[1] !== sessionId) return null
  const rel = decodeURIComponent(m[2].split('?')[0])
  const abs = path.resolve(sessionDir, rel)
  if (!abs.startsWith(path.resolve(sessionDir) + path.sep)) return null
  return abs
}

export const ffmpegArgs = (input, output, { encoder = 'h264_videotoolbox' } = {}) => [
  '-y', '-nostdin',
  '-i', input,
  '-map', '0:v:0', '-map', '0:a:0?',
  '-c:v', encoder,
  ...(encoder === 'libx264' ? ['-preset', 'veryfast', '-crf', '23'] : ['-b:v', '3M', '-maxrate', '4M']),
  '-vf', "scale=-2:'min(720,ih)'",
  '-force_key_frames', 'expr:gte(t,n_forced*1)',
  '-g', '60',
  '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
  '-movflags', '+faststart',
  output,
]

const runFfmpeg = (args) => new Promise((resolve, reject) => {
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  proc.stderr.on('data', (d) => { err += d; if (err.length > 8192) err = err.slice(-8192) })
  proc.on('error', reject)
  proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-400)}`))))
})

export const transcodeOne = async (input, output) => {
  const tmp = `${output}.tmp.mp4`
  try {
    await runFfmpeg(ffmpegArgs(input, tmp, { encoder: 'h264_videotoolbox' }))
  } catch {
    // Hardware encoder unavailable/failed — software fallback.
    await runFfmpeg(ffmpegArgs(input, tmp, { encoder: 'libx264' }))
  }
  await fs.rename(tmp, output)
}

const downloadTo = async (url, dest) => {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

const fileExists = async (p) => {
  try { const st = await fs.stat(p); return st.isFile() && st.size > 0 } catch { return false }
}

// One build job per session; concurrent calls attach to the running job and
// new items found in later calls are appended to it.
const jobs = new Map() // sessionId -> job

export const getJob = (sessionId) => jobs.get(sessionId) || null

export const buildProxies = async ({ sessionId, sessionDir, items = [] }) => {
  let job = jobs.get(sessionId)
  if (!job) {
    job = {
      sessionId,
      total: 0,
      done: 0,
      running: false,
      errors: [],
      map: {},
      queue: [],
      seen: new Set(),
    }
    jobs.set(sessionId, job)
  }

  const proxyDir = path.join(sessionDir, PROXY_DIR)
  await fs.mkdir(proxyDir, { recursive: true })

  for (const item of items) {
    const src = item?.src
    if (!src || job.seen.has(src)) continue
    job.seen.add(src)
    job.total += 1
    job.queue.push({ ...item, src })
  }

  const publicUrlFor = (key) => `/api/session/${sessionId}/${PROXY_DIR}/${key}.mp4`

  const processItem = async (item) => {
    const key = contentKey(item.src)
    const outPath = path.join(proxyDir, `${key}.mp4`)
    try {
      if (await fileExists(outPath)) {
        job.map[item.src] = publicUrlFor(key)
        return
      }
      // Pick the cheapest available source: same-session local file, the
      // session's mirrored copy of this clip, else the remote master.
      let input = localSourceFor(item.src, sessionId, sessionDir)
      if (input && !(await fileExists(input))) input = null
      if (!input) {
        const mirrorRel = mirrorRelFor(item)
        if (mirrorRel) {
          const mirrorAbs = path.join(sessionDir, mirrorRel)
          if (await fileExists(mirrorAbs)) input = mirrorAbs
        }
      }
      let tmpDownload = null
      if (!input) {
        if (!/^https?:\/\//i.test(item.src)) throw new Error('no local source and src is not a URL')
        tmpDownload = path.join(proxyDir, `${key}.download`)
        await downloadTo(item.src, tmpDownload)
        input = tmpDownload
      }
      await transcodeOne(input, outPath)
      if (tmpDownload) await fs.rm(tmpDownload, { force: true })
      job.map[item.src] = publicUrlFor(key)
    } catch (err) {
      job.errors.push({ src: String(item.src).slice(0, 120), error: err.message })
    } finally {
      job.done += 1
    }
  }

  if (!job.running) {
    job.running = true
    job.promise = (async () => {
      while (job.queue.length) {
        const batch = job.queue.splice(0, CONCURRENCY)
        await Promise.all(batch.map(processItem))
      }
      job.running = false
    })()
  }

  await job.promise
  return job
}

// Non-blocking variant for the HTTP route: kicks the job and returns its
// current state immediately.
export const startProxyBuild = ({ sessionId, sessionDir, items }) => {
  const promise = buildProxies({ sessionId, sessionDir, items })
  promise.catch(() => {})
  return getJob(sessionId)
}

export const jobStatus = (sessionId) => {
  const job = jobs.get(sessionId)
  if (!job) return { total: 0, done: 0, running: false, map: {}, errors: [] }
  return {
    total: job.total,
    done: job.done,
    running: job.running,
    map: job.map,
    errors: job.errors,
  }
}
