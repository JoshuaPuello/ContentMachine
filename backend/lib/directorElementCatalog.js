/**
 * Canonical non-motion-graphic elements emitted by the ContentMachine Director.
 *
 * Motion graphics author their own sound because their beats are bespoke.
 * Stable chrome elements receive restrained defaults that travel through the
 * same generation, waveform analysis, alignment, preview, and final mix path.
 */
export const DIRECTOR_ELEMENT_CATALOG = Object.freeze({
  'lower-third': {
    label: 'Lower Third',
    sound: {
      role: 'reveal',
      at_seconds: 0.32,
      generation_duration_seconds: 1.4,
      gain_db: -21,
      description:
        'One isolated premium documentary lower-third reveal: a very soft linen-air sweep ending in a muted felt contact. Warm, organic, dry, elegant and brief; no pitch, chime, interface beep, music, bass hit, or synthetic texture.',
    },
  },
  'date-chip': {
    label: 'Date Chip',
    sound: {
      role: 'reveal',
      at_seconds: 0.24,
      generation_duration_seconds: 1.3,
      gain_db: -22,
      description:
        'One unique documentary date-chip punctuation: a small archival index card makes a short movement across thick wool felt and settles. Audible paper fibre and soft felt friction, restrained and unpitched; no clock, bell, beep, click-track, music, or electronic UI sound.',
    },
  },
  'title-card': {
    label: 'Title Bloom',
    sound: {
      role: 'reveal',
      at_seconds: 0.9,
      generation_duration_seconds: 1.8,
      gain_db: -20,
      description:
        'One elegant cinematic title bloom: a slow soft movement of air through heavy fabric that resolves into a barely audible warm felt landing. Organic, diffuse and narration-safe; no braam, boom, riser, melody, shimmer, chime, or synthetic whoosh.',
    },
  },
  'chapter-overview': {
    label: 'Chapter Constellation',
    sound: {
      role: 'reveal',
      at_seconds: 0.45,
      generation_duration_seconds: 1.6,
      gain_db: -22,
      description:
        'One subtle chapter-constellation reveal: soft thread tension and a quiet cloth-air trace as portrait frames connect. Refined physical foley with a short tail; no electricity, neon buzz, sparkle, chime, music, or science-fiction UI sound.',
    },
  },
  'chapter-focus': {
    label: 'Chapter Focus',
    sound: {
      role: 'resolve',
      at_seconds: 0.42,
      generation_duration_seconds: 1.2,
      gain_db: -21,
      description:
        'One restrained chapter selection accent: a soft matted-card lift followed by a muted felt settle. Tactile, warm, dry, and very brief beneath narration; no pop, button click, notification, pitch, music, or electronic sound.',
    },
  },
  'map-segment': {
    label: 'Map Segment',
    sound: null,
    silenceReason:
      'Maps remain intentionally silent by default because narration, labels, arrows, and camera movement already carry dense information. A map may author bespoke cues later only when a specific narrated event earns them.',
  },
});

export function directorElementSoundDesign(kind, id = kind) {
  const definition = DIRECTOR_ELEMENT_CATALOG[kind];
  if (!definition?.sound) {
    return {
      enabled: false,
      strategy: definition?.silenceReason || 'Intentional silence.',
      cues: [],
    };
  }
  return {
    enabled: false,
    strategy: `Narration-safe canonical sound for ${definition.label}.`,
    cues: [{
      id: `${id}-sound`,
      asset: null,
      ...structuredClone(definition.sound),
    }],
  };
}

export function attachDirectorElementSoundDesign(plan) {
  for (const [index, item] of (plan.lower_thirds || []).entries()) {
    item.id ||= `lower-third-${index + 1}`;
    item.sound_design ||= directorElementSoundDesign('lower-third', item.id);
  }
  for (const [index, item] of (plan.date_chips || []).entries()) {
    item.id ||= `date-chip-${index + 1}`;
    item.sound_design ||= directorElementSoundDesign('date-chip', item.id);
  }
  for (const [index, item] of (plan.title_cards || []).entries()) {
    item.id ||= `title-card-${index + 1}`;
    item.sound_design ||= directorElementSoundDesign('title-card', item.id);
  }
  for (const [index, item] of (plan.maps || []).entries()) {
    item.id ||= `map-segment-${index + 1}`;
    item.sound_design ||= directorElementSoundDesign('map-segment', item.id);
  }
  if (plan.trailer) {
    plan.trailer.id ||= 'trailer-title';
    plan.trailer.sound_design ||= directorElementSoundDesign('title-card', plan.trailer.id);
  }
  if (plan.chapters?.length) {
    plan.chapter_overview_sound_design ||= directorElementSoundDesign(
      'chapter-overview',
      'chapter-overview'
    );
    for (const [index, chapter] of plan.chapters.entries()) {
      chapter.id ||= `chapter-${index + 1}`;
      chapter.sound_design ||= directorElementSoundDesign('chapter-focus', chapter.id);
    }
  }
  return plan;
}

export function directorSoundDesignOwners(plan) {
  return [
    ...(plan.motion_graphics || []),
    ...(plan.lower_thirds || []),
    ...(plan.date_chips || []),
    ...(plan.title_cards || []),
    ...(plan.trailer ? [plan.trailer] : []),
    ...(plan.chapter_overview_sound_design
      ? [{ id: 'chapter-overview', sound_design: plan.chapter_overview_sound_design }]
      : []),
    ...(plan.chapters || []),
  ];
}
