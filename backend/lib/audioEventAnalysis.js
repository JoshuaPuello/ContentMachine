import { spawn } from 'child_process';

const DB_FLOOR = -120;

const db = (value) => value > 0 ? 20 * Math.log10(value) : DB_FLOOR;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.round((sorted.length - 1) * clamp(p, 0, 1))];
};

function run(command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(-1200)}`));
    });
    signal?.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
  });
}

export async function decodeMonoPcm(inputPath, {
  sampleRate = 24_000,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  signal,
} = {}) {
  const raw = await run(ffmpegPath, [
    '-v', 'error',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', String(sampleRate),
    '-f', 'f32le',
    'pipe:1',
  ], { signal });
  return {
    samples: new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4)),
    sampleRate,
  };
}

function mergeRegions(regions, maxGapFrames) {
  const merged = [];
  for (const region of regions) {
    const previous = merged.at(-1);
    if (previous && region.startFrame - previous.endFrame <= maxGapFrames) {
      previous.endFrame = region.endFrame;
      previous.peak = Math.max(previous.peak, region.peak);
      previous.peakFrame = previous.peak >= region.peak ? previous.peakFrame : region.peakFrame;
    } else {
      merged.push({ ...region });
    }
  }
  return merged;
}

/**
 * Locate the actual audible event inside a generated audio file.
 *
 * ACE-Step produces a minimum ten-second file and may place the requested
 * transient anywhere inside it. The returned anchorSeconds is measured from
 * the beginning of the trimmed asset, so the renderer can place that real
 * onset on the visual beat instead of assuming the sound begins at t=0.
 */
export function analyzePcmEvent(samples, sampleRate, {
  windowMs = 20,
  hopMs = 10,
  mergeGapMs = 120,
  preRollMs = 45,
  postRollMs = 180,
  minEventMs = 35,
  maxEventSeconds = 4.5,
} = {}) {
  const windowSize = Math.max(32, Math.round(sampleRate * windowMs / 1000));
  const hopSize = Math.max(16, Math.round(sampleRate * hopMs / 1000));
  const frames = [];

  for (let offset = 0; offset + windowSize <= samples.length; offset += hopSize) {
    let energy = 0;
    let peak = 0;
    for (let i = offset; i < offset + windowSize; i++) {
      const absolute = Math.abs(samples[i]);
      energy += absolute * absolute;
      peak = Math.max(peak, absolute);
    }
    frames.push({ rms: Math.sqrt(energy / windowSize), peak });
  }

  if (!frames.length) {
    return { accepted: false, rejectionReasons: ['audio contains no analyzable samples'], regions: [] };
  }

  const rmsValues = frames.map((frame) => frame.rms);
  const peakRms = Math.max(...rmsValues);
  const noiseRms = percentile(rmsValues, 0.25);
  const threshold = Math.max(
    10 ** (-48 / 20),
    noiseRms * 3.2,
    peakRms * 0.055
  );

  const rawRegions = [];
  let active = null;
  frames.forEach((frame, index) => {
    if (frame.rms >= threshold) {
      if (!active) active = { startFrame: index, endFrame: index, peak: frame.peak, peakFrame: index };
      active.endFrame = index;
      if (frame.peak > active.peak) {
        active.peak = frame.peak;
        active.peakFrame = index;
      }
    } else if (active) {
      rawRegions.push(active);
      active = null;
    }
  });
  if (active) rawRegions.push(active);

  const merged = mergeRegions(rawRegions, Math.ceil(mergeGapMs / hopMs))
    .map((region) => {
      const startSeconds = region.startFrame * hopSize / sampleRate;
      const endSeconds = Math.min(samples.length / sampleRate, (region.endFrame * hopSize + windowSize) / sampleRate);
      return {
        ...region,
        startSeconds,
        endSeconds,
        durationSeconds: endSeconds - startSeconds,
        peakSeconds: region.peakFrame * hopSize / sampleRate,
        peakDbfs: db(region.peak),
      };
    })
    .filter((region) => region.durationSeconds >= minEventMs / 1000);

  const durationSeconds = samples.length / sampleRate;
  const activeSeconds = merged.reduce((sum, region) => sum + region.durationSeconds, 0);
  const coverage = durationSeconds ? activeSeconds / durationSeconds : 0;
  const candidates = merged
    .filter((region) => region.durationSeconds <= maxEventSeconds)
    .map((region) => {
      const transientBonus = clamp(1 - region.durationSeconds / maxEventSeconds, 0, 1);
      const peakScore = clamp((region.peakDbfs + 48) / 42, 0, 1);
      return { ...region, score: peakScore * 0.72 + transientBonus * 0.28 };
    })
    .sort((a, b) => b.score - a.score);

  const selected = candidates[0] || merged
    .map((region) => ({ ...region, score: clamp((region.peakDbfs + 48) / 42, 0, 1) }))
    .sort((a, b) => b.score - a.score)[0];

  const rejectionReasons = [];
  if (!selected) rejectionReasons.push('no distinct audible event was detected');
  if (noiseRms >= peakRms * 0.65) {
    rejectionReasons.push('audio is continuously active and behaves like music or ambience');
  }
  if (coverage > 0.72) rejectionReasons.push('audio is continuously active and behaves like music or ambience');
  if (merged.length > 8) rejectionReasons.push('too many separate events were generated');
  if (selected?.durationSeconds > maxEventSeconds) rejectionReasons.push('the strongest event is too long for a motion-graphic cue');
  if ((selected?.peakDbfs ?? DB_FLOOR) < -38) rejectionReasons.push('the detected event is too quiet');

  if (!selected) {
    return {
      accepted: false,
      durationSeconds,
      noiseFloorDbfs: db(noiseRms),
      thresholdDbfs: db(threshold),
      activeCoverage: coverage,
      regions: merged,
      rejectionReasons,
    };
  }

  const trimStartSeconds = Math.max(0, selected.startSeconds - preRollMs / 1000);
  const trimEndSeconds = Math.min(durationSeconds, selected.endSeconds + postRollMs / 1000);
  const anchorSeconds = selected.startSeconds - trimStartSeconds;
  const confidence = clamp(
    selected.score
      - Math.max(0, coverage - 0.45) * 0.8
      - Math.max(0, merged.length - 4) * 0.04,
    0,
    1
  );

  return {
    accepted: rejectionReasons.length === 0 && confidence >= 0.46,
    durationSeconds,
    noiseFloorDbfs: db(noiseRms),
    thresholdDbfs: db(threshold),
    activeCoverage: coverage,
    regions: merged,
    selected: {
      onsetSeconds: selected.startSeconds,
      offsetSeconds: selected.endSeconds,
      peakSeconds: selected.peakSeconds,
      peakDbfs: selected.peakDbfs,
      durationSeconds: selected.durationSeconds,
    },
    trimStartSeconds,
    trimEndSeconds,
    anchorSeconds,
    confidence,
    rejectionReasons: confidence < 0.46
      ? [...rejectionReasons, 'event-detection confidence is too low']
      : rejectionReasons,
  };
}

export async function analyzeAudioEvent(inputPath, options) {
  const { samples, sampleRate } = await decodeMonoPcm(inputPath, options);
  return analyzePcmEvent(samples, sampleRate, options);
}

export function isSyntheticTimbre(timbre) {
  return Number.isFinite(timbre?.meanCrest)
    && timbre.meanCrest > 24
    && Number.isFinite(timbre?.meanFlatness)
    && timbre.meanFlatness < 0.18;
}

/**
 * Detect strongly pitched, game-like timbres that can pass a waveform-only
 * transient test. Crest alone is not sufficient: natural wood, cork, and paper
 * impacts can have a strong resonant peak. Tonal synthetic sounds combine high
 * crest with low spectral flatness, while organic foley remains broadband.
 */
export async function analyzeSpectralTimbre(inputPath, {
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  signal,
} = {}) {
  const output = await run(ffmpegPath, [
    '-v', 'error',
    '-i', inputPath,
    '-vn',
    '-af', 'aspectralstats=measure=crest+flatness+flux,ametadata=print:file=-',
    '-f', 'null',
    '-',
  ], { signal });
  const text = output.toString('utf8');
  const valuesFor = (measure) =>
    [...text.matchAll(new RegExp(`lavfi\\.aspectralstats\\.[12]\\.${measure}=([0-9.eE+-]+)`, 'g'))]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
  const crest = valuesFor('crest');
  const flatness = valuesFor('flatness');
  const flux = valuesFor('flux');
  if (!crest.length) {
    return {
      meanCrest: null,
      peakCrest: null,
      meanFlatness: null,
      meanFlux: null,
      frameCount: 0,
    };
  }
  const mean = (values) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    meanCrest: mean(crest),
    peakCrest: Math.max(...crest),
    meanFlatness: mean(flatness),
    meanFlux: mean(flux),
    frameCount: crest.length,
  };
}

export async function extractNormalizedEvent(inputPath, outputPath, analysis, {
  targetPeakDb = -8,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  signal,
} = {}) {
  if (!analysis?.selected || !Number.isFinite(analysis.trimStartSeconds)) {
    throw new Error('accepted waveform analysis is required before extraction');
  }
  const duration = Math.max(0.08, analysis.trimEndSeconds - analysis.trimStartSeconds);
  const fadeOutStart = Math.max(0, duration - Math.min(0.12, duration * 0.3));
  // Integrated loudness meters under-read very short transients and can leave
  // a valid tick 20–30 dB too quiet. Peak-normalize the detected event itself,
  // then apply the Director's gain during the final mix.
  const measuredPeakDb = Number(analysis.selected.peakDbfs);
  const gainDb = clamp(
    targetPeakDb - (Number.isFinite(measuredPeakDb) ? measuredPeakDb : targetPeakDb),
    -18,
    30
  );
  const limiter = 10 ** (targetPeakDb / 20);
  await run(ffmpegPath, [
    '-y',
    '-v', 'error',
    '-ss', analysis.trimStartSeconds.toFixed(4),
    '-t', duration.toFixed(4),
    '-i', inputPath,
    '-vn',
    '-af',
    `afade=t=in:st=0:d=0.008,afade=t=out:st=${fadeOutStart.toFixed(4)}:d=${Math.max(0.02, duration - fadeOutStart).toFixed(4)},volume=${gainDb.toFixed(2)}dB,alimiter=limit=${limiter.toFixed(6)}:level=false`,
    '-ar', '48000',
    '-ac', '2',
    '-c:a', 'libmp3lame',
    '-b:a', '192k',
    outputPath,
  ], { signal });
  return {
    durationSeconds: duration,
    anchorSeconds: analysis.anchorSeconds,
  };
}
