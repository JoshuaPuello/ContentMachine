import test from 'node:test';
import assert from 'node:assert/strict';
import { withImageGenerationTimeout } from './images.js';

test('image generation timeout aborts a stalled provider request', async () => {
  let aborted = false;
  await assert.rejects(
    withImageGenerationTimeout((signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted = true;
        reject(new Error('provider aborted'));
      }, { once: true });
    }), 20),
    /timed out/i
  );
  assert.equal(aborted, true);
});

test('image generation timeout preserves a successful provider result', async () => {
  const result = await withImageGenerationTimeout(async () => 'ready', 100);
  assert.equal(result, 'ready');
});
