import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMasterTimeline, MIN_EXPOSED_FRAMES } from './timelineNormalize.js';

const clip = (startFrame, durationInFrames) => ({
  src: 'clip.mp4', startFrame, durationInFrames, transitionIn: 'cut', volume: 0, push: true,
});

const baseTimeline = (overrides = {}) => ({
  fps: 30,
  width: 1920,
  height: 1080,
  style: 'chronicle',
  clips: [clip(0, 600)],
  narration: [],
  music: [],
  overlays: [],
  tailFrames: 30,
  ...overrides,
});

test('a map ending just before the film end is extended to cover it (no flash)', () => {
  const t = baseTimeline({
    clips: [clip(0, 6893)],
    overlays: [{ kind: 'map', src: 'm.mp4', startFrame: 6412, durationInFrames: 480 }],
  });
  const { timeline, log } = normalizeMasterTimeline(t);
  const map = timeline.overlays[0];
  assert.equal(map.startFrame + map.durationInFrames, 6893);
  assert.equal(map.holdFrames, 6893 - 6892);
  assert.ok(log.some((l) => l.includes('map')));
});

test('a map is not touched when the exposed tail is long enough', () => {
  const t = baseTimeline({
    clips: [clip(0, 1000)],
    overlays: [{ kind: 'map', src: 'm.mp4', startFrame: 300, durationInFrames: 480 }],
  });
  const { timeline } = normalizeMasterTimeline(t);
  assert.equal(timeline.overlays[0].durationInFrames, 480);
  assert.equal(timeline.overlays[0].holdFrames, undefined);
});

test('a map exposing a short window before the next full-frame overlay is extended to meet it', () => {
  const t = baseTimeline({
    clips: [clip(0, 2000)],
    overlays: [
      { kind: 'map', src: 'm.mp4', startFrame: 300, durationInFrames: 480 },
      {
        kind: 'chapter-active',
        chapters: [{ title: 'A', image: 'a.jpg' }],
        activeIndex: 0,
        startFrame: 880,
        durationInFrames: 150,
      },
    ],
  });
  const { timeline } = normalizeMasterTimeline(t);
  const map = timeline.overlays.find((o) => o.kind === 'map');
  assert.equal(map.startFrame + map.durationInFrames, 880);
  assert.equal(map.holdFrames, 100);
});

test('a title flowing directly into a chapter reveal exits to black', () => {
  const t = baseTimeline({
    overlays: [
      { kind: 'title', text: 'T', startFrame: 320, durationInFrames: 150 },
      {
        kind: 'chapter-reveal',
        chapters: [{ title: 'A', image: 'a.jpg' }],
        startFrame: 470,
        durationInFrames: 200,
      },
    ],
  });
  const { timeline } = normalizeMasterTimeline(t);
  assert.equal(timeline.overlays.find((o) => o.kind === 'title').exit, 'to-black');
});

test('a short exposed window between title and chapters is closed by extending the title', () => {
  const t = baseTimeline({
    overlays: [
      { kind: 'title', text: 'T', startFrame: 320, durationInFrames: 110 },
      {
        kind: 'chapter-reveal',
        chapters: [{ title: 'A', image: 'a.jpg' }],
        startFrame: 470,
        durationInFrames: 200,
      },
    ],
  });
  const { timeline } = normalizeMasterTimeline(t);
  const title = timeline.overlays.find((o) => o.kind === 'title');
  assert.equal(title.durationInFrames, 150);
  assert.equal(title.exit, 'to-black');
});

test('a long exposed window after the title is left alone and the title exit stays reveal', () => {
  const t = baseTimeline({
    clips: [clip(0, 2000)],
    overlays: [
      { kind: 'title', text: 'T', startFrame: 100, durationInFrames: 150 },
      {
        kind: 'chapter-reveal',
        chapters: [{ title: 'A', image: 'a.jpg' }],
        startFrame: 250 + MIN_EXPOSED_FRAMES,
        durationInFrames: 200,
      },
    ],
  });
  const { timeline } = normalizeMasterTimeline(t);
  const title = timeline.overlays.find((o) => o.kind === 'title');
  assert.equal(title.durationInFrames, 150);
  assert.equal(title.exit, undefined);
});

test('text overlays overlapping a map window are dropped', () => {
  const t = baseTimeline({
    clips: [clip(0, 2000)],
    overlays: [
      { kind: 'map', src: 'm.mp4', startFrame: 300, durationInFrames: 480 },
      { kind: 'date-chip', text: '1944', corner: 'tr', startFrame: 400, durationInFrames: 180 },
      { kind: 'lower-third', text: 'Someone', startFrame: 1200, durationInFrames: 180 },
    ],
  });
  const { timeline, log } = normalizeMasterTimeline(t);
  assert.equal(timeline.overlays.some((o) => o.kind === 'date-chip'), false);
  assert.equal(timeline.overlays.some((o) => o.kind === 'lower-third'), true);
  assert.ok(log.some((l) => l.includes('date-chip')));
});

test('small text overlays are dropped when an agentic motion graphic owns the hierarchy', () => {
  const result = normalizeMasterTimeline(baseTimeline({
    overlays: [
      {
        kind: 'motion-graphic',
        spec: { presentation: 'overlay' },
        startFrame: 120,
        durationInFrames: 240,
      },
      {
        kind: 'lower-third',
        text: 'Competing label',
        startFrame: 180,
        durationInFrames: 120,
      },
    ],
  }));
  assert.deepEqual(result.timeline.overlays.map((overlay) => overlay.kind), ['motion-graphic']);
  assert.match(result.log.join('\n'), /overlaps a motion-graphic/);
});

test('chapter overlays are never resized (timing is narration-locked)', () => {
  const t = baseTimeline({
    clips: [clip(0, 2000)],
    overlays: [
      {
        kind: 'chapter-active',
        chapters: [{ title: 'A', image: 'a.jpg' }],
        activeIndex: 0,
        startFrame: 300,
        durationInFrames: 150,
      },
      { kind: 'map', src: 'm.mp4', startFrame: 520, durationInFrames: 480 },
    ],
  });
  const { timeline, log } = normalizeMasterTimeline(t);
  const stinger = timeline.overlays.find((o) => o.kind === 'chapter-active');
  assert.equal(stinger.durationInFrames, 150);
  assert.ok(log.some((l) => l.includes('short exposed window')));
});
