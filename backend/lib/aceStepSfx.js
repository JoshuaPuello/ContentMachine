import crypto from 'crypto';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import {
  analyzeAudioEvent,
  analyzeSpectralTimbre,
  extractNormalizedEvent,
  isSyntheticTimbre,
} from './audioEventAnalysis.js';

const DEFAULT_BASE_URL = 'https://api.acemusic.ai';
const DEFAULT_MODEL = 'acemusic/acestep-v1.5-turbo';
const SFX_PIPELINE_VERSION = 6;
const TRANSIENT_ROLES = new Set(['transition', 'accent', 'impact', 'tick', 'reveal', 'resolve']);
const PROCEDURAL_ROLES = new Set([...TRANSIENT_ROLES, 'count']);
const MAX_ROLE_EVENT_SECONDS = {
  transition: 2.4,
  accent: 1.6,
  impact: 3.2,
  tick: 0.7,
  reveal: 2.4,
  resolve: 2.8,
};

const ROLE_DIRECTION = {
  transition: 'one refined airy cinematic whoosh, fast clean attack, short smooth tail',
  accent: 'one delicate editorial accent, clean attack, warm restrained decay',
  impact: 'one low restrained cinematic impact, soft sub body, no boom, short decay',
  tick: 'one precise muted mechanical tick, dry, elegant, no sequence',
  reveal: 'one soft glass-and-air reveal shimmer, clean transient, very short tail',
  texture: 'minimal quiet tonal texture, sparse, no melody, no rhythm, no pulse',
  resolve: 'one warm restrained resolution tone, gentle attack, elegant short decay',
  count: 'a restrained sequence of soft felted mechanical count ticks, unpitched, dry, smooth, and evenly paced',
};

const safeSegment = (value, fallback = 'sound') => {
  const cleaned = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return cleaned || fallback;
};

function runProcess(command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-6000); });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited ${code}: ${stderr.slice(-1000)}`)));
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
}

async function generateProceduralFallback(cue, outputPath, variant = 1, { signal } = {}) {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
  const pitch = variant === 1 ? 1 : 1.12;
  const role = cue.role || 'accent';
  let inputs;
  let filter;
  let duration;

  if (role === 'count') {
    duration = Math.max(0.6, Math.min(8, Number(cue.target_duration_seconds) || 3));
    const interval = [0.19, 0.15, 0.12][(variant - 1) % 3];
    const decay = [54, 68, 82][(variant - 1) % 3];
    const highpass = [480, 620, 760][(variant - 1) % 3];
    const lowpass = [2900, 3600, 4300][(variant - 1) % 3];
    inputs = ['-f', 'lavfi', '-i',
      `aevalsrc=((random(0)*2-1)*0.12*exp(-mod(t\\,${interval})*${decay})*lt(mod(t\\,${interval})\\,0.055)):s=48000:d=${duration}`];
    filter = `highpass=f=${highpass},lowpass=f=${lowpass},acompressor=threshold=0.025:ratio=3:attack=2:release=45,afade=t=in:st=0:d=0.08,afade=t=out:st=${Math.max(0, duration - 0.12).toFixed(3)}:d=0.12`;
  } else if (role === 'tick') {
    duration = 0.5;
    inputs = ['-f', 'lavfi', '-i',
      `aevalsrc=(0.34*sin(2*PI*${Math.round(1180 * pitch)}*t)*exp(-34*t))+(0.12*sin(2*PI*${Math.round(690 * pitch)}*t)*exp(-19*t)):s=48000:d=${duration}`];
    filter = 'highpass=f=180,lowpass=f=7200,afade=t=out:st=0.26:d=0.22';
  } else if (role === 'impact') {
    duration = 1.35;
    inputs = [
      '-f', 'lavfi', '-i', `sine=frequency=${Math.round(62 * pitch)}:sample_rate=48000:duration=${duration}`,
      '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.08:sample_rate=48000:duration=${duration}`,
    ];
    filter = '[0:a]volume=0.42,afade=t=out:st=0.1:d=1.2[body];[1:a]lowpass=f=900,afade=t=out:st=0:d=0.42[air];[body][air]amix=inputs=2:normalize=0';
  } else if (role === 'transition') {
    duration = 1.1;
    inputs = ['-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.22:sample_rate=48000:duration=${duration}`];
    filter = `highpass=f=${Math.round(420 * pitch)},lowpass=f=${Math.round(6800 * pitch)},volume=0.7*exp(-pow((t-0.48)/0.24\\,2)):eval=frame,afade=t=in:st=0:d=0.13,afade=t=out:st=0.72:d=0.34`;
  } else {
    duration = role === 'resolve' ? 1.35 : 1.05;
    const variantIndex = (variant - 1) % 3;
    const bodyColor = role === 'resolve' ? 'brown' : 'pink';
    const bodyLowpass = role === 'resolve'
      ? [720, 940, 1180][variantIndex]
      : [2500, 3300, 4200][variantIndex];
    const airHighpass = role === 'resolve'
      ? [1300, 1600, 1900][variantIndex]
      : [1700, 2200, 2800][variantIndex];
    inputs = [
      '-f', 'lavfi', '-i', `anoisesrc=color=${bodyColor}:amplitude=0.16:sample_rate=48000:duration=${duration}`,
      '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.055:sample_rate=48000:duration=${duration}`,
    ];
    filter = `[0:a]lowpass=f=${bodyLowpass},highpass=f=80,volume=0.44,afade=t=in:st=0:d=0.018,afade=t=out:st=0.08:d=${(duration - 0.1).toFixed(2)}[body];[1:a]highpass=f=${airHighpass},lowpass=f=7200,volume=0.28,afade=t=in:st=0:d=0.012,afade=t=out:st=0.03:d=${Math.min(0.62, duration - 0.04).toFixed(2)}[air];[body][air]amix=inputs=2:normalize=0`;
  }

  await runProcess(ffmpeg, [
    '-y', '-v', 'error',
    ...inputs,
    '-filter_complex', filter,
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    outputPath,
  ], { signal });
  return duration;
}

function cloudPrompt(cue) {
  const role = ROLE_DIRECTION[cue.role] || ROLE_DIRECTION.accent;
  return [
    'Professional documentary motion-graphics sound design.',
    role + '.',
    cue.description ? `Editorial action: ${cue.description}.` : '',
    'Generate exactly ONE isolated sound event.',
    'Place the event after approximately one second of clean silence.',
    'No music. No melody. No harmony. No beat. No rhythm. No drums. No vocals.',
    'No electronic beep, no chiptune, no 8-bit or arcade-game timbre, no pitched arpeggio.',
    'No bell, no notification chime, no sci-fi user-interface tone.',
    'No repeated events. No ambience bed. No cinematic trailer music.',
    'Neutral studio background, clean high-resolution sound, subtle enough to sit under narration.',
    'The remainder of the ten-second file should be silent after the decay.',
  ].filter(Boolean).join(' ');
}

function extractAudioData(result) {
  const message = result?.choices?.[0]?.message;
  const parts = Array.isArray(message?.audio) ? message.audio : [];
  const url = parts
    .map((part) => part?.audio_url?.url || part?.url)
    .find((candidate) => typeof candidate === 'string');
  if (!url?.startsWith('data:audio/')) {
    throw new Error('ACE-Step response did not contain generated audio');
  }
  const match = url.match(/^data:audio\/([^;,]+);base64,(.+)$/s);
  if (!match) throw new Error('ACE-Step returned an unsupported audio data URL');
  const subtype = match[1].toLowerCase();
  const extension = subtype.includes('wav') ? 'wav' : subtype.includes('mpeg') || subtype.includes('mp3') ? 'mp3' : 'bin';
  return {
    bytes: Buffer.from(match[2], 'base64'),
    extension,
    metadata: typeof message.content === 'string' ? message.content : '',
  };
}

export class AceStepSfxClient {
  constructor({
    apiKey = process.env.ACESTEP_API_KEY,
    baseUrl = process.env.ACESTEP_API_BASE_URL || DEFAULT_BASE_URL,
    model = process.env.ACESTEP_MODEL || DEFAULT_MODEL,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.model = model;
    this.fetch = fetchImpl;
    this.providerName = 'ace-step';
    this.supportsCount = false;
    this.supportsPreciseDuration = false;
  }

  get configured() {
    return Boolean(this.apiKey);
  }

  async generateRaw(cue, {
    durationSeconds = 10,
    seed,
    signal,
  } = {}) {
    if (!this.apiKey) throw new Error('ACESTEP_API_KEY is not configured');
    const body = {
      model: this.model,
      messages: [{ role: 'user', content: cloudPrompt(cue) }],
      modalities: ['audio'],
      stream: false,
      task_type: 'text2music',
      thinking: false,
      use_cot_caption: false,
      use_cot_language: false,
      use_cot_metas: false,
      inference_steps: Number(process.env.ACESTEP_INFERENCE_STEPS) || 12,
      guidance_scale: Number(process.env.ACESTEP_GUIDANCE_SCALE) || 7,
      lyrics: '[Instrumental]',
      audio_config: {
        format: 'wav',
        duration: Math.max(10, Math.min(20, Number(durationSeconds) || 10)),
        instrumental: true,
        vocal_language: 'en',
      },
      ...(Number.isFinite(seed) ? { seed: String(seed) } : {}),
    };

    const response = await this.fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'ContentMachine-Director-SFX/1.0',
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 800);
      throw new Error(`ACE-Step ${response.status}: ${detail || response.statusText}`);
    }
    return {
      ...extractAudioData(await response.json()),
      prompt: body.messages[0].content,
    };
  }
}

export async function materializeCueOptions({
  cue,
  sessionId,
  outputRoot,
  optionCount = 2,
  maxAttempts = 4,
  client = new AceStepSfxClient(),
  onProgress = () => {},
  signal,
  force = false,
}) {
  if (!client.configured) {
    return {
      ...cue,
      asset: null,
      options: [],
      status: 'unconfigured',
      error: 'ACESTEP_API_KEY is not configured',
    };
  }

  const cueId = safeSegment(cue.id);
  const cueDir = path.join(outputRoot, safeSegment(sessionId, 'session'), 'sfx', cueId);
  await fs.mkdir(cueDir, { recursive: true });
  const manifestPath = path.join(cueDir, 'manifest.json');
  const requestFingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      pipelineVersion: SFX_PIPELINE_VERSION,
      role: cue.role,
      description: cue.description,
      gain_db: cue.gain_db,
      target_duration_seconds: cue.target_duration_seconds,
      provider_prompt: cue.provider_prompt,
      prompt: cloudPrompt(cue),
    }))
    .digest('hex')
    .slice(0, 16);
  if (!force) {
    try {
      const cached = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const cachedOptions = (cached.options || []).filter((option) => option?.url);
      if (cached.requestFingerprint === requestFingerprint && cachedOptions.length >= optionCount) {
        const selected = cachedOptions.find((option) => option.id === cached.selectedOptionId) || cachedOptions[0];
        onProgress(`sound ${cueId}: using ${cachedOptions.length} analyzed cached options`);
        return {
          ...cue,
          asset: selected.url,
          selected_option_id: selected.id,
          options: cachedOptions,
          analysis: selected.analysis,
          anchor_seconds: selected.anchor_seconds,
          duration_seconds: selected.duration_seconds,
          status: 'ready',
          error: null,
        };
      }
    } catch {
      // Missing or invalid cache: generate fresh analyzed options.
    }
  }
  const accepted = [];
  const attempts = [];

  const cloudAttempts = cue.role === 'count' && !client.supportsCount ? 0 : maxAttempts;
  for (let attempt = 1; attempt <= cloudAttempts && accepted.length < optionCount; attempt++) {
    onProgress(`sound ${cueId}: ${client.providerName || 'provider'} generating option ${accepted.length + 1}/${optionCount} (attempt ${attempt}/${maxAttempts})`);
    const requestedDurationSeconds = cue.role === 'count'
      ? Number(cue.target_duration_seconds) || 3
      : Number(cue.generation_duration_seconds)
        || (client.supportsPreciseDuration ? 2 : 10);
    let raw;
    try {
      raw = await client.generateRaw(cue, {
        durationSeconds: requestedDurationSeconds,
        seed: crypto.randomInt(1, 2_000_000_000),
        signal,
      });
    } catch (error) {
      const attemptRecord = {
        attempt,
        accepted: false,
        provider: client.providerName || 'audio-provider',
        rejection: error.message,
      };
      attempts.push(attemptRecord);
      onProgress(`sound ${cueId}: provider attempt ${attempt} failed — ${error.message}`);
      continue;
    }
    const rawPath = path.join(cueDir, `attempt-${attempt}-raw.${raw.extension}`);
    await fs.writeFile(rawPath, raw.bytes);
    const analysis = await analyzeAudioEvent(rawPath, { signal });
    const timbre = await analyzeSpectralTimbre(rawPath, { signal });
    analysis.spectralTimbre = timbre;
    const syntheticTonality = isSyntheticTimbre(timbre);
    if (syntheticTonality) {
      analysis.accepted = false;
      analysis.rejectionReasons = [
        ...(analysis.rejectionReasons || []),
        `spectral crest ${timbre.meanCrest.toFixed(1)} with flatness ${timbre.meanFlatness.toFixed(3)} indicates a pitched beep, chime, or game-like timbre`,
      ];
    }
    if (raw.preserveFullDuration && analysis.selected) {
      const ignoredForPreciseSfx = new Set([
        'audio is continuously active and behaves like music or ambience',
        ...(cue.role === 'count' ? ['too many separate events were generated'] : []),
      ]);
      analysis.rejectionReasons = (analysis.rejectionReasons || [])
        .filter((reason) => !ignoredForPreciseSfx.has(reason));
      analysis.accepted = analysis.rejectionReasons.length === 0
        && (analysis.confidence ?? 0) >= 0.46;
    }
    const roleMaxSeconds = MAX_ROLE_EVENT_SECONDS[cue.role];
    if (
      analysis.selected
      && roleMaxSeconds
      && analysis.selected.durationSeconds > roleMaxSeconds
    ) {
      analysis.accepted = false;
      analysis.rejectionReasons = [
        ...(analysis.rejectionReasons || []),
        `${cue.role} event is ${analysis.selected.durationSeconds.toFixed(2)}s; maximum is ${roleMaxSeconds.toFixed(2)}s`,
      ];
    }
    const attemptRecord = {
      attempt,
      prompt: raw.prompt,
      providerMetadata: raw.metadata,
      analysis,
      accepted: false,
    };

    if (!analysis.accepted && TRANSIENT_ROLES.has(cue.role)) {
      attemptRecord.rejection = analysis.rejectionReasons.join('; ') || 'waveform did not contain one clean transient';
      attempts.push(attemptRecord);
      onProgress(`sound ${cueId}: rejected attempt ${attempt} — ${attemptRecord.rejection}`);
      continue;
    }

    const selectedAnalysis = raw.preserveFullDuration && analysis.selected
      ? {
        ...analysis,
        selected: {
          ...analysis.selected,
          offsetSeconds: Math.min(
            analysis.durationSeconds,
            raw.requestedDurationSeconds || analysis.durationSeconds
          ),
          durationSeconds: Math.min(
            analysis.durationSeconds,
            raw.requestedDurationSeconds || analysis.durationSeconds
          ),
        },
        trimStartSeconds: 0,
        trimEndSeconds: Math.min(
          analysis.durationSeconds,
          raw.requestedDurationSeconds || analysis.durationSeconds
        ),
        anchorSeconds: cue.role === 'count' ? 0 : analysis.selected.onsetSeconds,
      }
      : analysis.selected ? analysis : {
      ...analysis,
      selected: {
        onsetSeconds: 0,
        offsetSeconds: Math.min(4.5, analysis.durationSeconds || 4.5),
        peakSeconds: 0,
        peakDbfs: 0,
        durationSeconds: Math.min(4.5, analysis.durationSeconds || 4.5),
      },
      trimStartSeconds: 0,
      trimEndSeconds: Math.min(4.5, analysis.durationSeconds || 4.5),
      anchorSeconds: 0,
      };
    const optionIndex = accepted.length + 1;
    const outputName = `option-${optionIndex}.mp3`;
    const outputPath = path.join(cueDir, outputName);
    const extracted = await extractNormalizedEvent(rawPath, outputPath, selectedAnalysis, { signal });
    const option = {
      id: `${cueId}-option-${optionIndex}`,
      url: `/api/session/${sessionId}/files/sfx/${cueId}/${outputName}`,
      duration_seconds: extracted.durationSeconds,
      anchor_seconds: extracted.anchorSeconds,
      gain_db: Number.isFinite(Number(cue.gain_db)) ? Number(cue.gain_db) : -12,
      provider: raw.provider || client.providerName || 'audio-provider',
      analysis: {
        confidence: analysis.confidence,
        original_duration_seconds: analysis.durationSeconds,
        detected_onset_seconds: analysis.selected?.onsetSeconds ?? 0,
        detected_offset_seconds: analysis.selected?.offsetSeconds ?? extracted.durationSeconds,
        peak_dbfs: analysis.selected?.peakDbfs ?? 0,
        active_coverage: analysis.activeCoverage,
      },
    };
    accepted.push(option);
    attemptRecord.accepted = true;
    attemptRecord.option = option;
    attempts.push(attemptRecord);
    onProgress(`sound ${cueId}: ${option.provider} option ${optionIndex} accepted · onset ${option.analysis.detected_onset_seconds.toFixed(2)}s · confidence ${(option.analysis.confidence * 100).toFixed(0)}%`);
  }

  // ACE-Step is a music foundation model and sometimes refuses to yield one
  // isolated transient even with a strict prompt. Silence is not an acceptable
  // final-film fallback. Fill any missing options with deterministic,
  // narration-safe editorial synthesis and still run the same waveform audit.
  while (accepted.length < optionCount && PROCEDURAL_ROLES.has(cue.role)) {
    const optionIndex = accepted.length + 1;
    const rawFallbackPath = path.join(cueDir, `fallback-${optionIndex}-raw.mp3`);
    const outputName = `option-${optionIndex}.mp3`;
    const outputPath = path.join(cueDir, outputName);
    await generateProceduralFallback(cue, rawFallbackPath, optionIndex, { signal });
    const analysis = await analyzeAudioEvent(rawFallbackPath, { signal });
    const extractionAnalysis = cue.role === 'count'
      ? {
        ...analysis,
        selected: {
          onsetSeconds: 0,
          offsetSeconds: Math.max(0.6, Math.min(8, Number(cue.target_duration_seconds) || 3)),
          peakSeconds: analysis.selected?.peakSeconds || 0,
          peakDbfs: analysis.selected?.peakDbfs ?? -12,
          durationSeconds: Math.max(0.6, Math.min(8, Number(cue.target_duration_seconds) || 3)),
        },
        trimStartSeconds: 0,
        trimEndSeconds: Math.max(0.6, Math.min(8, Number(cue.target_duration_seconds) || 3)),
        anchorSeconds: 0,
      }
      : analysis;
    const extracted = await extractNormalizedEvent(rawFallbackPath, outputPath, extractionAnalysis, { signal });
    const option = {
      id: `${cueId}-option-${optionIndex}`,
      url: `/api/session/${sessionId}/files/sfx/${cueId}/${outputName}`,
      duration_seconds: extracted.durationSeconds,
      anchor_seconds: extracted.anchorSeconds,
      gain_db: Number.isFinite(Number(cue.gain_db)) ? Number(cue.gain_db) : -12,
      provider: 'procedural-fallback',
      analysis: {
        confidence: analysis.confidence ?? 1,
        original_duration_seconds: analysis.durationSeconds,
        detected_onset_seconds: analysis.selected?.onsetSeconds ?? 0,
        detected_offset_seconds: analysis.selected?.offsetSeconds ?? analysis.durationSeconds,
        peak_dbfs: analysis.selected?.peakDbfs ?? 0,
        active_coverage: analysis.activeCoverage,
      },
    };
    accepted.push(option);
    attempts.push({
      attempt: `fallback-${optionIndex}`,
      accepted: true,
      provider: 'procedural-fallback',
      analysis,
      option,
    });
    onProgress(`sound ${cueId}: provider attempts exhausted; clean synthesized option ${optionIndex} accepted`);
  }

  const selected = accepted[0] || null;
  const manifest = {
    requestFingerprint,
    cue: {
      id: cue.id,
      role: cue.role,
      description: cue.description,
      at_seconds: cue.at_seconds,
      gain_db: cue.gain_db,
      target_duration_seconds: cue.target_duration_seconds,
    },
    options: accepted,
    selectedOptionId: selected?.id || null,
    attempts,
    generatedAt: new Date().toISOString(),
  };
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return {
    ...cue,
    asset: selected?.url || null,
    selected_option_id: selected?.id || null,
    options: accepted,
    analysis: selected?.analysis || null,
    anchor_seconds: selected?.anchor_seconds || 0,
    duration_seconds: selected?.duration_seconds || null,
    status: selected ? 'ready' : 'failed',
    error: selected ? null : attempts.at(-1)?.rejection || 'No usable sound event was generated',
  };
}
