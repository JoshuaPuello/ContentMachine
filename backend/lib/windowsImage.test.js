import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  buildNeutralImageReference,
  buildOrderedReferenceBoard,
  queueWindowsImageTask,
} from './windowsImage.js';

const solidReference = async (color, name) => ({
  referenceId: name.toLowerCase(),
  name,
  contentType: 'image/png',
  bytes: await sharp({
    create: {
      width: 320,
      height: 480,
      channels: 3,
      background: color,
    },
  }).png().toBuffer(),
});

test('neutral Windows image references preserve the requested canvas ratio', async () => {
  const portrait = await buildNeutralImageReference('9:16');
  const metadata = await sharp(portrait.bytes).metadata();
  assert.equal(portrait.referenceId, 'composition-frame');
  assert.equal(metadata.width, 1600);
  assert.ok(Math.abs((metadata.width / metadata.height) - (9 / 16)) < 0.002);
});

test('ordered references are packed left-to-right into one worker attachment', async () => {
  const first = await solidReference('#ff0000', 'First');
  const second = await solidReference('#0000ff', 'Second');
  const board = await buildOrderedReferenceBoard([first, second]);
  const metadata = await sharp(board.bytes).metadata();
  assert.deepEqual(board.names, ['First', 'Second']);
  assert.equal(metadata.width, 1024);
  assert.equal(metadata.height, 768);
  const { data, info } = await sharp(board.bytes)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixel = (x, y) => {
    const offset = (y * info.width + x) * info.channels;
    return [...data.subarray(offset, offset + 3)];
  };
  assert.ok(pixel(256, 200)[0] > pixel(256, 200)[2], 'first reference remains on the left');
  assert.ok(pixel(768, 200)[2] > pixel(768, 200)[0], 'second reference remains on the right');
});

test('queue validation rejects unsupported worker output counts before I/O', async () => {
  await assert.rejects(
    queueWindowsImageTask({
      sessionId: 'session_test',
      itemId: 'shot-1',
      prompt: 'Documentary frame',
      references: [await buildNeutralImageReference('16:9')],
      outputCount: 4,
    }),
    /must be 1, 2, or 3/,
  );
});

test('queue validation rejects prompts beyond the v1 limit before I/O', async () => {
  await assert.rejects(
    queueWindowsImageTask({
      sessionId: 'session_test',
      itemId: 'shot-1',
      prompt: 'x'.repeat(50_001),
      references: [await buildNeutralImageReference('16:9')],
      outputCount: 1,
    }),
    /cannot exceed 50,000 characters/,
  );
});

test('queue validation rejects item identifiers that could collide after sanitizing', async () => {
  await assert.rejects(
    queueWindowsImageTask({
      sessionId: 'session_test',
      itemId: 'shot/../one',
      prompt: 'Documentary frame',
      references: [await buildNeutralImageReference('16:9')],
      outputCount: 1,
    }),
    /stable safe identifier/,
  );
});
