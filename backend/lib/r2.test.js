import test from 'node:test';
import assert from 'node:assert/strict';
import { projectR2Prefix, projectR2AssetKey, projectR2AssetUrl } from './r2.js';

test('uses an isolated deterministic prefix for every project', () => {
  assert.equal(
    projectR2Prefix('session_2026-07-21_floorb'),
    'contentmachine/projects/session_2026-07-21_floorb/'
  );
  assert.equal(
    projectR2AssetKey('session_2026-07-21_floorb', 'images/all/scene_01_v2.jpg'),
    'contentmachine/projects/session_2026-07-21_floorb/assets/images/all/scene_01_v2.jpg'
  );
});

test('rejects unsafe project ids and keeps asset paths inside the project prefix', () => {
  assert.throws(() => projectR2Prefix('../another-project'), /valid project session id/i);
  assert.equal(
    projectR2AssetKey('safe_project', '../../images/frame.jpg'),
    'contentmachine/projects/safe_project/assets/images/frame.jpg'
  );
});

test('builds the same deterministic public URL consumed by video providers', () => {
  const previous = process.env.R2_PUBLIC_URL;
  process.env.R2_PUBLIC_URL = 'https://media.example.test/';
  try {
    assert.equal(
      projectR2AssetUrl('safe_project', 'images/frame.jpg'),
      'https://media.example.test/contentmachine/projects/safe_project/assets/images/frame.jpg'
    );
  } finally {
    if (previous === undefined) delete process.env.R2_PUBLIC_URL;
    else process.env.R2_PUBLIC_URL = previous;
  }
});
