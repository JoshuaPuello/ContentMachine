import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_MODEL = 'eleven_text_to_sound_v2';

const ROLE_DIRECTION = {
  transition: 'one smooth movement of air through soft cloth, clean attack and short diffuse tail',
  accent: 'one delicate felt-and-paper contact with a restrained dry decay',
  impact: 'one folded heavy-cloth contact against wood, soft and controlled, without a trailer boom',
  tick: 'one tiny muted felted mechanical click, dry, brief, and entirely unpitched',
  reveal: 'one soft cloth, paper, and air reveal movement with a clean organic transient',
  texture: 'a minimal quiet texture made only from air, cloth, paper, and soft physical friction',
  resolve: 'one soft felt-pad contact followed by a short airy release, with no tonal resonance',
  count: 'a continuous sequence of soft felted mechanical counting clicks, even and tactile',
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

async function streamToBuffer(stream) {
  if (!stream) throw new Error('ElevenLabs returned an empty audio stream');
  const chunks = [];
  if (typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value?.byteLength) chunks.push(Buffer.from(value));
    }
  } else {
    for await (const chunk of stream) {
      if (chunk?.byteLength) chunks.push(Buffer.from(chunk));
    }
  }
  if (!chunks.length) throw new Error('ElevenLabs returned no audio bytes');
  return Buffer.concat(chunks);
}

export function elevenLabsPrompt(cue) {
  if (cue.provider_prompt) {
    return String(cue.provider_prompt).replace(/\s+/g, ' ').trim().slice(0, 450);
  }
  const direction = ROLE_DIRECTION[cue.role] || ROLE_DIRECTION.accent;
  const action = String(cue.description || 'an elegant documentary graphic settles into place')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  return [
    `Premium documentary SFX: ${direction}.`,
    cue.role === 'count'
      ? 'Continue for the requested duration, then stop cleanly.'
      : 'Exactly one isolated event.',
    'Organic studio foley only: air, cloth, felt, paper, wood, or muted mechanisms.',
    'No music, melody, rhythm, ringing, pitch, beep, chime, notification, sci-fi UI, chiptune, 8-bit, arcade, or game sound.',
    `Visual action: ${action}.`,
    'Elegant and subtle beneath narration.',
  ].join(' ').slice(0, 450);
}

export class ElevenLabsSfxClient {
  constructor({
    apiKey = process.env.ELEVENLABS_API_KEY,
    baseUrl = process.env.ELEVENLABS_API_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.ELEVENLABS_SFX_MODEL || DEFAULT_MODEL,
    outputFormat = process.env.ELEVENLABS_SFX_OUTPUT_FORMAT || 'mp3_44100_128',
    promptInfluence = Number(process.env.ELEVENLABS_SFX_PROMPT_INFLUENCE) || 0.85,
    fetchImpl = globalThis.fetch,
    sdkClient,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.outputFormat = outputFormat;
    this.promptInfluence = clamp(promptInfluence, 0, 1);
    this.client = sdkClient || new ElevenLabsClient({
      apiKey,
      baseUrl: this.baseUrl,
      fetch: fetchImpl,
      headers: { 'User-Agent': 'ContentMachine-Director-SFX/1.0' },
      maxRetries: 2,
      timeoutInSeconds: 120,
    });
    this.providerName = 'elevenlabs';
    this.supportsCount = true;
    this.supportsPreciseDuration = true;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async generateRaw(cue, { durationSeconds = 2, signal } = {}) {
    if (!this.apiKey) throw new Error('ELEVENLABS_API_KEY is not configured');
    const prompt = elevenLabsPrompt(cue);
    const requestedDuration = clamp(Number(durationSeconds) || 2, 0.5, 30);
    const request = {
      text: prompt,
      durationSeconds: requestedDuration,
      promptInfluence: this.promptInfluence,
      loop: false,
      modelId: this.model,
      outputFormat: this.outputFormat,
    };
    const response = await this.client.textToSoundEffects
      .convert(request, { abortSignal: signal })
      .withRawResponse();
    return {
      bytes: await streamToBuffer(response.data),
      extension: 'mp3',
      metadata: {
        characterCost: response.rawResponse?.headers?.get('character-cost'),
        requestId: response.rawResponse?.headers?.get('request-id'),
      },
      prompt,
      provider: this.providerName,
      preserveFullDuration: true,
      requestedDurationSeconds: requestedDuration,
    };
  }
}

export class ChainedSfxClient {
  constructor(clients) {
    this.clients = (clients || []).filter((client) => client?.configured);
    this.providerName = this.clients.map((client) => client.providerName).join('→') || 'unconfigured';
    this.supportsCount = this.clients.some((client) => client.supportsCount);
    this.supportsPreciseDuration = this.clients.some((client) => client.supportsPreciseDuration);
  }

  get configured() {
    return this.clients.length > 0;
  }

  async generateRaw(cue, options) {
    const failures = [];
    for (const client of this.clients) {
      try {
        return await client.generateRaw(cue, options);
      } catch (error) {
        failures.push(`${client.providerName}: ${error.message}`);
      }
    }
    throw new Error(failures.join(' | ') || 'No sound-effects provider is configured');
  }
}
