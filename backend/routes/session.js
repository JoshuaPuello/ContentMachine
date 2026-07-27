// Auto-save session route.
// Saves project state to output/<sessionId>/ as real files so nothing
// is lost even if the user never manually exports.
//
// Endpoints:
//   POST /api/session/save          — save/update a session
//   GET  /api/session/list          — list all saved sessions
//   GET  /api/session/:id           — load session.json for a session
//   GET  /api/session/:id/files/*   — serve individual files (images/videos)
//   DELETE /api/session/:id         — delete a session

import express from 'express'
import fs from 'fs/promises'
import { createWriteStream, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import http from 'http'
import { randomUUID } from 'crypto'
import { deleteProjectAssetsFromR2, isR2Configured } from '../lib/r2.js'
import { deleteRenderWorkspacesForSession } from './render.js'
import { startProxyBuild, jobStatus as proxyJobStatus } from '../lib/previewProxy.js'
import { normalizeProjectImagePrompts } from '../lib/imagePromptQuality.js'
import {
  OUTPUT_ROOT,
  withSessionMutationLock,
} from '../lib/sessionStore.js'
import { mergeWindowsStateIntoProject, cancelWindowsProject } from '../lib/windowsVideo.js'

const router = express.Router()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
export { withSessionMutationLock } from '../lib/sessionStore.js'

export const hasPopulatedProjectCore = (project) => Boolean(
  project?.story
  || project?.scene_plan
  || (Array.isArray(project?.scenes) && project.scenes.length > 0)
  || project?.tts_script
  || (Array.isArray(project?.video_prompts) && project.video_prompts.length > 0)
)

export const wouldErasePopulatedProject = (incoming, existing) => (
  hasPopulatedProjectCore(existing) && !hasPopulatedProjectCore(incoming)
)

const projectTitle = (project) => String(project?.story?.title || '').trim().toLowerCase()
const hasGeneratedDownstream = (project) => Boolean(
  Object.keys(project?.images || {}).length
  || Object.keys(project?.selected_images || {}).length
  || (Array.isArray(project?.video_prompts) && project.video_prompts.length)
  || Object.keys(project?.video_jobs || {}).length
  || Object.keys(project?.selected_videos || {}).length
  || project?.timeline?.items?.length
  || project?.metadata
  || project?.all_thumbnails?.length
  || project?.thumbnail
)

export const wouldMixDifferentProjects = (incoming, existing) => {
  const incomingTitle = projectTitle(incoming)
  const existingTitle = projectTitle(existing)
  return Boolean(
    incomingTitle
    && existingTitle
    && incomingTitle !== existingTitle
    && hasGeneratedDownstream(incoming)
  )
}

export const hasStaleWriteToken = (incomingToken, existingToken) => Boolean(
  existingToken && incomingToken !== existingToken
)

// ── Helpers ────────────────────────────────────────────────────────────────

// URLs that point back at a session's own stored files
// ("/api/session/<id>/files/<rel>", relative or absolute host) must NEVER be
// re-downloaded: the download truncates the destination first, and when the
// destination IS the source, the file zeroes itself out. Recognize them and
// keep the existing reference instead.
const ownSessionFile = (url, sessionId) => {
  const match = String(url).match(/\/api\/session\/([^/]+)\/files\/([^?#]+)/)
  if (!match || match[1] !== sessionId) return null
  const rel = decodeURIComponent(match[2])
  return rel.includes('..') ? null : rel
}

// Decode a base64 data URI or download an HTTP URL to a local file.
// Returns the relative path written (e.g. "images/all/scene_01_v1.png").
// Downloads go to a temp file first and are renamed only on success — a
// failed or non-200 response can never corrupt an existing file.
const saveAsset = async (url, relPath, sessionDir, sessionId) => {
  if (!url) return null

  // Already one of this session's own files — no I/O, keep the reference
  const ownRel = ownSessionFile(url, sessionId)
  if (ownRel) return ownRel

  const absPath = path.join(sessionDir, relPath)
  await fs.mkdir(path.dirname(absPath), { recursive: true })

  if (url.startsWith('data:')) {
    // base64 data URI — decode and write
    const [, b64] = url.split(',')
    if (!b64) return null
    const buf = Buffer.from(b64, 'base64')
    await fs.writeFile(absPath, buf)
    return relPath
  }

  if (url.startsWith('http://') || url.startsWith('https://')) {
    // Download from CDN — into a temp file, renamed only when complete
    const tmpPath = `${absPath}.download.${randomUUID()}`
    try {
      await new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http
        proto.get(url, { timeout: 60000 }, (res) => {
          if (res.statusCode !== 200) {
            res.resume()
            reject(new Error(`HTTP ${res.statusCode} fetching ${url.slice(0, 120)}`))
            return
          }
          const file = createWriteStream(tmpPath)
          res.pipe(file)
          file.on('finish', () => { file.close(); resolve() })
          file.on('error', reject)
        }).on('error', reject)
      })
      const stat = await fs.stat(tmpPath)
      if (stat.size === 0) throw new Error('Downloaded 0 bytes')
      await fs.rename(tmpPath, absPath)
      return relPath
    } catch (err) {
      try { await fs.unlink(tmpPath) } catch { /* already gone */ }
      throw err
    }
  }

  return null
}

const extFromUrl = (url, fallback = 'jpg') => {
  if (!url) return fallback
  if (url.startsWith('data:image/png')) return 'png'
  if (url.startsWith('data:image/webp')) return 'webp'
  if (url.startsWith('data:image/gif')) return 'gif'
  const match = url.match(/\.(\w{2,4})(?:\?|$)/)
  return match ? match[1].toLowerCase() : fallback
}

const pad = (n) => String(n).padStart(2, '0')

// Image keys are "scene_segment_variation" ("3_1_2"); legacy: "scene_variation".
// Segment-aware parsing — treating the segment as the variation made every
// variant of a shot overwrite the same file.
const parseImageKey = (key) => {
  const parts = String(key).split('_')
  if (parts.length >= 3) return { scene: parts[0], segment: Number(parts[1]) || 0, variant: Number(parts[2]) || 0 }
  return { scene: parts[0], segment: 0, variant: Number(parts[1]) || 0 }
}

// Unit keys are "scene_segment" ("3_1"); legacy: plain scene numbers.
const parseUnitKey = (key) => {
  const parts = String(key).split('_')
  return { scene: parts[0], segment: parts.length > 1 ? Number(parts[1]) || 0 : 0 }
}

const unitFileLabel = (key) => {
  const { scene, segment } = parseUnitKey(key)
  return segment > 0 ? `scene_${pad(scene)}_shot${segment + 1}` : `scene_${pad(scene)}`
}

const safeFileLabel = (value, fallback) => {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned || fallback
}

// Chapter portraits are repeated in the root chapter list and in every
// reveal/active timeline item. A single data URI could therefore be copied
// into session.json many times, turning a local project into a multi-megabyte
// payload. Store every unique portrait once and keep lightweight references.
const externalizeTimelinePortraits = async (snapshot, sessionDir, sessionId) => {
  const chapterRefs = []
  for (const chapter of snapshot.timeline?.chapters || []) chapterRefs.push(chapter)
  for (const item of snapshot.timeline?.items || []) {
    if (item.kind !== 'chapter-reveal' && item.kind !== 'chapter-active') continue
    for (const chapter of item.payload?.chapters || []) chapterRefs.push(chapter)
  }

  const savedBySource = new Map()
  let portraitNumber = 0
  for (const chapter of chapterRefs) {
    const source = chapter?.image
    if (!source || source.startsWith('__session_file__/')) continue
    if (savedBySource.has(source)) {
      chapter.image = savedBySource.get(source)
      continue
    }

    portraitNumber++
    const ext = extFromUrl(source, 'png')
    const title = safeFileLabel(chapter.title, `chapter-${pad(portraitNumber)}`)
    const relPath = `chapters/${pad(portraitNumber)}-${title}.${ext}`
    try {
      const saved = await saveAsset(source, relPath, sessionDir, sessionId)
      if (saved) {
        const reference = `__session_file__/${saved}`
        savedBySource.set(source, reference)
        chapter.image = reference
      }
    } catch (e) {
      console.warn(`Session save: failed to write chapter portrait ${title}:`, e.message)
    }
  }
}

const mergeRecordUrls = (incoming = {}, durable = {}) => {
  const merged = { ...incoming }
  for (const [key, saved] of Object.entries(durable || {})) {
    if (!merged[key]) {
      merged[key] = saved
    } else if (!merged[key]?.url && saved?.url) {
      merged[key] = { ...saved, ...merged[key], url: saved.url }
    }
  }
  return merged
}

export const mergeDurableAssetReferences = (snapshot, durable) => {
  if (!durable) return
  snapshot.images = mergeRecordUrls(snapshot.images, durable.images)
  snapshot.selected_images = mergeRecordUrls(snapshot.selected_images, durable.selected_images)
  snapshot.image_history = { ...(durable.image_history || {}), ...(snapshot.image_history || {}) }
  snapshot.video_jobs = mergeRecordUrls(snapshot.video_jobs, durable.video_jobs)
  snapshot.selected_videos = mergeRecordUrls(snapshot.selected_videos, durable.selected_videos)
  snapshot.video_history = { ...(durable.video_history || {}), ...(snapshot.video_history || {}) }
}

export const restoreImageReferencesFromDisk = async (snapshot, sessionDir) => {
  let changed = false
  const restoreFolder = async (folder, selected) => {
    let files
    try { files = await fs.readdir(path.join(sessionDir, 'images', folder)) } catch { return }
    for (const filename of files) {
      const match = filename.match(/^scene_(\d+)(?:_shot(\d+))?(?:_v(\d+))?\.(jpe?g|png|webp|gif)$/i)
      if (!match) continue
      const scene = String(Number(match[1]))
      const segment = match[2] ? Number(match[2]) - 1 : 0
      const variant = match[3] ? Number(match[3]) - 1 : 0
      const key = selected ? `${scene}_${segment}` : `${scene}_${segment}_${variant}`
      const collection = selected
        ? (snapshot.selected_images ||= {})
        : (snapshot.images ||= {})
      if (!collection[key]?.url) {
        collection[key] = {
          ...(collection[key] || {}),
          url: `__session_file__/images/${folder}/${filename}`,
        }
        changed = true
      }
    }
  }
  await restoreFolder('all', false)
  await restoreFolder('selected', true)
  return changed
}

// ── POST /api/session/save ─────────────────────────────────────────────────
// Body: { sessionId, project }
// project is the exportProject() snapshot from the frontend.
// Images in project.images and project.selected_images may be base64 or HTTP URLs.
// We extract them to files and replace URLs with local file references.
router.post('/save', async (req, res) => {
  try {
    const { sessionId, project } = req.body
    if (!validSessionId(sessionId) || !project) {
      return res.status(400).json({ error: 'sessionId and project required' })
    }

    await withSessionMutationLock(sessionId, async () => {
    const sessionDir = path.join(OUTPUT_ROOT, sessionId)
    await fs.mkdir(sessionDir, { recursive: true })

    // A loaded project receives a stable write token. Tabs holding an older
    // in-memory copy cannot silently overwrite a repaired or newly loaded
    // project snapshot.
    const existingJsonPath = path.join(sessionDir, 'session.json')
    let existingWriteToken = null
    let existingSnapshot = null
    try {
      existingSnapshot = JSON.parse(await fs.readFile(existingJsonPath, 'utf8'))
      existingWriteToken = existingSnapshot._session?.write_token || null
    } catch {
      // First save for a new project.
    }
    if (hasStaleWriteToken(project.session_write_token, existingWriteToken)) {
      return res.status(409).json({
        error: 'This project was updated by a newer local session. Reopen it before saving.',
        code: 'STALE_SESSION',
      })
    }
    if (wouldErasePopulatedProject(project, existingSnapshot)) {
      return res.status(409).json({
        error: 'Refusing to replace a populated project with an empty browser snapshot. Reopen the project and try again.',
        code: 'EMPTY_SESSION_OVERWRITE',
      })
    }
    if (wouldMixDifferentProjects(project, existingSnapshot)) {
      return res.status(409).json({
        error: 'Refusing to attach generated media from one story to a different project. Create or reopen the intended project first.',
        code: 'CROSS_PROJECT_CONTAMINATION',
      })
    }
    // This is an optimistic-concurrency revision, not a permanent project key.
    // Rotate it after every accepted save so another tab holding the previous
    // revision cannot overwrite this newer snapshot.
    const writeToken = randomUUID()

    // Deep clone project so we can replace URLs with local paths
    const snapshot = JSON.parse(JSON.stringify(project))
    normalizeProjectImagePrompts(snapshot)
    mergeDurableAssetReferences(snapshot, existingSnapshot)
    await mergeWindowsStateIntoProject(snapshot, sessionId)

    // ── Save all image variants ──────────────────────────────────────────
    for (const [key, img] of Object.entries(snapshot.images || {})) {
      if (!img?.url) continue
      const { scene, segment, variant } = parseImageKey(key)
      const shotPart = segment > 0 ? `_shot${segment + 1}` : ''
      const ext = extFromUrl(img.url)
      const relPath = `images/all/scene_${pad(scene)}${shotPart}_v${variant + 1}.${ext}`
      try {
        const saved = await saveAsset(img.url, relPath, sessionDir, sessionId)
        if (saved) img.url = `__session_file__/${saved}`
      } catch (e) {
        console.warn(`Session save: failed to write image ${key}:`, e.message)
      }
    }

    // ── Save selected images ─────────────────────────────────────────────
    for (const [unitKey, img] of Object.entries(snapshot.selected_images || {})) {
      if (!img?.url) continue
      const ext = extFromUrl(img.url)
      const relPath = `images/selected/${unitFileLabel(unitKey)}.${ext}`
      try {
        const saved = await saveAsset(img.url, relPath, sessionDir, sessionId)
        if (saved) img.url = `__session_file__/${saved}`
      } catch (e) {
        console.warn(`Session save: failed to write selected image ${unitKey}:`, e.message)
      }
    }

    // ── Save image history ───────────────────────────────────────────────
    for (const [key, entries] of Object.entries(snapshot.image_history || {})) {
      const { scene, segment, variant } = parseImageKey(key)
      const shotPart = segment > 0 ? `_shot${segment + 1}` : ''
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        if (!entry?.url) continue
        const ext = extFromUrl(entry.url)
        const relPath = `images/history/scene_${pad(scene)}${shotPart}_v${variant + 1}_prev${i + 1}.${ext}`
        try {
          const saved = await saveAsset(entry.url, relPath, sessionDir, sessionId)
          if (saved) entry.url = `__session_file__/${saved}`
        } catch (e) {
          console.warn(`Session save: failed to write history image ${key}[${i}]:`, e.message)
        }
      }
    }

    // ── Save thumbnails ──────────────────────────────────────────────────
    if (Array.isArray(snapshot.all_thumbnails)) {
      for (let i = 0; i < snapshot.all_thumbnails.length; i++) {
        const thumb = snapshot.all_thumbnails[i]
        if (!thumb?.url) continue
        const ext = extFromUrl(thumb.url)
        const relPath = `thumbnails/thumbnail_${pad(i + 1)}.${ext}`
        try {
          const saved = await saveAsset(thumb.url, relPath, sessionDir, sessionId)
          if (saved) thumb.url = `__session_file__/${saved}`
        } catch (e) {
          console.warn(`Session save: failed to write thumbnail ${i}:`, e.message)
        }
      }
    }

    // ── Save thumbnail history ───────────────────────────────────────────
    for (const [idx, entries] of Object.entries(snapshot.thumbnail_history || {})) {
      for (let i = 0; i < (entries || []).length; i++) {
        const entry = entries[i]
        if (!entry?.url) continue
        const ext = extFromUrl(entry.url)
        const relPath = `thumbnails/history/thumbnail_${pad(parseInt(idx, 10) + 1)}_prev${i + 1}.${ext}`
        try {
          const saved = await saveAsset(entry.url, relPath, sessionDir, sessionId)
          if (saved) entry.url = `__session_file__/${saved}`
        } catch (e) {
          console.warn(`Session save: failed to write thumbnail history ${idx}[${i}]:`, e.message)
        }
      }
    }

    // ── Save selected thumbnail urls ─────────────────────────────────────
    if (snapshot.thumbnail?.selected_url) {
      const ext = extFromUrl(snapshot.thumbnail.selected_url)
      try {
        const saved = await saveAsset(snapshot.thumbnail.selected_url, `thumbnails/selected.${ext}`, sessionDir, sessionId)
        if (saved) snapshot.thumbnail.selected_url = `__session_file__/${saved}`
      } catch { /* keep remote url */ }
    }

    // ── Save videos to disk ──────────────────────────────────────────────
    // Download all video versions (current + history) so nothing is lost if
    // CDN links expire. Videos are written to videos/ and videos/history/.
    for (const [sceneNum, job] of Object.entries(snapshot.video_jobs || {})) {
      if (!job?.url) continue
      // Broker-completed Windows videos are permanent R2 objects validated by
      // StoryForge. Keep that canonical remote evidence instead of downloading
      // hundreds of megabytes during an unrelated browser autosave.
      if (job.provider === 'windows-worker' && job.objectKey) continue
      const relPath = `videos/${unitFileLabel(sceneNum)}_selected.mp4`
      try {
        const saved = await saveAsset(job.url, relPath, sessionDir, sessionId)
        if (saved) job.url = `__session_file__/${saved}`
      } catch (e) {
        console.warn(`Session save: failed to write video ${sceneNum}:`, e.message)
      }
    }

    for (const [sceneNum, job] of Object.entries(snapshot.selected_videos || {})) {
      if (!job?.url || job.url.startsWith('__session_file__')) continue
      // If video_jobs already wrote this URL to disk, skip (same URL)
      const existingJob = snapshot.video_jobs?.[sceneNum]
      if (existingJob?.provider === 'windows-worker' && existingJob?.objectKey && existingJob.url === job.url) continue
      if (existingJob?.url?.startsWith('__session_file__')) continue
      const relPath = `videos/${unitFileLabel(sceneNum)}_selected.mp4`
      try {
        const saved = await saveAsset(job.url, relPath, sessionDir, sessionId)
        if (saved) job.url = `__session_file__/${saved}`
      } catch (e) {
        console.warn(`Session save: failed to write selected video ${sceneNum}:`, e.message)
      }
    }

    for (const [sceneNum, entries] of Object.entries(snapshot.video_history || {})) {
      for (let i = 0; i < (entries || []).length; i++) {
        const entry = entries[i]
        if (!entry?.url) continue
        const relPath = `videos/history/${unitFileLabel(sceneNum)}_v${i + 1}.mp4`
        try {
          const saved = await saveAsset(entry.url, relPath, sessionDir, sessionId)
          if (saved) entry.url = `__session_file__/${saved}`
        } catch (e) {
          console.warn(`Session save: failed to write video history ${sceneNum}[${i}]:`, e.message)
        }
      }
    }

    await externalizeTimelinePortraits(snapshot, sessionDir, sessionId)
    await restoreImageReferencesFromDisk(snapshot, sessionDir)

    // ── Write session metadata ───────────────────────────────────────────
    // The user-given project name rides along in the snapshot (project_name,
    // set by exportProject) so a save never clobbers a rename.
    const projectName = typeof project.project_name === 'string' && project.project_name.trim()
      ? project.project_name.trim()
      : null
    snapshot._session = {
      id: sessionId,
      saved_at: new Date().toISOString(),
      write_token: writeToken,
      title: project.story?.title || 'Untitled',
      ...(projectName ? { name: projectName } : {}),
    }

    // Atomic write: write to .tmp then rename
    const jsonPath = path.join(sessionDir, 'session.json')
    const tmpPath  = `${jsonPath}.tmp.${randomUUID()}`
    await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), 'utf8')
    await fs.rename(tmpPath, jsonPath)

    res.json({ ok: true, sessionId, writeToken })
    })
  } catch (err) {
    console.error('Session save error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/session/list ──────────────────────────────────────────────────
// Cheap by design: session.json is parsed but only small fields are plucked
// (title, key counts) — heavy base64/asset payloads are never touched.
router.get('/list', async (req, res) => {
  try {
    const entries = await fs.readdir(OUTPUT_ROOT, { withFileTypes: true })
    const sessions = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const jsonPath = path.join(OUTPUT_ROOT, entry.name, 'session.json')
      try {
        const raw = await fs.readFile(jsonPath, 'utf8')
        const data = JSON.parse(raw)

        // First selected image on disk becomes the project card thumbnail
        let thumbnailUrl = null
        try {
          const selectedDir = path.join(OUTPUT_ROOT, entry.name, 'images', 'selected')
          const files = (await fs.readdir(selectedDir)).sort()
          const img = files.find(f => /\.(jpe?g|png)$/i.test(f))
          if (img) thumbnailUrl = `/api/session/${entry.name}/files/images/selected/${encodeURIComponent(img)}`
        } catch {
          // no selected images yet
        }

        const updatedAt = data._session?.saved_at
          || (await fs.stat(jsonPath).then(s => s.mtime.toISOString()).catch(() => null))

        sessions.push({
          id: entry.name,
          title: data._session?.title || data.story?.title || 'Untitled',
          saved_at: data._session?.saved_at || null,
          scene_count: data.scenes?.length || 0,
          has_images: Object.values(data.images || {}).some(i => i?.url),
          has_videos: Object.values(data.video_jobs || {}).some(j => j?.url),
          has_thumbnail: !!(data.thumbnail?.selected_url),
          // ── Projects page fields ──
          name: data._session?.name || data.story?.title || entry.name,
          updatedAt,
          progress: {
            hasStory: !!data.story,
            scenes: data.scenes?.length || 0,
            imagesSelected: Object.keys(data.selected_images || {}).length,
            videosSelected: Object.keys(data.selected_videos || {}).length,
            hasTimeline: !!data.timeline?.built,
            hasMetadata: !!(
              data.metadata?.selected_title
              || data.metadata?.description
              || data.metadata?.all_titles?.length
            ),
            hasThumbnail: !!data.thumbnail?.selected_url,
            hasAudio: !!data.audio?.fullAudio
              || Object.keys(data.audio?.sceneAudio || {}).length > 0,
          },
          thumbnailUrl,
        })
      } catch {
        // session.json missing or corrupt — skip
      }
    }
    sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    res.json({ sessions })
  } catch (err) {
    console.error('Session list error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── PATCH /api/session/:id/name ────────────────────────────────────────────
// Body: { name } — stores the user-given project name in _session.name.
// Atomic write (tmp + rename), same as save.
router.patch('/:id/name', async (req, res) => {
  try {
    const { id } = req.params
    if (id.includes('..') || id.includes('/') || id.includes('\\')) {
      return res.status(400).json({ error: 'Invalid session id' })
    }
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
    if (!name) {
      return res.status(400).json({ error: 'name required' })
    }
    await withSessionMutationLock(id, async () => {
    const jsonPath = path.join(OUTPUT_ROOT, id, 'session.json')
    const raw = await fs.readFile(jsonPath, 'utf8')
    const data = JSON.parse(raw)
    await mergeWindowsStateIntoProject(data, id)
    data._session = { ...(data._session || { id }), name }
    // Keep the snapshot-level copy in sync so a later frontend save
    // (which writes _session from project_name) can't roll the name back.
    data.project_name = name
    const tmpPath = `${jsonPath}.tmp.${randomUUID()}`
    await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8')
    await fs.rename(tmpPath, jsonPath)
    res.json({ ok: true, name })
    })
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ error: 'Session not found' })
    }
    console.error('Session rename error:', err)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/session/:id ───────────────────────────────────────────────────
// Returns session.json with __session_file__ placeholders replaced with
// full HTTP URLs so the frontend can load images directly.
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params
    // Basic safety: no path traversal
    if (id.includes('..') || id.includes('/') || id.includes('\\')) {
      return res.status(400).json({ error: 'Invalid session id' })
    }
    await withSessionMutationLock(id, async () => {
    const jsonPath = path.join(OUTPUT_ROOT, id, 'session.json')
    const raw = await fs.readFile(jsonPath, 'utf8')
    const data = JSON.parse(raw)
    let changed = await restoreImageReferencesFromDisk(data, path.join(OUTPUT_ROOT, id))
    const promptNormalization = normalizeProjectImagePrompts(data)
    changed = changed || promptNormalization.changed
    if (!data._session?.write_token) {
      data._session = { ...(data._session || { id }), write_token: randomUUID() }
      changed = true
    }
    const durableRaw = JSON.stringify(data, null, 2)
    if (changed) {
      const tmpPath = `${jsonPath}.tmp.${randomUUID()}`
      await fs.writeFile(tmpPath, durableRaw, 'utf8')
      await fs.rename(tmpPath, jsonPath)
    }
    // Replace __session_file__/<relPath> with a full URL the browser can fetch
    const baseUrl = `${req.protocol}://${req.get('host')}/api/session/${id}/files`
    const resolved = durableRaw.replaceAll(
      /"__session_file__\/([^"]+)"/g,
      (_, relPath) => `"${baseUrl}/${relPath}"`
    )
    res.setHeader('Content-Type', 'application/json')
    res.send(resolved)
    })
  } catch (err) {
    if (req.query.optional === '1' && err.code === 'ENOENT') {
      return res.status(204).end()
    }
    console.error('Session load error:', err)
    res.status(404).json({ error: 'Session not found' })
  }
})

// ── GET /api/session/:id/files/* ───────────────────────────────────────────
// Serves individual asset files (images, thumbnails) directly.
router.get('/:id/files/*', async (req, res) => {
  try {
    const { id } = req.params
    if (id.includes('..') || id.includes('/') || id.includes('\\')) {
      return res.status(400).json({ error: 'Invalid session id' })
    }
    const relPath = req.params[0]
    if (!relPath || relPath.includes('..')) {
      return res.status(400).json({ error: 'Invalid path' })
    }
    const absPath = path.join(OUTPUT_ROOT, id, relPath)
    // Ensure file is inside session dir
    if (!absPath.startsWith(path.join(OUTPUT_ROOT, id))) {
      return res.status(403).json({ error: 'Forbidden' })
    }
    // Generated media carries a per-generation name (or is only replaced by
    // an explicit re-selection), so short-lived browser caching is safe and
    // stops the editor refetching narration/music every time an audio
    // element remounts (the default max-age=0 forced a revalidation
    // round-trip per mount).
    if (/\.(mp4|mp3|wav|m4a|aac|ogg|png|jpe?g|webp)$/i.test(absPath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600')
    }
    res.sendFile(absPath)
  } catch {
    res.status(404).json({ error: 'File not found' })
  }
})

// ── Preview proxies ─────────────────────────────────────────────────────────
// The editor plays local short-GOP proxies instead of remote master clips.
// POST kicks (or attaches to) the per-session build job; GET polls status;
// the file route serves content-addressed proxies with immutable caching.
router.post('/:id/preview-proxies', async (req, res) => {
  try {
    const { id } = req.params
    if (id.includes('..') || id.includes('/') || id.includes('\\')) {
      return res.status(400).json({ error: 'Invalid session id' })
    }
    const sessionDir = path.join(OUTPUT_ROOT, id)
    if (!existsSync(sessionDir)) return res.status(404).json({ error: 'Session not found' })
    const items = Array.isArray(req.body?.items) ? req.body.items : []
    const cleaned = items
      .filter(item => typeof item?.src === 'string' && item.src)
      .map(item => ({
        src: item.src,
        sceneNumber: item.sceneNumber,
        segmentIndex: item.segmentIndex,
      }))
    startProxyBuild({ sessionId: id, sessionDir, items: cleaned })
    res.json(proxyJobStatus(id))
  } catch (err) {
    console.error('preview-proxies start failed:', err)
    res.status(500).json({ error: 'Failed to start proxy build' })
  }
})

router.get('/:id/preview-proxies', (req, res) => {
  res.json(proxyJobStatus(req.params.id))
})

router.get('/:id/preview-proxy/:file', (req, res) => {
  const { id, file } = req.params
  if (id.includes('..') || id.includes('/') || id.includes('\\')) {
    return res.status(400).json({ error: 'Invalid session id' })
  }
  if (!/^[a-f0-9]{40}\.mp4$/.test(file)) {
    return res.status(400).json({ error: 'Invalid proxy name' })
  }
  const absPath = path.join(OUTPUT_ROOT, id, 'preview-proxy', file)
  // Content-addressed: a given name never changes contents, so let the
  // browser cache it for good (range requests still work via sendFile).
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.sendFile(absPath, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Proxy not found' })
  })
})

// ── DELETE /api/session/:id ────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params
    if (!validSessionId(id)) {
      return res.status(400).json({ error: 'Invalid session id' })
    }
    if (!isR2Configured()) {
      throw new Error('Project deletion requires R2 configuration so remote assets cannot be orphaned')
    }
    // Broker cancellation owns its own per-session mutation. Complete it before
    // entering the deletion lock to avoid lock re-entry and to fail closed when
    // remote Windows work cannot be scoped and canceled safely.
    await cancelWindowsProject(id, { deleteAssets: true, reason: 'Content Machine project deleted' })
    const result = await withSessionMutationLock(id, async () => {
      // Delete remote data first. If R2 refuses the operation, keep the local
      // project visible so deletion can be retried instead of silently leaving
      // inaccessible orphaned objects in the bucket.
      const r2 = await deleteProjectAssetsFromR2(id)
      const renderWorkspacesDeleted = await deleteRenderWorkspacesForSession(id)
      const sessionDir = path.join(OUTPUT_ROOT, id)
      await fs.rm(sessionDir, { recursive: true, force: true })
      return { r2, renderWorkspacesDeleted }
    })
    res.json({
      ok: true,
      localDeleted: true,
      r2ObjectsDeleted: result.r2.deleted,
      r2Configured: result.r2.configured,
      renderWorkspacesDeleted: result.renderWorkspacesDeleted,
    })
  } catch (err) {
    console.error(`Session deletion failed for ${req.params.id}:`, err)
    res.status(500).json({ error: err.message })
  }
})

export default router
