import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { usePipelineStore } from '../store/pipelineStore'
import ImageCard from '../components/ImageCard'
import ImageModal from '../components/ImageModal'
import ExportModal from '../components/ExportModal'
import {
  areAllSelectableImageUnitsSelected,
  selectableImageUnitCount,
} from '../lib/imageSelection'
import toast from 'react-hot-toast'

// Derive human-readable duration range from the selected video model
const getDurationHint = (videoModel) => {
  if (videoModel === 'lightricks/ltx-2-fast')        return '6–20s (even steps)'
  if (videoModel === 'kwaivgi/kling-v3-video')        return '3–15s'
  if (videoModel === 'kwaivgi/kling-v2.5-turbo-pro') return '5s or 10s'
  return '6s / 8s / 10s'  // LTX-2 Pro default
}

// Animated terminal that streams the scene plan JSON as it arrives
function LivePlanningTerminal({ scenePlan, phase, settings = {}, imageBatches = [], onRetryBatch }) {
  const [displayedLines, setDisplayedLines] = useState([])
  const [cursor, setCursor] = useState(true)
  const termRef = useRef(null)

  const imageModelLabel = settings.imageModel?.split('/').pop() || 'flux-pro'
  const videoModelLabel = settings.videoModel?.split('/').pop() || 'ltx-2-pro'
  const aspect = settings.aspectRatio || '16:9'
  const durationHint = getDurationHint(settings.videoModel)

  const phaseLines = {
    scenePlan: [
      '> Analyzing narrative structure...',
      '> Calculating optimal scene count...',
      '> Applying SMART pacing algorithm...',
      `> Assigning durations (${durationHint})...`,
      `> Video model: ${videoModelLabel}  |  Aspect ratio: ${aspect}`,
      '> Writing visual descriptions...',
      '> Configuring mannequin details...',
      '> Building environment specs...',
    ],
    images: [
      '> Scene plan complete ✓',
      `> Image model: ${imageModelLabel}  |  Aspect ratio: ${aspect}`,
      '> Generating image prompt variations...',
      '> Applying cinematography vocabulary...',
      '> Mapping continuity requirements...',
      '> Dispatching to image generation API...',
    ]
  }

  const lines = phaseLines[phase] || phaseLines.scenePlan

  useEffect(() => {
    setDisplayedLines([])
    let i = 0
    const interval = setInterval(() => {
      if (lines && i < lines.length) {
        const nextLine = lines[i]
        if (nextLine) setDisplayedLines(prev => [...prev, nextLine])
        i++
      } else {
        clearInterval(interval)
      }
    }, 600)
    return () => clearInterval(interval)
  }, [phase])

  // Blink cursor
  useEffect(() => {
    const t = setInterval(() => setCursor(c => !c), 530)
    return () => clearInterval(t)
  }, [])

  // Show scene plan JSON lines once available
  const jsonLines = scenePlan ? JSON.stringify(scenePlan, null, 2).split('\n').slice(0, 22) : []

  // Only scroll when content count changes — not on cursor blink
  const prevLineCount = useRef(0)
  useEffect(() => {
    const currentCount = displayedLines.length + jsonLines.length + imageBatches.length
    if (currentCount !== prevLineCount.current && termRef.current) {
      termRef.current.scrollTop = termRef.current.scrollHeight
      prevLineCount.current = currentCount
    }
  }, [displayedLines.length, jsonLines.length, imageBatches.length])

  const batchStatusIcon = (status) =>
    status === 'done' ? '✓' : status === 'failed' ? '✗' : status === 'running' ? '▶' : '○'
  const batchStatusColor = (status) =>
    status === 'done' ? 'text-green-400' : status === 'failed' ? 'text-red-400' : status === 'running' ? 'text-yellow-300' : 'text-slate-500'

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="rounded-xl overflow-hidden border border-border shadow-2xl">
        {/* Title bar */}
        <div className="bg-surface-raised px-4 py-2.5 flex items-center gap-2 border-b border-border">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-error/70" />
            <div className="w-3 h-3 rounded-full bg-warning/70" />
            <div className="w-3 h-3 rounded-full bg-success/70" />
          </div>
          <span className="text-xs text-text-disabled font-mono ml-2">pipeline — scene-planner</span>
          {phase === 'images' && (
            <span className="ml-auto text-xs text-text-disabled font-mono">{imageModelLabel} · {aspect}</span>
          )}
        </div>

        {/* Terminal body */}
        <div
          ref={termRef}
          className="bg-[#0d1117] p-4 h-72 overflow-y-auto font-mono text-xs leading-relaxed"
        >
          {displayedLines.filter(Boolean).map((line, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.2 }}
              className={line.includes('✓') ? 'text-green-400' : 'text-emerald-300'}
            >
              {line}
            </motion.div>
          ))}

          {jsonLines.length > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-2">
              <div className="text-blue-400 mb-1">&gt; Scene plan received:</div>
              {jsonLines.filter(Boolean).map((line, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.04 }}
                  className="text-slate-400"
                >
                  {line.includes('"scene_id"') || line.includes('"duration_seconds"')
                    ? <span className="text-yellow-300">{line}</span>
                    : line.includes('"visual_description"') || line.includes('"shot_type"')
                    ? <span className="text-purple-300">{line}</span>
                    : line}
                </motion.div>
              ))}
              {jsonLines.length === 22 && <div className="text-slate-500">  ...</div>}
            </motion.div>
          )}

          {/* Batch progress */}
          {imageBatches.length > 0 && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-2">
              <div className="text-blue-400 mb-1">&gt; Generating image prompts in batches:</div>
              {imageBatches.map(b => (
                <div key={b.batchIndex} className="flex items-center gap-2">
                  <span className={batchStatusColor(b.status)}>
                    {batchStatusIcon(b.status)} Batch {b.batchIndex + 1}/{imageBatches.length} — scenes {b.sceneNumbers[0]}–{b.sceneNumbers[b.sceneNumbers.length - 1]}
                  </span>
                  {b.status === 'failed' && onRetryBatch && (
                    <button
                      onClick={() => onRetryBatch(b.batchIndex)}
                      className="text-[10px] px-1.5 py-0.5 rounded bg-error/20 text-red-400 hover:bg-error/40 transition-colors"
                    >
                      retry
                    </button>
                  )}
                </div>
              ))}
            </motion.div>
          )}

          <span className="text-emerald-400">{cursor ? '█' : ' '}</span>
        </div>
      </div>
    </div>
  )
}

const SCENES_PER_PAGE = 80

function SceneImages() {
  const navigate = useNavigate()
  const [selectedModal, setSelectedModal] = useState(null)
  const [regeneratingAll, setRegeneratingAll] = useState(false)
  const [currentPage, setCurrentPage] = useState(0)
  const [showExportModal, setShowExportModal] = useState(false)
  const [characterEditor, setCharacterEditor] = useState(null)
  const allImagesCompleteToastedRef = useRef(false)
  const autoStartRef = useRef(false)

  const {
    selectedStory,
    scenePlan,
    scenePlanLoading,
    scenePlanError,
    scenes,
    audio,
    images,
    imageHistory,
    selectedImages,
    imagesLoading,
    imagesError,
    generationState,
    generationPhase,
    imageProgress,
    imageBatches,
    settings,
    characters,
    characterSceneLinks,
    characterAudit,
    characterStatus,
    characterError,
    prepareCharacters,
    regenerateCharacter,
    selectCharacterOption,
    approveCharacters,
    setSceneCharacters,
    selectImage,
    selectAllImages,
    deselectAllImages,
    regenerateImage,
    editSceneImageWithAi,
    applySceneImageEdit,
    resumeImageGeneration,
    stopGeneration,
    retryScenePlan,
    retryImagePrompts,
    retryImageBatch,
    fetchScenePlan,
    regenerateAllImages,
  } = usePipelineStore()

  // scenes = one entry per (scene, segment) unit; selection is per unit
  const completedCount = scenes.filter(scene => (
    selectedImages[`${scene.scene_number}_${scene.segment_index ?? 0}`]?.url
  )).length
  const totalUnitCount = scenes.length
  const allSelected = completedCount === totalUnitCount && totalUnitCount > 0
  const selectableUnitCount = selectableImageUnitCount(scenes, images)
  const allAvailableSelected = areAllSelectableImageUnitsSelected(scenes, images, selectedImages)

  const imagesCompleteCount = Object.values(images).filter(img => img?.url && !img?.error).length
  const imagesTotalCount = scenes.reduce((sum, s) => sum + (s.prompts?.length ?? 0), 0)
  const allImagesComplete = imagesTotalCount > 0 && imagesCompleteCount === imagesTotalCount

  // Redirect to home if no story selected — must be in useEffect, not render body,
  // to avoid calling navigate() during React 18 concurrent render
  useEffect(() => {
    if (!selectedStory) navigate('/')
  }, [selectedStory, navigate])

  // Audio-first flow: arriving here with a scene plan but no image prompts yet
  // means the audio step just finished — start the image pipeline automatically
  useEffect(() => {
    if (autoStartRef.current) return
    if (selectedStory && scenePlan && scenes.length === 0 && !scenePlanLoading
        && characterStatus === 'ready'
        && generationState !== 'running' && !imagesError && !scenePlanError) {
      autoStartRef.current = true
      retryImagePrompts()
    }
  }, [selectedStory, scenePlan, scenes.length, scenePlanLoading, characterStatus, generationState, imagesError, scenePlanError])

  useEffect(() => {
    if (selectedStory && scenePlan?.scenes?.length && characterStatus === 'idle') {
      prepareCharacters().catch(error => toast.error(`Character preparation failed: ${error.message}`))
    }
  }, [selectedStory, scenePlan, characterStatus, prepareCharacters])

  // Toast on error states
  useEffect(() => {
    if (scenePlanError) {
      toast.error(`Scene planning failed: ${scenePlanError}`, { id: 'scene-plan-error', duration: 6000 })
    }
  }, [scenePlanError])

  useEffect(() => {
    if (imagesError) {
      toast.error(`Image generation failed: ${imagesError}`, { id: 'images-error', duration: 6000 })
    }
  }, [imagesError])

  // Toast when all images complete — only on the false→true transition,
  // not on every remount (ref survives re-renders but resets on unmount/mount)
  useEffect(() => {
    if (allImagesComplete && !allImagesCompleteToastedRef.current) {
      allImagesCompleteToastedRef.current = true
      toast.success('All images generated!', { id: 'images-done' })
    }
    if (!allImagesComplete) {
      allImagesCompleteToastedRef.current = false
    }
  }, [allImagesComplete])

  // Pagination — only active when scenes exceed threshold
  const totalPages = Math.ceil(scenes.length / SCENES_PER_PAGE)
  const isPaginated = scenes.length > 80
  const visibleScenes = isPaginated
    ? scenes.slice(currentPage * SCENES_PER_PAGE, (currentPage + 1) * SCENES_PER_PAGE)
    : scenes

  // Group per-segment units under their parent scene for display
  const groupedScenes = (() => {
    const map = new Map()
    visibleScenes.forEach(unit => {
      if (!map.has(unit.scene_number)) map.set(unit.scene_number, [])
      map.get(unit.scene_number).push(unit)
    })
    return [...map.entries()].map(([sceneNumber, units]) => ({
      sceneNumber,
      units: units.sort((a, b) => (a.segment_index ?? 0) - (b.segment_index ?? 0))
    }))
  })()

  // Reset to page 0 when a new generation run starts (first scene number changes)
  const firstSceneNumber = scenes[0]?.scene_number ?? 0
  useEffect(() => {
    setCurrentPage(0)
  }, [firstSceneNumber])

  const pageVariants = {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 }
  }

  // Guard: while selectedStory is null the useEffect above will redirect;
  // render nothing in the meantime to avoid downstream crashes
  if (!selectedStory) return null

  if (characterStatus !== 'ready' && scenes.length === 0) {
    const busy = ['extracting', 'generating', 'linking'].includes(characterStatus)
    return (
      <motion.div variants={pageVariants} initial="initial" animate="animate" exit="exit" className="min-h-[calc(100vh-3.5rem)] p-8">
        <div className="max-w-5xl mx-auto">
          <div className="mb-7">
            <p className="text-[10px] uppercase tracking-[0.2em] text-accent mb-2">Character continuity</p>
            <h1 className="text-2xl font-semibold text-text-primary">Approve the recurring cast</h1>
            <p className="text-sm text-text-secondary mt-2 max-w-2xl leading-relaxed">
              Sonnet extracts recurring characters from the completed story, the configured image model creates their reference portraits, and scene generation waits for your approval.
            </p>
          </div>

          {busy && (
            <div className="card p-8 flex items-center gap-4 mb-6">
              <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {characterStatus === 'extracting' ? 'Sonnet is extracting the cast…' : characterStatus === 'generating' ? 'Generating character references…' : 'Sonnet is linking characters to scenes…'}
                </p>
                <p className="text-xs text-text-disabled mt-1">Scene images will not start until this continuity pass is complete.</p>
              </div>
            </div>
          )}

          {characterError && (
            <div className="mb-5 p-4 rounded-xl border border-error/30 bg-error/10">
              <p className="text-sm text-error">{characterError}</p>
              <button onClick={() => prepareCharacters()} className="btn-secondary mt-3 text-xs px-3 py-1.5">Retry character preparation</button>
            </div>
          )}

          {characterAudit && (
            <div className="mb-5 rounded-xl border border-border bg-surface/60 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <p className="text-xs font-medium text-text-primary">
                  Cast audit: {characterAudit.included_count ?? characters.length} recurring identit{(characterAudit.included_count ?? characters.length) === 1 ? 'y' : 'ies'}
                </p>
                {(characterAudit.excluded || []).length > 0 && (
                  <span className="text-[10px] uppercase tracking-wider text-text-disabled">
                    {characterAudit.excluded.length} scene-local candidate{characterAudit.excluded.length === 1 ? '' : 's'} excluded
                  </span>
                )}
              </div>
              {characterAudit.coverage_notes && (
                <p className="text-[11px] text-text-secondary mt-1 leading-relaxed">{characterAudit.coverage_notes}</p>
              )}
              {(characterAudit.excluded || []).length > 0 && (
                <details className="mt-2">
                  <summary className="text-[10px] text-accent cursor-pointer select-none">Review excluded scene-local roles</summary>
                  <div className="mt-2 space-y-1.5">
                    {characterAudit.excluded.map((candidate, index) => (
                      <p key={`${candidate.name}-${index}`} className="text-[10px] text-text-disabled">
                        <span className="text-text-secondary">{candidate.name}</span> — {candidate.reason}
                      </p>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}

          {characters.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {characters.map(character => (
                <div key={character.id} className="card overflow-hidden">
                  <div className="aspect-[3/4] bg-black/40 relative">
                    {character.image
                      ? <img src={character.image} alt={character.name} className="w-full h-full object-cover" />
                      : <div className="w-full h-full flex items-center justify-center text-xs text-text-disabled">{character.generating ? 'Generating…' : 'No image'}</div>}
                    {character.generating && <div className="absolute inset-0 bg-black/55 flex items-center justify-center"><div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" /></div>}
                  </div>
                  <div className="p-4">
                    <div className="flex justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-semibold text-text-primary">{character.name}</h3>
                        <p className="text-[10px] uppercase tracking-wider text-accent mt-0.5">{character.role}</p>
                      </div>
                      <span className="text-[9px] text-text-disabled">{character.importance}</span>
                    </div>
                    <p className="text-xs text-text-secondary leading-relaxed mt-3 line-clamp-4">{character.description}</p>
                    {character.error && <p className="text-[10px] text-error mt-2">{character.error}</p>}
                    {(character.image_options || []).length > 1 && (
                      <div className="flex gap-2 mt-3">
                        {character.image_options.map((option, index) => (
                          <button key={index} onClick={() => selectCharacterOption(character.id, option)} className={`w-12 h-14 overflow-hidden rounded border ${character.image === option.url ? 'border-accent' : 'border-border'}`}>
                            <img src={option.url} alt={`Option ${index + 1}`} className="w-full h-full object-cover" />
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="grid grid-cols-2 gap-2 mt-4">
                      <button
                        onClick={() => regenerateCharacter(character.id, character.visual_prompt, 1, false)
                          .catch(error => toast.error(error.message))}
                        disabled={character.generating}
                        className="btn-secondary py-2 text-xs disabled:opacity-40"
                        title="Create a fresh reference from the canonical mannequin identity prompt"
                      >
                        {character.generating ? 'Generating…' : 'Regenerate'}
                      </button>
                      <button
                        onClick={() => setCharacterEditor({ character, prompt: '', count: 1 })}
                        disabled={character.generating || !character.image}
                        className="btn-secondary py-2 text-xs disabled:opacity-40"
                      >
                        Edit with AI
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {characterStatus === 'review' && (
            <div className="sticky bottom-4 mt-7 p-4 rounded-xl border border-accent/35 bg-surface/95 backdrop-blur flex items-center justify-between gap-4 shadow-2xl">
              <div>
                <p className="text-sm font-semibold text-text-primary">Do these references look consistent?</p>
                <p className="text-xs text-text-disabled mt-0.5">Approval runs the Sonnet scene-link pass, then image prompts begin.</p>
              </div>
              <button onClick={() => approveCharacters().catch(error => toast.error(error.message))} disabled={characters.some(character => !character.image)} className="btn-primary px-5 py-2.5 text-sm disabled:opacity-40">
                Approve cast & continue
              </button>
            </div>
          )}

          {characterEditor && (
            <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-6" onClick={() => setCharacterEditor(null)}>
              <div className="card p-5 w-full max-w-lg" onClick={event => event.stopPropagation()}>
                <h2 className="text-base font-semibold text-text-primary">Edit {characterEditor.character.name} with AI</h2>
                <p className="text-xs text-text-secondary mt-1">The current image is supplied as the first reference; describe only the change.</p>
                <textarea value={characterEditor.prompt} onChange={event => setCharacterEditor(current => ({ ...current, prompt: event.target.value }))} className="w-full h-28 mt-4 text-sm" placeholder="Keep the same identity and pose, but change…" autoFocus />
                <div className="flex items-center justify-between mt-4">
                  <label className="text-xs text-text-secondary">Options <select value={characterEditor.count} onChange={event => setCharacterEditor(current => ({ ...current, count: Number(event.target.value) }))} className="ml-2 text-xs"><option value={1}>1</option><option value={2}>2</option></select></label>
                  <div className="flex gap-2">
                    <button onClick={() => setCharacterEditor(null)} className="btn-ghost px-3 py-2 text-xs">Cancel</button>
                    <button onClick={async () => {
                      try {
                        await regenerateCharacter(characterEditor.character.id, characterEditor.prompt, characterEditor.count, true)
                        setCharacterEditor(null)
                      } catch (error) { toast.error(error.message) }
                    }} disabled={!characterEditor.prompt.trim()} className="btn-primary px-4 py-2 text-xs disabled:opacity-40">Generate</button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </motion.div>
    )
  }

  // ── Scene planning loading screen ──────────────────────────────────────────
  // Don't show loading screen when paused — the main grid has the Resume button.
  // Also escape if all image batches finished (done/failed) but scenes is still empty
  // (every batch failed silently without setting imagesError) — prevents infinite lock.
  const allBatchesSettled = imageBatches.length > 0 &&
    imageBatches.every(b => b.status === 'done' || b.status === 'failed')
  if (scenePlanLoading || (!allBatchesSettled && scenes.length === 0 && !scenePlanError && !imagesError && generationState !== 'idle' && generationState !== 'stopped' && generationState !== 'paused')) {
    return (
      <motion.div
        variants={pageVariants} initial="initial" animate="animate" exit="exit"
        transition={{ duration: 0.25 }}
        className="min-h-[calc(100vh-3.5rem)] flex flex-col items-center justify-center p-8 gap-8"
      >
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
            <span className="text-lg font-medium text-text-primary">Planning your documentary</span>
          </div>
          <p className="text-sm text-text-secondary">{selectedStory.title}</p>
        </div>

        <LivePlanningTerminal
          scenePlan={scenePlan}
          phase={generationPhase === 'images' ? 'images' : 'scenePlan'}
          settings={settings}
          imageBatches={imageBatches || []}
          onRetryBatch={async (batchIndex) => {
            try {
              await retryImageBatch(batchIndex)
            } catch (err) {
              toast.error(`Batch retry failed: ${err.message}`, { duration: 5000 })
            }
          }}
        />

        <div className="text-center space-y-1">
          <p className="text-xs text-text-disabled">
            {generationPhase === 'scenePlan'
              ? 'AI is designing scene structure and pacing...'
              : 'Generating image prompts for each scene...'}
          </p>
        </div>
      </motion.div>
    )
  }

  // ── Idle + no scenes = generation hasn't started (e.g. store rehydrated but no plan yet)
  if (scenes.length === 0 && generationState === 'idle' && !scenePlanError) {
    return (
      <motion.div
        variants={pageVariants} initial="initial" animate="animate" exit="exit"
        className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center p-8"
      >
        <div className="text-center max-w-md">
          <p className="text-sm text-text-secondary mb-4">
            {scenePlan ? 'Ready to generate images for your shots.' : 'Ready to plan your documentary.'}
          </p>
          <button
            onClick={() => scenePlan ? retryImagePrompts() : fetchScenePlan()}
            className="btn-primary px-6 py-2"
          >
            {scenePlan ? 'Generate Images' : 'Start Planning'}
          </button>
        </div>
      </motion.div>
    )
  }

  // ── Error screen ───────────────────────────────────────────────────────────
  if (scenePlanError || (imagesError && scenes.length === 0)) {
    return (
      <motion.div
        variants={pageVariants} initial="initial" animate="animate" exit="exit"
        className="min-h-[calc(100vh-3.5rem)] flex items-center justify-center p-8"
      >
        <div className="text-center max-w-md">
          <div className="w-12 h-12 rounded-full bg-error/10 flex items-center justify-center mx-auto mb-4">
            <svg className="w-6 h-6 text-error" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-text-primary mb-2">
            {scenePlanError ? 'Scene Planning Failed' : 'Image Prompts Failed'}
          </h2>
          <p className="text-sm text-text-secondary mb-6">
            {scenePlanError || imagesError}
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={scenePlanError ? retryScenePlan : retryImagePrompts}
              className="btn-primary px-6 py-2"
            >
              Retry
            </button>
            <button onClick={() => navigate('/')} className="btn-ghost px-6 py-2">
              Back to Stories
            </button>
          </div>
        </div>
      </motion.div>
    )
  }

  const totalDuration = scenePlan?.total_duration_seconds || 0
  const durationMinutes = Math.floor(totalDuration / 60)
  const durationSeconds = totalDuration % 60

  return (
    <motion.div
      variants={pageVariants} initial="initial" animate="animate" exit="exit"
      transition={{ duration: 0.2 }}
      className="min-h-[calc(100vh-3.5rem)] pb-24"
    >
      {/* Sticky header */}
      <div className="sticky top-14 bg-background/95 backdrop-blur-sm border-b border-border py-3 px-8 z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-text-primary">{selectedStory.title}</h1>
            <p className="text-xs text-text-secondary">
              {scenePlan?.total_scenes} scenes · {totalUnitCount} shots · {durationMinutes}m {durationSeconds}s · Select one image per shot
            </p>
          </div>

          <div className="flex items-center gap-3">
            {/* Progress bar */}
            {imageProgress.total > 0 && (
              <div className="flex items-center gap-2">
                <div className="w-32 h-1.5 bg-surface-raised rounded-full overflow-hidden">
                  <motion.div
                    className="h-full bg-accent rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${(imageProgress.completed.length / imageProgress.total) * 100}%` }}
                    transition={{ duration: 0.4 }}
                  />
                </div>
                <span className="text-xs text-text-secondary whitespace-nowrap">
                  <span className="text-accent font-medium">{imageProgress.completed.length}</span>
                  <span className="text-text-disabled">/{imageProgress.total}</span>
                </span>
              </div>
            )}

            {/* Stop mid-run — progress is kept and can be resumed */}
            {generationState === 'running' && generationPhase === 'images' && (
              <button
                onClick={stopGeneration}
                title="Stop image generation (keeps progress, resume anytime)"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-error/10 text-error border border-error/20 text-xs font-medium hover:bg-error/20 transition-colors"
              >
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>
                Stop
              </button>
            )}

            {(generationState === 'paused' || generationState === 'stopped') && imageProgress.pending.length > 0 && (
              <button
                onClick={resumeImageGeneration}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent-hover transition-colors"
              >
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                Resume ({imageProgress.pending.length} left)
              </button>
            )}

            {generationState === 'stopped' && imagesError && (
              <button
                onClick={retryImagePrompts}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-error/10 text-error border border-error/20 text-xs font-medium hover:bg-error/20 transition-colors"
              >
                Retry Failed
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Scene grid */}
      <div className="max-w-6xl mx-auto p-8 space-y-10">

        {/* Prompt batches still writing or failed — without this the grid
            silently shows a partial story (only the batches that finished) */}
        {imageBatches.some(b => b.status === 'failed' || b.status === 'running' || b.status === 'pending') && (
          <div className={`flex items-start gap-3 rounded-xl px-4 py-3 border ${
            imageBatches.some(b => b.status === 'failed')
              ? 'bg-error/8 border-error/30'
              : 'bg-accent/8 border-accent/25'
          }`}>
            {imageBatches.some(b => b.status === 'failed') ? (
              <svg className="w-4 h-4 text-error shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            ) : (
              <div className="w-4 h-4 border-2 border-accent border-t-transparent rounded-full animate-spin shrink-0 mt-0.5" />
            )}
            <div className="flex-1 text-xs leading-relaxed">
              <span className="font-medium text-text-primary">
                This is a partial view — not all scenes are here yet.
              </span>{' '}
              <span className="text-text-secondary">
                Prompts are written in batches; scenes appear as their batch finishes.
              </span>
              <div className="mt-2 space-y-1.5">
                {imageBatches.map(b => {
                  const label = `Scenes ${b.sceneNumbers[0]}–${b.sceneNumbers[b.sceneNumbers.length - 1]}`
                  if (b.status === 'running') return (
                    <div key={b.batchIndex} className="flex items-center gap-2 text-text-secondary">
                      <div className="w-2.5 h-2.5 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin" />
                      <span>{label} — writing prompts now (a few minutes with local Claude)...</span>
                    </div>
                  )
                  if (b.status === 'pending') return (
                    <div key={b.batchIndex} className="flex items-center gap-2 text-text-disabled">
                      <span className="w-2 h-2 rounded-full bg-border" />
                      <span>{label} — queued</span>
                    </div>
                  )
                  if (b.status === 'failed') return (
                    <div key={b.batchIndex} className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          toast.loading(`Rewriting prompts for ${label.toLowerCase()} — takes a few minutes...`, { id: `batch-${b.batchIndex}`, duration: 6000 })
                          retryImageBatch(b.batchIndex)
                            .catch(err => toast.error(`Batch retry failed: ${err.message}`))
                        }}
                        className="px-3 py-1 rounded-lg bg-error/15 text-error border border-error/30 text-xs font-medium hover:bg-error/25 transition-colors"
                      >
                        Retry {label}
                      </button>
                      {b.error && <span className="text-[10px] text-text-disabled">{b.error}</span>}
                    </div>
                  )
                  return null
                })}
              </div>
            </div>
          </div>
        )}

        {/* No measured audio → shots were sized from planned durations only */}
        {scenes.length > 0 && !Object.values(audio?.sceneAudio || {}).some(a => a?.durationSeconds) && (
          <div className="flex items-start gap-3 bg-warning/8 border border-warning/25 rounded-xl px-4 py-3">
            <svg className="w-4 h-4 text-warning shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div className="text-xs leading-relaxed">
              <span className="font-medium text-text-primary">Shots are based on planned scene durations — no audio was measured.</span>{' '}
              <span className="text-text-secondary">
                Each scene got exactly the shots its planned length needs (usually one). To fit shots to your real narration,
                add audio in the <button onClick={() => navigate('/audio')} className="text-accent hover:text-accent-hover underline underline-offset-2">Audio step</button>,
                then press <span className="font-medium text-text-primary">"Replan Shots from Audio"</span> below — scenes whose audio
                runs longer than one clip will split into 2+ sequential shots, each needing its own image.
              </span>
            </div>
          </div>
        )}

        {/* Pagination tabs — only shown when > 80 scenes (50 images × 4 variations each) */}
        {isPaginated && (
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-text-disabled mr-1">Page:</span>
            {Array.from({ length: totalPages }, (_, i) => {
              const startScene = i * SCENES_PER_PAGE + 1
              const endScene = Math.min((i + 1) * SCENES_PER_PAGE, scenes.length)
              const pageSelectedCount = scenes
                .slice(i * SCENES_PER_PAGE, (i + 1) * SCENES_PER_PAGE)
                .filter(s => selectedImages[`${s.scene_number}_${s.segment_index ?? 0}`]).length
              const pageTotal = endScene - startScene + 1
              return (
                <button
                  key={i}
                  onClick={() => setCurrentPage(i)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    currentPage === i
                      ? 'bg-accent text-white'
                      : 'bg-surface-raised border border-border text-text-secondary hover:border-accent/50 hover:text-text-primary'
                  }`}
                >
                  <span>Scenes {startScene}–{endScene}</span>
                  {pageSelectedCount > 0 && (
                    <span className={`text-[10px] px-1 rounded ${currentPage === i ? 'bg-white/20' : 'bg-accent/15 text-accent'}`}>
                      {pageSelectedCount}/{pageTotal}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        )}

        {groupedScenes.map(({ sceneNumber, units }) => {
          const planScene = scenePlan?.scenes?.find(s => s.scene_number === sceneNumber)
          const multiShot = units.length > 1
          const selectedShots = units.filter(u => selectedImages[`${sceneNumber}_${u.segment_index ?? 0}`]).length
          return (
            <div key={sceneNumber}>
              {/* Scene header */}
              <div className="flex items-center gap-3 mb-3">
                <div className="flex items-center gap-2">
                  <span className="w-7 h-7 rounded-lg bg-surface-raised border border-border flex items-center justify-center text-xs font-bold text-text-secondary">
                    {sceneNumber}
                  </span>
                  <div>
                    <span className="text-sm font-medium text-text-primary">{units[0].scene_title}</span>
                    {planScene && (
                      <span className="ml-2 text-xs text-text-disabled">
                        {planScene.duration_seconds}s · {planScene.shot_type}
                      </span>
                    )}
                    {multiShot && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-accent/10 text-accent font-medium">
                        {units.length} shots — select one image per shot
                      </span>
                    )}
                  </div>
                </div>
                {selectedShots === units.length && units.length > 0 && (
                  <span className="flex items-center gap-1 text-xs text-success font-medium">
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    {multiShot ? 'All shots selected' : 'Selected'}
                  </span>
                )}
                {multiShot && selectedShots > 0 && selectedShots < units.length && (
                  <span className="text-xs text-text-disabled">{selectedShots}/{units.length} shots selected</span>
                )}
                {characters.length > 0 && (
                  <details className="ml-auto relative">
                    <summary className="list-none cursor-pointer text-[10px] px-2.5 py-1.5 rounded-lg border border-border bg-surface-raised text-text-secondary hover:border-accent/40">
                      {(characterSceneLinks[String(sceneNumber)]?.character_ids || []).length
                        ? `${characterSceneLinks[String(sceneNumber)].character_ids.length} linked character${characterSceneLinks[String(sceneNumber)].character_ids.length > 1 ? 's' : ''}`
                        : 'Link characters'}
                    </summary>
                    <div className="absolute right-0 top-9 z-20 w-64 p-3 rounded-xl border border-border bg-surface shadow-2xl">
                      <p className="text-[10px] text-text-disabled mb-2">Image references supplied for this scene</p>
                      <div className="space-y-1.5">
                        {characters.map(character => {
                          const current = characterSceneLinks[String(sceneNumber)]?.character_ids || []
                          const linked = current.includes(character.id)
                          return (
                            <label key={character.id} className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer p-1.5 rounded hover:bg-white/[0.03]">
                              <input
                                type="checkbox"
                                checked={linked}
                                onChange={event => setSceneCharacters(
                                  sceneNumber,
                                  event.target.checked ? [...current, character.id] : current.filter(id => id !== character.id)
                                )}
                              />
                              {character.image && <img src={character.image} alt="" className="w-7 h-7 rounded object-cover" />}
                              <span>{character.name}</span>
                            </label>
                          )
                        })}
                      </div>
                    </div>
                  </details>
                )}
              </div>

              {/* Visual description */}
              {planScene?.visual_description && (
                <p className="text-xs text-text-disabled mb-3 pl-9 leading-relaxed italic">
                  {planScene.visual_description}
                </p>
              )}

              {/* One block per shot (segment) */}
              <div className="space-y-4">
                {units.map(unit => {
                  const segIdx = unit.segment_index ?? 0
                  const selKey = `${sceneNumber}_${segIdx}`
                  return (
                    <div key={selKey}>
                      {multiShot && (
                        <div className="flex items-center gap-2 pl-9 mb-2">
                          <span className={`text-[11px] font-semibold ${selectedImages[selKey] ? 'text-success' : 'text-text-secondary'}`}>
                            Shot {segIdx + 1} of {unit.segment_count}
                          </span>
                          {unit.target_duration && (
                            <span className="text-[10px] text-text-disabled">
                              covers {Math.round(unit.target_duration)}s of audio
                              {unit.playback_rate && unit.playback_rate < 1
                                ? ` · ${unit.clip_duration}s clip @ ${Math.round(unit.playback_rate * 100)}% speed`
                                : unit.clip_duration ? ` · ${unit.clip_duration}s clip` : ''}
                            </span>
                          )}
                          {selectedImages[selKey] && (
                            <svg className="w-3 h-3 text-success" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </div>
                      )}
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pl-9">
                        {unit.prompts.map((prompt, idx) => {
                          const key = `${sceneNumber}_${segIdx}_${idx}`
                          return (
                            <ImageCard
                              key={key}
                              imageKey={key}
                              image={images[key]}
                              isLoading={!!imagesLoading[key]}
                              isSelected={selectedImages[selKey]?.promptIndex === idx}
                              onSelect={() => selectImage(sceneNumber, segIdx, idx)}
                              onRegenerate={(newPrompt) => {
                                regenerateImage(sceneNumber, segIdx, idx, newPrompt)
                                  .catch(err => toast.error(`Regeneration failed: ${err.message}`))
                              }}
                              onViewFull={() => setSelectedModal({ sceneNumber, segmentIndex: segIdx, promptIndex: idx })}
                              variationLabel={
                                multiShot
                                  ? `Shot ${segIdx + 1} · v${idx + 1}`
                                  : ['Establishing', 'Intimate', 'Detail', 'Atmospheric'][idx] || `v${idx + 1}`
                              }
                            />
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}

        {/* Pagination prev/next footer */}
        {isPaginated && totalPages > 1 && (
          <div className="flex items-center justify-between pt-4 border-t border-border">
            <button
              onClick={() => { setCurrentPage(p => Math.max(0, p - 1)); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
              disabled={currentPage === 0}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-sm text-text-secondary hover:border-accent/50 hover:text-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              Previous
            </button>
            <span className="text-xs text-text-disabled">
              Page {currentPage + 1} of {totalPages} · {scenes.length} scenes total
            </span>
            <button
              onClick={() => { setCurrentPage(p => Math.min(totalPages - 1, p + 1)); window.scrollTo({ top: 0, behavior: 'smooth' }) }}
              disabled={currentPage === totalPages - 1}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg border border-border text-sm text-text-secondary hover:border-accent/50 hover:text-text-primary transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Next
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-surface/95 backdrop-blur-sm border-t border-border py-4 px-8 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-baseline gap-1">
              <span className="text-sm font-semibold text-text-primary">{completedCount}</span>
              <span className="text-sm text-text-secondary">/ {totalUnitCount} shots selected</span>
            </div>
            {selectableUnitCount > 0 && (
              <button
                onClick={allAvailableSelected ? deselectAllImages : selectAllImages}
                className="btn-ghost py-1 px-3 text-xs"
              >
                {allAvailableSelected ? 'Deselect All' : 'Select All'}
              </button>
            )}
            {!allSelected && completedCount > 0 && (
              <span className="text-xs text-text-disabled">
                {totalUnitCount - completedCount} remaining
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                if (!confirm('Re-plan shots from the current audio durations and regenerate all image prompts + images? Existing images for this step will be replaced.')) return
                retryImagePrompts()
              }}
              disabled={scenes.length === 0 || generationState === 'running'}
              title="Recompute how many shots each scene needs from the latest audio, then regenerate prompts and images"
              className="btn-secondary px-4 py-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Replan Shots from Audio
            </button>
            <button
              onClick={async () => {
                if (regeneratingAll) return
                setRegeneratingAll(true)
                try {
                  await regenerateAllImages()
                  toast.success('All images regenerated!')
                } catch (err) {
                  toast.error(`Regeneration failed: ${err.message}`)
                } finally {
                  setRegeneratingAll(false)
                }
              }}
              disabled={regeneratingAll || scenes.length === 0}
              className="btn-secondary px-4 py-2 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
            >
              {regeneratingAll ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
                  <span>Regenerating...</span>
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  <span>Regenerate All</span>
                </>
              )}
            </button>
            <button
              onClick={() => setShowExportModal(true)}
              disabled={imagesCompleteCount === 0}
              className="btn-secondary px-4 py-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Export Project
            </button>
            <button
              onClick={() => navigate('/videos')}
              disabled={!allSelected}
              className="btn-primary px-6 py-2 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Continue to Videos →
            </button>
          </div>
        </div>
      </div>

      {/* Export modal */}
      <AnimatePresence>
        {showExportModal && (
          <ExportModal onClose={() => setShowExportModal(false)} />
        )}
      </AnimatePresence>

      {/* Full-screen image modal */}
      <AnimatePresence>
        {selectedModal && (
          <ImageModal
            image={images[`${selectedModal.sceneNumber}_${selectedModal.segmentIndex ?? 0}_${selectedModal.promptIndex}`]}
            history={imageHistory[`${selectedModal.sceneNumber}_${selectedModal.segmentIndex ?? 0}_${selectedModal.promptIndex}`] || []}
            onClose={() => setSelectedModal(null)}
            onRegenerate={(newPrompt) => {
              regenerateImage(selectedModal.sceneNumber, selectedModal.segmentIndex ?? 0, selectedModal.promptIndex, newPrompt)
                .catch(err => toast.error(`Regeneration failed: ${err.message}`))
            }}
            onEditWithAI={(instruction, count) => (
              editSceneImageWithAi(
                selectedModal.sceneNumber,
                selectedModal.segmentIndex ?? 0,
                selectedModal.promptIndex,
                instruction,
                count
              )
            )}
            onApplyEdit={(option) => applySceneImageEdit(
              selectedModal.sceneNumber,
              selectedModal.segmentIndex ?? 0,
              selectedModal.promptIndex,
              option
            )}
            onSelect={(url, prompt) => selectImage(selectedModal.sceneNumber, selectedModal.segmentIndex ?? 0, selectedModal.promptIndex, url, prompt)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default SceneImages
