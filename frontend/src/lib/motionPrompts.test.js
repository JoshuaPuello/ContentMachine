import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildContinuityContext,
  derivePreviousEndingState,
  preserveProtectedMotionPrompt,
  splitNarrationAcrossSegments,
} from './motionPrompts.js'

test('splits narration by segment duration without losing or duplicating words', () => {
  const source = 'The driller reaches the runway. He sees the aircraft turn. Then the shelling starts and everyone runs.'
  const parts = splitNarrationAcrossSegments(source, [6, 10])
  assert.equal(parts.length, 2)
  assert.equal(parts.join(' '), source)
  assert.match(parts[0], /\.$/)
})

test('keeps single segment narration unchanged', () => {
  assert.deepEqual(splitNarrationAcrossSegments('No hesitation.', [10]), ['No hesitation.'])
})

test('marks later segments as advancing rather than restarting', () => {
  const context = buildContinuityContext({
    previousUnit: { scene_number: 3, scene_description: 'The drill begins to turn.' },
    currentUnit: { scene_number: 3, segment_index: 1, segment_count: 2 },
    previousSelectedPrompt: 'One porcelain driller holds a wrench beside the engine.',
    previousEndingState: 'The wrench rests against the engine fitting.',
  })
  assert.match(context, /advance the same scene action rather than restarting/i)
  assert.match(context, /Previous selected frame: One porcelain driller/i)
  assert.match(context, /Previous authored ending: The wrench rests/i)
})

test('derives a stable first-run handoff before authored endings exist', () => {
  const ending = derivePreviousEndingState({
    previousUnit: { scene_number: 3 },
    previousSelectedPrompt: 'One porcelain driller holds a wrench beside the engine.',
  })
  assert.match(ending, /preceding clip completes its restrained action/i)
  assert.match(ending, /porcelain driller holds a wrench/i)
  assert.match(ending, /stable hold without changing figure count, wardrobe, props, or visual style/i)
})

test('prompt edits can change creative motion but cannot erase protected locks', () => {
  const original = 'SOURCE FRAME LOCK:\nimmutable\nCHARACTER / STYLE LOCK:\nporcelain\nWARDROBE LOCK:\norange\nOBJECT LOCK:\nwrench\nSCENE INTENT:\nold action\nCAMERA:\nslow push\nSTORYBOARD / SHOT LIST — 00:00–00:06:\nold beats\nENDING STATE:\nold hold\nSTABILITY / NEGATIVE CONSTRAINTS:\nno morphing'
  const edited = 'SOURCE FRAME LOCK:\nDELETED\nSCENE INTENT:\nnew restrained action\nCAMERA:\nnear locked\nSTORYBOARD / SHOT LIST — 00:00–00:06:\nnew beats\nENDING STATE:\nnew stable hold\nSTABILITY / NEGATIVE CONSTRAINTS:\nDELETED'
  const merged = preserveProtectedMotionPrompt(original, edited)
  assert.match(merged, /SOURCE FRAME LOCK:\nimmutable/)
  assert.match(merged, /CHARACTER \/ STYLE LOCK:\nporcelain/)
  assert.match(merged, /SCENE INTENT:\nnew restrained action/)
  assert.match(merged, /STABILITY \/ NEGATIVE CONSTRAINTS:\nno morphing/)
  assert.doesNotMatch(merged, /DELETED/)
})
