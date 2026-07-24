import test from 'node:test';
import assert from 'node:assert/strict';
import { splitVoiceoverAtSentenceBoundaries } from './claude.js';

test('supplied voiceover is preserved exactly while partitioning scenes', () => {
  const source = 'First sentence stays exact. Second sentence also stays exact! The final question remains unchanged?';
  const chunks = splitVoiceoverAtSentenceBoundaries(source, 3);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(' '), source);
});

test('more visual scenes than sentences never invent narration', () => {
  const source = 'One complete sentence. Another complete sentence.';
  const chunks = splitVoiceoverAtSentenceBoundaries(source, 5);
  assert.equal(chunks.length, 5);
  assert.equal(chunks.filter(Boolean).length, 5);
  assert.equal(chunks.filter(Boolean).join(' '), source);
});

test('fewer requested scenes merge complete sentences without rewriting', () => {
  const source = 'One. Two. Three. Four.';
  const chunks = splitVoiceoverAtSentenceBoundaries(source, 2);
  assert.equal(chunks.length, 2);
  assert.equal(chunks.join(' '), source);
});
