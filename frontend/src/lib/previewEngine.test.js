import test from 'node:test'
import assert from 'node:assert/strict'
import {
  planClips,
  poolAssign,
  audioWindow,
  clipLocalTime,
  driftAdjustedRate,
  musicVolumeAt,
  sfxCueItems,
} from './previewEngine.js'

const clip = (id, start, end, extra = {}) => ({
  id, kind: 'clip', startTime: start, endTime: end,
  payload: { src: `http://x/${id}.mp4`, ...extra },
})

const ITEMS = [
  clip('a', 0, 4),
  clip('b', 4, 8, { playbackRate: 0.8 }),
  clip('c', 8, 12),
  clip('d', 12, 16),
  { id: 'n1', kind: 'narration', startTime: 1, endTime: 6, payload: { src: 'http://x/n1.mp3' } },
  { id: 'm1', kind: 'music', startTime: 0, endTime: 30, payload: { src: 'http://x/m1.mp3', volume: 0.5 } },
]

test('planClips returns the active clip and the next two upcoming clips', () => {
  const plan = planClips(ITEMS, 5)
  assert.equal(plan.active?.id, 'b')
  assert.deepEqual(plan.upcoming.map(i => i.id), ['c', 'd'])
  // In a gap or before the first clip there is no active but upcoming exists
  const before = planClips([clip('z', 2, 3)], 0.5)
  assert.equal(before.active, null)
  assert.deepEqual(before.upcoming.map(i => i.id), ['z'])
  // Overlapping clips: the later-starting one wins (matches previous player)
  const overlap = planClips([clip('p', 0, 10), clip('q', 4, 8)], 5)
  assert.equal(overlap.active.id, 'q')
})

test('poolAssign keeps the active clip on its already-prepared element and never reassigns the visible slot src', () => {
  // 3 slots; slot1 was prepared with clip b while a was visible on slot0
  const prev = { slots: [{ clipId: 'a' }, { clipId: 'b' }, { clipId: 'c' }], visible: 0 }
  const out = poolAssign(prev, planClips(ITEMS, 5))
  // b became active: visible slot flips to the slot already holding b
  assert.equal(out.visible, 1)
  assert.equal(out.slots[out.visible].clipId, 'b')
  // The freed and spare slots hold the next two clips
  const others = out.slots.filter((_, i) => i !== out.visible).map(s => s.clipId).sort()
  assert.deepEqual(others, ['c', 'd'])
})

test('poolAssign cold-starts when the active clip is not prepared anywhere', () => {
  const prev = { slots: [{ clipId: null }, { clipId: null }, { clipId: null }], visible: 0 }
  const out = poolAssign(prev, planClips(ITEMS, 5))
  assert.equal(out.slots[out.visible].clipId, 'b')
  assert.ok(out.coldStart)
})

test('audioWindow mounts only the neighborhood and flags which items are audible now', () => {
  const win = audioWindow(ITEMS, 5, { behind: 4, ahead: 18 })
  const ids = win.map(w => w.item.id)
  assert.ok(ids.includes('n1'))
  assert.ok(ids.includes('m1'))
  const n1 = win.find(w => w.item.id === 'n1')
  assert.equal(n1.active, true)
  const far = audioWindow(ITEMS, 29.5, { behind: 4, ahead: 18 })
  assert.ok(!far.map(w => w.item.id).includes('n1'))
})

test('clipLocalTime honors playbackRate and startFrom', () => {
  assert.equal(clipLocalTime(clip('b', 4, 8, { playbackRate: 0.8 }), 5), 0.8)
  assert.equal(clipLocalTime(clip('b', 4, 8, { startFrom: 2 }), 5), 3)
})

test('driftAdjustedRate nudges within ±2% and requests resync only for gross drift', () => {
  const base = 1
  // small drift → bounded rate adjustment, no resync
  const small = driftAdjustedRate(base, 0.1)
  assert.ok(small.rate < 1 && small.rate >= 0.98)
  assert.equal(small.resync, false)
  const ahead = driftAdjustedRate(base, -0.1)
  assert.ok(ahead.rate > 1 && ahead.rate <= 1.02)
  // tiny drift → rate returns to base
  assert.equal(driftAdjustedRate(base, 0.005).rate, base)
  // gross drift (stalled element) → resync requested
  assert.equal(driftAdjustedRate(base, 0.9).resync, true)
})

test('musicVolumeAt applies fades, ducking and master; sfxCueItems expands cues', () => {
  const music = { startTime: 0, endTime: 10, payload: { volume: 0.5, fadeInSeconds: 2, fadeOutSeconds: 2, duckingDb: -6 } }
  const mid = musicVolumeAt(music, 5, 1, false)
  assert.ok(Math.abs(mid - 0.5) < 1e-9)
  const ducked = musicVolumeAt(music, 5, 1, true)
  assert.ok(ducked < mid)
  assert.equal(musicVolumeAt({ ...music, payload: { ...music.payload, muted: true } }, 5, 1, false), 0)

  const items = [{
    id: 'clipX', kind: 'clip', startTime: 10, endTime: 14,
    payload: { spec: { sound_design: { cues: [{ id: 'c1', asset: 'http://x/s.mp3', at_seconds: 1, duration_seconds: 0.5, gain_db: -12 }] } } },
  }]
  const cues = sfxCueItems(items, 1)
  assert.equal(cues.length, 1)
  assert.equal(cues[0].startTime, 11)
  assert.equal(cues[0].kind, 'sound-effect')
})
