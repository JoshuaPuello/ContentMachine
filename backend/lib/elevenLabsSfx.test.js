import assert from 'node:assert/strict';
import test from 'node:test';
import { ElevenLabsSfxClient, elevenLabsPrompt } from './elevenLabsSfx.js';

test('ElevenLabs SFX request uses explicit duration and v2 sound model', async () => {
  let request;
  const client = new ElevenLabsSfxClient({
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(Buffer.from('fake-mp3'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    },
  });
  const cue = {
    role: 'reveal',
    description: 'a portrait card glides into focus',
  };
  const generated = await client.generateRaw(cue, { durationSeconds: 2 });
  const body = JSON.parse(request.init.body);
  const headers = new Headers(request.init.headers);

  assert.match(request.url, /\/v1\/sound-generation\?output_format=mp3_44100_128$/);
  assert.equal(headers.get('xi-api-key'), 'test-key');
  assert.equal(body.model_id, 'eleven_text_to_sound_v2');
  assert.equal(body.duration_seconds, 2);
  assert.equal(body.prompt_influence, 0.85);
  assert.equal(body.loop, false);
  assert.equal(generated.provider, 'elevenlabs');
  assert.equal(generated.preserveFullDuration, true);
});

test('ElevenLabs prompt explicitly excludes game-like tonal sound', () => {
  const prompt = elevenLabsPrompt({
    role: 'resolve',
    description: 'the final statistic settles',
  });
  assert.ok(prompt.length <= 450);
  assert.match(prompt, /no music/i);
  assert.match(prompt, /chiptune/i);
  assert.match(prompt, /8-bit/i);
  assert.match(prompt, /organic studio foley/i);
});
