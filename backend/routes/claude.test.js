import assert from 'node:assert/strict';
import test from 'node:test';
import { parseClaudeStreamEvent } from './claude.js';

test('normalizes partial Claude stream text without duplicating final output', () => {
  assert.deepEqual(parseClaudeStreamEvent({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: '{"camera"' },
    },
  }), { delta: '{"camera"', result: '' });

  assert.deepEqual(parseClaudeStreamEvent({
    type: 'result',
    subtype: 'success',
    result: '{"camera":[]}',
  }), { delta: '', result: '{"camera":[]}' });
});

test('ignores non-text Claude transport events', () => {
  assert.deepEqual(parseClaudeStreamEvent({ type: 'system', subtype: 'init' }), {
    delta: '',
    result: '',
  });
});
