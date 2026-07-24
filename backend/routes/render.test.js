import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

test('sound cue timing aligns the detected onset to the visual beat', async () => {
  const { soundCueTiming } = await import(`./render.js?sound-test=${Date.now()}`);
  const timing = soundCueTiming(10, {
    at_seconds: 3.7,
    anchor_seconds: 0.045,
    duration_seconds: 0.5,
    gain_db: -12,
  });
  assert.equal(timing.visualBeatSeconds, 13.7);
  assert.equal(timing.startFrame, Math.round((13.7 - 0.045) * 30));
  assert.equal(timing.durationInFrames, 15);
  assert.ok(Math.abs(timing.volume - 0.2511886) < 0.00001);
});

test('sound-effects master preserves authored gain, supports mute, and clamps boost', async () => {
  const {
    mixSoundEffectVolume,
    normalizeSoundEffectsVolume,
  } = await import(`./render.js?mix-test=${Date.now()}`);
  assert.equal(normalizeSoundEffectsVolume(undefined), 1);
  assert.equal(normalizeSoundEffectsVolume(-1), 0);
  assert.equal(normalizeSoundEffectsVolume(9), 1.5);
  assert.equal(mixSoundEffectVolume(0.2, 1), 0.2);
  assert.equal(mixSoundEffectVolume(0.2, 0), 0);
  assert.ok(Math.abs(mixSoundEffectVolume(0.2, 1.5) - 0.3) < 0.000001);
  assert.equal(mixSoundEffectVolume(0.9, 1.5), 1);
});

test('background-music master preserves authored normalization and clamps safely', async () => {
  const {
    mixBackgroundMusicVolume,
    normalizeBackgroundMusicVolume,
  } = await import(`./render.js?music-mix-test=${Date.now()}`);
  assert.equal(normalizeBackgroundMusicVolume(undefined), 1);
  assert.equal(normalizeBackgroundMusicVolume(-2), 0);
  assert.equal(normalizeBackgroundMusicVolume(4), 1.5);
  assert.equal(mixBackgroundMusicVolume(0.5, 1), 0.5);
  assert.equal(mixBackgroundMusicVolume(0.5, 0), 0);
  assert.equal(mixBackgroundMusicVolume(0.5, 1.5), 0.75);
  assert.equal(mixBackgroundMusicVolume(0.9, 1.5), 1);
});

test('film treatment is normalized as a renderer-safe project contract', async () => {
  const { normalizeFilmTreatment } = await import(`./render.js?film-treatment-test=${Date.now()}`);
  assert.equal(normalizeFilmTreatment(undefined), undefined);
  assert.deepEqual(normalizeFilmTreatment({
    grain: 1.8,
    atmosphere: 0.42,
    vignette: -0.4,
  }), {
    grain: 1,
    atmosphere: 0.42,
    vignette: 0,
  });
});

test('project cleanup removes only render workspaces owned by that session', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'contentmachine-render-cleanup-'));
  const workRoot = path.join(root, 'public', 'docmaster-work');
  const ownedA = path.join(workRoot, 'render_session_alpha_abc');
  const ownedB = path.join(workRoot, 'render_session_alpha_xyz');
  const foreign = path.join(workRoot, 'render_session_beta_abc');
  await Promise.all([ownedA, ownedB, foreign].map(directory => fs.mkdir(directory, { recursive: true })));

  const previousPath = process.env.STORYFORGE_PATH;
  process.env.STORYFORGE_PATH = root;
  try {
    const { deleteRenderWorkspacesForSession } = await import(`./render.js?cleanup-test=${Date.now()}`);
    const deleted = await deleteRenderWorkspacesForSession('session_alpha');
    assert.equal(deleted, 2);
    await assert.rejects(fs.access(ownedA));
    await assert.rejects(fs.access(ownedB));
    await fs.access(foreign);
    await assert.rejects(
      deleteRenderWorkspacesForSession('../session_beta'),
      /invalid project session id/i
    );
  } finally {
    if (previousPath === undefined) delete process.env.STORYFORGE_PATH;
    else process.env.STORYFORGE_PATH = previousPath;
    await fs.rm(root, { recursive: true, force: true });
  }
});
