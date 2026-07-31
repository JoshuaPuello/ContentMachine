import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSceneSheetMasterPrompt,
  buildSceneSheetTemplateSvg,
  hydrateSceneSheetReferences,
  layoutForCount,
  planSceneSheets,
  withSceneSheetTemplateContract,
} from './sceneSheets.js'

const unit = (scene, segment = 0, prompt = `prompt ${scene}_${segment}`) => ({
  scene_number: scene,
  segment_index: segment,
  scene_title: `Scene ${scene}`,
  prompts: [prompt],
  narration: `Narration ${scene}_${segment}`,
})

const planScene = (scene, scenario, extra = {}) => ({
  scene_number: scene,
  scene_id: `s${String(scene).padStart(2, '0')}`,
  scenario_id: scenario,
  scenario_continuity: `fixed world for ${scenario}`,
  shot_type: 'medium shot',
  mannequin_details: { action: `action ${scene}` },
  ...extra,
})

test('hydrates persisted character references after a project refresh', () => {
  const workflow = {
    groups: [{
      id: 'sheet-vault',
      references: [{
        order: 1,
        type: 'character',
        characterId: 'jorge',
        name: 'Jorge',
      }],
    }],
  }
  const characters = [{ id: 'jorge', image: 'data:image/jpeg;base64,portrait' }]
  const workflowBefore = structuredClone(workflow)
  const charactersBefore = structuredClone(characters)

  const hydrated = hydrateSceneSheetReferences(workflow, characters)

  assert.equal(
    hydrated.groups[0].references[0].sourceUrl,
    'data:image/jpeg;base64,portrait'
  )
  assert.deepEqual(workflow, workflowBefore)
  assert.deepEqual(characters, charactersBefore)
})

test('keeps server-provided scene-sheet reference URLs authoritative', () => {
  const workflow = {
    groups: [{
      references: [{
        type: 'character',
        character_id: 'jorge',
        sourceUrl: '/api/session/example/files/current-portrait.png',
      }],
    }],
  }

  const hydrated = hydrateSceneSheetReferences(workflow, [{
    id: 'jorge',
    image: 'data:image/jpeg;base64,older-portrait',
  }])

  assert.equal(
    hydrated.groups[0].references[0].sourceUrl,
    '/api/session/example/files/current-portrait.png'
  )
})

test('builds deterministic 16:9 structural templates for every sheet size', () => {
  for (let count = 2; count <= 6; count += 1) {
    const layout = layoutForCount(count)
    const svg = buildSceneSheetTemplateSvg(layout, count)
    assert.match(svg, /width="1600" height="900"/)
    assert.equal((svg.match(/data-state="occupied"/g) || []).length, count)
    assert.equal(
      (svg.match(/data-state="unused"/g) || []).length,
      (layout.columns * layout.rows) - count,
    )
  }
})

test('adds the layout-template contract once to existing project prompts', () => {
  const layout = layoutForCount(3)
  const once = withSceneSheetTemplateContract('Create the sheet.', layout, 3)
  const twice = withSceneSheetTemplateContract(once, layout, 3)
  assert.match(once, /FIRST reference image/i)
  assert.match(once, /3×1 grid template/)
  assert.equal(twice, once)
})

test('groups non-adjacent compatible scenes and treats every segment as one tile', () => {
  const result = planSceneSheets({
    scenePlan: {
      scenes: [
        planScene(1, 'vault-night'),
        planScene(2, 'street-day'),
        planScene(3, 'vault-night'),
      ],
    },
    scenes: [
      unit(1, 0),
      unit(1, 1),
      unit(2, 0),
      unit(3, 0),
    ],
  })

  assert.equal(result.sheets.length, 1)
  assert.deepEqual(result.sheets[0].unitIds, ['1_0', '1_1', '3_0'])
  assert.deepEqual(result.sheets[0].layout, {
    columns: 3,
    rows: 1,
    tileAspectRatio: '16:9',
  })
  assert.deepEqual(result.isolatedUnitIds, ['2_0'])
})

test('balances large groups so no singleton scene sheet is created', () => {
  const scenes = Array.from({ length: 7 }, (_, index) => unit(index + 1))
  const result = planSceneSheets({
    scenePlan: {
      scenes: scenes.map(scene => planScene(scene.scene_number, 'shared-set')),
    },
    scenes,
  })

  assert.deepEqual(result.sheets.map(sheet => sheet.unitIds.length), [4, 3])
  assert.ok(result.sheets.every(sheet => sheet.unitIds.length >= 2))
})

test('uses explicit broader environment families only when opted in', () => {
  const args = {
    scenePlan: {
      scenes: [
        planScene(1, 'bank-lobby-before', { environment_family_id: 'bank-interior' }),
        planScene(2, 'bank-lobby-after', { environment_family_id: 'bank-interior' }),
        planScene(3, 'airport', { environment_family_id: 'airport' }),
      ],
    },
    scenes: [unit(1), unit(2), unit(3)],
  }

  const exactOnly = planSceneSheets(args)
  assert.deepEqual(exactOnly.isolatedUnitIds, ['1_0', '2_0', '3_0'])

  const withFamilies = planSceneSheets({ ...args, allowEnvironmentFamilies: true })
  assert.equal(withFamilies.sheets.length, 1)
  assert.equal(withFamilies.sheets[0].kind, 'environment-family')
  assert.deepEqual(withFamilies.sheets[0].unitIds, ['1_0', '2_0'])
  assert.deepEqual(withFamilies.isolatedUnitIds, ['3_0'])
})

test('orders character references by first appearance and preserves link order', () => {
  const result = planSceneSheets({
    scenePlan: {
      scenes: [planScene(1, 'road'), planScene(2, 'road'), planScene(3, 'road')],
    },
    scenes: [unit(1), unit(2), unit(3)],
    characters: [
      { id: 'alpha', name: 'Alpha', description: 'first character', image: 'alpha.png' },
      { id: 'beta', name: 'Beta', description: 'second character', image: 'beta.png' },
      { id: 'gamma', name: 'Gamma', description: 'third character', image: 'gamma.png' },
    ],
    characterSceneLinks: {
      1: { character_ids: ['beta', 'alpha'] },
      2: { character_ids: ['alpha', 'gamma'] },
      3: { character_ids: ['beta'] },
    },
  })

  assert.deepEqual(
    result.sheets[0].references.map(reference => reference.id),
    ['beta', 'alpha', 'gamma']
  )
  assert.deepEqual(
    result.sheets[0].references.map(reference => reference.order),
    [1, 2, 3]
  )
})

test('uses deterministic layouts for every supported tile count', () => {
  assert.deepEqual(layoutForCount(2), { columns: 2, rows: 1, tileAspectRatio: '16:9' })
  assert.deepEqual(layoutForCount(3), { columns: 3, rows: 1, tileAspectRatio: '16:9' })
  assert.deepEqual(layoutForCount(4), { columns: 2, rows: 2, tileAspectRatio: '16:9' })
  assert.deepEqual(layoutForCount(5), { columns: 3, rows: 2, tileAspectRatio: '16:9' })
  assert.deepEqual(layoutForCount(6), { columns: 3, rows: 2, tileAspectRatio: '16:9' })
  assert.throws(() => layoutForCount(1), /require 2-6 tiles/i)
})

test('master prompt contains world, ordered-reference, anatomy and panel contracts', () => {
  const result = planSceneSheets({
    scenePlan: {
      scenes: [planScene(1, 'vault'), planScene(2, 'vault')],
    },
    scenes: [unit(1, 0, 'Jorge enters the corridor'), unit(2, 0, 'Jorge opens the vault')],
    characters: [{
      id: 'jorge',
      name: 'Jorge',
      role: 'custodian',
      description: 'navy suit and swept black hair',
      image: 'jorge.png',
    }],
    characterSceneLinks: {
      1: { character_ids: ['jorge'] },
      2: { character_ids: ['jorge'] },
    },
  })
  const prompt = buildSceneSheetMasterPrompt(result.sheets[0])

  assert.match(prompt, /IMMUTABLE WORLD CONTRACT/)
  assert.match(prompt, /REFERENCE 1 — Jorge/)
  assert.match(prompt, /exactly five proportional fingers/i)
  assert.match(prompt, /mannequin material is only the visual surface/i)
  assert.match(prompt, /PANEL 01 — unit 1_0/)
  assert.match(prompt, /PANEL 02 — unit 2_0/)
  assert.match(prompt, /Jorge opens the vault/)
})

test('five-panel prompt keeps the unused sixth cell empty', () => {
  const scenes = Array.from({ length: 5 }, (_, index) => unit(index + 1))
  const result = planSceneSheets({
    scenePlan: { scenes: scenes.map(scene => planScene(scene.scene_number, 'shared-room')) },
    scenes,
  })
  assert.match(result.sheets[0].masterPrompt, /final 1 unused grid cell empty/i)
})

test('planning is deterministic and does not mutate source data', () => {
  const input = {
    scenePlan: {
      scenes: [planScene(2, 'same'), planScene(1, 'same')],
    },
    scenes: [unit(2, 1), unit(1, 0), unit(2, 0)],
    characters: [],
    characterSceneLinks: {},
  }
  const before = structuredClone(input)
  const first = planSceneSheets(input)
  const second = planSceneSheets(input)

  assert.deepEqual(input, before)
  assert.deepEqual(first, second)
  assert.deepEqual(first.sheets[0].unitIds, ['1_0', '2_0', '2_1'])
  assert.equal(first.sheets[0].id, 'sheet_scenario_same_1_1_0_2_1')
})
