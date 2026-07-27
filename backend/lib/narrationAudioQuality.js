const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const median = (values) => {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const round = (value, places = 3) => {
  const scale = 10 ** places
  return Math.round(value * scale) / scale
}

export const mergeSilenceIntervals = (intervals, maxBridgeSeconds = 0.06) => {
  const sorted = (intervals || [])
    .filter(interval => Number.isFinite(interval?.start) && Number.isFinite(interval?.end) && interval.end > interval.start)
    .map(interval => ({ start: interval.start, end: interval.end }))
    .sort((a, b) => a.start - b.start)

  const merged = []
  for (const interval of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && interval.start - previous.end <= maxBridgeSeconds) {
      previous.end = Math.max(previous.end, interval.end)
    } else {
      merged.push({ ...interval })
    }
  }
  return merged
}

export const pauseAtBoundary = (silenceIntervals, previousWordEnd, nextWordStart) => {
  if (!Number.isFinite(previousWordEnd) || !Number.isFinite(nextWordStart)) return null
  const semanticMidpoint = (previousWordEnd + nextWordStart) / 2
  const merged = mergeSilenceIntervals(silenceIntervals)
  const candidates = merged
    .filter(interval => (
      interval.end >= previousWordEnd - 0.35
      && interval.start <= nextWordStart + 0.55
      && interval.start <= semanticMidpoint + 0.45
      && interval.end >= semanticMidpoint - 0.45
    ))
    .map(interval => ({
      ...interval,
      durationSeconds: interval.end - interval.start,
      distance: Math.abs(((interval.start + interval.end) / 2) - semanticMidpoint),
    }))
    .sort((a, b) => a.distance - b.distance)
  const best = candidates[0]
  return best ? {
    startSeconds: round(best.start),
    endSeconds: round(best.end),
    durationSeconds: round(best.durationSeconds),
  } : {
    startSeconds: round(previousWordEnd),
    endSeconds: round(nextWordStart),
    durationSeconds: round(Math.max(0, nextWordStart - previousWordEnd)),
  }
}

const boundaryLabel = (unit) => unit?.unit_id || unit?.scene_id || unit?.sceneId || 'unknown'

const boundaryText = (unit) => (unit?.text || unit?.speechText || '').trim()

const targetForBoundary = (boundary, baseline) => {
  const previousText = boundary.previousText || ''
  const isCinema = String(boundary.fromUnitId).startsWith('cinema:')
    || String(boundary.toUnitId).startsWith('cinema:')
  if (/[,;—–-]\s*$/.test(previousText)) return clamp(baseline * 0.58, 0.38, 0.62)
  if (isCinema) return clamp(baseline + 0.08, 0.75, 1.1)
  return clamp(baseline, 0.62, 0.95)
}

export const analyzeNarrationBoundaries = ({ units, alignments, silenceIntervals }) => {
  const boundaries = []
  for (let index = 0; index < units.length - 1; index++) {
    const previous = alignments[index]
    const next = alignments[index + 1]
    if (!Number.isFinite(previous?.lastWordEnd) || !Number.isFinite(next?.firstWordStart)) continue
    const pause = pauseAtBoundary(silenceIntervals, previous.lastWordEnd, next.firstWordStart)
    boundaries.push({
      id: `boundary-${index + 1}`,
      index,
      fromUnitId: boundaryLabel(units[index]),
      toUnitId: boundaryLabel(units[index + 1]),
      previousText: boundaryText(units[index]),
      nextText: boundaryText(units[index + 1]),
      previousWordEndSeconds: round(previous.lastWordEnd),
      nextWordStartSeconds: round(next.firstWordStart),
      timeSeconds: round((previous.lastWordEnd + next.firstWordStart) / 2),
      transcriptGapSeconds: round(Math.max(0, next.firstWordStart - previous.lastWordEnd)),
      pauseStartSeconds: pause?.startSeconds ?? null,
      pauseEndSeconds: pause?.endSeconds ?? null,
      pauseSeconds: pause?.durationSeconds ?? null,
      matchConfidence: round(Math.min(previous.matchRatio || 0, next.matchRatio || 0), 2),
    })
  }

  const confidentPauses = boundaries
    .filter(boundary => boundary.matchConfidence >= 0.65 && boundary.pauseSeconds >= 0.18 && boundary.pauseSeconds <= 2.5)
    .map(boundary => boundary.pauseSeconds)
  const rawMedian = median(confidentPauses)
  const baseline = clamp(rawMedian || 0.8, 0.62, 0.95)
  const absoluteDeviations = confidentPauses.map(value => Math.abs(value - rawMedian))
  const mad = median(absoluteDeviations)
  const warningFloor = clamp(Math.min(baseline - Math.max(0.18, 2.5 * mad), 0.5), 0.32, 0.5)

  const issues = []
  for (const boundary of boundaries) {
    const targetGapSeconds = targetForBoundary(boundary, baseline)
    boundary.targetGapSeconds = round(targetGapSeconds)
    const pause = boundary.pauseSeconds
    if (!Number.isFinite(pause)) continue
    const highConfidence = boundary.matchConfidence >= 0.65
    const shouldFlag = pause < 0.25 || (highConfidence && pause < warningFloor)
    if (!shouldFlag) continue
    const insertSeconds = Math.max(0, targetGapSeconds - pause)
    issues.push({
      id: `gap-${boundary.index + 1}`,
      type: 'short_gap',
      severity: pause < 0.18 ? 'high' : 'medium',
      confidence: highConfidence ? 0.94 : 0.68,
      timeSeconds: round((boundary.pauseStartSeconds + boundary.pauseEndSeconds) / 2),
      startSeconds: boundary.pauseStartSeconds,
      endSeconds: boundary.pauseEndSeconds,
      fromUnitId: boundary.fromUnitId,
      toUnitId: boundary.toUnitId,
      title: `Tight transition · ${boundary.fromUnitId} → ${boundary.toUnitId}`,
      description: `Only ${pause.toFixed(2)}s of measured breathing room separates these narration units.`,
      evidence: {
        measuredPauseSeconds: pause,
        transcriptGapSeconds: boundary.transcriptGapSeconds,
        projectMedianPauseSeconds: round(rawMedian || baseline),
      },
      suggestion: `Insert a transparent ${insertSeconds.toFixed(2)}s pause to reach a natural ${targetGapSeconds.toFixed(2)}s separation.`,
      operation: {
        type: 'insert_silence',
        atSeconds: round((boundary.pauseStartSeconds + boundary.pauseEndSeconds) / 2),
        durationSeconds: round(insertSeconds),
      },
      autoFix: insertSeconds >= 0.05,
      defaultSelected: true,
      status: 'open',
    })
  }

  return {
    boundaries,
    issues,
    profile: {
      medianPauseSeconds: round(rawMedian || baseline),
      madSeconds: round(mad),
      warningFloorSeconds: round(warningFloor),
      analyzedBoundaryCount: boundaries.length,
    },
  }
}

const rmsDb = (sumSquares, count) => {
  if (!count) return -120
  return 20 * Math.log10(Math.max(1e-8, Math.sqrt(sumSquares / count)))
}

export const analyzePcmSignal = (samples, sampleRate, { boundaryTimes = [], wordTimes = [], peakBuckets = 1400 } = {}) => {
  const peaks = []
  const bucketSize = Math.max(1, Math.floor(samples.length / peakBuckets))
  let absolutePeak = 0
  let sum = 0
  let clippedSamples = 0
  let totalSquares = 0
  for (let bucketStart = 0; bucketStart < samples.length; bucketStart += bucketSize) {
    let bucketPeak = 0
    const bucketEnd = Math.min(samples.length, bucketStart + bucketSize)
    for (let index = bucketStart; index < bucketEnd; index++) {
      const sample = samples[index]
      const absolute = Math.abs(sample)
      bucketPeak = Math.max(bucketPeak, absolute)
      absolutePeak = Math.max(absolutePeak, absolute)
      if (absolute >= 0.999) clippedSamples++
      sum += sample
      totalSquares += sample * sample
    }
    peaks.push(round(bucketPeak, 4))
  }

  const issues = []
  const durationSeconds = samples.length / sampleRate
  const dcOffset = samples.length ? sum / samples.length : 0
  if (clippedSamples >= 6) {
    issues.push({
      id: 'signal-clipping',
      type: 'clipping',
      severity: 'high',
      confidence: 0.96,
      timeSeconds: 0,
      title: 'Digital clipping detected',
      description: `${clippedSamples} samples touch full scale and may sound distorted.`,
      suggestion: 'Create a protected master with de-clipping and a conservative true-peak ceiling.',
      operation: { type: 'declip' },
      autoFix: true,
      defaultSelected: true,
      status: 'open',
    })
  }
  if (Math.abs(dcOffset) > 0.01) {
    issues.push({
      id: 'signal-dc-offset',
      type: 'dc_offset',
      severity: 'medium',
      confidence: 0.95,
      timeSeconds: 0,
      title: 'DC offset detected',
      description: `The waveform is offset from zero by ${round(dcOffset, 4)}.`,
      suggestion: 'Remove the offset with a transparent 20Hz high-pass pass.',
      operation: { type: 'remove_dc' },
      autoFix: true,
      defaultSelected: true,
      status: 'open',
    })
  }

  const windowSamples = Math.max(1, Math.round(sampleRate * 0.1))
  const levels = []
  for (let start = 0; start < samples.length; start += windowSamples) {
    let square = 0
    const end = Math.min(samples.length, start + windowSamples)
    for (let index = start; index < end; index++) square += samples[index] * samples[index]
    levels.push(rmsDb(square, end - start))
  }
  const nearBoundary = (time) => boundaryTimes.some(boundary => Math.abs(boundary - time) < 0.45)
  const insideSpokenWord = (time) => wordTimes.some(word => {
    const start = word.startTime ?? word.start
    const end = word.endTime ?? word.end
    return Number.isFinite(start) && Number.isFinite(end) && time >= start + 0.1 && time <= end - 0.1
  })
  const stableSpeechLevel = (slice) => {
    const active = slice.filter(level => level > -42)
    if (active.length < Math.ceil(slice.length * 0.8)) return null
    const center = median(active)
    const spread = median(active.map(level => Math.abs(level - center)))
    return spread <= 2.3 ? center : null
  }
  let lastLevelIssue = -10
  for (let index = 10; index < levels.length - 10; index++) {
    const before = stableSpeechLevel(levels.slice(index - 10, index - 2))
    const after = stableSpeechLevel(levels.slice(index + 2, index + 10))
    if (!Number.isFinite(before) || !Number.isFinite(after)) continue
    const timeSeconds = index * 0.1
    const difference = after - before
    if (
      Math.abs(difference) >= 12
      && !nearBoundary(timeSeconds)
      && insideSpokenWord(timeSeconds)
      && timeSeconds - lastLevelIssue > 3
    ) {
      issues.push({
        id: `level-${Math.round(timeSeconds * 1000)}`,
        type: 'level_jump',
        severity: Math.abs(difference) >= 10 ? 'high' : 'medium',
        confidence: 0.78,
        timeSeconds: round(timeSeconds),
        startSeconds: round(Math.max(0, timeSeconds - 0.45)),
        endSeconds: round(Math.min(durationSeconds, timeSeconds + 0.45)),
        title: difference > 0 ? 'Sudden level increase' : 'Sudden level decrease',
        description: `Narration level changes by ${Math.abs(difference).toFixed(1)} dB in under half a second.`,
        suggestion: 'Review this transition. A conservative local gain ramp can smooth a confirmed level mismatch.',
        operation: { type: 'review_level', deltaDb: round(difference, 1) },
        autoFix: false,
        defaultSelected: false,
        status: 'open',
      })
      lastLevelIssue = timeSeconds
    }
  }

  let lastClick = -10
  const clickThreshold = 1.05
  const nearWordOnset = (time) => wordTimes.some(word => Math.abs((word.startTime ?? word.start ?? 0) - time) < 0.035)
  for (let index = 1; index < samples.length; index++) {
    const delta = Math.abs(samples[index] - samples[index - 1])
    if (delta < clickThreshold) continue
    const timeSeconds = index / sampleRate
    if (timeSeconds - lastClick < 1 || nearWordOnset(timeSeconds)) continue
    issues.push({
      id: `click-${Math.round(timeSeconds * 1000)}`,
      type: 'click',
      severity: 'medium',
      confidence: 0.76,
      timeSeconds: round(timeSeconds),
      startSeconds: round(Math.max(0, timeSeconds - 0.03)),
      endSeconds: round(Math.min(durationSeconds, timeSeconds + 0.03)),
      title: 'Possible click or digital pop',
      description: 'A very short discontinuity is stronger than the surrounding waveform.',
      suggestion: 'Preview this point. Confirmed clicks can be repaired with a localized de-click pass.',
      operation: { type: 'declick' },
      autoFix: true,
      defaultSelected: false,
      status: 'open',
    })
    lastClick = timeSeconds
    if (issues.filter(issue => issue.type === 'click').length >= 12) break
  }

  return {
    waveform: { peaks, bucketCount: peaks.length, durationSeconds: round(durationSeconds) },
    issues,
    stats: {
      peakDbfs: round(20 * Math.log10(Math.max(1e-8, absolutePeak)), 2),
      rmsDbfs: round(rmsDb(totalSquares, samples.length), 2),
      dcOffset: round(dcOffset, 6),
      clippedSamples,
    },
  }
}

export const publicAudit = (audit) => {
  const { cache: _cache, sourceFilename: _sourceFilename, ...safe } = audit
  return safe
}

export const summarizeAudit = (issues, loudness = {}) => {
  const open = (issues || []).filter(issue => issue.status !== 'resolved')
  const high = open.filter(issue => issue.severity === 'high').length
  return {
    overallStatus: open.length ? 'review-required' : 'clean',
    issueCount: open.length,
    highPriorityCount: high,
    safeFixCount: open.filter(issue => issue.autoFix).length,
    integratedLufs: Number.isFinite(loudness.integratedLufs) ? loudness.integratedLufs : null,
    truePeakDb: Number.isFinite(loudness.truePeakDb) ? loudness.truePeakDb : null,
  }
}
