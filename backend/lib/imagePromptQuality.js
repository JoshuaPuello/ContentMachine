const MANNEQUIN_GUARD_MARKER = 'UNIVERSAL FIGURE CONTRACT v2:';
const ANATOMY_GUARD_MARKER = 'ANATOMY CONTRACT v2:';
const FRAMING_GUARD_MARKER = 'FRAMING CONTRACT:';
const TIGHT_DETAIL_MARKER = 'TIGHT-DETAIL OVERRIDE v2:';
const PROP_MATERIAL_MARKER = 'PROP MATERIAL CONTRACT:';

const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ');

const sceneText = (scene, prompt) => [
  scene?.shot_type,
  scene?.visual_description,
  scene?.camera_intent,
  scene?.mannequin_details?.action,
  prompt,
].map(clean).join(' ').toLowerCase();

const isTightShot = (text) =>
  /\b(extreme close[- ]up|macro|insert shot|tight detail|detail shot)\b/.test(text);

const isObjectOrBodyPartDetail = (text) =>
  /\b(gavel|hand|hands|finger|fingers|wrist|forearm|arm|foot|feet|shoe|shoes|key|pen|document|phone|screen|monitor|photograph|letter|weapon|tool|object)\b/.test(text);

const hasMediaLayer = (text) =>
  /\b(screen|monitor|television|tv|phone display|projection|projected|photograph|photo|video footage|bodycam|archive footage|reflection|mirror)\b/.test(text);

export const buildImagePromptGuardrails = (scene = {}, prompt = '') => {
  const combined = sceneText(scene, prompt);
  const guards = [];

  if (!prompt.includes(MANNEQUIN_GUARD_MARKER)) {
    guards.push(
      `${MANNEQUIN_GUARD_MARKER} every visible human-shaped figure at every depth must be a seamless, featureless glossy porcelain mannequin. The porcelain surface is uninterrupted: no articulated doll joints, ball joints, hinges, panel lines, wrist seams, finger-segment seams, or mechanical articulation are visible. This includes unnamed people, crowds, soft-focus silhouettes, reflections, photographs, and figures shown inside televisions, phones, projections, monitors, bodycam footage, or archival media. No realistic human skin, eyes, nose, mouth, facial anatomy, or photoreal human appears anywhere in the image.`
    );
  }

  if (!prompt.includes(ANATOMY_GUARD_MARKER)) {
    guards.push(
      `${ANATOMY_GUARD_MARKER} every mannequin has life-size, age-appropriate realistic human anatomy and proportions: natural head-to-body scale, shoulders, torso, pelvis, limb lengths, underlying joint geometry, hands, and exactly five proportional fingers per visible hand. Joints bend naturally beneath a continuous porcelain surface without visible articulation lines. Poses remain physically plausible and weight-bearing. No chibi, toy, figurine, doll, bobblehead, miniature, compressed torso, oversized head or hands, shortened limbs, fused anatomy, extra limbs, duplicated body parts, or malformed fingers.`
    );
  }

  if (!prompt.includes(FRAMING_GUARD_MARKER)) {
    guards.push(
      `${FRAMING_GUARD_MARKER} obey the requested camera crop. Describe and show only anatomy and clothing naturally visible inside that crop. Never squeeze a complete head-to-toe body into a close-up merely to satisfy wardrobe continuity; clothing outside the frame remains implied and must not appear.`
    );
  }

  if (!prompt.includes(PROP_MATERIAL_MARKER)) {
    guards.push(
      `${PROP_MATERIAL_MARKER} porcelain applies only to human figures and their visible anatomy. Every prop, garment, surface, and environment retains its documented real-world material, scale, weight, and texture—wood remains natural wood with visible grain, metal remains metal, fabric remains fabric, and glass remains glass. Never turn props into glossy porcelain, plastic toys, miniatures, or fused extensions of the mannequin.`
    );
  }

  if (isTightShot(combined) && isObjectOrBodyPartDetail(combined) && !prompt.includes(TIGHT_DETAIL_MARKER)) {
    guards.push(
      `${TIGHT_DETAIL_MARKER} this is an object/body-part insert, not a full-character portrait. Show only the specific object and the minimum anatomically connected body region needed for the action—for a hand-held object, one correctly proportioned hand, wrist, and forearm entering naturally from outside the frame. Do not invent a second hand, arm, limb, or background body unless the scene explicitly requires it. The head, face, torso, pelvis, legs, and footwear remain outside the composition unless the scene explicitly focuses on one of them. Ignore any earlier instruction that asks an out-of-frame face, trousers, or shoes to be visible.`
    );
  }

  if (hasMediaLayer(combined)) {
    guards.push(
      'NESTED-IMAGE CHECK: the content visible inside every screen, recording, reflection, or photograph follows the exact same porcelain-mannequin style and anatomy rules as the primary scene; nested media is never an exception.'
    );
  }

  return guards.join(' ');
};

export const hardenDocumentaryImagePrompt = (prompt, scene = {}) => {
  let base = clean(prompt);
  if (!base) return base;
  const combined = sceneText(scene, base);
  if (isTightShot(combined) && isObjectOrBodyPartDetail(combined)) {
    base = base
      .replace(/\s+with\s+[^,.]*\b(?:trousers|pants|breeches|skirt)\b[^,.]*\b(?:shoes|boots|sandals|footwear)\b[^,.]*/gi, '')
      .replace(/,\s*featureless smooth porcelain face(?:,\s*no eyes\s*\/\s*nose\s*\/\s*mouth)?/gi, '')
      .replace(/\bporcelain skin tone\b/gi, 'porcelain surface tone')
      .replace(/\bwith wood splinters and dust particles frozen mid-air\b/gi, 'at the exact contact point with subtle impact vibration and no debris');
  }
  const guards = buildImagePromptGuardrails(scene, base);
  return guards ? `${base} ${guards}` : base;
};

const sourceSceneFor = (sourceScenes, authoredScene) =>
  sourceScenes.find(scene =>
    String(scene.scene_id || '') === String(authoredScene.scene_id || '')
    || Number(scene.scene_number) === Number(authoredScene.scene_number)
  ) || {};

const hardenVariations = (variations, scene) => (Array.isArray(variations) ? variations : [])
  .map(variation => ({
    ...variation,
    prompt: hardenDocumentaryImagePrompt(variation.prompt, scene),
  }));

export const hardenImagePromptScenes = (authoredScenes, sourceScenes = []) =>
  (Array.isArray(authoredScenes) ? authoredScenes : []).map(authoredScene => {
    const scene = sourceSceneFor(sourceScenes, authoredScene);
    if (Array.isArray(authoredScene.segments)) {
      return {
        ...authoredScene,
        segments: authoredScene.segments.map(segment => ({
          ...segment,
          variations: hardenVariations(segment.variations, scene),
        })),
      };
    }
    return {
      ...authoredScene,
      variations: hardenVariations(authoredScene.variations, scene),
    };
  });

const sceneNumberFromKey = (key) => {
  const number = Number(String(key || '').split('_')[0]);
  return Number.isInteger(number) && number > 0 ? number : null;
};

export const normalizeProjectImagePrompts = (project) => {
  if (!project || typeof project !== 'object') return { changed: false, promptCount: 0 };
  const planScenes = project.scene_plan?.scenes || [];
  const sceneByNumber = new Map(planScenes.map(scene => [Number(scene.scene_number), scene]));
  let changed = false;
  let promptCount = 0;

  const normalizePrompt = (prompt, sceneNumber) => {
    if (typeof prompt !== 'string' || !prompt.trim()) return prompt;
    const hardened = hardenDocumentaryImagePrompt(prompt, sceneByNumber.get(Number(sceneNumber)) || {});
    promptCount++;
    if (hardened !== prompt) changed = true;
    return hardened;
  };

  for (const unit of project.scenes || []) {
    unit.prompts = (unit.prompts || []).map(prompt =>
      normalizePrompt(prompt, unit.scene_number)
    );
  }

  const normalizeCollection = (collection) => {
    for (const [key, entry] of Object.entries(collection || {})) {
      if (entry && typeof entry === 'object' && typeof entry.prompt === 'string') {
        entry.prompt = normalizePrompt(entry.prompt, sceneNumberFromKey(key));
      }
    }
  };
  normalizeCollection(project.images);
  normalizeCollection(project.selected_images);

  for (const [key, entries] of Object.entries(project.image_history || {})) {
    for (const entry of entries || []) {
      if (entry && typeof entry.prompt === 'string') {
        entry.prompt = normalizePrompt(entry.prompt, sceneNumberFromKey(key));
      }
    }
  }

  return { changed, promptCount };
};
