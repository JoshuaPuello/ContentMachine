/**
 * Canonical sound design for the twenty-four Director Lab references.
 *
 * These cues are deliberately sparse: one reusable, narration-safe sound per
 * visual idea, except Hero Stat where the counter texture and final landing are
 * two distinct editorial actions. Frames are authored against the 30fps,
 * 240-frame Director Lab compositions.
 */
export const DIRECTOR_SFX_CATALOG = [
  {
    presetId: 'director-data-hero-stat',
    cues: [
      {
        id: 'hero-stat-count',
        role: 'count',
        frames: [22],
        target_duration_seconds: 3,
        description: 'a continuous sequence of soft felted mechanical counting clicks following the rising documentary statistic, evenly paced, unpitched, tactile, and stopping cleanly when the number stops',
        gain_db: -22,
      },
      {
        id: 'hero-stat-resolve',
        role: 'resolve',
        frames: [112],
        description: 'the featured documentary number reaches its final value with one warm felt-and-air landing, organic and unpitched, confident without sounding triumphant',
        gain_db: -15,
      },
    ],
  },
  {
    presetId: 'director-data-measured-comparison',
    cues: [{
      id: 'measured-comparison-resolve',
      role: 'resolve',
      frames: [158],
      provider_prompt: 'A small leather-bound notebook gently placed once on a thick felt desk pad: one soft muted thump with a faint natural air movement, close dry studio foley, quiet and refined.',
      description: 'two restrained comparison bars finish at their measured values with one soft tactile editorial landing, dry, warm, precise, and unpitched',
      gain_db: -16,
    }],
  },
  {
    presetId: 'director-time-archive-timeline',
    cues: [{
      id: 'archive-timeline-marker',
      role: 'tick',
      frames: [64, 98, 132, 166],
      description: 'one archival timeline milestone appears with a muted mechanical paper-index tick, dry, delicate, historical, and entirely unpitched',
      gain_db: -18,
    }],
  },
  {
    presetId: 'director-time-parallel-events',
    cues: [{
      id: 'parallel-events-marker',
      role: 'tick',
      frames: [66, 100, 134],
      provider_prompt: 'A felt-covered wooden index tab tapped once against archival paper: one tiny dry physical click, close quiet studio foley.',
      description: 'one synchronized historical event marker locks onto a shared time ruler with a soft precise editorial tick, tactile, restrained, and unpitched',
      gain_db: -19,
    }],
  },
  {
    presetId: 'director-geography-strategic-locator',
    cues: [{
      id: 'strategic-locator-arrival',
      role: 'resolve',
      frames: [168],
      provider_prompt: 'A small wooden map marker pressed gently once onto a thick folded paper map: one muted contact with a brief soft paper rustle, close studio foley.',
      description: 'a regional map route reaches its exact strategic location with one restrained cartographic landing, soft paper movement and felt contact, no impact boom',
      gain_db: -17,
    }],
  },
  {
    presetId: 'director-geography-camera-journey',
    cues: [{
      id: 'camera-journey-handoff',
      role: 'transition',
      frames: [122],
      description: 'the documentary map camera hands off smoothly from one distant location to the next with one refined low airy movement, spatial but subtle and non-musical',
      gain_db: -18,
    }],
  },
  {
    presetId: 'director-entities-portrait-legend',
    cues: [{
      id: 'portrait-legend-reveal',
      role: 'reveal',
      frames: [34],
      provider_prompt: 'A heavy archival portrait print sliding a short distance across soft linen and stopping gently: one brief paper-and-fabric movement, quiet close studio foley.',
      description: 'an elegant historical portrait legend glides into focus and settles with one soft silk-and-air movement, museum-like, organic, diffuse, and unpitched',
      gain_db: -17,
    }],
  },
  {
    presetId: 'director-entities-exploded-object',
    cues: [{
      id: 'exploded-object-component',
      role: 'tick',
      frames: [76, 100, 124, 148],
      description: 'one museum-grade mechanical component separates and receives its callout with a tiny muted precision click, tactile metal and felt, never sharp or electronic',
      gain_db: -19,
    }],
  },
  {
    presetId: 'director-evidence-front-page-focus',
    cues: [{
      id: 'front-page-reveal',
      role: 'reveal',
      frames: [58],
      description: 'an archival newspaper front page settles beneath the documentary camera with one soft paper unfold and restrained editorial focus movement, clean studio foley',
      gain_db: -18,
    }],
  },
  {
    presetId: 'director-evidence-document-proof',
    cues: [{
      id: 'document-proof-highlight',
      role: 'reveal',
      frames: [152],
      description: 'one exact clause on an attributed historical document becomes highlighted with a delicate paper-and-graphite editorial reveal, dry, subtle, and non-musical',
      gain_db: -18,
    }],
  },
  {
    presetId: 'director-systems-causal-flow',
    cues: [{
      id: 'causal-flow-connection',
      role: 'transition',
      frames: [84, 132],
      description: 'a thin causal connection travels cleanly from one diagram node to the next with one soft directional air-and-felt movement, precise and understated',
      gain_db: -18,
    }],
  },
  {
    presetId: 'director-systems-organization-focus',
    cues: [{
      id: 'organization-focus-lock',
      role: 'resolve',
      frames: [120],
      provider_prompt: 'A small smooth wooden tile placed gently once onto a thick felt presentation board: one soft muted contact, close dry studio foley.',
      description: 'an organization diagram settles its attention on the active branch with one quiet authoritative felted lock, structured, warm, and unpitched',
      gain_db: -17,
    }],
  },
  {
    presetId: 'director-science-orbital-system',
    cues: [{
      id: 'orbital-system-lock',
      role: 'resolve',
      frames: [120],
      provider_prompt: 'A smooth wooden disk gliding briefly over dense felt and stopping softly: one quiet friction movement and muted contact, close studio foley.',
      description: 'a scientific orbital system reaches a stable explanatory alignment with one smooth low air-and-glass settling movement, restrained, diffuse, and non-tonal',
      gain_db: -19,
    }],
  },
  {
    presetId: 'director-science-layered-cutaway',
    cues: [{
      id: 'layered-cutaway-reveal',
      role: 'reveal',
      frames: [146],
      description: 'the final hidden technical layer is exposed in a clean cross-section with one soft material separation sound, fine paper, glass, and air, never metallic or sharp',
      gain_db: -18,
    }],
  },
  {
    presetId: 'director-archive-contact-sheet',
    cues: [{
      id: 'contact-sheet-selection',
      role: 'tick',
      frames: [114],
      description: 'one photograph is selected from a cinematic archival contact sheet with a muted film-editor index click, soft mechanical foley, dry and unpitched',
      gain_db: -18,
    }],
  },
  {
    presetId: 'director-archive-depth-reconstruction',
    cues: [{
      id: 'depth-reconstruction-reveal',
      role: 'reveal',
      frames: [54],
      description: 'a flat archival photograph opens into gentle foreground, subject, and environmental depth with one restrained photographic paper-and-air reveal',
      gain_db: -19,
    }],
  },
  {
    presetId: 'director-typography-source-quote',
    cues: [{
      id: 'source-quote-reveal',
      role: 'reveal',
      frames: [92],
      description: 'a concise attributed quotation finishes revealing over footage with one soft editorial ink-and-paper settle, intimate, warm, and non-musical',
      gain_db: -19,
    }],
  },
  {
    presetId: 'director-typography-definition-reveal',
    cues: [{
      id: 'definition-reveal',
      role: 'reveal',
      frames: [92],
      description: 'a key documentary term resolves into its precise definition with one clean typographic underline movement, felt and paper texture, subtle and unpitched',
      gain_db: -18,
    }],
  },
  {
    presetId: 'director-scale-human-comparison',
    cues: [{
      id: 'human-comparison-resolve',
      role: 'resolve',
      frames: [154],
      provider_prompt: 'A small wooden scale model set gently once onto a padded cloth table: one soft low muted thump, close dry studio foley.',
      description: 'a familiar human reference and the compared structure reach their final scale relationship with one soft low tactile landing, legible and restrained',
      gain_db: -17,
    }],
  },
  {
    presetId: 'director-scale-nested-scale',
    cues: [{
      id: 'nested-scale-step',
      role: 'tick',
      frames: [62, 94, 126, 158],
      description: 'one nested order of magnitude comes into focus with a delicate optical-mechanical step, soft lens movement and felt contact, precise and non-electronic',
      gain_db: -20,
    }],
  },
  {
    presetId: 'director-strategy-decision-matrix',
    cues: [{
      id: 'decision-matrix-resolve',
      role: 'resolve',
      frames: [150],
      provider_prompt: 'A solid wooden decision token placed gently once onto a thick felt board: one confident but quiet muted contact, close studio foley.',
      description: 'a risk-versus-impact matrix lands on the narrated strategic choice with one restrained decisive felted placement, confident, warm, and without a trailer boom',
      gain_db: -16,
    }],
  },
  {
    presetId: 'director-strategy-influence-network',
    cues: [{
      id: 'influence-network-resolve',
      role: 'resolve',
      frames: [150],
      provider_prompt: 'Cotton thread pulled gently across heavy paper, followed by one small wooden pin pressed softly into cork: a brief quiet physical movement, close studio foley.',
      description: 'a stakeholder influence network completes its meaningful relationships and settles on the central actor with one soft connective editorial landing',
      gain_db: -18,
    }],
  },
  {
    presetId: 'director-digital-device-workflow',
    cues: [{
      id: 'device-workflow-step',
      role: 'tick',
      frames: [60, 98, 136],
      description: 'one verified step in a premium documentary device workflow completes with a muted physical interface tap, tactile glass and felt, no notification or electronic beep',
      gain_db: -20,
    }],
  },
  {
    presetId: 'director-digital-data-network',
    cues: [{
      id: 'data-network-arrival',
      role: 'resolve',
      frames: [178],
      description: 'a clean service-to-service data packet reaches its destination with one subtle physical routing lock, soft mechanical texture, modern but entirely non-electronic',
      gain_db: -18,
    }],
  },
];

const ROLE_DURATION_SECONDS = {
  tick: 0.65,
  transition: 1.4,
  reveal: 1.5,
  resolve: 1.2,
};

export const DIRECTOR_SFX_CUES = DIRECTOR_SFX_CATALOG.flatMap((item) =>
  item.cues.map((cue) => ({
    ...cue,
    preset_id: item.presetId,
    at_seconds: cue.frames[0] / 30,
    generation_duration_seconds:
      cue.generation_duration_seconds ?? ROLE_DURATION_SECONDS[cue.role] ?? 2,
  }))
);
