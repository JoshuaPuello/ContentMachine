import { useEffect, useMemo, useState } from 'react'
import { usePipelineStore } from '../../store/pipelineStore'
import { TRANSITION_LIBRARY, transitionDefinition } from '../../lib/transitionLibrary'

// ─── InspectorPanel ──────────────────────────────────────────────────────────
// Kind-specific editing for the selected timeline item. Times commit on
// blur/Enter; text fields commit as you type.

const KIND_LABELS = {
  clip: 'Clip',
  narration: 'Narration',
  music: 'Music',
  'sound-effect': 'Sound effect',
  map: 'Map segment',
  'chapter-reveal': 'Chapter reveal',
  'chapter-active': 'Chapter stinger',
  title: 'Title card',
  'lower-third': 'Lower third',
  'date-chip': 'Date chip',
  'motion-graphic': 'Motion graphic',
  transition: 'Transition',
}

function Field({ label, children }) {
  return (
    <div>
      <label className="text-[10px] font-medium uppercase tracking-wider text-text-disabled block mb-1">
        {label}
      </label>
      {children}
    </div>
  )
}

// Uncontrolled numeric input committing on blur/Enter — keeps typing smooth
function NumberField({ value, onCommit, min, max, step = 0.1, disabled }) {
  return (
    <input
      key={value}
      type="number"
      defaultValue={Math.round(value * 100) / 100}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className="text-xs font-mono !py-1.5"
      onBlur={(e) => {
        const v = parseFloat(e.target.value)
        if (Number.isFinite(v) && Math.abs(v - value) > 1e-6) onCommit(v)
      }}
      onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
    />
  )
}

function GraphicScaleControl({ value, onCommit, applyToAll, onApplyToAll, allLabel }) {
  return (
    <div className="space-y-2 rounded-lg border border-border bg-background/45 p-2.5">
      <Field label={`Component size · ${Math.round(value * 100)}%`}>
        <input
          key={value}
          type="range"
          min="0.75"
          max="2"
          step="0.05"
          defaultValue={value}
          onPointerUp={(event) => onCommit(Number(event.currentTarget.value))}
          onKeyUp={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              onCommit(Number(event.currentTarget.value))
            }
          }}
          className="w-full accent-[var(--color-accent)]"
        />
      </Field>
      <label className="flex items-start gap-2 text-[10px] leading-relaxed text-text-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={applyToAll}
          onChange={(event) => onApplyToAll(event.target.checked)}
          className="mt-0.5"
        />
        <span>{allLabel}</span>
      </label>
    </div>
  )
}

const MODEL_OPTIONS = ['opus', 'sonnet']

function TraceEntry({ entry, defaultOpen = false }) {
  const [open, setOpen] = useState(defaultOpen)
  if (!entry) return null
  return (
    <div className="rounded-md border border-border bg-background/60 overflow-hidden">
      <button
        onClick={() => setOpen(value => !value)}
        className="w-full flex items-center gap-2 px-2.5 py-2 text-left hover:bg-surface-raised/50"
      >
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          entry.status === 'completed' ? 'bg-success' : entry.status === 'running' ? 'bg-warning animate-pulse' : 'bg-error'
        }`} />
        <span className="text-[10px] font-medium text-text-secondary truncate">{entry.label}</span>
        <span className="ml-auto text-[9px] uppercase tracking-wider text-text-disabled">{entry.model}</span>
        <span className="text-[10px] text-text-disabled">{open ? '−' : '+'}</span>
      </button>
      {open && (
        <div className="border-t border-border p-2.5 space-y-3">
          <div>
            <p className="text-[9px] uppercase tracking-wider text-text-disabled mb-1">System prompt</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-[9px] leading-relaxed text-text-secondary font-mono">{entry.systemPrompt || '—'}</pre>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wider text-text-disabled mb-1">Request</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-[9px] leading-relaxed text-text-secondary font-mono">{entry.userPrompt || '—'}</pre>
          </div>
          <div>
            <p className="text-[9px] uppercase tracking-wider text-text-disabled mb-1 flex items-center gap-1.5">
              Claude response
              {entry.status === 'running' && <span className="text-warning normal-case tracking-normal">streaming…</span>}
            </p>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-[9px] leading-relaxed text-text-primary font-mono">{entry.response || entry.error || 'Waiting for response…'}</pre>
          </div>
          {!!entry.validationErrors?.length && (
            <div>
              <p className="text-[9px] uppercase tracking-wider text-error mb-1">Validation</p>
              <pre className="whitespace-pre-wrap break-words text-[9px] leading-relaxed text-error font-mono">{entry.validationErrors.join('\n')}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const MAP_PRESENTATIONS = [
  { id: 'split', label: 'Split panel', hint: 'Footage and map side by side' },
  { id: 'corner', label: 'Corner card', hint: 'Small card, top right' },
  { id: 'inset', label: 'Inset card', hint: 'Card that expands to full' },
  { id: 'full', label: 'Full screen', hint: 'Takeover — use sparingly' },
]

function MapInspectorFields({ item, setPayload }) {
  const {
    regenerateMapItem,
    loadMapHistory,
    selectMapOption,
    decideMapAttempt,
    generateAllMaps,
    mapQueueRunning,
    mapQueueProgress,
  } = usePipelineStore()
  const [logsOpen, setLogsOpen] = useState(false)
  const [sourceDuration, setSourceDuration] = useState(null)
  const options = useMemo(() => {
    const retained = item.payload?.mapOptions || []
    if (retained.length) return retained
    if (item.payload?.src) {
      return [{
        id: 'current-output',
        url: item.payload.src,
        posterUrl: item.payload.posterUrl,
        status: 'recommended',
        label: 'Current output',
      }]
    }
    return []
  }, [item.payload?.mapOptions, item.payload?.src, item.payload?.posterUrl])
  // No fallback to options[0]: with a single retained option and nothing
  // promoted yet (needs-selection), a fallback made preview === selected and
  // hid the only path to actually using the map in the film.
  const selectedId = item.payload?.selectedOptionId
    || options.find(option => option.url === item.payload?.src)?.id
    || null
  const [previewId, setPreviewId] = useState(selectedId)
  useEffect(() => { setPreviewId(selectedId) }, [item.id, selectedId])
  useEffect(() => { void loadMapHistory(item.id) }, [item.id, loadMapHistory])
  useEffect(() => { setSourceDuration(null) }, [item.id, item.payload?.src])
  // A paused interactive run just rendered an attempt: jump the preview to it.
  const awaitingOptionId = item.payload?.awaitingDecision?.optionId || null
  useEffect(() => {
    if (awaitingOptionId) setPreviewId(awaitingOptionId)
  }, [awaitingOptionId])

  const preview = options.find(option => option.id === previewId) || options[0] || null
  const status = item.payload?.status || 'pending'
  const models = item.payload?.mapModels || { ideation: 'opus', executor: 'opus', reviewer: 'opus' }
  const trace = item.payload?.mapTrace
  const phaseEntries = [
    ...(trace?.phases?.ideation || []),
    ...(trace?.phases?.execution || []),
    ...(trace?.phases?.review || []),
  ]
  const setModel = (role, value) => setPayload({
    mapModels: { ...models, [role]: value },
  })

  return (
    <>
      <Field label="Preview">
        <div className="aspect-video rounded-md overflow-hidden border border-border bg-black">
          {preview?.url ? (
            <video
              key={preview.url}
              src={preview.url}
              poster={preview.posterUrl || undefined}
              controls
              preload="metadata"
              className="w-full h-full object-contain"
              onLoadedMetadata={(event) => {
                if (preview.url === item.payload?.src && Number.isFinite(event.currentTarget.duration)) {
                  setSourceDuration(event.currentTarget.duration)
                }
              }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-[10px] text-text-disabled">
              {status === 'rendering' ? 'generating map…' : 'no playable option yet'}
            </div>
          )}
        </div>
      </Field>

      {!!options.length && (
        <Field label={`Playable options (${options.length})`}>
          <div className="grid grid-cols-3 gap-2">
            {options.map((option, index) => (
              <button
                key={option.id}
                onClick={() => setPreviewId(option.id)}
                className={`text-left rounded-md border overflow-hidden transition-colors ${
                  preview?.id === option.id ? 'border-accent ring-1 ring-accent/40' : 'border-border hover:border-text-disabled'
                }`}
              >
                <div className="aspect-video bg-black">
                  {option.posterUrl
                    ? <img src={option.posterUrl} alt="" className="w-full h-full object-cover" />
                    : <div className="w-full h-full flex items-center justify-center text-[9px] text-text-disabled">MP4</div>}
                </div>
                <div className="px-1.5 py-1">
                  <p className="text-[9px] text-text-primary truncate">{option.label || `Option ${index + 1}`}</p>
                  <p className={`text-[8px] uppercase tracking-wider ${option.status === 'recommended' ? 'text-success' : 'text-warning'}`}>
                    {option.status || 'rendered'}
                  </p>
                </div>
              </button>
            ))}
          </div>
          {preview?.url && preview.id !== 'current-output' && preview.url !== item.payload?.src && (
            <button
              onClick={() => selectMapOption(item.id, preview.id)}
              className="btn-primary w-full py-1.5 text-xs mt-2"
            >
              Use this option in the film
            </button>
          )}
        </Field>
      )}

      {status === 'awaiting-decision' && item.payload?.awaitingDecision && (
        <Field label={`Attempt ${item.payload.awaitingDecision.attempt} rendered — your call`}>
          <p className="text-[10px] text-text-secondary leading-relaxed mb-1.5">
            Review the newest option above, then decide.
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => decideMapAttempt(item.id, 'accept')}
              className="btn-primary py-1.5 text-xs"
            >
              Use this attempt
            </button>
            {item.payload.awaitingDecision.canContinue ? (
              <button
                onClick={() => decideMapAttempt(item.id, 'continue')}
                className="btn-secondary py-1.5 text-xs"
              >
                Try another attempt
              </button>
            ) : (
              <button
                onClick={() => decideMapAttempt(item.id, 'stop')}
                className="btn-secondary py-1.5 text-xs"
              >
                Stop &amp; keep options
              </button>
            )}
          </div>
        </Field>
      )}

      <Field label="Presentation">
        <div className="grid grid-cols-2 gap-1.5">
          {MAP_PRESENTATIONS.map(mode => {
            const active = (item.payload?.presentation || 'split') === mode.id
            return (
              <button
                key={mode.id}
                onClick={() => setPayload({ presentation: mode.id })}
                className={`text-left px-2 py-1.5 rounded-md border transition-colors ${
                  active
                    ? 'border-accent bg-accent/10'
                    : 'border-border hover:border-text-disabled'
                }`}
              >
                <p className={`text-[10px] font-medium ${active ? 'text-accent' : 'text-text-primary'}`}>{mode.label}</p>
                <p className="text-[9px] text-text-disabled">{mode.hint}</p>
              </button>
            )
          })}
        </div>
        {item.payload?.suggestedPresentation && (
          <p className="text-[9px] text-text-disabled mt-1">
            Director suggests: {item.payload.suggestedPresentation}
          </p>
        )}
      </Field>

      {sourceDuration != null && sourceDuration > (item.endTime - item.startTime) + 0.05 && (
        <Field label="Source window">
          <input
            type="range"
            min={0}
            max={Math.max(0, sourceDuration - (item.endTime - item.startTime))}
            step={0.1}
            value={item.payload?.sourceStart || 0}
            onChange={(event) => setPayload({ sourceStart: Number(event.target.value) })}
            className="w-full"
          />
          <p className="text-[9px] text-text-disabled mt-1">
            Using {(item.payload?.sourceStart || 0).toFixed(1)}s–{((item.payload?.sourceStart || 0) + (item.endTime - item.startTime)).toFixed(1)}s
            of the {sourceDuration.toFixed(1)}s map video
          </p>
        </Field>
      )}

      <Field label="Status">
        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider border ${
          status === 'ready'
            ? 'text-success border-success/30 bg-success/10'
            : status === 'failed'
              ? 'text-error border-error/30 bg-error/10'
              : 'text-warning border-warning/30 bg-warning/10'
        }`}>
          {status}
        </span>
        {item.payload?.progressMessage && (
          <p className="text-[10px] text-warning mt-1.5 leading-relaxed">{item.payload.progressMessage}</p>
        )}
        {item.payload?.error && (
          <p className="text-[10px] text-error mt-1.5 leading-relaxed">{item.payload.error}</p>
        )}
      </Field>

      {item.payload?.request?.subject && (
        <Field label="Subject">
          <p className="text-xs text-text-secondary leading-relaxed">{item.payload.request.subject}</p>
        </Field>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Ideation model">
          <select
            value={models.ideation || 'opus'}
            disabled={status === 'rendering'}
            onChange={(event) => setModel('ideation', event.target.value)}
            className="text-xs !py-1.5"
          >
            {MODEL_OPTIONS.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </Field>
        <Field label="Executor model">
          <select
            value={models.executor || 'opus'}
            disabled={status === 'rendering'}
            onChange={(event) => setModel('executor', event.target.value)}
            className="text-xs !py-1.5"
          >
            {MODEL_OPTIONS.map(model => <option key={model} value={model}>{model}</option>)}
          </select>
        </Field>
      </div>
      <p className="text-[9px] text-text-disabled -mt-2">Quality gate: mechanical validation · every attempt stays selectable</p>

      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => regenerateMapItem(item.id)}
          disabled={status === 'rendering' || mapQueueRunning}
          className="btn-secondary py-1.5 text-xs disabled:opacity-40"
        >
          {status === 'rendering' ? 'Generating…' : 'Generate map'}
        </button>
        <button
          onClick={generateAllMaps}
          disabled={status === 'rendering' || mapQueueRunning}
          className="btn-secondary py-1.5 text-xs disabled:opacity-40"
        >
          {mapQueueRunning
            ? `Queue ${mapQueueProgress?.current || 0}/${mapQueueProgress?.total || 0}`
            : 'Generate all pending'}
        </button>
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <button
          onClick={() => setLogsOpen(value => !value)}
          className="w-full flex items-center justify-between px-2.5 py-2 text-[10px] font-medium text-text-secondary hover:bg-surface-raised/50"
        >
          <span>Generation request & live Claude log</span>
          <span>{logsOpen ? 'Minimize' : 'Expand'}</span>
        </button>
        {logsOpen && (
          <div className="border-t border-border p-2.5 space-y-2">
            {trace?.request && (
              <div className="rounded-md bg-background/60 border border-border p-2.5">
                <p className="text-[9px] uppercase tracking-wider text-text-disabled mb-1">Canonical map request</p>
                <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words text-[9px] leading-relaxed text-text-secondary font-mono">{JSON.stringify(trace.request, null, 2)}</pre>
              </div>
            )}
            {phaseEntries.length
              ? phaseEntries.map((entry, index) => <TraceEntry key={`${entry.label}-${index}`} entry={entry} defaultOpen={entry.status === 'running'} />)
              : <p className="text-[10px] text-text-disabled py-2">No saved Claude trace for this legacy result yet.</p>}
            {!!trace?.events?.length && (
              <div>
                <p className="text-[9px] uppercase tracking-wider text-text-disabled mb-1">Run events</p>
                <div className="max-h-36 overflow-auto space-y-1 font-mono text-[9px] text-text-secondary">
                  {trace.events.map((event, index) => <p key={index}>{event.at?.slice(11, 19)} · {event.message}</p>)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function InspectorPanel({ item, onClose, onDeleted }) {
  const {
    updateTimelineItem, resizeTimelineItem, deleteTimelineItem, setTimelineGraphicScale,
  } = usePipelineStore()
  const [applyScaleToAll, setApplyScaleToAll] = useState(false)

  useEffect(() => {
    setApplyScaleToAll(false)
  }, [item?.id])

  if (!item) return null

  const dur = item.endTime - item.startTime
  const setPayload = (patch) => updateTimelineItem(item.id, { payload: patch })
  const locked = !!item.locked

  const renderKindFields = () => {
    switch (item.kind) {
      case 'transition': {
        const selected = transitionDefinition(item.payload?.type)
        return (
          <>
            <Field label="Transition library">
              <div className="space-y-2">
                {TRANSITION_LIBRARY.map(option => {
                  const active = selected.id === option.id
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => updateTimelineItem(item.id, {
                        label: option.label,
                        payload: { type: option.id },
                      })}
                      className={`group w-full rounded-lg border p-2 text-left transition-colors ${
                        active ? 'border-accent bg-accent/10' : 'border-border hover:border-accent/50 bg-background/40'
                      }`}
                    >
                      <div className="relative h-9 mb-2 overflow-hidden rounded bg-black">
                        <div className="absolute inset-0 bg-gradient-to-br from-slate-700 to-slate-950" />
                        <div className={`absolute inset-0 bg-gradient-to-br from-amber-950 to-zinc-900 transition-all duration-700 ${
                          option.id === 'soft-blur'
                            ? 'opacity-80 blur-[3px] group-hover:blur-0 group-hover:opacity-100'
                            : option.id === 'dip-to-black'
                              ? 'opacity-0 group-hover:opacity-100'
                              : option.id === 'film-dissolve'
                                ? 'opacity-60 mix-blend-screen group-hover:opacity-100'
                                : 'opacity-55 group-hover:opacity-100'
                        }`} />
                        {option.id === 'dip-to-black' && <div className="absolute inset-0 bg-black opacity-70 group-hover:opacity-0 transition-opacity duration-700" />}
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-medium text-text-primary">{option.label}</span>
                        {active && <span className="ml-auto text-[8px] uppercase tracking-wider text-accent">Selected</span>}
                      </div>
                      <p className="mt-1 text-[9px] leading-relaxed text-text-disabled">{option.description}</p>
                    </button>
                  )
                })}
              </div>
            </Field>
            {item.payload?.reason && (
              <Field label="Director rationale">
                <p className="text-[10px] leading-relaxed text-text-secondary">{item.payload.reason}</p>
              </Field>
            )}
            <p className="text-[9px] leading-relaxed text-text-disabled">
              Double-clicking opened this transition at its live preview beat. Choosing another option updates both the Editor and final render.
            </p>
          </>
        )
      }
      case 'title':
        return (
          <>
            <Field label="Text">
              <input
                value={item.payload?.text || ''}
                onChange={(e) => setPayload({ text: e.target.value })}
                className="text-sm !py-1.5"
              />
            </Field>
            <Field label="Subtitle">
              <input
                value={item.payload?.subtitle || ''}
                onChange={(e) => setPayload({ subtitle: e.target.value })}
                className="text-sm !py-1.5"
              />
            </Field>
          </>
        )
      case 'lower-third':
        return (
          <>
            <Field label="Text">
              <input
                value={item.payload?.text || ''}
                onChange={(e) => setPayload({ text: e.target.value })}
                className="text-sm !py-1.5"
              />
            </Field>
            <Field label="Subtitle">
              <input
                value={item.payload?.subtitle || ''}
                onChange={(e) => setPayload({ subtitle: e.target.value })}
                className="text-sm !py-1.5"
              />
            </Field>
            <GraphicScaleControl
              value={item.payload?.textScale ?? 1.18}
              applyToAll={applyScaleToAll}
              onApplyToAll={setApplyScaleToAll}
              onCommit={(value) => setTimelineGraphicScale(item.id, item.kind, value, applyScaleToAll)}
              allLabel="Apply to every lower third and save as the library default"
            />
          </>
        )
      case 'date-chip':
        return (
          <>
            <Field label="Text">
              <input
                value={item.payload?.text || ''}
                onChange={(e) => setPayload({ text: e.target.value })}
                className="text-sm !py-1.5"
              />
            </Field>
            <Field label="Corner">
              <select
                value={item.payload?.corner || 'tr'}
                onChange={(e) => setPayload({ corner: e.target.value })}
                className="text-sm !py-1.5"
              >
                <option value="tl">Top left</option>
                <option value="tr">Top right</option>
                <option value="bl">Bottom left</option>
                <option value="br">Bottom right</option>
              </select>
            </Field>
            <GraphicScaleControl
              value={item.payload?.textScale ?? 1.22}
              applyToAll={applyScaleToAll}
              onApplyToAll={setApplyScaleToAll}
              onCommit={(value) => setTimelineGraphicScale(item.id, item.kind, value, applyScaleToAll)}
              allLabel="Apply to every chip and save as the library default"
            />
          </>
        )
      case 'sound-effect':
        return (
          <>
            <Field label="Narration cue">
              <p className="rounded border border-border bg-background/50 px-2.5 py-2 text-[10px] leading-relaxed text-text-secondary">
                {item.payload?.cue || item.label}
              </p>
            </Field>
            <Field label="Generation prompt">
              <textarea
                value={item.payload?.prompt || ''}
                readOnly
                rows={5}
                className="text-[10px] leading-relaxed resize-none"
              />
            </Field>
            <Field label="Volume">
              <NumberField
                value={item.payload?.volume ?? 0.28}
                min={0}
                max={1}
                step={0.02}
                onCommit={(volume) => setPayload({ volume })}
              />
            </Field>
          </>
        )
      case 'motion-graphic': {
        const spec = item.payload?.spec || {}
        const content = spec.composition?.content || {}
        const background = spec.composition?.background || {}
        const sound = spec.sound_design || {}
        const selectSoundOption = (cueIndex, option) => {
          const cues = [...(sound.cues || [])]
          cues[cueIndex] = {
            ...cues[cueIndex],
            asset: option.url,
            selected_option_id: option.id,
            anchor_seconds: option.anchor_seconds,
            duration_seconds: option.duration_seconds,
            analysis: option.analysis,
            status: 'ready',
          }
          const nextSound = { ...sound, enabled: true, cues }
          setPayload({
            spec: { ...spec, sound_design: nextSound },
            soundDesign: nextSound,
          })
        }
        return (
          <>
            <Field label="Director intent">
              <p className="text-xs text-text-secondary leading-relaxed">{spec.intent || '—'}</p>
            </Field>
            <Field label="Why this beat">
              <p className="text-[11px] text-text-secondary leading-relaxed">{spec.reason || '—'}</p>
            </Field>
            <Field label="On-screen title">
              <input
                value={content.title || ''}
                onChange={(e) => setPayload({
                  spec: {
                    ...spec,
                    composition: {
                      ...spec.composition,
                      content: { ...content, title: e.target.value },
                    },
                  },
                })}
                className="text-sm !py-1.5"
              />
            </Field>
            <Field label="Presentation">
              <select
                value={spec.presentation || 'overlay'}
                onChange={(e) => setPayload({ spec: { ...spec, presentation: e.target.value }, presentation: e.target.value })}
                className="text-sm !py-1.5"
              >
                <option value="overlay">Over footage</option>
                <option value="takeover">Full-frame takeover</option>
              </select>
            </Field>
            <Field label="Background">
              <select
                value={background.mode || 'footage-dim'}
                onChange={(e) => setPayload({
                  spec: {
                    ...spec,
                    composition: {
                      ...spec.composition,
                      background: { ...background, mode: e.target.value },
                    },
                  },
                })}
                className="text-sm !py-1.5"
              >
                <option value="footage-dim">Dimmed footage</option>
                <option value="editorial-gradient">Editorial gradient</option>
                <option value="archival-paper">Archival paper</option>
                <option value="technical-grid">Technical grid</option>
                <option value="soft-atmosphere">Soft atmosphere</option>
                <option value="spatial-field">Spatial field</option>
              </select>
            </Field>
            <Field label="Visual source">
              <p className="text-[10px] font-mono text-text-disabled break-all leading-relaxed">
                {spec.source?.mode === 'invent'
                  ? `Original · ${spec.source?.invention_notes || spec.intent}`
                  : `Adapted · ${spec.source?.reference_preset || 'visual grammar'}`}
              </p>
            </Field>
            <Field label="Analyzed sound design">
              <div className="space-y-2">
                <p className="text-[10px] text-text-secondary leading-relaxed">{sound.strategy || 'No strategy authored.'}</p>
                {(sound.cues || []).map((cue, cueIndex) => (
                  <div key={cue.id || cueIndex} className="rounded-md border border-border bg-background/50 p-2 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full ${cue.status === 'ready' ? 'bg-success' : cue.status === 'failed' ? 'bg-error' : 'bg-warning'}`} />
                      <span className="text-[10px] font-medium text-text-primary">{cue.role}</span>
                      <span className="ml-auto text-[9px] font-mono text-text-disabled">{Number(cue.at_seconds || 0).toFixed(2)}s</span>
                    </div>
                    <p className="text-[9px] leading-relaxed text-text-secondary">{cue.description}</p>
                    {(cue.options || []).map((option, optionIndex) => {
                      const selected = cue.selected_option_id === option.id || (!cue.selected_option_id && option.url === cue.asset)
                      return (
                        <div key={option.id || option.url} className={`rounded border p-1.5 ${selected ? 'border-primary/70 bg-primary/5' : 'border-border'}`}>
                          <div className="flex items-center gap-2 mb-1">
                            <button
                              onClick={() => selectSoundOption(cueIndex, option)}
                              className={`text-[9px] px-1.5 py-0.5 rounded ${selected ? 'bg-primary text-white' : 'bg-surface-raised text-text-secondary'}`}
                            >
                              {selected ? 'Selected' : `Use option ${optionIndex + 1}`}
                            </button>
                            <span className="text-[8px] font-mono text-text-disabled">
                              onset {Number(option.analysis?.detected_onset_seconds || 0).toFixed(2)}s · {Math.round(Number(option.analysis?.confidence || 0) * 100)}%
                            </span>
                          </div>
                          <audio controls preload="metadata" src={option.url} className="w-full h-7" />
                        </div>
                      )
                    })}
                    {!cue.options?.length && (
                      <p className="text-[9px] text-text-disabled">{cue.error || 'No generated asset attached.'}</p>
                    )}
                  </div>
                ))}
                <p className="text-[9px] text-text-disabled leading-relaxed">
                  Each selected cue is aligned by its detected waveform onset and mixed below narration.
                </p>
              </div>
            </Field>
          </>
        )
      }
      case 'clip':
        return (
          <>
            <Field label="Embedded audio">
              <label className="flex items-center justify-between text-xs text-text-secondary">
                <span>{item.payload?.muted ? 'Muted' : 'Enabled'}</span>
                <input
                  type="checkbox"
                  checked={!item.payload?.muted && (item.payload?.volume ?? 0) > 0}
                  onChange={(event) => setPayload(event.target.checked
                    ? { muted: false, volume: item.payload?.previousVolume || 1 }
                    : { muted: true, previousVolume: item.payload?.volume || 1 })}
                  className="accent-accent"
                />
              </label>
            </Field>
            <Field label="Volume (0–1)">
              <NumberField
                value={item.payload?.volume ?? 0}
                min={0} max={1} step={0.05}
                onCommit={(v) => setPayload({ volume: Math.max(0, Math.min(1, v)) })}
              />
            </Field>
            <Field label="Playback rate">
              <p className="text-xs font-mono text-text-secondary py-1">
                {(item.payload?.playbackRate ?? 1).toFixed(2)}× <span className="text-text-disabled">(from selection)</span>
              </p>
            </Field>
            <Field label="Source">
              <p className="text-[10px] font-mono text-text-disabled break-all leading-relaxed max-h-16 overflow-hidden">
                {item.payload?.src || '—'}
              </p>
            </Field>
          </>
        )
      case 'music':
        return (
          <>
            <Field label="Track preview">
              <audio controls preload="metadata" src={item.payload?.src} className="w-full h-8" />
            </Field>
            <Field label="Track">
              <p className="text-xs text-text-primary">{item.payload?.trackName || item.label}</p>
              <p className="mt-1 text-[9px] uppercase tracking-wider text-text-disabled">
                {[item.payload?.mood, item.payload?.provider, item.payload?.model].filter(Boolean).join(' · ')}
              </p>
            </Field>
            {item.payload?.reason && (
              <Field label="Director rationale">
                <p className="text-[10px] text-text-secondary leading-relaxed">{item.payload.reason}</p>
              </Field>
            )}
            <Field label="Audio">
              <label className="flex items-center justify-between text-xs text-text-secondary">
                <span>{item.payload?.muted ? 'Muted' : 'Enabled'}</span>
                <input
                  type="checkbox"
                  checked={!item.payload?.muted}
                  onChange={(event) => setPayload({ muted: !event.target.checked })}
                  className="accent-accent"
                />
              </label>
            </Field>
            <Field label="Authored volume (0–1)">
              <NumberField
                value={item.payload?.volume ?? 0.5}
                min={0} max={1} step={0.02}
                onCommit={(v) => setPayload({ volume: Math.max(0, Math.min(1, v)) })}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Fade in (s)">
                <NumberField
                  value={item.payload?.fadeInSeconds ?? 2.2}
                  min={0} max={8} step={0.1}
                  onCommit={(v) => setPayload({ fadeInSeconds: Math.max(0, Math.min(8, v)) })}
                />
              </Field>
              <Field label="Fade out (s)">
                <NumberField
                  value={item.payload?.fadeOutSeconds ?? 2.2}
                  min={0} max={8} step={0.1}
                  onCommit={(v) => setPayload({ fadeOutSeconds: Math.max(0, Math.min(8, v)) })}
                />
              </Field>
            </div>
            <Field label="Narration duck (dB)">
              <NumberField
                value={item.payload?.duckingDb ?? -3.5}
                min={-12} max={0} step={0.5}
                onCommit={(v) => setPayload({ duckingDb: Math.max(-12, Math.min(0, v)) })}
              />
            </Field>
            <Field label="Source">
              <p className="text-[9px] font-mono text-text-disabled break-all leading-relaxed">
                {item.payload?.src || '—'}
              </p>
            </Field>
          </>
        )
      case 'narration':
        return (
          <>
            <Field label="Audio">
              <label className="flex items-center justify-between text-xs text-text-secondary">
                <span>{item.payload?.muted ? 'Muted' : 'Enabled'}</span>
                <input
                  type="checkbox"
                  checked={!item.payload?.muted}
                  onChange={(event) => setPayload({ muted: !event.target.checked })}
                  className="accent-accent"
                />
              </label>
            </Field>
            <Field label="Source">
              <p className="text-[10px] font-mono text-text-disabled break-all leading-relaxed max-h-16 overflow-hidden">
                {item.payload?.src || '—'}
              </p>
            </Field>
            <p className="text-[10px] text-text-disabled leading-relaxed">
              Narration is locked to its scene — rebuild the timeline to re-derive it from the audio step.
            </p>
          </>
        )
      case 'map': {
        return <MapInspectorFields item={item} setPayload={setPayload} />
      }
      case 'chapter-reveal':
      case 'chapter-active':
        return (
          <>
            {item.kind === 'chapter-active' && (
              <Field label="Active chapter (index)">
                <NumberField
                  value={item.payload?.activeIndex ?? 0}
                  min={0}
                  max={Math.max(0, (item.payload?.chapters?.length || 1) - 1)}
                  step={1}
                  onCommit={(v) => setPayload({
                    activeIndex: Math.max(0, Math.min((item.payload?.chapters?.length || 1) - 1, Math.round(v))),
                  })}
                />
              </Field>
            )}
            <Field label="Chapters">
              <ul className="space-y-1">
                {(item.payload?.chapters || []).map((ch, i) => (
                  <li key={i} className="flex items-center gap-2 text-xs text-text-secondary">
                    <span className="font-mono text-[10px] text-text-disabled">{String(i + 1).padStart(2, '0')}</span>
                    <span className="truncate">{ch.title}</span>
                    {!ch.image && <span className="text-[9px] text-warning ml-auto shrink-0">no portrait</span>}
                  </li>
                ))}
              </ul>
            </Field>
          </>
        )
      default:
        return null
    }
  }

  return (
    <div className={`${item.kind === 'map' ? 'w-[36rem]' : 'w-72'} max-w-[48vw] shrink-0 border-l border-border bg-surface flex flex-col min-h-0`}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-text-primary">{KIND_LABELS[item.kind] || item.kind}</h3>
          <p className="text-[10px] text-text-disabled truncate">{item.label}</p>
        </div>
        <button
          onClick={onClose}
          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-surface-raised text-text-secondary shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        <Field label="Label">
          <input
            value={item.label || ''}
            onChange={(e) => updateTimelineItem(item.id, { label: e.target.value })}
            className="text-sm !py-1.5"
            disabled={locked}
          />
        </Field>

        <div className="grid grid-cols-2 gap-2">
          <Field label="Start (s)">
            <NumberField
              value={item.startTime}
              min={0}
              disabled={locked}
              onCommit={(v) => resizeTimelineItem(item.id, v, item.endTime)}
            />
          </Field>
          <Field label="End (s)">
            <NumberField
              value={item.endTime}
              min={0.5}
              disabled={locked}
              onCommit={(v) => resizeTimelineItem(item.id, item.startTime, v)}
            />
          </Field>
        </div>
        <p className="text-[10px] font-mono text-text-disabled -mt-2">duration {dur.toFixed(2)}s</p>

        {renderKindFields()}

        {(() => {
          const sound = item.payload?.spec?.sound_design || item.payload?.soundDesign
          const ready = (sound?.cues || []).some(cue => cue?.asset && cue.status !== 'failed')
          if (!ready) return null
          return (
            <Field label="Attached sound effects">
              <label className="flex items-center justify-between text-xs text-text-secondary">
                <span>{item.payload?.soundMuted ? 'Muted' : 'Enabled'}</span>
                <input
                  type="checkbox"
                  checked={!item.payload?.soundMuted}
                  onChange={(event) => setPayload({ soundMuted: !event.target.checked })}
                  className="accent-accent"
                />
              </label>
            </Field>
          )
        })()}
      </div>

      <div className="px-4 py-3 border-t border-border shrink-0">
        <button
          onClick={() => { deleteTimelineItem(item.id); onDeleted?.() }}
          disabled={locked}
          className="w-full py-1.5 text-xs rounded-lg border border-error/40 text-error hover:bg-error/10 transition-colors disabled:opacity-40"
        >
          Delete item
        </button>
      </div>
    </div>
  )
}

export default InspectorPanel
