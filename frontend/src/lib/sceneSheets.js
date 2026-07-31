const MIN_TILES = 2
const MAX_TILES = 6

const text = (value) => String(value ?? '').trim()

const slug = (value, fallback = 'scenario') => {
  const normalized = text(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return normalized || fallback
}

const unitIdOf = (unit) => `${unit.scene_number}_${unit.segment_index ?? 0}`

// Persisted scene-sheet workflows intentionally keep only stable character
// IDs instead of duplicating large base64 portraits in every group. Rebuild
// those preview URLs from the canonical character collection whenever a
// project is loaded. Server-enriched workflows keep their existing URL.
export const hydrateSceneSheetReferences = (workflow, characters = []) => {
  if (!workflow) return workflow

  const charactersById = new Map(
    (characters || [])
      .filter(character => character?.id != null)
      .map(character => [String(character.id), character])
  )

  return {
    ...workflow,
    groups: (workflow.groups || []).map(group => ({
      ...group,
      references: (group.references || []).map(reference => {
        const characterId = reference.characterId
          ?? reference.character_id
          ?? (reference.type === 'character' ? reference.id : null)
        const character = characterId == null
          ? null
          : charactersById.get(String(characterId))
        return {
          ...reference,
          sourceUrl: reference.sourceUrl
            || reference.source_url
            || (reference.type === 'character' ? character?.image : null)
            || reference.image
            || reference.source
            || null,
        }
      }),
    })),
  }
}

const escapeSvg = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')

export const buildSceneSheetTemplateSvg = (layout, panelCount, {
  width = 1600,
  height = 900,
} = {}) => {
  const columns = Number(layout?.columns)
  const rows = Number(layout?.rows)
  const count = Number(panelCount)
  const capacity = columns * rows
  if (!Number.isInteger(columns) || !Number.isInteger(rows) || columns < 1 || rows < 1) {
    throw new Error('Scene-sheet template requires a valid grid layout')
  }
  if (!Number.isInteger(count) || count < 2 || count > capacity) {
    throw new Error('Scene-sheet template panel count is outside its grid')
  }

  const cells = Array.from({ length: capacity }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const x = (column * width) / columns
    const y = (row * height) / rows
    const cellWidth = width / columns
    const cellHeight = height / rows
    const occupied = index < count
    const label = occupied ? String(index + 1).padStart(2, '0') : 'EMPTY'
    return `<g data-panel="${index + 1}" data-state="${occupied ? 'occupied' : 'unused'}">
      <rect x="${x}" y="${y}" width="${cellWidth}" height="${cellHeight}" fill="${occupied ? (index % 2 ? '#151922' : '#11151d') : '#07090d'}"/>
      <rect x="${x + 1.5}" y="${y + 1.5}" width="${cellWidth - 3}" height="${cellHeight - 3}" fill="none" stroke="${occupied ? '#aeb7c6' : '#414754'}" stroke-width="3"/>
      <text x="${x + 24}" y="${y + cellHeight - 24}" fill="${occupied ? '#f5f7fa' : '#656c78'}" font-family="Arial, sans-serif" font-size="${occupied ? 32 : 24}" letter-spacing="3">${escapeSvg(label)}</text>
    </g>`
  }).join('\n')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#07090d"/>
    ${cells}
  </svg>`
}

export const sceneSheetTemplateDataUrl = (layout, panelCount) => (
  `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildSceneSheetTemplateSvg(layout, panelCount))}`
)

export const withSceneSheetTemplateContract = (prompt, layout, panelCount) => {
  const source = text(prompt)
  if (/GRID TEMPLATE CONTRACT/i.test(source)) return source
  return `${source}\n\nGRID TEMPLATE CONTRACT
- Attach the supplied ${layout.columns}×${layout.rows} grid template as the FIRST reference image. It is authoritative for canvas geometry, equal cell boundaries, reading order, and the ${panelCount} occupied cells.
- Use the template only as a structural mask. Replace every occupied dark cell with its assigned cinematic panel while preserving the exact divider positions.
- Keep any cell marked EMPTY completely empty, flat neutral charcoal, and free of story content.
- Keep only the requested small lower-left panel numbers. Do not reproduce template colors, placeholder fills, or extra guide text.
- Attach the ordered character reference images only AFTER the grid template, in the exact numbered order listed above.`
}

const layoutForCount = (count) => {
  if (count === 2) return { columns: 2, rows: 1, tileAspectRatio: '16:9' }
  if (count === 3) return { columns: 3, rows: 1, tileAspectRatio: '16:9' }
  if (count === 4) return { columns: 2, rows: 2, tileAspectRatio: '16:9' }
  if (count === 5 || count === 6) {
    return { columns: 3, rows: 2, tileAspectRatio: '16:9' }
  }
  throw new Error(`Scene sheets require ${MIN_TILES}-${MAX_TILES} tiles`)
}

// Balance large scenario groups instead of greedily taking six and leaving a
// visually useless singleton. Examples: 7 → 4+3, 8 → 4+4, 13 → 5+4+4.
const balancedChunkSizes = (count) => {
  if (count < MIN_TILES) return []
  const chunkCount = Math.ceil(count / MAX_TILES)
  const base = Math.floor(count / chunkCount)
  const remainder = count % chunkCount
  return Array.from(
    { length: chunkCount },
    (_, index) => base + (index < remainder ? 1 : 0)
  )
}

const chunkUnits = (units) => {
  const chunks = []
  let offset = 0
  for (const size of balancedChunkSizes(units.length)) {
    chunks.push(units.slice(offset, offset + size))
    offset += size
  }
  return chunks
}

const parentSceneForUnit = (unit, planByNumber) => (
  planByNumber.get(Number(unit.scene_number)) || {}
)

const scenarioIdFor = (scene) => (
  text(scene.scenario_id)
  || text(scene.scenarioId)
)

const environmentFamilyFor = (scene) => (
  text(scene.environment_family_id)
  || text(scene.environmentFamilyId)
  || text(scene.scenario_family_id)
  || text(scene.scenarioFamilyId)
)

const continuityFor = (scene) => (
  text(scene.scenario_continuity)
  || text(scene.scenarioContinuity)
  || text(scene.environment?.continuity)
)

const orderedCharacterReferences = ({
  units,
  characters,
  characterSceneLinks,
}) => {
  const byId = new Map((characters || []).map(character => [String(character.id), character]))
  const seen = new Set()
  const references = []

  for (const unit of units) {
    const ids = characterSceneLinks?.[String(unit.scene_number)]?.character_ids || []
    for (const rawId of ids) {
      const id = String(rawId)
      if (seen.has(id)) continue
      const character = byId.get(id)
      if (!character) continue
      seen.add(id)
      references.push({
        order: references.length + 1,
        id,
        name: text(character.name) || id,
        role: text(character.role),
        description: text(character.description),
        visualPrompt: text(character.visual_prompt || character.visualPrompt),
        image: character.image || null,
      })
    }
  }
  return references
}

const panelDescription = (unit, planScene, index) => {
  const prompt = text(unit.prompts?.[0])
  const beat = Array.isArray(planScene.visual_beats)
    ? planScene.visual_beats[unit.segment_index ?? index]
    : null
  const action = text(beat?.action || planScene.mannequin_details?.action)
  const shotType = text(beat?.shot_type || planScene.shot_type)
  const narration = text(unit.narration || unit.full_scene_narration)
  return {
    panelNumber: index + 1,
    label: String(index + 1).padStart(2, '0'),
    unitId: unitIdOf(unit),
    sceneNumber: Number(unit.scene_number),
    segmentIndex: Number(unit.segment_index ?? 0),
    sceneTitle: text(unit.scene_title || planScene.title || planScene.scene_id),
    shotType,
    action,
    narration,
    prompt,
  }
}

const referenceContract = (references) => {
  if (!references.length) {
    return 'No recurring character reference is required. Do not invent a foreground person unless a panel explicitly requires one.'
  }
  return references.map(reference => (
    `REFERENCE ${reference.order} — ${reference.name}${reference.role ? ` (${reference.role})` : ''}\n` +
    `Immutable identity: ${reference.description || reference.visualPrompt || 'match the supplied reference exactly.'}`
  )).join('\n\n')
}

export const buildSceneSheetMasterPrompt = (sheet) => {
  const { layout, panels, references } = sheet
  const unusedCells = (layout.columns * layout.rows) - panels.length
  const panelInstructions = panels.map(panel => [
    `PANEL ${panel.label} — unit ${panel.unitId}`,
    panel.sceneTitle ? `Narrative beat: ${panel.sceneTitle}` : null,
    panel.shotType ? `Shot design: ${panel.shotType}` : null,
    panel.action ? `Required visible action: ${panel.action}` : null,
    panel.narration ? `Narration context: ${panel.narration}` : null,
    `Image instruction: ${panel.prompt || 'Create the exact story beat described above without inventing new action.'}`,
  ].filter(Boolean).join('\n')).join('\n\n')

  return `CREATE ONE CINEMATIC SCENE SHEET — NOT SIX UNRELATED IMAGES.

OUTPUT CONTRACT
- Produce one ${layout.columns}-column × ${layout.rows}-row grid containing exactly ${panels.length} equal ${layout.tileAspectRatio} panels.
- Read panels left-to-right, top-to-bottom.
- Add only the small panel labels ${panels.map(panel => panel.label).join(', ')} in the bottom-left safe margin of their corresponding panels. Add no other captions, logos, borders, or typography.
- Every panel must be a polished standalone cinematic documentary frame, not a sketch, comic panel, mood board, or contact-sheet thumbnail.
- Use thin, neutral separators. Never overlap panels and never let a subject cross a panel boundary.
${unusedCells > 0 ? `- Leave the final ${unusedCells} unused grid cell${unusedCells === 1 ? '' : 's'} empty, flat neutral charcoal, and completely free of subjects, scenery, props, labels, or story content.` : ''}

IMMUTABLE WORLD CONTRACT
- Scenario: ${sheet.scenarioId}.
- Continuity anchors: ${sheet.scenarioContinuity || 'preserve the same physical geography, architecture, set dressing, weather, time of day, light direction, surface conditions, vehicles, vegetation, and persistent props throughout the sheet.'}
- All panels belong to one coherent physical world. A new camera angle may reveal another side of the location, but it must never redesign it.
- Preserve object identity, scale, wear, color, relative position, and cause-and-effect state between panels.

ORDERED REFERENCE CONTRACT
The supplied reference images are ordered exactly as listed below. Never swap identities:

${referenceContract(references)}

IMMUTABLE CHARACTER AND ANATOMY CONTRACT
- Every recurring character must match the corresponding ordered reference: silhouette, body build, apparent age, surface tone, hair shape, wardrobe continuity, and distinctive accessories.
- The documentary's people are life-size seamless glossy porcelain mannequins unless a panel explicitly contains no person.
- Every visible figure has realistic adult human anatomy and proportions, natural shoulder width, torso length, limb length, joints, posture, and weight distribution.
- Every visible hand has exactly five proportional fingers. No toy, doll, miniature, chibi, bobblehead, action-figure, rubber-limb, fused, duplicated, extra-limbed, or malformed anatomy.
- Faces remain featureless smooth porcelain with no eyes, nose, or mouth. The mannequin material is only the visual surface; pose, balance, gesture, and physical action must behave exactly like a real human.
- Never turn a mannequin into a flesh-and-blood person. Never introduce an unreferenced recurring character.

SHOT-SPECIFIC PANEL CONTRACT
${panelInstructions}

FINAL QUALITY CHECK
- Each panel advances a distinct authored shot or segment; a tighter crop of an unchanged pose is not a new shot.
- Verify every panel label maps to the correct unit and every referenced character is used only where required.
- Verify world geography and persistent props remain consistent across non-adjacent panels.
- Render clean cinematic lighting, physically plausible materials, realistic scale, controlled depth of field, and high-detail professional documentary composition.
- Return only the finished scene-sheet image.`
}

const makeSheet = ({
  kind,
  groupKey,
  units,
  planByNumber,
  characters,
  characterSceneLinks,
  chunkIndex,
}) => {
  const firstPlan = parentSceneForUnit(units[0], planByNumber)
  const exactScenarioIds = [...new Set(
    units.map(unit => scenarioIdFor(parentSceneForUnit(unit, planByNumber))).filter(Boolean)
  )]
  const scenarioId = kind === 'scenario'
    ? groupKey
    : `${groupKey} (${exactScenarioIds.join(', ')})`
  const continuity = [...new Set(
    units.map(unit => continuityFor(parentSceneForUnit(unit, planByNumber))).filter(Boolean)
  )].join(' | ')
  const unitIds = units.map(unitIdOf)
  const sheet = {
    id: `sheet_${kind}_${slug(groupKey)}_${chunkIndex + 1}_${unitIds[0]}_${unitIds.at(-1)}`,
    kind,
    groupKey,
    scenarioId,
    scenarioContinuity: continuity || continuityFor(firstPlan),
    unitIds,
    layout: layoutForCount(units.length),
    references: orderedCharacterReferences({ units, characters, characterSceneLinks }),
    panels: units.map((unit, index) => (
      panelDescription(unit, parentSceneForUnit(unit, planByNumber), index)
    )),
  }
  return { ...sheet, masterPrompt: buildSceneSheetMasterPrompt(sheet) }
}

/**
 * Create deterministic manual scene-sheet work from canonical scene-plan and
 * segment records. Inputs are treated as immutable.
 *
 * Exact scenario IDs always win. When allowEnvironmentFamilies is true, only
 * otherwise-isolated units with an explicitly authored family ID may combine.
 */
export const planSceneSheets = ({
  scenePlan,
  scenes = [],
  characters = [],
  characterSceneLinks = {},
  allowEnvironmentFamilies = false,
} = {}) => {
  const planScenes = Array.isArray(scenePlan?.scenes) ? scenePlan.scenes : []
  const planByNumber = new Map(
    planScenes.map(scene => [Number(scene.scene_number), scene])
  )
  const orderedUnits = [...scenes]
    .filter(unit => Number.isFinite(Number(unit?.scene_number)))
    .sort((a, b) => (
      Number(a.scene_number) - Number(b.scene_number)
      || Number(a.segment_index ?? 0) - Number(b.segment_index ?? 0)
    ))

  const exactGroups = new Map()
  const unmatched = []
  for (const unit of orderedUnits) {
    const planScene = parentSceneForUnit(unit, planByNumber)
    const scenarioId = scenarioIdFor(planScene)
    if (!scenarioId) {
      unmatched.push(unit)
      continue
    }
    if (!exactGroups.has(scenarioId)) exactGroups.set(scenarioId, [])
    exactGroups.get(scenarioId).push(unit)
  }

  const sheets = []
  const isolated = [...unmatched]
  for (const [scenarioId, units] of exactGroups) {
    if (units.length < MIN_TILES) {
      isolated.push(...units)
      continue
    }
    chunkUnits(units).forEach((chunk, chunkIndex) => {
      sheets.push(makeSheet({
        kind: 'scenario',
        groupKey: scenarioId,
        units: chunk,
        planByNumber,
        characters,
        characterSceneLinks,
        chunkIndex,
      }))
    })
  }

  let finalIsolated = isolated
  if (allowEnvironmentFamilies) {
    const familyGroups = new Map()
    const noFamily = []
    for (const unit of isolated) {
      const familyId = environmentFamilyFor(parentSceneForUnit(unit, planByNumber))
      if (!familyId) {
        noFamily.push(unit)
        continue
      }
      if (!familyGroups.has(familyId)) familyGroups.set(familyId, [])
      familyGroups.get(familyId).push(unit)
    }
    finalIsolated = [...noFamily]
    for (const [familyId, units] of familyGroups) {
      if (units.length < MIN_TILES) {
        finalIsolated.push(...units)
        continue
      }
      chunkUnits(units).forEach((chunk, chunkIndex) => {
        sheets.push(makeSheet({
          kind: 'environment-family',
          groupKey: familyId,
          units: chunk,
          planByNumber,
          characters,
          characterSceneLinks,
          chunkIndex,
        }))
      })
    }
  }

  sheets.sort((a, b) => {
    const [as, ag] = a.unitIds[0].split('_').map(Number)
    const [bs, bg] = b.unitIds[0].split('_').map(Number)
    return as - bs || ag - bg || a.id.localeCompare(b.id)
  })
  const isolatedUnitIds = finalIsolated
    .map(unitIdOf)
    .sort((a, b) => {
      const [as, ag] = a.split('_').map(Number)
      const [bs, bg] = b.split('_').map(Number)
      return as - bs || ag - bg
    })

  return {
    version: 1,
    sheets,
    isolatedUnitIds,
    groupedUnitIds: sheets.flatMap(sheet => sheet.unitIds),
  }
}

export { layoutForCount, unitIdOf }
