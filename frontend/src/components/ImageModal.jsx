import { useEffect, useState, useMemo } from 'react'
import { motion } from 'framer-motion'

// history: array of { url, prompt } oldest-first (from imageHistory[key])
// image:   current/latest { url, prompt, error, loading }
// onSelect(url, prompt): called with the viewed version's data
// onRegenerate(prompt): called with the viewed version's prompt (or edited)
function ImageModal({
  image,
  history = [],
  onClose,
  onRegenerate,
  onEditWithAI,
  onApplyEdit,
  onSelect,
  onPrevious,
  onNext,
  positionLabel,
}) {
  // Build full version list: history + provider alternatives + current. Keep
  // the current selection last so the existing "latest" behavior is stable.
  const allVersions = useMemo(() => {
    const candidates = [
      ...history,
      ...(image?.alternatives || []).map(option => ({
        url: option.url,
        prompt: option.prompt || image?.prompt,
        ordinal: option.ordinal,
      })),
      ...(image?.url ? [{ url: image.url, prompt: image.prompt }] : []),
    ]
    const seen = new Set()
    const unique = []
    for (let index = candidates.length - 1; index >= 0; index -= 1) {
      const candidate = candidates[index]
      if (!candidate?.url || seen.has(candidate.url)) continue
      seen.add(candidate.url)
      unique.unshift(candidate)
    }
    return unique
  }, [history, image])

  // Start viewing the latest version
  const [viewIndex, setViewIndex] = useState(allVersions.length - 1)
  const [isEditing, setIsEditing] = useState(false)
  const [optionCount, setOptionCount] = useState(1)
  const [editMode, setEditMode] = useState('ai')
  const [generatedOptions, setGeneratedOptions] = useState([])
  const [generatedIndex, setGeneratedIndex] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [generationError, setGenerationError] = useState(null)

  const historicalViewed = allVersions[viewIndex] || { url: image?.url, prompt: image?.prompt }
  const viewed = generatedOptions[generatedIndex] || historicalViewed
  const [editedPrompt, setEditedPrompt] = useState(viewed?.prompt || '')

  // Keep editedPrompt in sync when navigating between versions
  useEffect(() => {
    setEditedPrompt(viewed?.prompt || '')
    setIsEditing(false)
  }, [viewIndex])

  // Always start at latest when modal opens
  useEffect(() => {
    setViewIndex(allVersions.length - 1)
    setGeneratedOptions([])
    setGeneratedIndex(0)
    setIsEditing(false)
  }, [allVersions.length, image?.url])

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
      const tag = e.target?.tagName
      const isInteractive = e.target?.isContentEditable
        || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'VIDEO'].includes(tag)
      if (isInteractive || isEditing || generatedOptions.length) return
      if (e.key === 'ArrowLeft' && onPrevious) {
        e.preventDefault()
        onPrevious()
      }
      if (e.key === 'ArrowRight' && onNext) {
        e.preventDefault()
        onNext()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, onPrevious, onNext, isEditing, generatedOptions.length])

  const handleSelect = () => {
    if (generatedOptions.length && onApplyEdit) {
      onApplyEdit(viewed)
      onClose()
      return
    }
    onSelect(viewed?.url, viewed?.prompt)
    onClose()
  }

  const handleRegenerate = async () => {
    if (isEditing && editMode === 'ai' && onEditWithAI) {
      setGenerating(true)
      setGenerationError(null)
      try {
        const options = await onEditWithAI(editedPrompt, optionCount)
        if (!options?.length) throw new Error('No edited image options were returned')
        setGeneratedOptions(options)
        setGeneratedIndex(0)
        setIsEditing(false)
      } catch (error) {
        setGenerationError(error.message)
      } finally {
        setGenerating(false)
      }
      return
    }
    onRegenerate(isEditing ? editedPrompt : viewed?.prompt || null)
    setIsEditing(false)
    onClose()
  }

  const isLatest  = viewIndex === allVersions.length - 1
  const isOldest  = viewIndex === 0
  const total     = allVersions.length
  const versionLabel = total > 1
    ? `Version ${viewIndex + 1} of ${total}${isLatest ? ' (latest)' : ''}`
    : null

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50"
        onClick={onClose}
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.15 }}
        className="fixed inset-0 z-50 flex items-center justify-center p-8"
        onClick={onClose}
      >
        {onPrevious && !isEditing && !generatedOptions.length && (
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onPrevious() }}
            aria-label="Previous image"
            title="Previous image (Left arrow)"
            className="fixed left-4 md:left-7 top-1/2 -translate-y-1/2 z-[60] w-12 h-12 rounded-full border border-white/20 bg-black/65 backdrop-blur-md text-white flex items-center justify-center hover:bg-black/85 hover:border-white/40 transition-all shadow-xl"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
        {onNext && !isEditing && !generatedOptions.length && (
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); onNext() }}
            aria-label="Next image"
            title="Next image (Right arrow)"
            className="fixed right-4 md:right-7 top-1/2 -translate-y-1/2 z-[60] w-12 h-12 rounded-full border border-white/20 bg-black/65 backdrop-blur-md text-white flex items-center justify-center hover:bg-black/85 hover:border-white/40 transition-all shadow-xl"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
        <div
          className="bg-surface border border-border rounded-xl overflow-hidden max-w-4xl max-h-[90vh] flex flex-col shadow-2xl"
          onClick={e => e.stopPropagation()}
        >
          {/* Image with navigation arrows */}
          <div className="relative bg-black flex-shrink-0">
            {viewed?.url && (
              <img src={viewed.url} alt="" className="max-w-full max-h-[65vh] object-contain mx-auto block" />
            )}

            {/* Left arrow */}
            {!generatedOptions.length && total > 1 && !isOldest && (
              <button
                onClick={() => setViewIndex(i => i - 1)}
                className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 bg-black/60 hover:bg-black/80 rounded-full flex items-center justify-center text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            )}

            {/* Right arrow */}
            {!generatedOptions.length && total > 1 && !isLatest && (
              <button
                onClick={() => setViewIndex(i => i + 1)}
                className="absolute right-12 top-1/2 -translate-y-1/2 w-9 h-9 bg-black/60 hover:bg-black/80 rounded-full flex items-center justify-center text-white transition-colors"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
              </button>
            )}

            {/* Version badge */}
            {!generatedOptions.length && versionLabel && (
              <div className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-black/60 backdrop-blur-sm text-white text-[10px] px-2 py-1 rounded-full">
                {versionLabel}
              </div>
            )}

            <button
              onClick={onClose}
              className="absolute top-3 right-3 w-8 h-8 bg-black/50 rounded-full flex items-center justify-center text-white hover:bg-black/70 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Info & actions */}
          <div className="p-4 border-t border-border flex-shrink-0">
            {positionLabel && (
              <p className="text-[10px] uppercase tracking-[0.16em] text-text-disabled mb-2">
                {positionLabel}
              </p>
            )}
            {generatedOptions.length ? (
              <div>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div>
                    <p className="text-sm font-semibold text-text-primary">Choose the edit to keep</p>
                    <p className="text-[10px] text-text-disabled mt-0.5">Nothing changes until you save this selection.</p>
                  </div>
                  <span className="text-[10px] text-text-secondary">Option {generatedIndex + 1} of {generatedOptions.length}</span>
                </div>
                <div className="flex gap-2 mb-4">
                  {generatedOptions.map((option, index) => (
                    <button
                      key={`${option.url}-${index}`}
                      type="button"
                      onClick={() => setGeneratedIndex(index)}
                      className={`w-20 h-14 rounded-lg overflow-hidden border-2 ${generatedIndex === index ? 'border-accent' : 'border-border'}`}
                    >
                      <img src={option.url} alt={`Edited option ${index + 1}`} className="w-full h-full object-cover" />
                    </button>
                  ))}
                </div>
                <div className="flex gap-2">
                  <button onClick={handleSelect} className="btn-primary py-2 px-4 text-sm">Save selected edit</button>
                  <button
                    onClick={() => {
                      setGeneratedOptions([])
                      setIsEditing(true)
                      setEditMode('ai')
                    }}
                    className="btn-secondary py-2 px-4 text-sm"
                  >
                    Try another edit
                  </button>
                  <button onClick={onClose} className="btn-ghost py-2 px-4 text-sm">Cancel</button>
                </div>
              </div>
            ) : isEditing ? (
              <div className="space-y-3">
                <textarea
                  value={editedPrompt}
                  onChange={(e) => setEditedPrompt(e.target.value)}
                  className="w-full h-28 text-xs font-mono resize-none"
                  placeholder={editMode === 'ai' ? 'Describe only what should change in this existing image...' : 'Rewrite the complete generation prompt...'}
                  autoFocus
                />
                <div className="flex items-center justify-between gap-3">
                  <div className="flex rounded-lg border border-border overflow-hidden">
                    <button type="button" onClick={() => setEditMode('ai')} className={`px-3 py-1.5 text-xs ${editMode === 'ai' ? 'bg-accent/15 text-accent' : 'text-text-secondary'}`}>Edit existing</button>
                    <button type="button" onClick={() => setEditMode('regenerate')} className={`px-3 py-1.5 text-xs ${editMode === 'regenerate' ? 'bg-accent/15 text-accent' : 'text-text-secondary'}`}>Regenerate</button>
                  </div>
                  {editMode === 'ai' && (
                    <label className="text-xs text-text-secondary flex items-center gap-2">
                      Options
                      <select value={optionCount} onChange={event => setOptionCount(Number(event.target.value))} className="text-xs py-1">
                        <option value={1}>1</option>
                        <option value={2}>2</option>
                      </select>
                    </label>
                  )}
                </div>
                <div className="flex gap-2">
                  <button onClick={handleRegenerate} disabled={generating || !editedPrompt.trim()} className="btn-primary py-2 px-4 text-sm disabled:opacity-40">
                    {generating ? 'Generating options…' : editMode === 'ai' ? 'Generate edit options' : 'Regenerate'}
                  </button>
                  <button onClick={() => setIsEditing(false)} className="btn-ghost py-2 px-4 text-sm">
                    Cancel
                  </button>
                </div>
                {generationError && <p className="text-xs text-error">{generationError}</p>}
              </div>
            ) : (
              <>
                <p className="text-xs text-text-secondary font-mono mb-4 whitespace-pre-wrap leading-relaxed max-h-24 overflow-y-auto">
                  {viewed?.prompt}
                </p>
                <div className="flex gap-2 flex-wrap">
                  {viewed?.url && (
                    <button onClick={handleSelect} className="btn-primary py-2 px-4 text-sm">
                      {isLatest ? 'Select this image' : `Use version ${viewIndex + 1}`}
                    </button>
                  )}
                  <button onClick={() => { setIsEditing(true); setEditMode('ai'); setEditedPrompt('') }} className="btn-secondary py-2 px-4 text-sm">
                    Edit with AI
                  </button>
                  <button onClick={handleRegenerate} className="btn-ghost py-2 px-4 text-sm">
                    Regenerate
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </motion.div>
    </>
  )
}

export default ImageModal
