import { useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  sceneSheetTemplateDataUrl,
  withSceneSheetTemplateContract,
} from '../lib/sceneSheets'

const statusLabel = (status) => ({
  'awaiting-upload': 'Waiting for your sheet',
  'awaiting-sheet': 'Waiting for sheet',
  cropped: 'Crop ready',
  expanding: 'Expanding',
  expanded: 'Expanded',
  failed: 'Needs attention',
}[status] || String(status || 'Pending').replaceAll('-', ' '))

async function copyImage(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Could not load reference image')
  const source = await response.blob()
  const png = source.type === 'image/png'
    ? source
    : await new Promise((resolve, reject) => {
        const image = new Image()
        image.crossOrigin = 'anonymous'
        const objectUrl = URL.createObjectURL(source)
        image.onload = () => {
          const canvas = document.createElement('canvas')
          canvas.width = image.naturalWidth
          canvas.height = image.naturalHeight
          canvas.getContext('2d').drawImage(image, 0, 0)
          canvas.toBlob(blob => {
            URL.revokeObjectURL(objectUrl)
            blob ? resolve(blob) : reject(new Error('Could not convert image'))
          }, 'image/png')
        }
        image.onerror = () => {
          URL.revokeObjectURL(objectUrl)
          reject(new Error('Could not decode image'))
        }
        image.src = objectUrl
      })
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
}

async function imageFileFromClipboard() {
  if (!navigator.clipboard?.read) {
    throw new Error('Clipboard image access is unavailable in this browser')
  }
  const clipboardItems = await navigator.clipboard.read()
  for (const item of clipboardItems) {
    const imageType = item.types.find(type => type.startsWith('image/'))
    if (!imageType) continue
    const blob = await item.getType(imageType)
    const extension = imageType.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
    return new File([blob], `scene-sheet-paste.${extension}`, { type: imageType })
  }
  throw new Error('The clipboard does not contain an image')
}

function ReferenceCard({ reference }) {
  return (
    <div className="rounded-xl border border-border bg-black/20 overflow-hidden">
      <div className="aspect-[3/4] bg-black/30">
        {reference.sourceUrl
          ? <img src={reference.sourceUrl} alt={reference.name} className="w-full h-full object-cover" />
          : <div className="w-full h-full grid place-items-center text-xs text-text-disabled">Reference unavailable</div>}
      </div>
      <div className="p-3">
        <p className="text-[10px] uppercase tracking-[0.18em] text-accent">Reference {reference.order}</p>
        <p className="text-sm text-text-primary mt-1 truncate">{reference.name}</p>
        <div className="flex gap-2 mt-3">
          <button
            disabled={!reference.sourceUrl}
            onClick={() => copyImage(reference.sourceUrl)
              .then(() => toast.success(`Reference ${reference.order} copied`))
              .catch(error => toast.error(error.message))}
            className="btn-secondary flex-1 py-1.5 text-[11px] disabled:opacity-40"
          >Copy image</button>
          <a
            href={reference.sourceUrl || undefined}
            download
            className={`btn-ghost px-2.5 py-1.5 text-[11px] ${reference.sourceUrl ? '' : 'pointer-events-none opacity-40'}`}
          >Save</a>
        </div>
      </div>
    </div>
  )
}

function SceneSheetGroup({
  group,
  selectedImages,
  onUpload,
  onExpand,
  onSelect,
  onGenerateWindows,
  defaultWindowsOutputCount = 1,
  onRefreshWindows,
  onSelectWindowsOption,
  planningLocked = false,
}) {
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(null)
  const [windowsOutputCount, setWindowsOutputCount] = useState(
    group.windowsGeneration
      && !['complete', 'failed', 'canceled'].includes(group.windowsGeneration.status)
      ? group.windowsGeneration.outputCount
      : defaultWindowsOutputCount,
  )
  const windowsJob = group.windowsGeneration
  const windowsActive = windowsJob && !['complete', 'failed', 'canceled'].includes(windowsJob.status)
  useEffect(() => {
    if (!windowsActive) {
      setWindowsOutputCount(defaultWindowsOutputCount)
    }
  }, [
    defaultWindowsOutputCount,
    group.windowsGeneration?.outputCount,
    windowsActive,
  ])
  const templateUrl = useMemo(
    () => sceneSheetTemplateDataUrl(group.layout, group.panels.length),
    [group.layout, group.panels.length],
  )
  const completePrompt = useMemo(
    () => withSceneSheetTemplateContract(group.masterPrompt, group.layout, group.panels.length),
    [group.masterPrompt, group.layout, group.panels.length],
  )
  const expandedCount = group.panels.filter(panel => panel.expandedUrl || panel.expanded_url).length
  const remainingOrdinals = group.panels
    .filter(panel => !(panel.expandedUrl || panel.expanded_url))
    .map(panel => panel.ordinal)
  const handleUpload = async (file) => {
    if (!file || planningLocked) return
    setBusy('upload')
    try {
      await onUpload(group.id, file)
      toast.success(`${group.title} validated and cropped`)
    } catch (error) {
      toast.error(error.response?.data?.message || error.message)
    } finally {
      setBusy(null)
      if (inputRef.current) inputRef.current.value = ''
    }
  }
  const handleExpand = async (ordinals) => {
    if (planningLocked) return
    setBusy('expand')
    try {
      await onExpand(group.id, ordinals)
      toast.success('Panel expansion pass complete')
    } catch (error) {
      toast.error(error.response?.data?.message || error.message)
    } finally {
      setBusy(null)
    }
  }
  const handleClipboardButton = async () => {
    try {
      await handleUpload(await imageFileFromClipboard())
    } catch (error) {
      toast.error(error.message)
    }
  }
  const handlePaste = (event) => {
    const item = [...(event.clipboardData?.items || [])]
      .find(candidate => candidate.kind === 'file' && candidate.type.startsWith('image/'))
    const file = item?.getAsFile()
    if (!file) return
    event.preventDefault()
    void handleUpload(file)
  }

  useEffect(() => {
    if (!windowsActive || !onRefreshWindows) return undefined
    let active = true
    const poll = async () => {
      if (!active) return
      try {
        await onRefreshWindows(group.id)
      } catch {
        // The durable Windows task remains active during transient broker
        // outages. Keep polling without converting infrastructure downtime to
        // a failed generation.
      }
    }
    const timer = window.setInterval(poll, 4000)
    void poll()
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [group.id, windowsActive, onRefreshWindows])

  const generateWithWindows = async (retry = false) => {
    if (!onGenerateWindows || planningLocked) return
    setBusy('windows')
    try {
      await onGenerateWindows(group.id, windowsOutputCount, retry)
      toast.success(retry ? 'Windows image retry queued' : 'Windows image generation queued')
    } catch (error) {
      toast.error(error.response?.data?.message || error.message)
    } finally {
      setBusy(null)
    }
  }

  const selectWindowsOption = async (ordinal) => {
    setBusy(`windows-select-${ordinal}`)
    try {
      await onSelectWindowsOption(group.id, ordinal)
      toast.success(`Variation ${ordinal} selected and cropped`)
    } catch (error) {
      toast.error(error.response?.data?.message || error.message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-surface/80 overflow-hidden shadow-xl shadow-black/10">
      <div className="p-5 border-b border-border bg-gradient-to-r from-accent/[0.08] to-transparent">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.2em] text-accent">Continuity sheet</span>
              <span className="text-[10px] px-2 py-0.5 rounded-full border border-border text-text-disabled">
                {group.layout.columns} × {group.layout.rows} · {group.panels.length} shots
              </span>
              {group.sheet?.needsOutpaint && <span className="text-[10px] px-2 py-0.5 rounded-full border border-accent/30 bg-accent/10 text-accent">
                AI canvas · auto-fit to 16:9
              </span>}
            </div>
            <h3 className="text-lg font-semibold text-text-primary mt-2">{group.title}</h3>
            <p className="text-xs text-text-secondary leading-relaxed mt-2 max-w-3xl">{group.scenarioContinuity}</p>
          </div>
          <span className="text-[10px] uppercase tracking-wider text-text-disabled">{statusLabel(group.status)}</span>
        </div>
      </div>

      <div className="p-5 space-y-6">
        <div className="grid lg:grid-cols-[minmax(0,1fr)_260px] gap-5">
          <div>
            <div className="flex items-center justify-between gap-3 mb-2">
              <p className="text-xs font-medium text-text-primary">Master generation prompt</p>
              <button
                onClick={() => navigator.clipboard.writeText(completePrompt)
                  .then(() => toast.success('Complete sheet prompt copied'))}
                className="btn-secondary py-1.5 px-3 text-xs"
              >Copy complete prompt</button>
            </div>
            <pre className="h-64 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-[#0d1117] p-4 text-[11px] leading-relaxed text-slate-300 font-mono">{completePrompt}</pre>
          </div>
          <div className="space-y-5">
            <div>
              <p className="text-xs font-medium text-text-primary mb-2">Grid template · attach first</p>
              <div className="rounded-xl border border-accent/25 bg-black/20 overflow-hidden">
                <div className="aspect-video bg-[#07090d]">
                  <img src={templateUrl} alt={`${group.layout.columns} by ${group.layout.rows} scene-sheet template`} className="w-full h-full object-contain" />
                </div>
                <div className="p-3">
                  <p className="text-[10px] leading-relaxed text-text-disabled">Give this image to the generator before the character references. It defines the exact canvas, panel order, dividers, and unused cells Content Machine will crop.</p>
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button
                      onClick={() => copyImage(templateUrl)
                        .then(() => toast.success('Grid template copied'))
                        .catch(error => toast.error(error.message))}
                      className="btn-secondary py-1.5 text-[11px]"
                    >Copy template</button>
                    <a href={templateUrl} download={`scene-sheet-grid-${group.panels.length}-panels.svg`} className="btn-ghost text-center py-1.5 text-[11px]">Save template</a>
                  </div>
                </div>
              </div>
            </div>
            <div>
            <p className="text-xs font-medium text-text-primary mb-2">Reference order</p>
            {group.references?.length
              ? <div className="grid grid-cols-2 lg:grid-cols-1 gap-3">{group.references.map(reference => <ReferenceCard key={`${reference.type}-${reference.order}`} reference={reference} />)}</div>
              : <div className="rounded-xl border border-dashed border-border p-4 text-xs text-text-disabled">This sheet has no recurring character reference. The continuity world and shot prompts are sufficient.</div>}
            </div>
          </div>
        </div>

        <div
          className="rounded-xl border border-border bg-surface-raised/50 p-4 outline-none focus:border-accent/50 focus:ring-1 focus:ring-accent/20"
          tabIndex={0}
          onPaste={handlePaste}
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-text-primary">Upload the finished {group.layout.columns}×{group.layout.rows} sheet</p>
              <p className="text-xs text-text-disabled mt-1">PNG, JPEG, or WebP · maximum 50 MiB. Native grids and common AI canvases (16:9, 3:2, 4:3) are supported; extracted panels are safely outpainted to final 16:9 frames.</p>
            </div>
            <div className="flex items-center gap-2">
              {group.sheetUrl && <a href={group.sheetUrl} target="_blank" rel="noreferrer" className="btn-ghost py-2 px-3 text-xs">View source</a>}
              <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={event => handleUpload(event.target.files?.[0])} />
              <button disabled={!!busy || planningLocked} onClick={() => inputRef.current?.click()} className="btn-secondary py-2 px-4 text-xs disabled:opacity-40">
                {busy === 'upload' ? 'Validating…' : group.sheetUrl ? 'Replace sheet' : 'Upload sheet'}
              </button>
              <button disabled={!!busy || planningLocked} onClick={handleClipboardButton} className="btn-secondary py-2 px-4 text-xs disabled:opacity-40">
                Paste image
              </button>
              <button disabled={!!busy || planningLocked || !group.sheetUrl || remainingOrdinals.length === 0} onClick={() => handleExpand(remainingOrdinals)} className="btn-primary py-2 px-4 text-xs disabled:opacity-40">
                {busy === 'expand' ? 'Expanding…' : expandedCount ? remainingOrdinals.length ? `Expand remaining (${remainingOrdinals.length})` : 'All panels expanded' : 'Expand all panels'}
              </button>
              {expandedCount > 0 && (
                <button
                  disabled={!!busy || planningLocked || !group.sheetUrl}
                  onClick={() => handleExpand(group.panels.map(panel => panel.ordinal))}
                  title="Regenerate every panel in this continuity sheet and automatically select each successful result"
                  className="btn-secondary py-2 px-4 text-xs disabled:opacity-40"
                >
                  Retry sheet group
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-accent/25 bg-gradient-to-r from-accent/[0.08] to-transparent p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-medium text-text-primary">Generate through Windows · Extra High</p>
                <span className="rounded-full border border-accent/30 bg-accent/10 px-2 py-0.5 text-[9px] uppercase tracking-wider text-accent">1 active task</span>
              </div>
              <p className="text-xs text-text-disabled mt-1">
                Content Machine sends the grid first and one ordered character board second. Windows owns provider retries and uploads every result directly to R2.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label
                className="text-[10px] uppercase tracking-wider text-text-disabled"
                title="Number of alternatives to request for the next generated set. Existing completed sets keep their original alternatives."
              >
                Next set options
              </label>
              <select
                value={windowsOutputCount}
                onChange={event => setWindowsOutputCount(Number(event.target.value))}
                disabled={windowsActive || busy === 'windows'}
                className="text-xs py-2"
              >
                {[1, 2, 3].map(count => <option key={count} value={count}>{count}</option>)}
              </select>
              <button
                disabled={planningLocked || windowsActive || busy === 'windows'}
                onClick={() => generateWithWindows(windowsJob?.status === 'failed')}
                className="btn-primary py-2 px-4 text-xs disabled:opacity-40"
              >
                {busy === 'windows'
                  ? 'Queueing…'
                  : windowsActive
                    ? 'Generating…'
                      : ['failed', 'canceled'].includes(windowsJob?.status)
                      ? 'Retry Windows'
                      : windowsJob?.status === 'complete'
                        ? 'Generate new set'
                        : 'Generate with Windows'}
              </button>
            </div>
          </div>
          {windowsJob && (
            <div className="mt-4">
              <div className="flex items-center justify-between gap-3 text-[10px]">
                <span className="uppercase tracking-wider text-text-secondary">
                  {String(windowsJob.progress?.phase || windowsJob.status).replaceAll('-', ' ')}
                  {windowsJob.attempts ? ` · worker pass ${windowsJob.attempts}/3` : ''}
                  {windowsJob.status === 'retrying' && windowsJob.nextAttemptAt
                    ? ` · resumes ${new Date(windowsJob.nextAttemptAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                    : ''}
                </span>
                <span className="text-accent">{windowsJob.progress?.percent || (windowsJob.status === 'complete' ? 100 : 0)}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-surface-raised overflow-hidden mt-2">
                <div
                  className="h-full bg-accent rounded-full transition-[width] duration-500"
                  style={{ width: `${windowsJob.progress?.percent || (windowsJob.status === 'complete' ? 100 : 4)}%` }}
                />
              </div>
              {windowsJob.error && (
                <p className="text-[10px] text-error mt-2">{windowsJob.error.message}</p>
              )}
              {windowsJob.outputs?.length > 0 && (
                <>
                  <p className="mt-3 text-[10px] text-text-disabled">
                    This completed set contains {windowsJob.outputs.length} generated {windowsJob.outputs.length === 1 ? 'option' : 'options'}.
                    The “Next set options” selector only applies when generating a new set.
                  </p>
                  <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3 mt-3">
                    {windowsJob.outputs.map((output, index) => {
                    const selected = windowsJob.selectedOrdinal === output.ordinal
                    const validLayout = output.layoutValidation?.valid !== false
                    return (
                      <article
                        key={output.ordinal}
                        className={`rounded-xl border overflow-hidden bg-black/20 ${
                          selected ? 'border-success ring-1 ring-success/30' : 'border-border'
                        }`}
                      >
                        <a href={output.url} target="_blank" rel="noreferrer" className="block aspect-video bg-black/40">
                          <img src={output.url} alt={`Windows variation ${output.ordinal}`} className="w-full h-full object-cover" />
                        </a>
                        <div className="p-3 flex items-center justify-between gap-3">
                          <div>
                            <p className="text-xs text-text-primary">Variation {output.ordinal}</p>
                            <p className="text-[9px] text-text-disabled">{output.width}×{output.height}</p>
                            <p className={`text-[9px] mt-0.5 ${validLayout ? 'text-success' : 'text-error'}`}>
                              {output.layoutValidation?.message || 'Validated output'}
                            </p>
                          </div>
                          <button
                            onClick={() => selectWindowsOption(output.ordinal)}
                            disabled={!!busy || selected || !validLayout}
                            className="btn-secondary px-3 py-1.5 text-[10px] disabled:opacity-40"
                          >
                            {busy === `windows-select-${output.ordinal}`
                              ? 'Applying…'
                              : selected
                                ? 'Selected'
                                : !validLayout
                                  ? 'Incompatible'
                                  : index === 0
                                  ? 'Use first'
                                  : 'Use variation'}
                          </button>
                        </div>
                      </article>
                    )
                    })}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-4">
          {group.panels.map(panel => {
            const expandedUrl = panel.expandedUrl || panel.expanded_url
            const cropUrl = panel.cropUrl || panel.crop_url
            const selected = selectedImages[panel.unitId]?.sceneSheetGroupId === group.id
            return (
              <article key={panel.unitId} className={`rounded-xl border overflow-hidden ${selected ? 'border-success ring-1 ring-success/30' : 'border-border'} bg-black/15`}>
                <div className="aspect-video bg-black/40 relative">
                  {expandedUrl || cropUrl
                    ? <img src={expandedUrl || cropUrl} alt={panel.label} className="w-full h-full object-cover" />
                    : <div className="w-full h-full grid place-items-center text-xs text-text-disabled">Panel {String(panel.ordinal).padStart(2, '0')}</div>}
                  <span className="absolute top-2 left-2 rounded bg-black/70 border border-white/10 px-2 py-1 text-[10px] text-white">{String(panel.ordinal).padStart(2, '0')}</span>
                  {selected && <span className="absolute top-2 right-2 rounded bg-success/90 px-2 py-1 text-[10px] text-white">Selected</span>}
                </div>
                <div className="p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-medium text-text-primary">{panel.label}</p>
                    <span className={`text-[9px] uppercase tracking-wider ${panel.status === 'failed' ? 'text-error' : 'text-text-disabled'}`}>{statusLabel(panel.status)}</span>
                  </div>
                  <p className="text-[10px] text-text-disabled leading-relaxed mt-2 line-clamp-3">{panel.prompt}</p>
                  {panel.error && <p className="text-[10px] text-error mt-2">{panel.error}</p>}
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button disabled={!cropUrl || !!busy || planningLocked} onClick={() => handleExpand([panel.ordinal])} className="btn-secondary py-1.5 text-[11px] disabled:opacity-40">{expandedUrl ? 'Re-expand' : 'Expand panel'}</button>
                    <button disabled={!expandedUrl || !!busy || selected || planningLocked} onClick={() => onSelect(group.id, panel.unitId)} className="btn-secondary py-1.5 text-[11px] disabled:opacity-40">{selected ? 'Auto-selected' : 'Use this frame'}</button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}

export default function SceneSheetWorkspace({
  workflow,
  selectedImages,
  onPlan,
  onRefresh,
  onUpload,
  onGenerateWindows,
  onBeginWindows,
  onCancelWindows,
  onRefreshWindows,
  onSelectWindowsOption,
  onExpand,
  onSelect,
  onSelectAllExpanded,
  defaultWindowsOutputCount = 1,
}) {
  const [planning, setPlanning] = useState(false)
  const [bulkWindowsGeneration, setBulkWindowsGeneration] = useState(false)
  const [cancelingWindows, setCancelingWindows] = useState(false)
  const serverPlanning = workflow?.status === 'planning'
  const planningMeta = workflow?.planning
  const totals = useMemo(() => {
    const panels = workflow?.groups?.flatMap(group => group.panels || []) || []
    return {
      sheets: workflow?.groups?.length || 0,
      panels: panels.length,
      expanded: panels.filter(panel => panel.expandedUrl || panel.expanded_url).length,
      selected: panels.filter(panel => {
        const group = workflow?.groups?.find(candidate => candidate.panels?.includes(panel))
        return selectedImages[panel.unitId]?.sceneSheetGroupId === group?.id
      }).length,
      isolated: workflow?.isolatedUnitIds?.length || workflow?.isolated_unit_ids?.length || 0,
    }
  }, [workflow, selectedImages])

  useEffect(() => {
    if (!serverPlanning || !onRefresh) return undefined
    let active = true
    let timer = null
    let inFlight = false
    const poll = async () => {
      if (!active || inFlight) return
      inFlight = true
      try {
        await onRefresh()
      } catch {
        // Planning is server-owned. A transient status request failure should
        // stay pending and retry instead of being presented as a plan failure.
      } finally {
        inFlight = false
        if (active) timer = window.setTimeout(poll, 1500)
      }
    }
    timer = window.setTimeout(poll, 500)
    return () => {
      active = false
      if (timer) window.clearTimeout(timer)
    }
  }, [serverPlanning, onRefresh])

  const plan = async () => {
    setPlanning(true)
    try {
      const nextWorkflow = await onPlan()
      toast.success(nextWorkflow?.status === 'planning'
        ? 'Scene-sheet planning started — results will appear as each Sonnet chunk finishes'
        : 'Continuity sheet plan ready')
    } catch (error) {
      toast.error(error.response?.data?.message || error.message)
    } finally {
      setPlanning(false)
    }
  }

  const generatePendingWindowsSheets = async () => {
    const pending = (workflow?.groups || []).filter(group =>
      !group.windowsGeneration
      || ['failed', 'canceled'].includes(group.windowsGeneration.status)
    )
    if (!pending.length || !onGenerateWindows) return
    setBulkWindowsGeneration(true)
    try {
      const runId = await onBeginWindows?.()
      const results = await Promise.allSettled(pending.map(group =>
        onGenerateWindows(
          group.id,
          defaultWindowsOutputCount,
          ['failed', 'canceled'].includes(group.windowsGeneration?.status),
          runId,
        )
      ))
      const failed = results.filter(result => result.status === 'rejected')
      if (failed.length) {
        toast.error(`${pending.length - failed.length} sheets queued; ${failed.length} could not be queued`)
      } else {
        toast.success(`${pending.length} Windows scene-sheet tasks queued`)
      }
    } finally {
      setBulkWindowsGeneration(false)
    }
  }

  const cancelWindows = async () => {
    if (!onCancelWindows) return
    setCancelingWindows(true)
    try {
      await onCancelWindows()
      toast.success('All Windows image generation canceled')
    } catch (error) {
      toast.error(error.response?.data?.message || error.message)
    } finally {
      setBulkWindowsGeneration(false)
      setCancelingWindows(false)
    }
  }

  const hasActiveWindows = (workflow?.groups || []).some(group => {
    const status = group.windowsGeneration?.status
    return status && !['complete', 'failed', 'canceled'].includes(status)
  })

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-accent/25 bg-gradient-to-br from-accent/[0.10] via-surface to-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-3xl">
            <p className="text-[10px] uppercase tracking-[0.22em] text-accent">Scene sheets · experimental</p>
            <h2 className="text-xl font-semibold text-text-primary mt-2">Continuity-first image generation</h2>
            <p className="text-sm text-text-secondary leading-relaxed mt-2">Compatible shots—even non-adjacent ones—share one visual world. Copy the authored prompt and ordered references, generate the sheet with your preferred provider, upload it here, then expand and approve every panel independently.</p>
          </div>
          <div className="flex items-center gap-2">
            {workflow?.groups?.some(group =>
              !group.windowsGeneration || ['failed', 'canceled'].includes(group.windowsGeneration.status)
            ) && (
              <button
                onClick={generatePendingWindowsSheets}
                disabled={planning || serverPlanning || bulkWindowsGeneration}
                className="btn-secondary px-4 py-2 text-xs disabled:opacity-40"
              >
                {bulkWindowsGeneration ? 'Queueing Windows sheets…' : 'Generate pending with Windows'}
              </button>
            )}
            {(hasActiveWindows || bulkWindowsGeneration) && (
              <button
                onClick={cancelWindows}
                disabled={cancelingWindows}
                className="px-4 py-2 text-xs rounded-lg border border-error/30 bg-error/10 text-error hover:bg-error/20 disabled:opacity-40"
              >
                {cancelingWindows ? 'Canceling…' : 'Cancel all Windows tasks'}
              </button>
            )}
            {totals.expanded > 0 && onSelectAllExpanded && (
              <button
                onClick={() => {
                  try {
                    const selected = onSelectAllExpanded()
                    toast.success(`${Object.keys(selected || {}).length} latest expanded frames selected`)
                  } catch (error) {
                    toast.error(error.message)
                  }
                }}
                disabled={totals.expanded !== totals.panels || totals.selected === totals.panels}
                title={totals.expanded !== totals.panels
                  ? 'Expand every panel before selecting the complete sheet set'
                  : 'Replace older selections with every latest expanded sheet frame'}
                className="btn-secondary px-4 py-2 text-xs disabled:opacity-40"
              >
                {totals.selected === totals.panels ? 'Latest frames selected' : `Use all expanded frames (${totals.expanded})`}
              </button>
            )}
            <button onClick={plan} disabled={planning || serverPlanning} className="btn-primary px-4 py-2 text-xs disabled:opacity-40">
              {serverPlanning
                ? `Planning ${planningMeta?.completedChunks || 0}/${planningMeta?.totalChunks || 0} chunks…`
                : planning
                  ? 'Starting Sonnet planners…'
                  : workflow?.groups?.length ? 'Re-plan sheets' : 'Plan scene sheets'}
            </button>
          </div>
        </div>
        {serverPlanning && planningMeta && (
          <div className="mt-5 rounded-xl border border-accent/25 bg-black/15 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium text-text-primary">
                  Planning continuity with up to {planningMeta.maxParallel || 3} parallel Sonnet sessions
                </p>
                <p className="text-[10px] text-text-disabled mt-1">
                  {planningMeta.processedUnits || 0}/{planningMeta.totalUnits || 0} shots analyzed
                  {' · '}{planningMeta.activeChunks || 0} active
                  {' · '}{planningMeta.fallbackChunks || 0} deterministic fallback
                </p>
              </div>
              <span className="text-sm font-semibold text-accent">{planningMeta.percent || 0}%</span>
            </div>
            <div className="h-1.5 rounded-full bg-surface-raised overflow-hidden mt-3">
              <div
                className="h-full bg-accent rounded-full transition-[width] duration-500"
                style={{ width: `${planningMeta.percent || 0}%` }}
              />
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2 mt-3">
              {(planningMeta.chunks || []).map(chunk => (
                <div key={chunk.index} className="flex items-center gap-2 rounded-lg border border-border bg-surface/50 px-3 py-2">
                  {chunk.status === 'running'
                    ? <div className="w-3 h-3 rounded-full border-2 border-accent border-t-transparent animate-spin shrink-0" />
                    : <span className={`w-2 h-2 rounded-full shrink-0 ${
                      chunk.status === 'completed'
                        ? chunk.usedFallback ? 'bg-warning' : 'bg-success'
                        : chunk.status === 'failed' ? 'bg-error' : 'bg-border'
                    }`} />}
                  <div className="min-w-0">
                    <p className="text-[10px] text-text-secondary truncate">
                      Chunk {chunk.index + 1} · {chunk.unitCount} shots
                    </p>
                    <p className="text-[9px] uppercase tracking-wider text-text-disabled">
                      {chunk.status === 'completed' && chunk.usedFallback
                        ? 'Completed with safe fallback'
                        : chunk.status}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <p className="text-[10px] text-text-disabled mt-3">
              Completed groups appear below immediately. Upload controls unlock after every chunk is finalized so a late planner result cannot invalidate your work.
            </p>
          </div>
        )}
        {workflow && <div className="grid grid-cols-4 gap-3 mt-5">
          {[['Sheets', totals.sheets], ['Sheet shots', totals.panels], ['Expanded', totals.expanded], ['Standard shots', totals.isolated]].map(([label, value]) => <div key={label} className="rounded-xl border border-border bg-black/15 px-3 py-2"><p className="text-lg text-text-primary">{value}</p><p className="text-[9px] uppercase tracking-wider text-text-disabled">{label}</p></div>)}
        </div>}
      </div>
      {(workflow?.groups || []).map(group => (
        <SceneSheetGroup
          key={group.id}
          group={group}
          selectedImages={selectedImages}
          onUpload={onUpload}
          onGenerateWindows={onGenerateWindows}
          defaultWindowsOutputCount={defaultWindowsOutputCount}
          onRefreshWindows={onRefreshWindows}
          onSelectWindowsOption={onSelectWindowsOption}
          onExpand={onExpand}
          onSelect={onSelect}
          planningLocked={serverPlanning}
        />
      ))}
      {workflow && !workflow.groups?.length && !serverPlanning && <div className="rounded-xl border border-border p-5 text-sm text-text-secondary">No shots share a sufficiently strong continuity world. All shots will use the standard individual image flow.</div>}
    </div>
  )
}
