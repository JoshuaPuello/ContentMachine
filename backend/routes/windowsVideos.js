import express from 'express'
import multer from 'multer'
import fs from 'fs/promises'
import { createReadStream } from 'fs'
import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  attachManualWindowsVideo,
  assertWindowsUnit,
  cancelWindowsProject,
  missingWindowsUnits,
  pauseWindowsProject,
  queueWindowsUnits,
  regenerateWindowsUnit,
  resetWindowsRepairBudget,
  resumeWindowsProject,
  windowsStatus,
} from '../lib/windowsVideo.js'
import { readSessionSnapshot, validSessionId } from '../lib/sessionStore.js'
import { deleteProjectAssetFromR2, projectR2AssetKey, uploadFileToR2 } from '../lib/r2.js'

const router = express.Router()
export const manualWindowsVideoRouter = express.Router()
const upload = multer({
  storage: multer.diskStorage({
    destination: '/tmp',
    filename: (_req, _file, callback) => callback(null, `content-machine-${randomUUID()}.mp4`),
  }),
  limits: { fileSize: 512 * 1024 * 1024, files: 1, fields: 4 },
})
const execFileAsync = promisify(execFile)

const safeSession = (value) => {
  if (!validSessionId(value)) throw new Error('A valid sessionId is required')
  return String(value)
}

const requireProjectAccess = async (req, sessionId) => {
  const supplied = String(req.get('x-content-machine-session-token') || '')
  const project = await readSessionSnapshot(sessionId)
  const expected = String(project._session?.write_token || '')
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  if (!expected || left.length !== right.length || !timingSafeEqual(left, right)) {
    const error = new Error('Project authorization failed')
    error.status = 401
    throw error
  }
}

router.post('/generate', async (req, res) => {
  try {
    const sessionId = safeSession(req.body?.sessionId)
    await requireProjectAccess(req, sessionId)
    const unitIds = Array.isArray(req.body?.unitIds) ? req.body.unitIds.map(String) : []
    const results = await queueWindowsUnits(sessionId, unitIds)
    res.status(results.some((item) => !item.error) ? 202 : 400).json({ results, status: await windowsStatus(sessionId, false) })
  } catch (error) {
    res.status(error.status || 400).json({ error: true, code: error.code || 'WINDOWS_QUEUE_FAILED', message: error.message })
  }
})

router.get('/status/:sessionId', async (req, res) => {
  try {
    const sessionId = safeSession(req.params.sessionId)
    await requireProjectAccess(req, sessionId)
    res.json(await windowsStatus(sessionId))
  } catch (error) {
    res.status(error.status || 503).json({ error: true, code: error.code || 'WINDOWS_STATUS_FAILED', message: error.message, retryable: error.retryable !== false })
  }
})

router.post('/pause', async (req, res) => {
  try {
    const sessionId = safeSession(req.body?.sessionId)
    await requireProjectAccess(req, sessionId)
    res.json(await pauseWindowsProject(sessionId, req.body?.reason))
  }
  catch (error) { res.status(error.status || 503).json({ error: true, code: error.code || 'WINDOWS_PAUSE_FAILED', message: error.message }) }
})

router.post('/resume', async (req, res) => {
  try {
    const sessionId = safeSession(req.body?.sessionId)
    await requireProjectAccess(req, sessionId)
    res.json(await resumeWindowsProject(sessionId, true))
  }
  catch (error) { res.status(error.status || 503).json({ error: true, code: error.code || 'WINDOWS_RESUME_FAILED', message: error.message }) }
})

router.post('/retry-missing', async (req, res) => {
  try {
    const sessionId = safeSession(req.body?.sessionId)
    await requireProjectAccess(req, sessionId)
    const requested = Array.isArray(req.body?.unitIds) ? new Set(req.body.unitIds.map(String)) : null
    const missing = (await missingWindowsUnits(sessionId)).filter((unitId) => !requested || requested.has(unitId))
    await resetWindowsRepairBudget(sessionId)
    res.json({ missing, results: missing.length ? await queueWindowsUnits(sessionId, missing) : [], status: await windowsStatus(sessionId, false) })
  } catch (error) {
    res.status(error.status || 503).json({ error: true, code: error.code || 'WINDOWS_RETRY_FAILED', message: error.message })
  }
})

router.post('/regenerate', async (req, res) => {
  try {
    const sessionId = safeSession(req.body?.sessionId)
    await requireProjectAccess(req, sessionId)
    const unitId = String(req.body?.unitId || '')
    await assertWindowsUnit(sessionId, unitId)
    const result = await regenerateWindowsUnit(sessionId, unitId, {
      prompt: req.body?.prompt,
    })
    if (result?.error) {
      return res.status(400).json({
        error: true,
        code: result.error.code || 'WINDOWS_REGENERATE_FAILED',
        message: result.error.message,
        retryable: result.error.retryable !== false,
      })
    }
    return res.status(202).json({ result, status: await windowsStatus(sessionId, false) })
  } catch (error) {
    return res.status(error.status || 503).json({
      error: true,
      code: error.code || 'WINDOWS_REGENERATE_FAILED',
      message: error.message,
      retryable: error.retryable !== false,
    })
  }
})

router.post('/cancel', async (req, res) => {
  try {
    const sessionId = safeSession(req.body?.sessionId)
    await requireProjectAccess(req, sessionId)
    await cancelWindowsProject(sessionId, { reason: req.body?.reason || 'Canceled by user' })
    res.json(await windowsStatus(sessionId, false))
  } catch (error) {
    res.status(error.status || 503).json({ error: true, code: error.code || 'WINDOWS_CANCEL_FAILED', message: error.message })
  }
})

const probeVideo = async (file) => {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,r_frame_rate',
    '-of', 'json', file,
  ], { maxBuffer: 1024 * 1024, timeout: 30_000 })
  const parsed = JSON.parse(stdout)
  const video = parsed.streams?.find((stream) => stream.codec_type === 'video')
  if (!video || !Number(parsed.format?.duration)) throw new Error('Uploaded file is not a valid MP4 video')
  const [numerator, denominator] = String(video.r_frame_rate || '0/1').split('/').map(Number)
  return {
    durationSeconds: Number(parsed.format.duration),
    width: Number(video.width),
    height: Number(video.height),
    fps: denominator ? numerator / denominator : 0,
    videoCodec: video.codec_name || 'unknown',
    hasAudio: parsed.streams.some((stream) => stream.codec_type === 'audio'),
  }
}

const sha256File = (filePath) => new Promise((resolve, reject) => {
  const hash = createHash('sha256')
  const stream = createReadStream(filePath)
  stream.on('data', (chunk) => hash.update(chunk))
  stream.on('error', reject)
  stream.on('end', () => resolve(hash.digest('hex')))
})

const manualAttachHandler = async (req, res) => {
  let temporary
  let uploadedAsset = null
  try {
    const sessionId = safeSession(req.body?.sessionId)
    await requireProjectAccess(req, sessionId)
    const unitId = String(req.body?.unitId || '')
    if (!/^\d+_\d+$/.test(unitId)) throw new Error('A valid unitId is required')
    if (!req.file?.path || !req.file.size) throw new Error('An MP4 file is required')
    if (req.file.mimetype !== 'video/mp4') throw new Error('Manual attachment must be video/mp4')
    temporary = req.file.path
    await assertWindowsUnit(sessionId, unitId)
    const media = await probeVideo(temporary)
    const sha256 = await sha256File(temporary)
    const relativePath = `videos/manual/${unitId}-${sha256.slice(0, 16)}.mp4`
    const url = await uploadFileToR2(temporary, req.file.size, 'video/mp4', { sessionId, relativePath })
    uploadedAsset = { sessionId, relativePath }
    const objectKey = projectR2AssetKey(sessionId, relativePath, 'video/mp4')
    const status = await attachManualWindowsVideo(sessionId, unitId, {
      url, objectKey, sha256, sizeBytes: req.file.size, etag: null, ...media,
    })
    uploadedAsset = null
    res.json({ unitId, result: status.jobs[unitId], status })
  } catch (error) {
    res.status(error.status || 400).json({ error: true, code: 'MANUAL_ATTACH_FAILED', message: error.message })
  } finally {
    if (uploadedAsset) {
      await deleteProjectAssetFromR2(uploadedAsset.sessionId, uploadedAsset.relativePath).catch(() => {})
    }
    if (temporary) await fs.unlink(temporary).catch(() => {})
  }
}

router.post('/manual-attach', upload.single('file'), manualAttachHandler)
manualWindowsVideoRouter.post('/manual-attach', upload.single('file'), manualAttachHandler)

export default router
