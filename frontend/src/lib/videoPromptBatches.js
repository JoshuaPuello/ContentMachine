const unitKey = (unit) => `${unit.scene_number}_${unit.segment_index ?? 0}`

export function missingSelectedImageUnits(units, selectedImages) {
  return (units || [])
    .map(unitKey)
    .filter(key => !selectedImages?.[key]?.prompt)
}

export function missingAuthoredPromptUnits(units, prompts) {
  const authored = new Set((prompts || []).map(unitKey))
  return (units || []).map(unitKey).filter(key => !authored.has(key))
}

export function videoPromptFailureMessage(batches, missingUnits = []) {
  const failed = (batches || []).filter(batch => batch.status === 'failed')
  const details = failed.slice(0, 3).map(batch => {
    const label = `batch ${batch.batchIndex + 1}`
    return batch.error ? `${label}: ${batch.error}` : `${label}: no prompts returned`
  })
  const suffix = failed.length > 3 ? ` (+${failed.length - 3} more batches)` : ''
  const missing = missingUnits.length > 0
    ? ` Missing shot${missingUnits.length === 1 ? '' : 's'}: ${missingUnits.join(', ')}.`
    : ''
  return `Video prompt generation did not complete${details.length ? ` — ${details.join(' | ')}${suffix}` : '.'}${missing}`
}
