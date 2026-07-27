import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { usePipelineStore } from '../store/pipelineStore'
import { planSceneSegments, getClipOptions } from '../lib/segmentation'
import api from '../services/api'
import toast from 'react-hot-toast'
import AudioReviewPanel from '../components/audio/AudioReviewPanel'
import { useExclusiveAudioPlayer } from '../hooks/useExclusiveAudioPlayer'

// Read an uploaded audio file as a base64 data URI so it flows through the
// existing store/export pipeline exactly like ElevenLabs-generated audio.
const fileToDataUri = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result)
  reader.onerror = reject
  reader.readAsDataURL(file)
})

// Measure the duration of an audio data URI (seconds) via an off-DOM element
const measureAudioDuration = (dataUri) => new Promise((resolve) => {
  const el = new Audio()
  el.preload = 'metadata'
  el.onloadedmetadata = () => resolve(Number.isFinite(el.duration) ? el.duration : null)
  el.onerror = () => resolve(null)
  el.src = dataUri
})

const copyToClipboard = async (text, label) => {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${label} copied`)
  } catch {
    toast.error('Copy failed')
  }
}

// The exact text ElevenLabs would receive: spoken lines only, cues stripped
const sceneSpokenText = (lines) => (lines || []).filter(l => !l.startsWith('[')).join('\n')
const sfxCueText = (cue) => cue.replace('[SFX:', '').replace(']', '').replace(/_/g, ' ').toLowerCase()
const sfxDurationFor = (cue) => (
  /ambience|rain|wind|crowd|room tone|traffic|ocean|waves/i.test(sfxCueText(cue)) ? 5
    : /click|snap|crack|slam|impact|knock|gunshot|beep/i.test(sfxCueText(cue)) ? 2
      : 3
)
const sfxPromptText = (cue, unit) => {
  const literal = sfxCueText(cue)
  const context = sceneSpokenText(unit?.lines || []).replace(/\s+/g, ' ').slice(0, 280)
  const duration = sfxDurationFor(cue)
  return [
    `Create one high-fidelity cinematic documentary sound effect: ${literal}.`,
    `The audible event must begin immediately, within the first 100 milliseconds, and the complete file must last exactly ${duration} seconds.`,
    context ? `Narrative context: "${context}". Match the real location, material, distance, scale, and acoustic perspective implied by that context.` : '',
    'Use naturalistic dynamics, detailed physical texture, restrained low end, and a clean editorial tail.',
    'It will sit quietly beneath spoken narration, so keep it subtle and intelligible rather than loud or theatrical.',
    'Isolated sound effect only: no speech, no vocals, no music, no melody, no rhythmic beat, no 8-bit or arcade tones, no synthetic UI bleeps, and no unrelated secondary events.',
  ].filter(Boolean).join(' ')
}

function AudioGeneration() {
  const navigate = useNavigate()
  // Track per-item loading instead of a global boolean to avoid blocking
  const [itemLoading, setItemLoading] = useState({})
  const sceneUploadRefs = useRef({})
  const sfxUploadRefs = useRef({})
  const fullAudioUploadRef = useRef(null)
  const ttsFetchStartedRef = useRef(false)
  const player = useExclusiveAudioPlayer()

  const {
    selectedStory,
    scenePlan,
    scenePlanLoading,
    scenePlanError,
    ttsScript,
    ttsLoading,
    ttsError,
    settings,
    audio,
    expressiveScript,
    expressiveLoading,
    expressiveError,
    setSceneAudio,
    setSfxAudio,
    storeAudioAsset,
    autoSaveSession,
    setAudioScriptFormat,
    fetchTtsScript,
    retryTtsScript,
    retryScenePlan,
    fetchExpressiveScript,
    analyzeFullAudio,
    validateFullAudioMarker,
    repairAuditedFullAudio,
    approveAuditedFullAudio,
    setFullAudioPreviewVariant,
  } = usePipelineStore()

  const hasElevenLabs = settings.keysConfigured?.elevenlabs
  const scriptFormat = settings.audioScriptFormat || 'plain'
  const sceneAudio = audio.sceneAudio || {}
  const sfxAudio   = audio.sfxAudio   || {}
  const fullAudio  = audio.fullAudio  || null
  const audioReviewPending = Boolean(fullAudio?.status && fullAudio.status !== 'split')

  // Redirect home when no story; fetch the narration script if it isn't
  // already being written (fetchScenePlan kicks it off automatically)
  useEffect(() => {
    if (!selectedStory) { navigate('/'); return }
    if (scenePlan && !ttsScript && !ttsLoading && !ttsFetchStartedRef.current) {
      ttsFetchStartedRef.current = true
      fetchTtsScript().catch(() => {})
    }
  }, [selectedStory, scenePlan, ttsScript, ttsLoading])

  const setLoading = (id, value) => setItemLoading(prev => ({ ...prev, [id]: value }))

  const handleGenerateSfx = async (cue) => {
    if (itemLoading[cue]) return

    setLoading(cue, true)
    setSfxAudio(cue, { loading: true })

    try {
      const units = ttsScript?.narration_sequence || ttsScript?.scene_breakdown || []
      const unit = units.find(candidate => (candidate.lines || []).includes(cue))
      const prompt = sfxPromptText(cue, unit)
      const requestedDuration = sfxDurationFor(cue)
      const result = await api.generateSfx(prompt, requestedDuration)
      const durationSeconds = await measureAudioDuration(result.audio) || requestedDuration
      const url = await storeAudioAsset(`sfx_${sfxCueText(cue).replace(/\s+/g, '-')}`, result.audio)
      setSfxAudio(cue, {
        audio: url,
        prompt,
        durationSeconds,
        volume: 0.28,
        loading: false,
      })
      autoSaveSession()
      toast.success('Sound effect ready', { id: `sfx-${cue}` })
    } catch (error) {
      setSfxAudio(cue, { error: error.message, loading: false })
      toast.error(`SFX failed: ${error.message}`)
    }
    setLoading(cue, false)
  }

  // Manual mode: user provides the audio file for a scene. Stored in the same
  // parts shape ElevenLabs produces, so playback and ZIP export work unchanged.
  const handleManualSceneUpload = async (scene, file) => {
    if (!file) return
    try {
      const sceneId = scene.unit_id || scene.scene_id
      const dataUri = await fileToDataUri(file)
      const durationSeconds = await measureAudioDuration(dataUri)
      // Store on the server first — state only holds the URL
      const url = await storeAudioAsset(sceneId, dataUri)
      const parts = [
        ...(scene.lines || []).filter(l => l.startsWith('[')).map(l => ({ type: 'cue', content: l })),
        { type: 'audio', content: url, text: sceneSpokenText(scene.lines), manual: true },
      ]
      setSceneAudio(sceneId, { parts, loading: false, durationSeconds })
      autoSaveSession()
      toast.success(`Audio attached to ${sceneId}${durationSeconds ? ` (${durationSeconds.toFixed(1)}s)` : ''}`)
    } catch (err) {
      toast.error(`Failed to read audio file: ${err.message}`)
    }
  }

  const handleManualSfxUpload = async (cue, file) => {
    if (!file) return
    try {
      const dataUri = await fileToDataUri(file)
      const durationSeconds = await measureAudioDuration(dataUri) || sfxDurationFor(cue)
      const url = await storeAudioAsset(`sfx_${sfxCueText(cue).replace(/\s+/g, '-')}`, dataUri)
      const units = ttsScript?.narration_sequence || ttsScript?.scene_breakdown || []
      const unit = units.find(candidate => (candidate.lines || []).includes(cue))
      setSfxAudio(cue, {
        audio: url,
        prompt: sfxPromptText(cue, unit),
        durationSeconds,
        volume: 0.28,
        loading: false,
        manual: true,
      })
      autoSaveSession()
      toast.success('Sound effect attached')
    } catch (err) {
      toast.error(`Failed to read audio file: ${err.message}`)
    }
  }

  // Full narration is persisted and audited first. Scene slices are created
  // only after the user approves the source or repaired master.
  const handleFullAudioUpload = async (file) => {
    if (!file) return
    try {
      const dataUri = await fileToDataUri(file)
      const durationSeconds = await measureAudioDuration(dataUri)
      toast.loading('Auditing narration pacing and signal quality…', { id: 'whisper' })
      const audit = await analyzeFullAudio(dataUri, { name: file.name, durationSeconds })
      toast.success(
        audit.summary?.issueCount
          ? `${audit.summary.issueCount} audio finding${audit.summary.issueCount === 1 ? '' : 's'} ready to review`
          : 'Audio passed quality review',
        { id: 'whisper' },
      )
    } catch (err) {
      toast.error(`Audio audit failed: ${err.message}`, { id: 'whisper' })
    }
  }

  const pageVariants = {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 }
  }

  if (!selectedStory) return null

  const narrationUnits = ttsScript?.narration_sequence || ttsScript?.scene_breakdown || []
  const uniqueSfxCues = [...new Set(
    narrationUnits.flatMap(unit => (unit.lines || []).filter(line => line.startsWith('[SFX:')))
  )]

  const generatedSceneCount = narrationUnits.filter(unit => sceneAudio[unit.unit_id || unit.scene_id]?.parts).length
  const totalScenes = narrationUnits.length

  // Plain full script: ONLY the spoken narration — no scene ids, no cue tags
  const plainFullScript = narrationUnits
    .map(unit => sceneSpokenText(unit.lines))
    .filter(Boolean)
    .join('\n\n')

  const expressiveFullScript = expressiveScript?.script || ''
  const cinemaOptionsMatch = !!ttsScript && (
    !!ttsScript.cinema_options?.chaptersEnabled === !!settings.chaptersEnabled
    && !!ttsScript.cinema_options?.trailerEnabled === !!settings.trailerIntroEnabled
  )

  // Shots preview: given current audio + video model settings, how many clips
  // will each scene need?
  const clipOptions = getClipOptions(settings.videoModel, settings.videoClipDuration)
  const speedFactor = settings.videoSpeedFactor || 1
  const segmentsFor = (scene) => {
    const measured = sceneAudio[scene.scene_id]?.durationSeconds
    const planScene = scenePlan?.scenes?.find(p => p.scene_id === scene.scene_id)
    return planSceneSegments(measured || planScene?.duration_seconds || null, clipOptions, speedFactor)
  }
  const totalShots = (ttsScript?.scene_breakdown || [])
    .reduce((sum, s) => sum + segmentsFor(s).length, 0)

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
            <h1 className="text-base font-semibold text-text-primary">Audio</h1>
            <p className="text-xs text-text-secondary">
              Narration first — each scene's audio length decides how many shots it needs
            </p>
          </div>
          <div className="flex items-center gap-4">
            {totalScenes > 0 && (
              <div className="text-xs text-text-secondary">
                <span className="text-accent font-medium">{generatedSceneCount}</span>
                <span className="text-text-disabled">/{totalScenes} scenes narrated</span>
                {totalShots > 0 && (
                  <span className="ml-3 text-text-disabled">{totalShots} shots planned</span>
                )}
              </div>
            )}
            <span className="px-3 py-1.5 rounded-lg border border-border bg-surface-raised text-[10px] uppercase tracking-[0.15em] text-text-secondary">
              Manual narration workflow
            </span>
          </div>
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-8 space-y-6">
        {/* Scene plan / script loading & errors */}
        {scenePlanError && !scenePlan ? (
          <div className="bg-surface border border-error/30 rounded-xl p-6 text-center">
            <p className="text-sm text-error mb-3">Scene planning failed: {scenePlanError}</p>
            <button onClick={() => retryScenePlan()} className="btn-primary px-5 py-2 text-sm">
              Retry Scene Plan
            </button>
          </div>
        ) : (ttsLoading || scenePlanLoading || (!ttsScript && !ttsError)) ? (
          <div className="bg-surface border border-border rounded-xl p-8 text-center">
            <div className="flex items-center justify-center gap-2 mb-2">
              <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
              <span className="text-sm font-medium text-text-primary">
                {!scenePlan ? 'Planning scenes...' : 'Writing narration script...'}
              </span>
            </div>
            <p className="text-xs text-text-secondary">{selectedStory.title}</p>
          </div>
        ) : null}

        {ttsError && !ttsScript && !scenePlanLoading && scenePlan && (
          <div className="bg-surface border border-error/30 rounded-xl p-6 text-center">
            <p className="text-sm text-error mb-3">Script generation failed: {ttsError}</p>
            <button
              onClick={() => retryTtsScript().catch(() => {})}
              className="btn-primary px-5 py-2 text-sm"
            >
              Retry Script
            </button>
          </div>
        )}

        {ttsScript?.scene_breakdown && (
          <>
            {(settings.trailerIntroEnabled || settings.chaptersEnabled) && (
              <div className={`border rounded-xl p-4 ${cinemaOptionsMatch ? 'border-accent/30 bg-accent/5' : 'border-warning/40 bg-warning/5'}`}>
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold text-text-primary">Cinematic voiceover plan</h3>
                    <p className="text-[11px] text-text-secondary mt-1">
                      {cinemaOptionsMatch
                        ? `${settings.trailerIntroEnabled ? 'Narrated trailer' : ''}${settings.trailerIntroEnabled && settings.chaptersEnabled ? ' · ' : ''}${settings.chaptersEnabled ? 'Synchronized chapter overview and transitions' : ''}`
                        : 'Cinema options changed after this script was written. Regenerating creates a new canonical script and clears superseded narration audio.'}
                    </p>
                  </div>
                  {!cinemaOptionsMatch && (
                    <button
                      onClick={() => retryTtsScript().catch(() => {})}
                      disabled={ttsLoading}
                      className="btn-primary px-3 py-1.5 text-xs disabled:opacity-40"
                    >
                      Regenerate narration plan
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ── Full script (plain / expressive) ── */}
            <div className="bg-surface border border-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Full Script</h3>
                  <p className="text-[11px] text-text-secondary mt-0.5">
                    Copy the whole narration at once, generate the audio anywhere, then upload the full recording below
                  </p>
                  {ttsScript.writing_profile && (
                    <p className="text-[10px] text-accent mt-1">
                      FacelessOS · {String(ttsScript.writing_profile.format || 'documentary').replaceAll('-', ' ')}
                      {ttsScript.writing_profile.continuity_audit?.pass ? ' · continuity passed' : ''}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {/* Format toggle */}
                  <div className="grid grid-cols-2 gap-1 bg-surface-raised rounded-lg p-1">
                    {[
                      { id: 'plain', label: 'Plain' },
                      { id: 'expressive', label: 'Expressive' }
                    ].map(f => (
                      <button key={f.id}
                        onClick={() => setAudioScriptFormat(f.id)}
                        className={`px-3 py-1 rounded-md text-[11px] font-medium transition-all ${
                          scriptFormat === f.id
                            ? 'bg-surface text-text-primary shadow-sm'
                            : 'text-text-secondary hover:text-text-primary'
                        }`}
                      >{f.label}</button>
                    ))}
                  </div>
                  {scriptFormat === 'expressive' && (
                    <button
                      onClick={() => fetchExpressiveScript().catch(() => {})}
                      disabled={expressiveLoading}
                      className="btn-secondary py-1.5 px-3 text-xs disabled:opacity-40"
                    >
                      {expressiveLoading ? (
                        <span className="flex items-center gap-1.5">
                          <div className="w-2.5 h-2.5 border border-accent border-t-transparent rounded-full animate-spin" />
                          Writing tags...
                        </span>
                      ) : expressiveFullScript ? 'Regenerate' : 'Generate Expressive'}
                    </button>
                  )}
                  <button
                    onClick={() => {
                      const text = scriptFormat === 'expressive' ? expressiveFullScript : plainFullScript
                      if (!text) { toast.error(scriptFormat === 'expressive' ? 'Generate the expressive script first' : 'No script yet'); return }
                      copyToClipboard(text, scriptFormat === 'expressive' ? 'Expressive script' : 'Full script')
                    }}
                    className="btn-primary py-1.5 px-3 text-xs"
                  >
                    Copy Full Script
                  </button>
                </div>
              </div>

              {scriptFormat === 'expressive' ? (
                expressiveError ? (
                  <p className="text-xs text-error">{expressiveError}</p>
                ) : expressiveFullScript ? (
                  <textarea
                    value={expressiveFullScript}
                    readOnly
                    className="w-full h-40 font-mono text-[11px] resize-none bg-surface-raised leading-relaxed"
                  />
                ) : (
                  <p className="text-xs text-text-disabled italic">
                    Expressive format rewrites the narration with audio tags — emotion, pauses, emphasis — for
                    advanced TTS voices (e.g. ElevenLabs v3). Click "Generate Expressive" to create it.
                  </p>
                )
              ) : (
                <textarea
                  value={plainFullScript}
                  readOnly
                  className="w-full h-40 font-mono text-[11px] resize-none bg-surface-raised leading-relaxed"
                />
              )}
            </div>

            {/* ── Full audio quality gate ── */}
            <input
              ref={fullAudioUploadRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={event => {
                handleFullAudioUpload(event.target.files?.[0])
                event.target.value = ''
              }}
            />
            {!fullAudio ? (
              <div className="bg-surface border border-border rounded-xl p-5 flex items-center justify-between gap-5">
                <div>
                  <h3 className="text-sm font-semibold text-text-primary">Full narration · Quality review</h3>
                  <p className="text-[11px] text-text-secondary mt-0.5">
                    {settings.keysConfigured?.whisper
                      ? 'Upload one recording. The source is preserved, transcribed, checked for pacing and signal defects, then reviewed before scene splitting.'
                      : 'Requires local Whisper + ffmpeg (pip install openai-whisper) — restart the backend after installing.'}
                  </p>
                </div>
                <button
                  onClick={() => fullAudioUploadRef.current?.click()}
                  disabled={!settings.keysConfigured?.whisper}
                  className="btn-primary py-2 px-4 text-xs disabled:opacity-40 shrink-0"
                >
                  Upload & audit audio
                </button>
              </div>
            ) : (
              <AudioReviewPanel
                fullAudio={fullAudio}
                player={player}
                onReplace={() => fullAudioUploadRef.current?.click()}
                onRepair={async (issueIds) => {
                  try {
                    toast.loading('Creating and verifying an improved master…', { id: 'audio-repair' })
                    await repairAuditedFullAudio(issueIds)
                    toast.success('Improved master ready for A/B review', { id: 'audio-repair' })
                  } catch (error) {
                    toast.error(error.message, { id: 'audio-repair' })
                  }
                }}
                onApprove={async (variant) => {
                  try {
                    toast.loading('Approving audio and creating scene slices…', { id: 'audio-approve' })
                    const slices = await approveAuditedFullAudio(variant)
                    toast.success(`${slices.length} narration units are ready`, { id: 'audio-approve' })
                  } catch (error) {
                    toast.error(error.message, { id: 'audio-approve' })
                  }
                }}
                onValidateMarker={async (marker) => {
                  const result = await validateFullAudioMarker(marker)
                  toast[result.validation?.confirmed ? 'success' : 'error'](
                    result.validation?.message || 'Marker saved for review',
                  )
                }}
                onVariantChange={setFullAudioPreviewVariant}
              />
            )}
          </>
        )}

        {ttsScript?.scene_breakdown ? (
          <>
            {/* Scene narration */}
            <div className="bg-surface border border-border rounded-xl p-5">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-text-primary">Scene Narration</h3>
                <span className="text-[10px] text-text-disabled">Upload per item, or approve the reviewed full master above</span>
              </div>

              <div className="space-y-3">
                {narrationUnits.map((scene, idx) => {
                  const id = scene.unit_id || scene.scene_id || `scene-${idx}`
                  const audioState = sceneAudio[id]
                  const playbackSource = audioState?.parts?.find(part => part.type === 'audio' && part.content)?.content
                  const isPlaying = player.activeId === id && player.playing
                  const isCinemaUnit = scene.cinema_type && scene.cinema_type !== 'scene'
                  const segments = isCinemaUnit ? [] : segmentsFor(scene)
                  const measured = audioState?.durationSeconds

                  return (
                    <div key={id} className="flex gap-3 p-3 border border-border rounded-lg bg-surface-raised/50">
                      <div className="w-10 h-10 rounded-lg bg-surface-raised border border-border flex items-center justify-center shrink-0 text-xs font-bold text-text-secondary">
                        {isCinemaUnit ? 'VO' : idx + 1}
                      </div>

                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-medium text-text-primary">
                            {isCinemaUnit
                              ? `${scene.cinema_type.replaceAll('-', ' ')}${scene.chapter_number ? ` · ${scene.chapter_number}` : ''}`
                              : scene.scene_id}
                          </span>
                          <span className="text-[10px] text-text-disabled">
                            {measured
                              ? <span className="text-accent font-medium">{measured.toFixed(1)}s audio</span>
                              : `${scene.duration}s planned`}
                            {' · '}
                            {isCinemaUnit
                              ? <span className="text-accent">cinematic voiceover</span>
                              : segments.length > 1
                              ? <span className={measured ? 'text-warning font-medium' : ''}>{segments.length} shots ({segments.map(s => `${Math.round(s.targetDuration)}s`).join(' + ')})</span>
                              : '1 shot'}
                          </span>
                        </div>

                        <p className="text-[10px] text-text-disabled font-mono mb-2 leading-relaxed whitespace-pre-wrap">
                          {sceneSpokenText(scene.lines)}
                        </p>

                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => copyToClipboard(sceneSpokenText(scene.lines), id)}
                            className="btn-secondary py-1 px-2.5 text-[10px]"
                          >
                            Copy Text
                          </button>
                          <input
                            ref={element => { sceneUploadRefs.current[id] = element }}
                            type="file"
                            accept="audio/*"
                            className="hidden"
                            onChange={event => {
                              handleManualSceneUpload(scene, event.target.files?.[0])
                              event.target.value = ''
                            }}
                          />
                          <button
                            onClick={() => sceneUploadRefs.current[id]?.click()}
                            className="btn-secondary py-1 px-2.5 text-[10px]"
                          >
                            {audioState?.parts ? 'Replace Audio' : 'Upload Audio'}
                          </button>

                          {playbackSource && (
                            <button
                              onClick={() => player.toggle({ id, source: playbackSource })
                                .catch(error => toast.error(`Playback failed: ${error.message}`))}
                              className="flex items-center gap-1 text-[10px] text-accent hover:text-accent-hover font-medium"
                            >
                              {isPlaying ? (
                                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>
                              ) : (
                                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
                              )}
                              {isPlaying ? 'Pause' : 'Play'}
                            </button>
                          )}

                          {audioState?.parts && (
                            <span className="text-[10px] text-success">✓ Ready{audioState.parts.some(p => p.whisper) ? ' (auto-split)' : ''}</span>
                          )}

                          {audioState?.error && (
                            <span className="text-[10px] text-error">{audioState.error.split(':')[0]}</span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Sound effects */}
            {uniqueSfxCues.length > 0 && (
              <div className="bg-surface border border-border rounded-xl p-5">
                <h3 className="text-sm font-semibold text-text-primary mb-4">Sound Effects</h3>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                   {uniqueSfxCues.map((cue, idx) => {
                     const sfxState = sfxAudio[cue]
                     const cueName = cue.replace('[SFX:', '').replace(']', '').replace(/_/g, ' ')
                     const isItemLoading = itemLoading[cue] || sfxState?.loading
                     const playerId = `sfx-${idx}`
                     const isPlaying = player.activeId === playerId && player.playing

                     return (
                       <div key={idx} className="border border-border rounded-lg p-3 bg-surface-raised/50">
                         <p className="text-[10px] font-semibold text-text-primary mb-2 leading-tight">{cueName}</p>
                         <div className="grid grid-cols-2 gap-1.5">
                           <button
                             onClick={() => {
                               const unit = narrationUnits.find(candidate => (candidate.lines || []).includes(cue))
                               copyToClipboard(sfxPromptText(cue, unit), 'SFX prompt')
                             }}
                             className="btn-secondary py-1 text-[10px] flex items-center justify-center"
                           >
                             Copy prompt
                           </button>
                           <button
                             onClick={() => handleGenerateSfx(cue)}
                             disabled={isItemLoading || !hasElevenLabs}
                             title={hasElevenLabs ? 'Generate with ElevenLabs' : 'Add an ElevenLabs key in Settings to generate'}
                             className="btn-secondary py-1 text-[10px] disabled:opacity-40 flex items-center justify-center gap-1"
                           >
                             {isItemLoading ? (
                               <div className="w-3 h-3 border border-accent border-t-transparent rounded-full animate-spin" />
                             ) : sfxState?.audio ? 'Regenerate' : 'Generate'}
                           </button>
                           <input
                             ref={element => { sfxUploadRefs.current[cue] = element }}
                             type="file"
                             accept="audio/*"
                             className="hidden"
                             onChange={event => {
                               handleManualSfxUpload(cue, event.target.files?.[0])
                               event.target.value = ''
                             }}
                           />
                           <button
                             onClick={() => sfxUploadRefs.current[cue]?.click()}
                             className="btn-secondary py-1 text-[10px] flex items-center justify-center"
                           >
                             {sfxState?.audio ? 'Replace file' : 'Upload file'}
                           </button>
                           {sfxState?.audio && (
                             <button
                               onClick={() => player.toggle({ id: playerId, source: sfxState.audio })
                                 .catch(error => toast.error(`Playback failed: ${error.message}`))}
                               className="btn-secondary py-1 px-2 text-[10px] flex items-center justify-center"
                               title={isPlaying ? 'Pause' : 'Play'}
                             >
                               {isPlaying ? (
                                 <><svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>Pause</>
                               ) : (
                                 <><svg className="w-3 h-3 mr-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>Play</>
                               )}
                             </button>
                           )}
                         </div>
                         {sfxState?.error && (
                           <p className="text-[9px] text-error mt-1 leading-tight">{sfxState.error.split(':')[0]}</p>
                         )}
                       </div>
                     )
                   })}
                 </div>
              </div>
            )}
          </>
        ) : null}
      </div>

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-surface/95 backdrop-blur-sm border-t border-border py-4 px-8 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-3">
          <p className="text-xs text-text-disabled">
            {audioReviewPending
              ? 'Approve the source or improved narration master before continuing'
              : generatedSceneCount === 0
              ? 'Provide audio to size the shots precisely — or continue and scenes will use their planned durations'
              : generatedSceneCount < totalScenes
                ? `${totalScenes - generatedSceneCount} scene${totalScenes - generatedSceneCount > 1 ? 's' : ''} without audio will use planned durations`
                : 'All scenes have audio — shots are sized to the real narration'}
          </p>
          <button
            onClick={() => navigate('/images')}
            disabled={!scenePlan || !ttsScript || audioReviewPending}
            className="btn-primary px-6 py-2 text-sm disabled:opacity-40"
          >
            Continue to Images →
          </button>
        </div>
      </div>
    </motion.div>
  )
}

export default AudioGeneration
