import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publicDirectorMusicCatalog,
  sanitizeDirectorScore,
} from './directorMusicCatalog.js';

test('Director music catalog exposes named previewable analyzed tracks', () => {
  const tracks = publicDirectorMusicCatalog();
  assert.equal(tracks.length, 7);
  for (const track of tracks) {
    assert.ok(track.name.length > 4);
    assert.match(track.url, /^\/api\/director\/music\/file\//);
    assert.ok(track.duration_seconds >= 60);
    assert.ok(track.waveform_peaks.length >= 120);
    assert.equal(track.provider, 'elevenlabs');
    assert.equal(track.model, 'music_v2');
  }
});

test('score sanitization creates opening + contiguous story cues and rotates tracks', () => {
  const score = sanitizeDirectorScore(null, {
    sceneCount: 9,
    storyTitle: 'A Different Case',
    enabled: true,
    chapters: [
      { start_scene: 1, title: 'The Door' },
      { start_scene: 4, title: 'The Search' },
      { start_scene: 7, title: 'What Remained' },
    ],
  });
  assert.equal(score.enabled, true);
  assert.equal(score.cues[0].section, 'opening');
  assert.deepEqual(score.cues.slice(1).map(cue => [cue.start_scene, cue.end_scene]), [
    [1, 3],
    [4, 6],
    [7, 9],
  ]);
  for (const cue of score.cues) {
    assert.ok(cue.track_name);
    assert.match(cue.asset_url, /^\/api\/director\/music\/file\//);
    assert.ok(cue.waveform_peaks.length >= 120);
    assert.ok(cue.authored_volume >= 0.24 && cue.authored_volume <= 0.9);
  }
  assert.equal(score.library.length, 7);
});
