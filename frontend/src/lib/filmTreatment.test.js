import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_FILM_TREATMENT,
  clampFilmAmount,
  effectiveFilmTreatment,
} from './filmTreatment.js'

test('film-treatment intensities are clamped and disabled layers resolve to zero', () => {
  assert.equal(clampFilmAmount(2), 1)
  assert.equal(clampFilmAmount(-1), 0)
  assert.deepEqual(effectiveFilmTreatment({
    filmGrainEnabled: false,
    filmGrainAmount: 0.9,
    atmosphericGradeEnabled: true,
    atmosphericGradeAmount: 1.4,
    vignetteEnabled: false,
  }), {
    grain: 0,
    atmosphere: 1,
    vignette: 0,
  })
})

test('new projects use the selected balanced cinema finish by default', () => {
  const treatment = effectiveFilmTreatment(DEFAULT_FILM_TREATMENT)
  assert.equal(treatment.grain, 0.32)
  assert.equal(treatment.atmosphere, 0.42)
  assert.equal(treatment.vignette, 0.70)
})
