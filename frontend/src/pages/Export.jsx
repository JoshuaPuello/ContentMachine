import { useState, useEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { usePipelineStore } from '../store/pipelineStore'
import { timelineTotalDuration } from '../lib/timeline'
import toast from 'react-hot-toast'
import api from '../services/api'

// ─── Final Film — full cinematic render via the studio timeline ─────────────
const CINEMA_STYLES = [
  { value: 'chronicle', label: 'Chronicle' },
  { value: 'heritage', label: 'Heritage' },
  { value: 'nocturne', label: 'Nocturne' },
]

const fmtDuration = (s) => {
  const m = Math.floor(s / 60)
  const sec = Math.round(s % 60)
  return `${m}:${String(sec).padStart(2, '0')}`
}

function FinalFilmCard() {
  const navigate = useNavigate()
  const logRef = useRef(null)
  const {
    timeline,
    renderJob,
    renderHistory,
    renderFilm,
    cancelRender,
    loadRenderHistory,
    deleteRenderVersion,
    deleteAllRenderVersions,
    settings,
    setCinemaStyle,
  } = usePipelineStore()

  const isRendering = renderJob?.status === 'running'

  // Keep the log tail pinned to the bottom
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [renderJob?.log?.length])

  useEffect(() => {
    loadRenderHistory().catch(error => {
      toast.error(`Could not load render history: ${error.message}`)
    })
  }, [loadRenderHistory])

  const handleRender = () => {
    renderFilm().catch(err => toast.error(`Render failed to start: ${err.message}`))
  }

  const counts = (() => {
    const items = timeline?.items || []
    const of = (pred) => items.filter(pred).length
    return {
      clips: of(i => i.kind === 'clip'),
      narration: of(i => i.kind === 'narration'),
      cinema: of(i => ['map', 'chapter-reveal', 'chapter-active', 'title'].includes(i.kind)),
      graphics: of(i => ['lower-third', 'date-chip'].includes(i.kind)),
      music: of(i => i.kind === 'music'),
    }
  })()
  const totalDuration = timelineTotalDuration(timeline?.items || [])

  return (
    <section className="bg-surface border border-border rounded-xl p-6">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Final Film</h2>
          <p className="text-xs text-text-secondary mt-0.5">
            Full cinematic render of the studio timeline (Remotion)
          </p>
        </div>
        {timeline?.built && (
          <div className="flex items-center gap-2">
            <select
              value={settings.cinemaStyle || 'chronicle'}
              onChange={e => setCinemaStyle(e.target.value)}
              disabled={isRendering}
              className="!w-32 text-xs !py-1.5"
              title="Cinema style variant"
            >
              {CINEMA_STYLES.map(s => (
                <option key={s.value} value={s.value}>{s.label}</option>
              ))}
            </select>
            {isRendering ? (
              <button
                onClick={() => cancelRender()}
                className="px-3 py-1.5 text-xs rounded-lg border border-error/40 text-error hover:bg-error/10 transition-colors"
              >
                Cancel
              </button>
            ) : (
              <button onClick={handleRender} className="btn-primary py-1.5 px-4 text-xs font-medium">
                {renderHistory.length ? 'Render New Version' : 'Render Final Film'}
              </button>
            )}
          </div>
        )}
      </div>

      {!timeline?.built ? (
        <div className="text-center py-8">
          <p className="text-sm text-text-secondary mb-3">
            The studio timeline hasn't been built yet — arrange the film in the Editor first.
          </p>
          <button onClick={() => navigate('/editor')} className="btn-primary px-5 py-2 text-sm">
            Open Editor
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Timeline summary */}
          <div className="flex flex-wrap gap-1.5">
            <span className="text-[10px] bg-surface-raised border border-border rounded px-2 py-1 text-text-secondary font-mono">
              {fmtDuration(totalDuration)}
            </span>
            <span className="text-[10px] bg-surface-raised border border-border rounded px-2 py-1 text-text-secondary">
              {counts.clips} clips
            </span>
            <span className="text-[10px] bg-surface-raised border border-border rounded px-2 py-1 text-text-secondary">
              {counts.narration} narration
            </span>
            {counts.cinema > 0 && (
              <span className="text-[10px] bg-surface-raised border border-border rounded px-2 py-1 text-text-secondary">
                {counts.cinema} cinema
              </span>
            )}
            {counts.graphics > 0 && (
              <span className="text-[10px] bg-surface-raised border border-border rounded px-2 py-1 text-text-secondary">
                {counts.graphics} graphics
              </span>
            )}
            {counts.music > 0 && (
              <span className="text-[10px] bg-surface-raised border border-border rounded px-2 py-1 text-text-secondary">
                {counts.music} music
              </span>
            )}
          </div>

          {/* Render progress / result */}
          {renderJob && (
            <div className="space-y-3">
              {isRendering && (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-text-secondary flex items-center gap-2">
                      <div className="w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
                      {renderJob.stage || 'working'}…
                    </span>
                    <span className="font-mono text-text-secondary">{renderJob.progress || 0}%</span>
                  </div>
                  <div className="h-1.5 bg-surface-raised rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-all duration-500"
                      style={{ width: `${renderJob.progress || 0}%` }}
                    />
                  </div>
                </>
              )}

              {renderJob.status === 'failed' && (
                <div className="border border-error/30 bg-error/5 rounded-lg p-3">
                  <p className="text-xs text-error leading-relaxed mb-2">{renderJob.error || 'Render failed'}</p>
                  <button onClick={handleRender} className="btn-secondary py-1.5 px-3 text-xs">
                    Retry render
                  </button>
                </div>
              )}

              {renderJob.status === 'canceled' && (
                <p className="text-xs text-text-disabled">Render canceled.</p>
              )}

              {renderJob.status === 'completed' && renderJob.output && (
                <p className="text-xs text-success">New render completed and added to this project's history.</p>
              )}

              {/* Live log tail */}
              {(isRendering || renderJob.status === 'failed') && renderJob.log?.length > 0 && (
                <pre
                  ref={logRef}
                  className="font-mono text-[10px] leading-relaxed text-text-secondary bg-background border border-border rounded-lg p-3 max-h-40 overflow-y-auto whitespace-pre-wrap"
                >
                  {renderJob.log.join('\n')}
                </pre>
              )}
            </div>
          )}

          <div className="border-t border-border pt-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h3 className="text-xs font-semibold text-text-primary">Project Render History</h3>
                <p className="text-[10px] text-text-disabled mt-0.5">
                  Every final MP4 generated for this project is retained here.
                </p>
              </div>
              {renderHistory.length > 0 && (
                <button
                  type="button"
                  onClick={async () => {
                    if (!window.confirm(`Delete all ${renderHistory.length} rendered films for this project? This cannot be undone.`)) return
                    try {
                      await deleteAllRenderVersions()
                      toast.success('All project renders deleted')
                    } catch (error) {
                      toast.error(`Delete failed: ${error.message}`)
                    }
                  }}
                  className="text-[10px] text-error hover:text-error/80"
                >
                  Delete all
                </button>
              )}
            </div>
            {renderHistory.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border py-7 text-center text-xs text-text-disabled">
                No final films have been rendered for this project yet.
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {renderHistory.map((render, index) => (
                  <article key={render.name} className="rounded-lg border border-border bg-background/50 overflow-hidden">
                    <video controls preload="metadata" src={render.url} className="w-full aspect-video bg-black" />
                    <div className="p-3">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-text-primary truncate">
                            {index === 0 ? 'Latest · ' : ''}{render.name}
                          </p>
                          <p className="text-[10px] text-text-disabled mt-1">
                            {new Date(render.createdAt).toLocaleString()} · {(render.size / 1024 / 1024).toFixed(1)} MB
                          </p>
                        </div>
                        <div className="ml-auto flex items-center gap-2 shrink-0">
                          <a href={render.url} download className="text-[10px] text-accent hover:text-accent-hover">
                            Download
                          </a>
                          <button
                            type="button"
                            onClick={async () => {
                              if (!window.confirm(`Delete ${render.name}? This cannot be undone.`)) return
                              try {
                                await deleteRenderVersion(render.name)
                                toast.success('Render deleted')
                              } catch (error) {
                                toast.error(`Delete failed: ${error.message}`)
                              }
                            }}
                            className="text-[10px] text-error hover:text-error/80"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}

// Lightbox with history navigation for thumbnails.
// versions: [{url, prompt}] oldest-first, last entry is latest.
function ThumbnailLightbox({ versions, slotIndex, selectedThumbnail, onSelect, onClose }) {
  const [viewIndex, setViewIndex] = useState(versions.length - 1)

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Escape')      onClose()
      if (e.key === 'ArrowLeft')   setViewIndex(i => Math.max(0, i - 1))
      if (e.key === 'ArrowRight')  setViewIndex(i => Math.min(versions.length - 1, i + 1))
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose, versions.length])

  const viewed   = versions[viewIndex]
  const isLatest = viewIndex === versions.length - 1
  const total    = versions.length
  const sel      = Array.isArray(selectedThumbnail) ? selectedThumbnail : selectedThumbnail ? [selectedThumbnail] : []
  const isSelected = sel.some(t => t.index === slotIndex)

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      className="fixed inset-0 bg-black/90 backdrop-blur-sm z-50 flex items-center justify-center p-6"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.92 }} transition={{ duration: 0.15 }}
        className="relative max-w-5xl w-full"
        onClick={e => e.stopPropagation()}
      >
        <img src={viewed?.url} alt="" className="w-full rounded-xl shadow-2xl" />

        {/* Left arrow */}
        {total > 1 && viewIndex > 0 && (
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
        {total > 1 && !isLatest && (
          <button
            onClick={() => setViewIndex(i => i + 1)}
            className="absolute right-16 top-1/2 -translate-y-1/2 w-9 h-9 bg-black/60 hover:bg-black/80 rounded-full flex items-center justify-center text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}

        <div className="absolute top-3 right-3 flex gap-2">
          <button
            onClick={onSelect}
            className="px-3 py-1.5 bg-accent text-white text-xs font-medium rounded-lg shadow-lg hover:bg-accent-hover transition-colors"
          >
            {isSelected ? 'Deselect' : 'Select for export'}
          </button>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center bg-black/60 text-white rounded-lg hover:bg-black/80 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="text-center text-xs text-white/50 mt-3">
          Thumbnail {slotIndex + 1}
          {total > 1 ? ` · Version ${viewIndex + 1} of ${total}${isLatest ? ' (latest)' : ''}` : ''}
        </p>
      </motion.div>
    </motion.div>
  )
}

function Export() {
  const location = useLocation()
  const navigate = useNavigate()
  const isMetadataPage = location.pathname === '/metadata'
  const [thumbnailProvider, setThumbnailProvider] = useState('fal')
  const [customTag, setCustomTag] = useState('')
  const [exporting, setExporting] = useState(false)
  const [lightboxIndex, setLightboxIndex] = useState(null)

  const {
    selectedStory,
    youtubeMetadata,
    metadataLoading,
    metadataError,
    thumbnailLoading,
    selectedTitle,
    thumbnailPrompts,
    thumbnails,
    thumbnailHistory,
    selectedThumbnail,
    includeThumbnail,
    includeMetadata,
    fetchMetadata,
    fetchThumbnailPrompts,
    generateThumbnails,
    regenerateThumbnail,
    selectThumbnail,
    setSelectedTitle,
    updateDescription,
    updateTags,
    updateChapters,
    setIncludeThumbnail,
    setIncludeMetadata,
    exportProject,
    retryMetadata,
    settings,
  } = usePipelineStore()

  useEffect(() => {
    if (isMetadataPage && !youtubeMetadata && !metadataLoading) {
      initMetadata()
    }
  }, [isMetadataPage])

  useEffect(() => {
    if (location.pathname === '/export') {
      document.getElementById('final-film-export')?.scrollIntoView({ block: 'start' })
    }
  }, [location.pathname])

  // Toast on errors
  useEffect(() => {
    if (metadataError) {
      toast.error(`Metadata generation failed: ${metadataError}`, { id: 'meta-error', duration: 6000 })
    }
  }, [metadataError])

  const initMetadata = async () => {
    try {
      const metadata = await fetchMetadata()
      if (metadata) {
        setSelectedTitle(metadata.titles?.[0])
        const prompts = await fetchThumbnailPrompts()
        if (prompts?.length) {
          generateThumbnails(thumbnailProvider).catch(err =>
            toast.error(`Thumbnail generation failed: ${err.message}`)
          )
        }
      }
    } catch (error) {
      // error already toasted via metadataError effect
    }
  }

  const handleGenerateThumbnails = async () => {
    try {
      // If we have no prompts yet (e.g. metadata was skipped), fetch them first
      let prompts = thumbnailPrompts
      if (!prompts?.length) {
        prompts = await fetchThumbnailPrompts()
        if (!prompts?.length) {
          toast.error('Could not generate thumbnail prompts')
          return
        }
      }
      await generateThumbnails(thumbnailProvider)
    } catch (err) {
      toast.error(`Thumbnail generation failed: ${err.message}`)
    }
  }

  const handleAddTag = () => {
    if (customTag.trim() && youtubeMetadata?.tags) {
      if (!youtubeMetadata.tags.includes(customTag.trim())) {
        updateTags([...youtubeMetadata.tags, customTag.trim()])
      }
      setCustomTag('')
    }
  }

  const handleRemoveTag = (tag) => {
    updateTags(youtubeMetadata.tags.filter(t => t !== tag))
  }

  const handleExport = async () => {
    setExporting(true)
    try {
      const project = exportProject()
      await api.exportZip(project)
      toast.success('Project exported successfully!')
    } catch (error) {
      toast.error(`Export failed: ${error.message}`)
    }
    setExporting(false)
  }

  const pageVariants = {
    initial: { opacity: 0, y: 8 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 }
  }

  return (
    <motion.div
      variants={pageVariants} initial="initial" animate="animate" exit="exit"
      transition={{ duration: 0.2 }}
      className="min-h-[calc(100vh-3.5rem)] pb-24"
    >
      {/* Header */}
      <div className="sticky top-14 bg-background/95 backdrop-blur-sm border-b border-border py-3 px-8 z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold text-text-primary">
              {location.pathname === '/metadata' ? 'Thumbnail & Metadata' : 'Export Project'}
            </h1>
            <p className="text-xs text-text-secondary">{selectedStory?.title}</p>
          </div>
          {isMetadataPage ? (
          <div className="flex items-center gap-3 text-xs text-text-disabled">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={includeMetadata} onChange={e => setIncludeMetadata(e.target.checked)}
                className="rounded" />
              Metadata
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={includeThumbnail} onChange={e => setIncludeThumbnail(e.target.checked)}
                className="rounded" />
              Thumbnail
            </label>
          </div>
          ) : (
            <button onClick={() => navigate('/metadata')} className="btn-secondary px-3 py-1.5 text-xs">
              Edit Thumbnail & Metadata
            </button>
          )}
        </div>
      </div>

      <div className="max-w-6xl mx-auto p-8 space-y-8">

        {/* ── Final Film (studio timeline render) ── */}
        {!isMetadataPage && <div id="final-film-export" className="scroll-mt-32"><FinalFilmCard /></div>}

        {/* ── YouTube Metadata ── */}
        {isMetadataPage && includeMetadata && (
          <section className="bg-surface border border-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-base font-semibold text-text-primary">YouTube Metadata</h2>
                <p className="text-xs text-text-secondary mt-0.5">AI-generated titles, description, tags & chapters</p>
              </div>
              {metadataError && !metadataLoading && (
                <button onClick={() => retryMetadata().catch(() => {})}
                  className="btn-secondary py-1.5 px-3 text-xs">
                  Retry
                </button>
              )}
            </div>

            {metadataLoading ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  {[1,2,3,4].map(i => <div key={i} className="h-12 skeleton rounded-lg" />)}
                </div>
                <div className="h-44 skeleton rounded-lg" />
                <div className="flex gap-2 flex-wrap">
                  {[1,2,3,4,5,6].map(i => <div key={i} className="w-16 h-6 skeleton rounded-full" />)}
                </div>
              </div>
            ) : metadataError && !youtubeMetadata ? (
              <div className="text-center py-8">
                <p className="text-sm text-error mb-3">{metadataError}</p>
                <button onClick={() => retryMetadata().catch(() => {})} className="btn-primary px-5 py-2 text-sm">
                  Retry Generation
                </button>
              </div>
            ) : youtubeMetadata ? (
              <div className="space-y-6">
                {/* Titles */}
                <div>
                  <label className="text-xs font-medium text-text-secondary mb-2 block">Video Titles — click to select</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {youtubeMetadata.titles?.map((title, i) => (
                      <button
                        key={i}
                        onClick={() => setSelectedTitle(title)}
                        className={`p-3 rounded-lg text-left text-sm transition-all border ${
                          selectedTitle === title
                            ? 'bg-accent/10 border-accent text-text-primary font-medium'
                            : 'bg-surface-raised border-border text-text-secondary hover:border-accent/40 hover:text-text-primary'
                        }`}
                      >
                        {selectedTitle === title && (
                          <span className="text-accent text-xs mr-1">✓</span>
                        )}
                        {title}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Description */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-text-secondary">Description</label>
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] text-text-disabled">
                        {youtubeMetadata.description?.split(/\s+/).filter(Boolean).length || 0} words
                      </span>
                      <button
                        onClick={() => {
                          navigator.clipboard.writeText(youtubeMetadata.description || '')
                          toast.success('Copied')
                        }}
                        className="text-[10px] text-accent hover:text-accent-hover"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                  <textarea
                    value={youtubeMetadata.description || ''}
                    onChange={e => updateDescription(e.target.value)}
                    className="w-full h-48 resize-none text-sm leading-relaxed"
                  />
                </div>

                {/* Tags */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-text-secondary">Tags</label>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(youtubeMetadata.tags?.join(', ') || '')
                        toast.success('Tags copied')
                      }}
                      className="text-[10px] text-accent hover:text-accent-hover"
                    >
                      Copy all
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mb-3 min-h-8">
                    {youtubeMetadata.tags?.map((tag, i) => (
                      <span key={i}
                        className="flex items-center gap-1 px-2.5 py-1 bg-surface-raised border border-border rounded-full text-xs text-text-secondary">
                        {tag}
                        <button onClick={() => handleRemoveTag(tag)}
                          className="text-text-disabled hover:text-error ml-0.5 leading-none">×</button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={customTag}
                      onChange={e => setCustomTag(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleAddTag()}
                      placeholder="Add tag..."
                      className="flex-1 text-sm"
                    />
                    <button onClick={handleAddTag} className="btn-secondary px-3 text-sm">Add</button>
                  </div>
                </div>

                {/* Chapters */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-medium text-text-secondary">Chapter Timestamps</label>
                    <button
                      onClick={() => {
                        const formatted = youtubeMetadata.chapters?.map(c => `${c.timestamp} ${c.label}`).join('\n') || ''
                        navigator.clipboard.writeText(formatted)
                        toast.success('Chapters copied')
                      }}
                      className="text-[10px] text-accent hover:text-accent-hover"
                    >
                      Copy
                    </button>
                  </div>
                  <div className="space-y-1.5">
                    {youtubeMetadata.chapters?.map((chapter, i) => (
                      <div key={i} className="flex gap-2">
                        <input
                          type="text"
                          value={chapter.timestamp}
                          onChange={e => {
                            const chapters = [...youtubeMetadata.chapters]
                            chapters[i] = { ...chapters[i], timestamp: e.target.value }
                            updateChapters(chapters)
                          }}
                          className="w-16 text-xs font-mono"
                          placeholder="0:00"
                        />
                        <input
                          type="text"
                          value={chapter.label}
                          onChange={e => {
                            const chapters = [...youtubeMetadata.chapters]
                            chapters[i] = { ...chapters[i], label: e.target.value }
                            updateChapters(chapters)
                          }}
                          className="flex-1 text-sm"
                        />
                        <button
                          onClick={() => {
                            const chapters = youtubeMetadata.chapters.filter((_, idx) => idx !== i)
                            updateChapters(chapters)
                          }}
                          className="text-text-disabled hover:text-error text-sm px-1"
                        >×</button>
                      </div>
                    ))}
                  </div>
                  <button
                    onClick={() => updateChapters([...(youtubeMetadata.chapters || []), { timestamp: '0:00', label: '' }])}
                    className="mt-2 text-xs text-accent hover:text-accent-hover"
                  >
                    + Add chapter
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-center py-8">
                <p className="text-sm text-text-secondary mb-3">Metadata not yet generated.</p>
                <button onClick={initMetadata} className="btn-primary px-5 py-2 text-sm">
                  Generate Metadata
                </button>
              </div>
            )}
          </section>
        )}

        {/* ── Thumbnail ── */}
        {isMetadataPage && includeThumbnail && (
          <section className="bg-surface border border-border rounded-xl p-6">
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-base font-semibold text-text-primary">Thumbnail</h2>
                <p className="text-xs text-text-secondary mt-0.5">YouTube thumbnail options</p>
              </div>
              <div className="flex items-center gap-2">
                {/* Provider selector */}
                <div className="flex bg-surface-raised border border-border rounded-lg p-0.5 gap-0.5">
                  {['fal', 'replicate', 'gemini', ...(settings.keysConfigured?.vertex ? ['vertex'] : [])].map(p => (
                    <button key={p}
                      onClick={() => setThumbnailProvider(p)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                        thumbnailProvider === p
                          ? 'bg-accent text-white shadow-sm'
                          : 'text-text-secondary hover:text-text-primary'
                      }`}
                    >
                      {p === 'fal' ? 'fal.ai' : p === 'replicate' ? 'Replicate' : p === 'gemini' ? 'Gemini' : 'Vertex'}
                    </button>
                  ))}
                </div>
                <button onClick={handleGenerateThumbnails} disabled={thumbnailLoading}
                  className="btn-secondary py-1.5 px-3 text-xs disabled:opacity-40">
                  {thumbnailLoading ? 'Generating...' : thumbnailPrompts?.length ? 'Regenerate' : 'Generate'}
                </button>
              </div>
            </div>

            {thumbnailLoading ? (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {[1,2,3,4].map(i => (
                  <div key={i} className="aspect-video skeleton rounded-lg" />
                ))}
              </div>
            ) : (
              <>
                <p className="text-[10px] text-text-disabled mb-3">Click to select for export · click image to enlarge · select multiple</p>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  {thumbnailPrompts.map((prompt, i) => {
                    const thumb = thumbnails[i]
                    const selectedArr = Array.isArray(selectedThumbnail)
                      ? selectedThumbnail
                      : selectedThumbnail ? [selectedThumbnail] : []
                    const isThumbSelected = selectedArr.some(t => t.index === i)
                    return (
                      <div key={i} className={`relative aspect-video rounded-lg overflow-hidden cursor-pointer group border-2 transition-all ${
                        isThumbSelected ? 'border-accent shadow-lg shadow-accent/20' : 'border-transparent hover:border-accent/40'
                      }`}
                        onClick={() => { if (thumb?.url) selectThumbnail(i) }}
                      >
                        {thumb?.loading ? (
                          <div className="absolute inset-0 skeleton" />
                        ) : thumb?.error ? (
                          <div className="absolute inset-0 bg-surface-raised flex flex-col items-center justify-center gap-1">
                            <span className="text-[10px] text-error">Failed</span>
                            <button onClick={e => { e.stopPropagation(); regenerateThumbnail(i, null, thumbnailProvider).catch(err => toast.error(err.message)) }}
                              className="text-[10px] text-accent hover:text-accent-hover">
                              Retry
                            </button>
                          </div>
                        ) : thumb?.url ? (
                          <>
                            <img src={thumb.url} alt="" className="w-full h-full object-cover" />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
                            {isThumbSelected && (
                              <div className="absolute top-2 right-2 w-6 h-6 bg-accent rounded-full flex items-center justify-center shadow-md">
                                <svg className="w-3.5 h-3.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                </svg>
                              </div>
                            )}
                            <div className="absolute bottom-2 left-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                              <button
                                onClick={e => { e.stopPropagation(); setLightboxIndex(i) }}
                                className="flex-1 bg-black/60 backdrop-blur-sm text-white text-[9px] py-1 rounded font-medium hover:bg-black/80"
                              >
                                ⤢ View
                              </button>
                              <button
                                onClick={e => { e.stopPropagation(); regenerateThumbnail(i, null, thumbnailProvider).catch(err => toast.error(err.message)) }}
                                className="flex-1 bg-black/60 backdrop-blur-sm text-white text-[9px] py-1 rounded font-medium hover:bg-black/80"
                              >
                                ↻ Regen
                              </button>
                            </div>
                          </>
                        ) : (
                          <div className="absolute inset-0 bg-surface-raised flex items-center justify-center">
                            <span className="text-[10px] text-text-disabled">No image</span>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>

                {(() => {
                  const selectedArr = Array.isArray(selectedThumbnail)
                    ? selectedThumbnail
                    : selectedThumbnail ? [selectedThumbnail] : []
                  if (!selectedArr.length) return null
                  return (
                    <div className="flex items-center gap-2 text-xs text-success">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      {selectedArr.length === 1
                        ? `Thumbnail ${selectedArr[0].index + 1} selected for export`
                        : `${selectedArr.length} thumbnails selected for export (${selectedArr.map(t => t.index + 1).join(', ')})`
                      }
                    </div>
                  )
                })()}
              </>
            )}
          </section>
        )}

        {/* Both skipped */}
        {isMetadataPage && !includeMetadata && !includeThumbnail && (
          <div className="bg-surface border border-border rounded-xl p-8 text-center">
            <p className="text-sm text-text-secondary mb-4">
              Both sections are skipped. Only videos and script will be exported.
            </p>
            <div className="flex gap-2 justify-center">
              <button onClick={() => setIncludeMetadata(true)} className="btn-secondary py-2 px-4 text-sm">
                Enable Metadata
              </button>
              <button onClick={() => setIncludeThumbnail(true)} className="btn-secondary py-2 px-4 text-sm">
                Enable Thumbnail
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Thumbnail lightbox with history navigation */}
      <AnimatePresence>
        {isMetadataPage && lightboxIndex !== null && (() => {
          const hist = thumbnailHistory?.[lightboxIndex] || []
          const current = thumbnails[lightboxIndex]
          const allVersions = [...hist, ...(current?.url ? [{ url: current.url, prompt: current.prompt }] : [])]
          if (!allVersions.length) return null
          return (
            <ThumbnailLightbox
              versions={allVersions}
              slotIndex={lightboxIndex}
              selectedThumbnail={selectedThumbnail}
              onSelect={() => { selectThumbnail(lightboxIndex); setLightboxIndex(null) }}
              onClose={() => setLightboxIndex(null)}
            />
          )
        })()}
      </AnimatePresence>

      {/* Bottom bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-surface/95 backdrop-blur-sm border-t border-border py-4 px-8 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="text-xs text-text-disabled space-y-0.5">
            {includeMetadata && selectedTitle && (
              <p>Title: <span className="text-text-secondary">{selectedTitle.substring(0, 50)}{selectedTitle.length > 50 ? '…' : ''}</span></p>
            )}
            {includeThumbnail && (() => {
              const sel = Array.isArray(selectedThumbnail) ? selectedThumbnail : selectedThumbnail ? [selectedThumbnail] : []
              return sel.length > 0 ? <p className="text-success">{sel.length} thumbnail{sel.length > 1 ? 's' : ''} selected ✓</p> : null
            })()}
          </div>
          <button
            onClick={isMetadataPage ? () => navigate('/export') : handleExport}
            disabled={exporting}
            className="btn-primary px-8 py-2.5 text-sm font-semibold disabled:opacity-50"
          >
            {exporting ? (
              <span className="flex items-center gap-2">
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Exporting...
              </span>
            ) : isMetadataPage ? 'Continue to Export' : 'Export Everything'}
          </button>
        </div>
      </div>
    </motion.div>
  )
}

export default Export
