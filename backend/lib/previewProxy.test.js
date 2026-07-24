import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const run = promisify(execFile)

const mod = () => import(`./previewProxy.js?t=${Date.now()}`)

test('contentKey ignores volatile query strings and differs per object path', async () => {
  const { contentKey } = await mod()
  const a1 = contentKey('https://cdn.example.com/bucket/video/abc/clip.mp4?Signature=X&Expires=1')
  const a2 = contentKey('https://cdn.example.com/bucket/video/abc/clip.mp4?Signature=Y&Expires=2')
  const b = contentKey('https://cdn.example.com/bucket/video/def/clip.mp4?Signature=X')
  assert.equal(a1, a2)
  assert.notEqual(a1, b)
  assert.match(a1, /^[a-f0-9]{40}$/)
  // Local API paths are keyed on the path alone too
  const l1 = contentKey('/api/session/s1/files/videos/scene_01_selected.mp4')
  assert.match(l1, /^[a-f0-9]{40}$/)
})

test('mirrorRelFor maps scene/segment to the session video mirror name', async () => {
  const { mirrorRelFor } = await mod()
  assert.equal(mirrorRelFor({ sceneNumber: 1, segmentIndex: 0 }), 'videos/scene_01_selected.mp4')
  assert.equal(mirrorRelFor({ sceneNumber: 1, segmentIndex: 1 }), 'videos/scene_01_shot2_selected.mp4')
  assert.equal(mirrorRelFor({ sceneNumber: 12, segmentIndex: 2 }), 'videos/scene_12_shot3_selected.mp4')
  assert.equal(mirrorRelFor({ sceneNumber: null, segmentIndex: 0 }), null)
})

test('localSourceFor resolves same-session file URLs and rejects traversal/foreign sessions', async () => {
  const { localSourceFor } = await mod()
  const dir = '/tmp/out/session_x'
  assert.equal(
    localSourceFor('/api/session/session_x/files/videos/a.mp4', 'session_x', dir),
    path.join(dir, 'videos/a.mp4')
  )
  assert.equal(localSourceFor('/api/session/other/files/videos/a.mp4', 'session_x', dir), null)
  assert.equal(localSourceFor('/api/session/session_x/files/../../etc/passwd', 'session_x', dir), null)
  assert.equal(localSourceFor('https://cdn.example.com/x.mp4', 'session_x', dir), null)
})

test('ffmpegArgs enforce short GOP, faststart, 720p cap and encoder choice', async () => {
  const { ffmpegArgs } = await mod()
  const hw = ffmpegArgs('/in.mp4', '/out.mp4', { encoder: 'h264_videotoolbox' })
  assert.ok(hw.includes('h264_videotoolbox'))
  assert.ok(hw.join(' ').includes('faststart'))
  assert.ok(hw.join(' ').includes('force_key_frames') || hw.join(' ').match(/-g\b/))
  assert.ok(hw.join(' ').includes("min(720"))
  const sw = ffmpegArgs('/in.mp4', '/out.mp4', { encoder: 'libx264' })
  assert.ok(sw.includes('libx264'))
})

test('transcodeOne produces a playable short-GOP proxy from a real file', async () => {
  const { transcodeOne } = await mod()
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-test-'))
  const input = path.join(dir, 'in.mp4')
  const output = path.join(dir, 'out.mp4')
  // 2.5s synthetic single-keyframe-ish source at 24fps
  await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=2.5', '-c:v', 'libx264', '-g', '999', '-pix_fmt', 'yuv420p', input])
  await transcodeOne(input, output)
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=key_frame', '-of', 'csv=p=0', '-skip_frame', 'nokey', output])
  const keyframes = stdout.trim().split('\n').filter(Boolean).length
  assert.ok(keyframes >= 3, `expected >=3 keyframes, got ${keyframes}`)
  await fs.rm(dir, { recursive: true, force: true })
})

test('buildProxies skips existing outputs and reports a src->url map', async () => {
  const { buildProxies, contentKey } = await mod()
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'proxy-session-'))
  const src = 'https://cdn.example.com/video/xyz/clip.mp4?Signature=Q'
  const key = contentKey(src)
  await fs.mkdir(path.join(sessionDir, 'preview-proxy'), { recursive: true })
  // Pre-place a fake proxy file → builder must not attempt any network/transcode
  await fs.writeFile(path.join(sessionDir, 'preview-proxy', `${key}.mp4`), 'stub')
  const job = await buildProxies({
    sessionId: 'session_t',
    sessionDir,
    items: [{ src, sceneNumber: 1, segmentIndex: 0 }],
  })
  assert.equal(job.total, 1)
  assert.equal(job.done, 1)
  assert.equal(job.errors.length, 0)
  assert.equal(job.map[src], `/api/session/session_t/preview-proxy/${key}.mp4`)
  await fs.rm(sessionDir, { recursive: true, force: true })
})
