import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzePcmEvent, isSyntheticTimbre } from './audioEventAnalysis.js';

test('detects and anchors a delayed transient instead of assuming t=0', () => {
  const sampleRate = 24_000;
  const samples = new Float32Array(sampleRate * 10);
  const onset = 6.2;
  for (let i = 0; i < sampleRate * 0.42; i++) {
    const envelope = Math.exp(-i / (sampleRate * 0.11));
    samples[Math.round(onset * sampleRate) + i] =
      Math.sin(i * 2 * Math.PI * 720 / sampleRate) * envelope * 0.7;
  }

  const analysis = analyzePcmEvent(samples, sampleRate);
  assert.equal(analysis.accepted, true);
  assert.ok(Math.abs(analysis.selected.onsetSeconds - onset) < 0.08);
  assert.ok(analysis.anchorSeconds > 0.02 && analysis.anchorSeconds < 0.08);
  assert.ok(analysis.trimStartSeconds > 6);
});

test('rejects continuously active music-like audio', () => {
  const sampleRate = 24_000;
  const samples = new Float32Array(sampleRate * 10);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = Math.sin(i * 2 * Math.PI * 220 / sampleRate) * 0.3;
  }

  const analysis = analyzePcmEvent(samples, sampleRate);
  assert.equal(analysis.accepted, false);
  assert.match(analysis.rejectionReasons.join(' '), /continuously active|too long/);
});

test('rejects a file with many repeated events', () => {
  const sampleRate = 24_000;
  const samples = new Float32Array(sampleRate * 10);
  for (let event = 0; event < 10; event++) {
    const start = Math.round((0.3 + event * 0.9) * sampleRate);
    for (let i = 0; i < sampleRate * 0.08; i++) {
      samples[start + i] = Math.sin(i * 2 * Math.PI * 1000 / sampleRate) * 0.55;
    }
  }

  const analysis = analyzePcmEvent(samples, sampleRate);
  assert.equal(analysis.accepted, false);
  assert.match(analysis.rejectionReasons.join(' '), /too many separate events/);
});

test('distinguishes resonant physical foley from a narrow synthetic tone', () => {
  assert.equal(isSyntheticTimbre({ meanCrest: 94, meanFlatness: 0.31 }), false);
  assert.equal(isSyntheticTimbre({ meanCrest: 94, meanFlatness: 0.08 }), true);
  assert.equal(isSyntheticTimbre({ meanCrest: 18, meanFlatness: 0.05 }), false);
});
