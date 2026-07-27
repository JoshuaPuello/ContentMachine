const CHARACTER_TYPES = new Set(['person', 'animal', 'personified-object']);
const IMPORTANCE_LEVELS = new Set(['primary', 'supporting']);

const cleanText = (value, fallback = '') =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : fallback;

const spokenLines = (lines) => (Array.isArray(lines) ? lines : [])
  .filter(line => typeof line === 'string' && !/^\s*\[[^\]]+\]\s*$/.test(line))
  .map(line => line.trim())
  .filter(Boolean)
  .join(' ');

const narrationUnits = (narration) => {
  if (Array.isArray(narration)) return narration;
  if (Array.isArray(narration?.narration_sequence)) return narration.narration_sequence;
  if (Array.isArray(narration?.scene_breakdown)) return narration.scene_breakdown;
  return [];
};

export const buildNarrationIndex = (narration) => {
  const byId = new Map();
  const byNumber = new Map();

  for (const unit of narrationUnits(narration)) {
    if (
      !unit
      || (unit.cinema_type && unit.cinema_type !== 'scene')
      || String(unit.scene_id || '').startsWith('cinema:')
    ) continue;
    const text = cleanText(
      unit.narration
      || unit.source_narration
      || unit.text
      || unit.script
      || spokenLines(unit.lines)
    );
    if (!text) continue;
    if (unit.scene_id) byId.set(String(unit.scene_id), text);
    const sceneNumber = Number(unit.scene_number ?? String(unit.scene_id || '').match(/\d+/)?.[0]);
    if (Number.isFinite(sceneNumber) && sceneNumber > 0) byNumber.set(sceneNumber, text);
  }

  return { byId, byNumber };
};

export const buildCharacterSceneContext = (scenePlan, narration) => {
  const index = buildNarrationIndex(narration);
  return (scenePlan?.scenes || []).map((scene, indexInPlan) => {
    const sceneNumber = Number(scene.scene_number) || indexInPlan + 1;
    return {
      scene_id: scene.scene_id || `s${String(sceneNumber).padStart(2, '0')}`,
      scene_number: sceneNumber,
      narration: cleanText(
        index.byId.get(String(scene.scene_id))
        || index.byNumber.get(sceneNumber)
        || scene.source_narration
        || scene.narration
      ),
      visual_description: cleanText(scene.visual_description),
      mannequin_details: scene.mannequin_details || null,
    };
  });
};

export const buildCharacterReferencePrompt = (character = {}, supplementalDirection = '') => {
  const name = cleanText(character.name, 'Recurring documentary character');
  const role = cleanText(character.role, 'recurring documentary subject');
  const description = cleanText(
    character.description,
    'Use the documented age, build, hair silhouette, posture, and period wardrobe supplied by the story.'
  );
  const rawExtra = cleanText(supplementalDirection);
  const extra = /MANDATORY VISUAL CONTINUITY STYLE|Create a museum-quality, full-body neutral character reference|\bmani(?:kin|quin)\s+style\b/i.test(rawExtra)
    ? ''
    : rawExtra;

  return [
    `Create a museum-quality, full-body neutral character reference portrait for ${name}, ${role}.`,
    `Source identity facts: ${description}`,
    'MANDATORY VISUAL CONTINUITY STYLE: render the entire person as a seamless, featureless glossy porcelain mannequin—not as a photorealistic human.',
    'The face must be a smooth blank porcelain surface with no eyes, eyebrows, nose, mouth, realistic skin, pores, flesh, age spots, or photographic facial detail.',
    'Any source description of complexion, eyes, facial structure, wrinkles, age spots, or skin is an identity note only; never render it as literal anatomy or flesh. Translate it only into non-facial silhouette, porcelain tint, sculpted hair, posture, proportions, and wardrobe.',
    'Communicate documented age and identity through body proportions, posture, height, build, sculpted hair shape, restrained porcelain tone, wardrobe, and accessories only. Never use exposed realistic human skin.',
    'Show the character centered from head to toe in a calm neutral standing pose, with a complete period-accurate outfit and identity-defining accessories only.',
    'Use a simple charcoal studio background, restrained museum lighting, crisp garment detail, consistent scale, and generous clear space around the silhouette.',
    'No text, labels, captions, logos, badges with readable text, extra people, cropped feet, cropped head, props unrelated to identity, or environmental scene.',
    extra ? `Additional art direction: ${extra}` : '',
  ].filter(Boolean).join(' ');
};

const stableCharacterId = (character, index) => cleanText(
  character?.id || character?.name || `character-${index + 1}`
).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const normalizeExtractedCharacters = (payload, sceneCount = Infinity) => {
  const seenIds = new Set();
  const characters = [];

  for (const [index, source] of (Array.isArray(payload?.characters) ? payload.characters : []).entries()) {
    const name = cleanText(source?.name);
    if (!name) continue;
    let id = stableCharacterId(source, index);
    if (!id) id = `character-${index + 1}`;
    let suffix = 2;
    const baseId = id;
    while (seenIds.has(id)) id = `${baseId}-${suffix++}`;
    seenIds.add(id);

    const sceneNumbers = [...new Set((Array.isArray(source.scene_numbers) ? source.scene_numbers : [])
      .map(Number)
      .filter(number => Number.isInteger(number) && number > 0 && number <= sceneCount))]
      .sort((a, b) => a - b);
    const character = {
      id,
      name,
      role: cleanText(source.role, 'Recurring documentary subject'),
      character_type: CHARACTER_TYPES.has(source.character_type) ? source.character_type : 'person',
      description: cleanText(source.description, 'Recurring visual identity documented by the story.'),
      scene_numbers: sceneNumbers,
      importance: IMPORTANCE_LEVELS.has(source.importance) ? source.importance : 'supporting',
      approved: false,
      image: null,
      image_options: [],
    };
    character.visual_prompt = buildCharacterReferencePrompt(character);
    characters.push(character);
  }

  const candidateAudit = payload?.candidate_audit || payload?.audit || {};
  const excluded = (Array.isArray(candidateAudit.excluded) ? candidateAudit.excluded : [])
    .map(item => typeof item === 'string'
      ? { name: item, reason: 'Scene-local identity; no reusable continuity reference required.' }
      : {
          name: cleanText(item?.name, 'Unnamed scene-local figure'),
          reason: cleanText(item?.reason, 'Scene-local identity; no reusable continuity reference required.'),
        });

  return {
    characters,
    audit: {
      candidate_count: Math.max(
        characters.length + excluded.length,
        Number(candidateAudit.candidate_count) || 0
      ),
      included_count: characters.length,
      excluded,
      coverage_notes: cleanText(
        candidateAudit.coverage_notes,
        'Recurring cast normalized and checked against the finalized narration and visual scene plan.'
      ),
    },
  };
};
