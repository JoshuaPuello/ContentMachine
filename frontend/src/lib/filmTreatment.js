export const DEFAULT_FILM_TREATMENT = Object.freeze({
  filmGrainEnabled: true,
  filmGrainAmount: 0.32,
  atmosphericGradeEnabled: true,
  atmosphericGradeAmount: 0.42,
  vignetteEnabled: true,
  vignetteAmount: 0.70,
})

export const clampFilmAmount = (value, fallback = 0) => {
  const parsed = Number(value)
  return Number.isFinite(parsed)
    ? Math.min(1, Math.max(0, parsed))
    : fallback
}

/** Convert persisted UI settings into the renderer's normalized contract. */
export const effectiveFilmTreatment = (settings = {}) => ({
  grain: settings.filmGrainEnabled === false
    ? 0
    : clampFilmAmount(settings.filmGrainAmount, DEFAULT_FILM_TREATMENT.filmGrainAmount),
  atmosphere: (settings.atmosphericGradeEnabled
      ?? DEFAULT_FILM_TREATMENT.atmosphericGradeEnabled)
    ? clampFilmAmount(
        settings.atmosphericGradeAmount,
        DEFAULT_FILM_TREATMENT.atmosphericGradeAmount
      )
    : 0,
  vignette: settings.vignetteEnabled === false
    ? 0
    : clampFilmAmount(settings.vignetteAmount, DEFAULT_FILM_TREATMENT.vignetteAmount),
})
