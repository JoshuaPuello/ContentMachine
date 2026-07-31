import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyDirectorPlan,
  buildDirectorMusicItems,
  buildNarrationSfxItems,
  deriveBaseTimeline,
} from './timeline.js'
import { clipLocalTime } from './previewEngine.js'

test('measured cinematic audio drives montage and chapter block durations', () => {
  const baseItems = [
    { id: 'c1', kind: 'clip', startTime: 0, endTime: 8, payload: {} },
    { id: 'n1', kind: 'narration', startTime: 0, endTime: 8, payload: {} },
    { id: 'c2', kind: 'clip', startTime: 8, endTime: 16, payload: {} },
    { id: 'n2', kind: 'narration', startTime: 8, endTime: 16, payload: {} },
  ]
  const chapters = [
    { title: 'One', start_scene: 1, image: 'one.jpg' },
    { title: 'Two', start_scene: 2, image: 'two.jpg' },
  ]
  const result = applyDirectorPlan({
    baseItems,
    sceneWindows: { 1: { start: 0, end: 8 }, 2: { start: 8, end: 16 } },
    plan: {
      trailer: { title: 'Title', subtitle: 'Subtitle' },
      trailerItems: Array.from({ length: 5 }, (_, index) => ({ src: `${index}.mp4`, sceneNumber: index + 1, duration: 2.08 })),
    },
    chapters,
    storyTitle: 'Title',
    cinemaAudio: {
      'cinema:trailer': { src: 'trailer.mp3', durationSeconds: 10.4 },
      'cinema:overview:1': { src: 'o1.mp3', durationSeconds: 3.2 },
      'cinema:overview:2': { src: 'o2.mp3', durationSeconds: 3.8 },
      'cinema:transition:1': { src: 't1.mp3', durationSeconds: 4.1 },
      'cinema:transition:2': { src: 't2.mp3', durationSeconds: 5.3 },
    },
  })

  const trailerVoice = result.items.find(item => item.label === 'Trailer voiceover')
  assert.equal(trailerVoice.endTime - trailerVoice.startTime, 10.4)
  const introClips = result.items.filter(item => item.payload?.intro && item.kind === 'clip')
  assert.equal(Number(introClips.at(-1).endTime.toFixed(2)), 10.4)

  const reveal = result.items.find(item => item.kind === 'chapter-reveal')
  assert.equal(Number((reveal.endTime - reveal.startTime).toFixed(2)), 11.1)
  assert.deepEqual(reveal.payload.activationCues, [
    { index: 0, offset: 0 },
    { index: 1, offset: 3.2 },
    { index: 0, offset: 7 },
  ])
  const second = result.items.find(item => item.kind === 'chapter-active')
  assert.equal(Number((second.endTime - second.startTime).toFixed(2)), 5.3)
})

test('multi-line TTS parts are scheduled sequentially without silence', () => {
  const result = deriveBaseTimeline({
    sceneOrder: [1],
    sceneAudioBySceneNumber: {
      1: {
        url: 'line-1.mp3',
        durationSeconds: 5,
        parts: [
          { src: 'line-1.mp3', durationSeconds: 2 },
          { src: 'line-2.mp3', durationSeconds: 3 },
        ],
      },
    },
    sceneSegments: { 1: [] },
    selectedVideos: {},
  })

  const narration = result.items.filter(item => item.kind === 'narration')
  assert.deepEqual(narration.map(item => [item.payload.src, item.startTime, item.endTime]), [
    ['line-1.mp3', 0, 2],
    ['line-2.mp3', 2, 5],
  ])
})

test('editorial target trims an eight-second provider source on the timeline', () => {
  const result = deriveBaseTimeline({
    sceneOrder: [1],
    sceneAudioBySceneNumber: {},
    sceneSegments: {
      1: [{
        segmentIndex: 0,
        targetDuration: 3.2,
        clipDuration: 8,
        playbackRate: 0.8,
      }],
    },
    selectedVideos: {
      '1_0': {
        url: '/provider-source-8s.mp4',
        duration: 8,
        target_duration: 3.2,
        playback_rate: 0.8,
      },
    },
  })

  const clip = result.items.find(item => item.kind === 'clip')
  assert.equal(clip.endTime - clip.startTime, 3.2)
  assert.equal(result.totalDuration, 3.2)
  assert.equal(clip.payload.playbackRate, 0.8)
  assert.equal(Number(clipLocalTime(clip, clip.endTime).toFixed(2)), 2.56)
  assert.equal(clip.payload.transitionIn, 'cut')
})

test('Director transitions become anchored, editable timeline objects', () => {
  const baseItems = [
    { id: 'c1', kind: 'clip', startTime: 0, endTime: 5, payload: { src: 'a.mp4', sceneNumber: 1, segmentIndex: 0 } },
    { id: 'c2', kind: 'clip', startTime: 5, endTime: 10, payload: { src: 'b.mp4', sceneNumber: 2, segmentIndex: 0 } },
  ]
  const result = applyDirectorPlan({
    baseItems,
    sceneWindows: { 1: { start: 0, end: 5 }, 2: { start: 5, end: 10 } },
    plan: { transitions: [{ id: 'tr-1', before_scene: 2, type: 'soft-blur', duration_seconds: 0.65, reason: 'A real time jump.' }] },
    chapters: [],
  })
  const transition = result.items.find(item => item.kind === 'transition')
  assert.equal(transition.startTime, 5)
  assert.equal(transition.endTime, 5.65)
  assert.equal(transition.payload.fromClipId, 'c1')
  assert.equal(transition.payload.toClipId, 'c2')
  assert.equal(transition.payload.type, 'soft-blur')
})

test('narration SFX uses measured line boundaries when individual TTS parts exist', () => {
  const items = buildNarrationSfxItems({
    ttsScript: {
      scene_breakdown: [{
        scene_id: 's01',
        lines: ['First spoken line.', '[SFX:METAL_DOOR_SLAM]', 'Second spoken line.'],
      }],
    },
    scenePlan: { scenes: [{ scene_id: 's01', scene_number: 1 }] },
    sceneWindows: { 1: { start: 10, end: 18 } },
    sceneAudio: {
      s01: {
        parts: [
          { type: 'audio', durationSeconds: 2.25 },
          { type: 'audio', durationSeconds: 5.75 },
        ],
      },
    },
    sfxAudio: {
      '[SFX:METAL_DOOR_SLAM]': {
        audio: '/door.mp3',
        durationSeconds: 2,
        prompt: 'precise door prompt',
      },
    },
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].startTime, 12.25)
  assert.equal(items[0].endTime, 14.25)
  assert.equal(items[0].payload.source, 'narration-cue')
})

test('narration SFX falls back to spoken-word position for a Whisper scene slice', () => {
  const items = buildNarrationSfxItems({
    ttsScript: {
      scene_breakdown: [{
        scene_id: 's01',
        lines: ['One two.', '[SFX:DISTANT_THUNDER]', 'Three four five six.'],
      }],
    },
    scenePlan: { scenes: [{ scene_id: 's01', scene_number: 1 }] },
    sceneWindows: { 1: { start: 20, end: 26 } },
    sceneAudio: { s01: { parts: [{ type: 'audio', durationSeconds: 6 }] } },
    sfxAudio: {
      '[SFX:DISTANT_THUNDER]': { audio: '/thunder.mp3', durationSeconds: 3 },
    },
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].startTime, 22)
  assert.equal(items[0].endTime, 25)
})

test('narration SFX anchors to the exact Whisper word gap when timestamps exist', () => {
  const items = buildNarrationSfxItems({
    ttsScript: {
      scene_breakdown: [{
        scene_id: 's01',
        lines: ['The lock turns.', '[SFX:LOCK_CLICK]', 'The door opens.'],
      }],
    },
    scenePlan: { scenes: [{ scene_id: 's01', scene_number: 1 }] },
    sceneWindows: { 1: { start: 40, end: 48 } },
    sceneAudio: {
      s01: {
        wordTimings: [
          { wordIndex: 0, startSeconds: 0.4, endSeconds: 0.7 },
          { wordIndex: 1, startSeconds: 0.75, endSeconds: 1.1 },
          { wordIndex: 2, startSeconds: 1.2, endSeconds: 1.55 },
          { wordIndex: 3, startSeconds: 2.05, endSeconds: 2.3 },
        ],
      },
    },
    sfxAudio: {
      '[SFX:LOCK_CLICK]': { audio: '/lock.mp3', durationSeconds: 1 },
    },
  })
  assert.equal(items.length, 1)
  assert.equal(items[0].startTime, 41.8)
})

test('Director score chains long sections with overlap and no exposed silence', () => {
  const library = [
    {
      id: 'investigation-a',
      name: 'Investigation A',
      roles: ['chapter'],
      moods: ['investigative'],
      duration_seconds: 8,
      waveform_peaks: [0.2, 0.5],
      url: '/music/a',
    },
    {
      id: 'investigation-b',
      name: 'Investigation B',
      roles: ['chapter'],
      moods: ['investigative'],
      duration_seconds: 8,
      waveform_peaks: [0.4, 0.3],
      url: '/music/b',
    },
  ]
  const items = buildDirectorMusicItems({
    score: {
      enabled: true,
      crossfade_seconds: 2,
      narration_duck_db: -3.5,
      library,
      cues: [{
        id: 'story',
        section: 'story',
        role: 'chapter',
        start_scene: 1,
        end_scene: 3,
        mood: 'investigative',
        track_id: 'investigation-a',
        authored_volume: 0.5,
      }],
    },
    sceneWindows: {
      1: { start: 0, end: 8 },
      2: { start: 8, end: 16 },
      3: { start: 16, end: 25 },
    },
    totalDuration: 25,
  })
  assert.ok(items.length >= 4)
  assert.equal(items[0].startTime, 0)
  assert.equal(items.at(-1).endTime, 25)
  for (let index = 1; index < items.length; index += 1) {
    assert.ok(items[index].startTime < items[index - 1].endTime)
    assert.notEqual(items[index].payload.trackId, items[index - 1].payload.trackId)
  }
})

test('map placement: +2s entry, two-clip span, 7s cap, and <2s tail extension', () => {
  const mapPlan = { maps: [{ id: 'map-1', after_scene: 2, duration_seconds: 7, request: { subject: 'Antwerp' } }] }
  const place = (clips, windows) => applyDirectorPlan({
    baseItems: clips,
    sceneWindows: { ...windows },
    plan: mapPlan,
    chapters: [],
    cinemaAudio: {},
  }).items.find(item => item.kind === 'map')

  // Owner clip 2-7, next clip 7-14. Entry = owner start + 2s = 4; the 7s cap
  // cuts at 11, leaving the next clip 3s of solo footage (>= 2s) — clean cut.
  const cap = place([
    { id: 'c1', kind: 'clip', startTime: 0, endTime: 2, payload: { src: 'a.mp4', sceneNumber: 1, segmentIndex: 0 } },
    { id: 'c2', kind: 'clip', startTime: 2, endTime: 7, payload: { src: 'b.mp4', sceneNumber: 2, segmentIndex: 0 } },
    { id: 'c3', kind: 'clip', startTime: 7, endTime: 14, payload: { src: 'c.mp4', sceneNumber: 3, segmentIndex: 0 } },
  ], { 1: { start: 0, end: 2 }, 2: { start: 2, end: 7 }, 3: { start: 7, end: 14 } })
  assert.equal(cap.startTime, 4)
  assert.equal(cap.endTime, 11)

  // Same layout but the second clip ends at 12.4: cutting at 11 would leave
  // only 1.4s of solo footage — the map holds to the clip end instead.
  const tail = place([
    { id: 'c1', kind: 'clip', startTime: 0, endTime: 2, payload: { src: 'a.mp4', sceneNumber: 1, segmentIndex: 0 } },
    { id: 'c2', kind: 'clip', startTime: 2, endTime: 7, payload: { src: 'b.mp4', sceneNumber: 2, segmentIndex: 0 } },
    { id: 'c3', kind: 'clip', startTime: 7, endTime: 12.4, payload: { src: 'c.mp4', sceneNumber: 3, segmentIndex: 0 } },
  ], { 1: { start: 0, end: 2 }, 2: { start: 2, end: 7 }, 3: { start: 7, end: 12.4 } })
  assert.equal(tail.startTime, 4)
  assert.equal(tail.endTime, 12.4)

  // A map may never span more than two clips: with short clips the reachable
  // end is the second clip's end even though 7s would ask for more.
  const span = place([
    { id: 'c1', kind: 'clip', startTime: 0, endTime: 2, payload: { src: 'a.mp4', sceneNumber: 1, segmentIndex: 0 } },
    { id: 'c2', kind: 'clip', startTime: 2, endTime: 6, payload: { src: 'b.mp4', sceneNumber: 2, segmentIndex: 0 } },
    { id: 'c3', kind: 'clip', startTime: 6, endTime: 8.5, payload: { src: 'c.mp4', sceneNumber: 3, segmentIndex: 0 } },
    { id: 'c4', kind: 'clip', startTime: 8.5, endTime: 16, payload: { src: 'd.mp4', sceneNumber: 4, segmentIndex: 0 } },
  ], { 1: { start: 0, end: 2 }, 2: { start: 2, end: 6 }, 3: { start: 6, end: 8.5 }, 4: { start: 8.5, end: 16 } })
  assert.equal(span.startTime, 4)
  assert.equal(span.endTime, 8.5)
})

test('map placement honors the director presentation hint', () => {
  const placed = applyDirectorPlan({
    baseItems: [
      { id: 'c1', kind: 'clip', startTime: 0, endTime: 6, payload: { src: 'a.mp4', sceneNumber: 1, segmentIndex: 0 } },
      { id: 'c2', kind: 'clip', startTime: 6, endTime: 12, payload: { src: 'b.mp4', sceneNumber: 1, segmentIndex: 1 } },
    ],
    sceneWindows: { 1: { start: 0, end: 12 } },
    plan: { maps: [{ id: 'map-1', after_scene: 1, duration_seconds: 7, request: { subject: 'X', presentation_hint: 'corner' } }] },
    chapters: [],
    cinemaAudio: {},
  }).items.find(item => item.kind === 'map')
  assert.equal(placed.payload.presentation, 'corner')
})
