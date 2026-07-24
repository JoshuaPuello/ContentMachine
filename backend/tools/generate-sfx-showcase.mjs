import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { AceStepSfxClient, materializeCueOptions } from '../lib/aceStepSfx.js';
import { DIRECTOR_SFX_CUES } from '../lib/directorSfxCatalog.js';
import { ChainedSfxClient, ElevenLabsSfxClient } from '../lib/elevenLabsSfx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '..', '.env') });
const outputRoot = path.resolve(__dirname, '..', '..', 'output');
const sessionId = process.argv[2] || 'director_sfx_showcase';
const filter = process.argv[3] || '';
const filters = filter.split(',').map((value) => value.trim()).filter(Boolean);
const maxAttempts = process.env.DIRECTOR_SFX_MAX_ATTEMPTS === undefined
  ? (process.env.ACESTEP_MAX_ATTEMPTS === undefined
  ? 6
  : Math.max(0, Number(process.env.ACESTEP_MAX_ATTEMPTS) || 0))
  : Math.max(0, Number(process.env.DIRECTOR_SFX_MAX_ATTEMPTS) || 0);
const optionCount = Math.max(1, Math.min(5,
  Number(process.env.DIRECTOR_SFX_OPTION_COUNT ?? process.env.ACESTEP_OPTION_COUNT) || 1
));
const force = /^(1|true|yes)$/i.test(
  process.env.DIRECTOR_SFX_FORCE ?? process.env.ACESTEP_FORCE ?? ''
);
const concurrency = Math.max(1, Math.min(6, Number(process.env.DIRECTOR_SFX_CONCURRENCY) || 3));
const cues = DIRECTOR_SFX_CUES.filter((cue) =>
  !filters.length || filters.some((value) =>
    cue.id.includes(value) || cue.preset_id.includes(value)
  )
);

const elevenLabs = new ElevenLabsSfxClient();
const aceStep = new AceStepSfxClient();
const provider = process.env.DIRECTOR_SFX_PROVIDER || 'elevenlabs';
const clients = provider === 'ace-step'
  ? [aceStep]
  : provider === 'auto'
    ? [elevenLabs, aceStep]
    : [elevenLabs];
const client = new ChainedSfxClient(clients);
if (!client.configured) throw new Error('Set ELEVENLABS_API_KEY or ACESTEP_API_KEY before running this tool');

const results = new Array(cues.length);
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(concurrency, cues.length) }, async () => {
  while (cursor < cues.length) {
    const index = cursor++;
    const cue = cues[index];
    const result = await materializeCueOptions({
      cue,
      sessionId,
      outputRoot,
      optionCount,
      maxAttempts,
      client,
      force,
      onProgress: (message) => process.stdout.write(`[${index + 1}/${cues.length}] ${message}\n`),
    });
    results[index] = {
      id: cue.id,
      preset_id: cue.preset_id,
      status: result.status,
      options: result.options?.map((option) => ({
        url: option.url,
        provider: option.provider,
        duration_seconds: option.duration_seconds,
        anchor_seconds: option.anchor_seconds,
        analysis: option.analysis,
      })),
      error: result.error,
    };
  }
}));

process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
