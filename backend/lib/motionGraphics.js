/**
 * Motion-graphics planning contract and deterministic editorial arbiter.
 *
 * The visual Director is deliberately allowed to adapt a catalog reference
 * or invent a new treatment. This module does not make creative decisions;
 * it only enforces the non-negotiable editorial laws that keep an ambitious
 * plan watchable, legible, renderable, and ready for future sound design.
 */

export const MOTION_GRAPHIC_REFERENCE_PRESETS = [
  'director-data-hero-stat',
  'director-data-measured-comparison',
  'director-time-archive-timeline',
  'director-time-parallel-events',
  'director-geography-strategic-locator',
  'director-geography-camera-journey',
  'director-entities-portrait-legend',
  'director-entities-exploded-object',
  'director-evidence-front-page-focus',
  'director-evidence-document-proof',
  'director-systems-causal-flow',
  'director-systems-organization-focus',
  'director-science-orbital-system',
  'director-science-layered-cutaway',
  'director-archive-contact-sheet',
  'director-archive-depth-reconstruction',
  'director-typography-source-quote',
  'director-typography-definition-reveal',
  'director-scale-human-comparison',
  'director-scale-nested-scale',
  'director-strategy-decision-matrix',
  'director-strategy-influence-network',
  'director-digital-device-workflow',
  'director-digital-data-network',
];

const PRESENTATIONS = new Set(['overlay', 'takeover']);
const ARCHETYPES = new Set([
  'hero',
  'minimal',
  'split',
  'comparison',
  'sequence',
  'timeline',
  'network',
  'document',
  'profile',
  'spatial',
  'diagram',
  'custom-grid',
]);
const BACKGROUNDS = new Set([
  'footage-dim',
  'editorial-gradient',
  'archival-paper',
  'technical-grid',
  'soft-atmosphere',
  'spatial-field',
]);
const TEMPOS = new Set(['contemplative', 'measured', 'energetic', 'urgent']);
const SIDES = new Set(['left', 'right', 'center', 'balanced']);
const SOUND_ROLES = new Set(['transition', 'accent', 'impact', 'tick', 'reveal', 'texture', 'resolve', 'count']);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const text = (value, max = 240) =>
  typeof value === 'string' ? value.trim().slice(0, max) : '';
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

const STOPWORDS = new Set([
  'a', 'an', 'and', 'as', 'at', 'by', 'for', 'from', 'in', 'is', 'it',
  'of', 'on', 'or', 'the', 'to', 'was', 'were', 'with',
]);
const SMALL_NUMBERS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function numberToWords(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 999) return '';
  if (number < 20) return SMALL_NUMBERS[number];
  if (number < 100) {
    return `${TENS[Math.floor(number / 10)]}${number % 10 ? ` ${SMALL_NUMBERS[number % 10]}` : ''}`;
  }
  return `${SMALL_NUMBERS[Math.floor(number / 100)]} hundred${number % 100 ? ` ${numberToWords(number % 100)}` : ''}`;
}

function normalizedTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[–—-]/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token && !STOPWORDS.has(token));
}

function overlapRatio(left, right) {
  const a = new Set(normalizedTokens(left));
  const b = new Set(normalizedTokens(right));
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function repeatsPrimaryFact(copy, primaryValue, primaryLabel) {
  if (!copy || (!primaryValue && !primaryLabel)) return false;
  const normalizedCopy = normalizedTokens(copy).join(' ');
  const numeric = String(primaryValue || '').match(/\d+/)?.[0];
  const spoken = numeric ? numberToWords(numeric) : '';
  const repeatsValue = !!numeric && (
    normalizedTokens(copy).includes(numeric)
    || (spoken && normalizedCopy.includes(spoken))
  );
  const repeatsLabel = primaryLabel && overlapRatio(copy, primaryLabel) >= 0.65;
  return repeatsValue || repeatsLabel;
}

function applySemanticUniqueness(spec) {
  const content = spec.composition.content;
  const layout = spec.composition.layout;
  const adjustments = [];
  const primaryFact = `${content.primary_value || ''} ${content.primary_label || ''}`.trim();

  // If explanatory prose simply says the same thing as the featured value,
  // two visual regions would manufacture hierarchy without adding meaning.
  // Collapse to one glass card and remove only the repeated sentence.
  if (
    content.primary_value
    && (
      repeatsPrimaryFact(content.body, content.primary_value, content.primary_label)
      || repeatsPrimaryFact(content.title, content.primary_value, content.primary_label)
    )
  ) {
    if (repeatsPrimaryFact(content.body, content.primary_value, content.primary_label)) {
      content.body = '';
    }
    layout.archetype = 'minimal';
    adjustments.push('Collapsed duplicated primary fact into one compact composition.');
  }

  // Elements must each contribute a distinct fact. The check is semantic
  // enough to catch paraphrased labels, but conservative enough not to erase
  // legitimate comparisons that merely share a subject.
  const represented = [content.title, content.body, primaryFact].filter(Boolean);
  content.elements = content.elements.filter((element) => {
    const fact = `${element.value || ''} ${element.title || ''} ${element.label || ''} ${element.body || ''}`.trim();
    if (!fact) return false;
    const duplicate = represented.some((existing) =>
      overlapRatio(existing, fact) >= 0.82
      || (
        element.value
        && repeatsPrimaryFact(existing, element.value, element.label || element.title)
      )
    );
    if (duplicate) {
      adjustments.push(`Removed repeated element "${element.title || element.label || element.value}".`);
      return false;
    }
    represented.push(fact);
    return true;
  });

  if (adjustments.length) spec.editorial_adjustments = adjustments;
  return spec;
}

function sceneTiming(sceneCount, audioDurations = {}) {
  const timings = {};
  let cursor = 0;
  for (let scene = 1; scene <= sceneCount; scene++) {
    const duration = Math.max(1, finite(audioDurations[String(scene)], 8));
    timings[scene] = { start: cursor, end: cursor + duration, duration };
    cursor += duration;
  }
  return { timings, totalDuration: cursor };
}

function sanitizeItem(item, index) {
  if (!item || typeof item !== 'object') return null;
  const title = text(item.content?.title || item.title, 100);
  const primaryValue = text(item.content?.primary_value, 40);
  const elements = Array.isArray(item.content?.elements)
    ? item.content.elements.slice(0, 8).map((element, elementIndex) => ({
        id: text(element?.id, 40) || `element-${elementIndex + 1}`,
        title: text(element?.title, 80),
        body: text(element?.body, 180),
        value: text(element?.value, 48),
        label: text(element?.label, 80),
        role: text(element?.role, 48),
        accent: /^#[0-9a-f]{6}$/i.test(element?.accent || '') ? element.accent : undefined,
      })).filter((element) => element.title || element.body || element.value || element.label)
    : [];
  if (!title && !primaryValue && !elements.length) return null;

  const duration = clamp(finite(item.duration_seconds, 7), 4, 18);
  const rawCues = Array.isArray(item.sound_design?.cues) ? item.sound_design.cues : [];
  const cues = rawCues.slice(0, 2).map((cue, cueIndex) => ({
    id: text(cue?.id, 40) || `cue-${cueIndex + 1}`,
    at_seconds: clamp(finite(cue?.at_seconds, 0), 0, duration),
    role: SOUND_ROLES.has(cue?.role) ? cue.role : 'accent',
    description: text(cue?.description, 140),
    asset: text(cue?.asset, 300) || null,
    gain_db: clamp(finite(cue?.gain_db, -12), -36, 0),
    generation_duration_seconds: clamp(finite(cue?.generation_duration_seconds, 2), 0.5, 30),
    target_duration_seconds: cue?.role === 'count'
      ? clamp(finite(cue?.target_duration_seconds, Math.max(0.6, duration - finite(cue?.at_seconds, 0))), 0.6, duration)
      : undefined,
  }));

  const referencePreset = text(item.source?.reference_preset, 100);
  const sourceMode = item.source?.mode === 'invent' ? 'invent' : 'adapt';
  const sanitized = {
    id: text(item.id, 80) || `motion-graphic-${index + 1}`,
    scene_number: Math.round(finite(item.scene_number, 0)),
    at_seconds_into_scene: Math.max(0, finite(item.at_seconds_into_scene, 1)),
    duration_seconds: duration,
    reason: text(item.reason, 320),
    narration_excerpt: text(item.narration_excerpt, 360),
    category: text(item.category, 48) || 'custom',
    intent: text(item.intent, 100) || 'editorial explanation',
    source: {
      mode: sourceMode,
      reference_preset: referencePreset || null,
      invention_notes: sourceMode === 'invent' ? text(item.source?.invention_notes, 420) : '',
    },
    presentation: PRESENTATIONS.has(item.presentation) ? item.presentation : 'overlay',
    composition: {
      layout: {
        archetype: ARCHETYPES.has(item.composition?.layout?.archetype)
          ? item.composition.layout.archetype
          : 'split',
        focus_side: SIDES.has(item.composition?.layout?.focus_side)
          ? item.composition.layout.focus_side
          : 'balanced',
        reverse_order: !!item.composition?.layout?.reverse_order,
        safe_margin_percent: clamp(finite(item.composition?.layout?.safe_margin_percent, 6), 4, 12),
      },
      background: {
        mode: BACKGROUNDS.has(item.composition?.background?.mode)
          ? item.composition.background.mode
          : (item.presentation === 'takeover' ? 'editorial-gradient' : 'footage-dim'),
        opacity: clamp(finite(item.composition?.background?.opacity, item.presentation === 'takeover' ? 1 : 0.68), 0.35, 1),
        accent: /^#[0-9a-f]{6}$/i.test(item.composition?.background?.accent || '')
          ? item.composition.background.accent
          : '#d94b43',
        secondary: /^#[0-9a-f]{6}$/i.test(item.composition?.background?.secondary || '')
          ? item.composition.background.secondary
          : '#58b7aa',
        texture: text(item.composition?.background?.texture, 80) || 'subtle-film-grain',
        rationale: text(item.composition?.background?.rationale, 180),
      },
      content: {
        eyebrow: text(item.content?.eyebrow, 80),
        title,
        body: text(item.content?.body, 420),
        primary_value: primaryValue,
        primary_label: text(item.content?.primary_label, 100),
        attribution: text(item.content?.attribution, 160),
        elements,
      },
      animation: {
        tempo: TEMPOS.has(item.composition?.animation?.tempo)
          ? item.composition.animation.tempo
          : 'measured',
        entry: text(item.composition?.animation?.entry, 100) || 'soft-rise',
        emphasis: text(item.composition?.animation?.emphasis, 100) || 'progressive-focus',
        exit: text(item.composition?.animation?.exit, 100) || 'soft-dissolve',
        beats: Array.isArray(item.composition?.animation?.beats)
          ? item.composition.animation.beats.slice(0, 10).map((beat, beatIndex) => ({
              at_seconds: clamp(finite(beat?.at_seconds, beatIndex), 0, duration),
              target: text(beat?.target, 80),
              action: text(beat?.action, 100),
            }))
          : [],
      },
    },
    sound_design: {
      enabled: false,
      strategy: text(item.sound_design?.strategy, 240),
      cues,
    },
  };
  return applySemanticUniqueness(sanitized);
}

/**
 * Accepts ambitious creative candidates and returns the strongest plan that
 * obeys pacing and collision laws. Presets are never required: invented
 * treatments use the same declarative composition contract.
 */
export function sanitizeMotionGraphics(candidates, sceneCount, {
  audioDurations = {},
  maps = [],
  titleCards = [],
  chapters = [],
  openingFocalMoment = false,
} = {}) {
  const { timings, totalDuration } = sceneTiming(sceneCount, audioDurations);
  const mapScenes = new Set((maps || []).map((map) => map.after_scene));
  const titleScenes = new Set((titleCards || []).map((card) => card.after_scene));
  const chapterScenes = new Set((chapters || []).map((chapter) => chapter.start_scene));
  const protectedWindows = [
    ...(maps || []).flatMap((map) => {
      const scene = timings[map.after_scene];
      if (!scene) return [];
      const duration = clamp(finite(map.duration_seconds, 18), 10, 30);
      return [{ start: Math.max(scene.start, scene.end - duration), end: scene.end, kind: 'map' }];
    }),
    ...(titleCards || []).flatMap((card) => {
      const scene = timings[card.after_scene];
      if (!scene) return [];
      return [{
        start: scene.end,
        end: scene.end + clamp(finite(card.duration_seconds, 5), 3, 7),
        kind: 'title',
      }];
    }),
  ];
  const cap = Math.max(1, Math.min(6, Math.floor(totalDuration / 38) || 1));
  const coverageCap = totalDuration * 0.25;
  const accepted = [];
  const rejected = [];
  let coverage = 0;

  const normalized = (candidates || [])
    .map(sanitizeItem)
    .filter(Boolean)
    .filter((item) => item.scene_number >= 1 && item.scene_number <= sceneCount)
    .map((item) => {
      const scene = timings[item.scene_number];
      const maxDuration = Math.max(0, scene.duration - 0.4);
      const duration = Math.min(item.duration_seconds, maxDuration);
      const offset = clamp(item.at_seconds_into_scene, 0, Math.max(0, scene.duration - duration));
      return {
        ...item,
        at_seconds_into_scene: offset,
        duration_seconds: duration,
        _absoluteStart: scene.start + offset,
      };
    })
    .filter((item) => item.duration_seconds >= 4)
    .sort((a, b) => a._absoluteStart - b._absoluteStart);

  for (const item of normalized) {
    let rejection = '';
    if (mapScenes.has(item.scene_number)) rejection = 'scene already carries a map';
    else if (titleScenes.has(item.scene_number)) rejection = 'scene boundary already carries a title';
    else if (chapterScenes.has(item.scene_number)) rejection = 'scene begins with a chapter focal moment';
    else if (openingFocalMoment && item.scene_number === 1 && item.at_seconds_into_scene < 8) {
      rejection = 'less than 8 seconds after the opening focal moment';
    }
    else if (accepted.length >= cap) rejection = 'program motion-graphics cap reached';
    else if (coverage + item.duration_seconds > coverageCap) rejection = '25% focal-graphics coverage cap reached';
    else {
      const itemEnd = item._absoluteStart + item.duration_seconds;
      const protectedClash = protectedWindows.find((window) =>
        item._absoluteStart < window.end + 8 && itemEnd > window.start - 8
      );
      if (protectedClash) rejection = `less than 8 seconds from a protected ${protectedClash.kind}`;
    }
    if (!rejection) {
      const previous = accepted.at(-1);
      if (previous) {
        const previousEnd = previous._absoluteStart + previous.duration_seconds;
        if (item._absoluteStart - previousEnd < 8) rejection = 'less than 8 seconds of breathing room';
      }
    }
    if (rejection) {
      rejected.push({ id: item.id, reason: rejection });
      continue;
    }
    accepted.push(item);
    coverage += item.duration_seconds;
  }

  return {
    items: accepted.map(({ _absoluteStart, ...item }) => item),
    audit: {
      candidate_count: normalized.length,
      accepted_count: accepted.length,
      rejected,
      total_graphics_seconds: Math.round(coverage * 100) / 100,
      program_coverage_ratio: totalDuration > 0 ? Math.round((coverage / totalDuration) * 1000) / 1000 : 0,
      rule: 'semantic compression, never decoration',
    },
  };
}
