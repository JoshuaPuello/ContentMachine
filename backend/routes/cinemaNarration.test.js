import test from 'node:test'
import assert from 'node:assert/strict'
import { buildNarrationSequence, normalizeCinemaNarration } from './claude.js'

const scenePlan = { scenes: Array.from({ length: 5 }, (_, index) => ({ scene_number: index + 1 })) }
const unit = (text, duration = 4) => ({ duration, lines: [text] })

test('cinematic narration sequence follows final playback order', () => {
  const cinema = normalizeCinemaNarration({
    trailer: {
      target_seconds: 10,
      candidate_scenes: [1, 3, 5, 2],
      narration: unit('The earth closes. One stranger answers.', 10),
    },
    chapters: [
      { title: 'Below', start_scene: 1, portrait_prompt: 'portrait one', overview_narration: unit('Below.'), transition_narration: unit('First, find them.') },
      { title: 'The Driller', start_scene: 3, portrait_prompt: 'portrait two', overview_narration: unit('The Driller.'), transition_narration: unit('Then a stranger arrives.') },
      { title: 'Camp Hope', start_scene: 5, portrait_prompt: 'portrait three', overview_narration: unit('Camp Hope.'), transition_narration: unit('Above them, hope waits.') },
    ],
  }, scenePlan, { trailerEnabled: true, chaptersEnabled: true })

  const scenes = scenePlan.scenes.map(scene => ({ scene_id: `s0${scene.scene_number}`, lines: [`Scene ${scene.scene_number}.`] }))
  const sequence = buildNarrationSequence(scenes, cinema)
  assert.deepEqual(sequence.map(item => item.unit_id), [
    'cinema:trailer',
    'cinema:overview:1', 'cinema:overview:2', 'cinema:overview:3',
    'cinema:transition:1',
    's01', 's02',
    'cinema:transition:2', 's03', 's04',
    'cinema:transition:3', 's05',
  ])
})

test('disabled cinema options preserve a scene-only sequence', () => {
  const cinema = normalizeCinemaNarration({}, scenePlan, { trailerEnabled: false, chaptersEnabled: false })
  const scenes = [{ scene_id: 's01', lines: ['One.'] }, { scene_id: 's02', lines: ['Two.'] }]
  assert.deepEqual(buildNarrationSequence(scenes, cinema).map(item => item.unit_id), ['s01', 's02'])
})

test('chapter ids are assigned after sorting and incomplete chapters are rejected', () => {
  const cinema = normalizeCinemaNarration({
    chapters: [
      { title: 'Later', start_scene: 4, portrait_prompt: 'later portrait', overview_narration: unit('Later.'), transition_narration: unit('Move later.') },
      { title: 'Broken', start_scene: 2, portrait_prompt: 'broken portrait', overview_narration: unit('Broken.'), transition_narration: { lines: [] } },
      { title: 'First', start_scene: 1, portrait_prompt: 'first portrait', overview_narration: unit('First.'), transition_narration: unit('Begin.') },
    ],
  }, scenePlan, { trailerEnabled: false, chaptersEnabled: true })

  assert.deepEqual(cinema.chapters.map(chapter => ({
    number: chapter.chapter_number,
    start: chapter.start_scene,
    overview: chapter.overview_narration.unit_id,
    transition: chapter.transition_narration.unit_id,
  })), [
    { number: 1, start: 1, overview: 'cinema:overview:1', transition: 'cinema:transition:1' },
    { number: 2, start: 4, overview: 'cinema:overview:2', transition: 'cinema:transition:2' },
  ])
})
