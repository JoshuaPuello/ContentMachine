import { useEffect, useMemo, useState } from 'react'
import AudioWaveform from './AudioWaveform'

const formatTime = (seconds) => {
  const value = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(value / 60)
  const remainder = value - minutes * 60
  return `${minutes}:${remainder.toFixed(1).padStart(4, '0')}`
}

const issueBadge = {
  high: 'border-error/35 bg-error/10 text-error',
  medium: 'border-warning/35 bg-warning/10 text-warning',
  low: 'border-border bg-surface-raised text-text-secondary',
}

const loadingCopy = {
  auditing: 'Transcribing and auditing the narration…',
  repairing: 'Building and verifying an improved master…',
  splitting: 'Approving the master and creating scene slices…',
}

export default function AudioReviewPanel({
  fullAudio,
  player,
  onReplace,
  onRepair,
  onApprove,
  onValidateMarker,
  onVariantChange,
}) {
  const [expanded, setExpanded] = useState(false)
  const [selectedIssueIds, setSelectedIssueIds] = useState([])
  const [marker, setMarker] = useState(null)
  const [markerType, setMarkerType] = useState('short_gap')
  const [markerNote, setMarkerNote] = useState('')
  const [submittingMarker, setSubmittingMarker] = useState(false)
  const variant = fullAudio?.previewVariant === 'repaired' && fullAudio?.repair ? 'repaired' : 'source'
  const activeAudit = variant === 'repaired' ? fullAudio?.repair?.audit : fullAudio?.audit
  const activeUrl = variant === 'repaired' ? fullAudio?.repair?.url : fullAudio?.sourceUrl || fullAudio?.url
  const issues = activeAudit?.issues || []
  const isBusy = ['auditing', 'repairing', 'splitting'].includes(fullAudio?.status)
  const activePlayer = player.activeId === 'full-audio' && player.source === activeUrl

  useEffect(() => {
    if (!activeAudit) return
    setExpanded((activeAudit.summary?.issueCount || 0) > 0)
    setSelectedIssueIds(
      issues.filter(issue => issue.autoFix && issue.defaultSelected).map(issue => issue.id),
    )
  }, [activeAudit?.auditId])

  const selectedRepairable = useMemo(
    () => issues.filter(issue => selectedIssueIds.includes(issue.id) && issue.autoFix),
    [issues, selectedIssueIds],
  )

  const changeVariant = async (next) => {
    const url = next === 'repaired' ? fullAudio?.repair?.url : fullAudio?.sourceUrl
    if (!url) return
    onVariantChange(next)
    if (player.activeId === 'full-audio') {
      await player.switchSource({ id: 'full-audio', source: url }).catch(() => {})
    }
  }

  if (!fullAudio) return null

  const reviewTone = !activeAudit
    ? 'border-border bg-surface-raised/35'
    : activeAudit.summary?.overallStatus === 'clean'
      ? 'border-success/30 bg-success/[0.035]'
      : 'border-warning/30 bg-warning/[0.025]'
  const reviewCopy = loadingCopy[fullAudio.status]
    || (!activeAudit
      ? 'This existing master predates automatic quality review. Re-upload it to run the audit; current scene audio remains unchanged until you approve a reviewed version.'
      : activeAudit.summary?.overallStatus === 'clean'
        ? 'No blocking pacing or signal defects were found. Review is collapsed because this master passed.'
        : `${activeAudit.summary?.issueCount || 0} finding${activeAudit.summary?.issueCount === 1 ? '' : 's'} detected before scene splitting.`)

  return (
    <div className={`border rounded-xl overflow-hidden ${reviewTone}`}>
      <div className="p-5">
        <div className="flex items-start justify-between gap-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className={`w-2 h-2 rounded-full ${
                isBusy ? 'bg-accent animate-pulse'
                  : !activeAudit ? 'bg-text-disabled'
                    : activeAudit.summary?.overallStatus === 'clean' ? 'bg-success' : 'bg-warning'
              }`} />
              <h3 className="text-sm font-semibold text-text-primary">Narration quality review</h3>
              {activeAudit && (
                <span className="text-[10px] uppercase tracking-[0.15em] text-text-disabled">
                  {variant === 'repaired' ? 'Improved master' : 'Source master'}
                </span>
              )}
            </div>
            <p className="text-[11px] text-text-secondary">{reviewCopy}</p>
            <p className="text-[10px] text-text-disabled mt-1">
              {fullAudio.name}{fullAudio.durationSeconds ? ` · ${formatTime(fullAudio.durationSeconds)}` : ''}
              {Number.isFinite(activeAudit?.loudness?.integratedLufs) ? ` · ${activeAudit.loudness.integratedLufs.toFixed(1)} LUFS` : ''}
              {Number.isFinite(activeAudit?.loudness?.truePeakDb) ? ` · ${activeAudit.loudness.truePeakDb.toFixed(1)} dBTP` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {fullAudio.repair?.url && (
              <div className="grid grid-cols-2 gap-1 p-1 rounded-lg bg-surface-raised">
                {['source', 'repaired'].map(option => (
                  <button
                    key={option}
                    onClick={() => changeVariant(option)}
                    className={`px-3 py-1 rounded-md text-[10px] font-medium transition-colors ${
                      variant === option ? 'bg-surface text-text-primary shadow-sm' : 'text-text-secondary'
                    }`}
                  >
                    {option === 'source' ? 'Source' : 'Improved'}
                  </button>
                ))}
              </div>
            )}
            <button onClick={onReplace} disabled={isBusy} className="btn-secondary py-1.5 px-3 text-xs disabled:opacity-40">
              Replace
            </button>
            {activeAudit && (
              <button
                onClick={() => setExpanded(value => !value)}
                className="btn-secondary py-1.5 px-3 text-xs"
              >
                {expanded ? 'Collapse' : 'Review details'}
              </button>
            )}
          </div>
        </div>

        {isBusy && (
          <div className="mt-4 h-1 rounded-full overflow-hidden bg-surface-raised">
            <div className="h-full w-2/3 bg-accent rounded-full animate-pulse" />
          </div>
        )}

        {activeUrl && (
          <div className="mt-4 flex items-center gap-3">
            <button
              onClick={() => player.toggle({ id: 'full-audio', source: activeUrl }).catch(() => {})}
              className="w-9 h-9 rounded-full bg-accent text-white flex items-center justify-center hover:bg-accent-hover transition-colors"
              aria-label={activePlayer && player.playing ? 'Pause full audio' : 'Play full audio'}
            >
              {activePlayer && player.playing ? (
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>
              ) : (
                <svg className="w-4 h-4 ml-0.5" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
              )}
            </button>
            <button onClick={player.stop} className="text-[10px] text-text-secondary hover:text-text-primary">Stop</button>
            <button onClick={() => player.seek((activePlayer ? player.currentTime : 0) - 10)} className="text-[10px] text-text-secondary hover:text-text-primary">−10s</button>
            <span className="text-[10px] tabular-nums text-text-secondary min-w-[42px]">
              {formatTime(activePlayer ? player.currentTime : 0)}
            </span>
            <input
              type="range"
              min="0"
              max={fullAudio.durationSeconds || activeAudit?.durationSeconds || 1}
              step="0.01"
              value={activePlayer ? player.currentTime : 0}
              onChange={event => {
                const time = Number(event.target.value)
                if (!activePlayer) {
                  player.toggle({ id: 'full-audio', source: activeUrl, startAt: time }).catch(() => {})
                } else {
                  player.seek(time)
                }
              }}
              className="flex-1 accent-accent"
              aria-label="Full audio position"
            />
            <span className="text-[10px] tabular-nums text-text-disabled min-w-[42px]">
              {formatTime(fullAudio.durationSeconds || activeAudit?.durationSeconds || 0)}
            </span>
            <button onClick={() => player.seek((activePlayer ? player.currentTime : 0) + 10)} className="text-[10px] text-text-secondary hover:text-text-primary">+10s</button>
          </div>
        )}
      </div>

      {expanded && activeAudit && (
        <div className="border-t border-border/80 p-5 bg-surface/55">
          <AudioWaveform
            peaks={activeAudit.waveform?.peaks || []}
            duration={activeAudit.durationSeconds || fullAudio.durationSeconds || 0}
            currentTime={activePlayer ? player.currentTime : 0}
            issues={issues}
            boundaries={activeAudit.boundaries || []}
            onSeek={(time) => {
              if (!activePlayer) {
                player.toggle({ id: 'full-audio', source: activeUrl, startAt: time }).catch(() => {})
              } else {
                player.seek(time)
              }
            }}
            onInspect={(time) => setMarker({ timeSeconds: time })}
          />
          <div className="flex items-center justify-between mt-2">
            <p className="text-[10px] text-text-disabled">
              Click the waveform to seek and open a quality marker. Drag to scrub without creating one.
            </p>
            <div className="flex items-center gap-3 text-[9px] uppercase tracking-wider">
              <span className="text-warning">● tight pacing</span>
              <span className="text-error">● signal defect</span>
            </div>
          </div>

          {marker && (
            <div className="mt-3 border border-accent/30 rounded-xl p-4 bg-accent/[0.045]">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <p className="text-xs font-semibold text-text-primary">Flag audio at {formatTime(marker.timeSeconds)}</p>
                  <p className="text-[10px] text-text-secondary">The backend will inspect this window and snap pacing issues to the nearest script boundary.</p>
                </div>
                <button onClick={() => setMarker(null)} className="text-text-disabled hover:text-text-primary">×</button>
              </div>
              <div className="grid md:grid-cols-[220px_1fr_auto] gap-2">
                <select value={markerType} onChange={event => setMarkerType(event.target.value)} className="text-xs">
                  <option value="short_gap">Tight / unnatural transition</option>
                  <option value="level_jump">Voice or level jump</option>
                  <option value="click">Click or digital pop</option>
                  <option value="other">Other concern</option>
                </select>
                <input
                  value={markerNote}
                  onChange={event => setMarkerNote(event.target.value)}
                  placeholder="Optional note about what you heard"
                  className="text-xs"
                />
                <button
                  disabled={submittingMarker}
                  onClick={async () => {
                    setSubmittingMarker(true)
                    try {
                      await onValidateMarker({ ...marker, type: markerType, note: markerNote })
                      setMarker(null)
                      setMarkerNote('')
                    } finally {
                      setSubmittingMarker(false)
                    }
                  }}
                  className="btn-primary px-4 py-2 text-xs disabled:opacity-40"
                >
                  {submittingMarker ? 'Checking…' : 'Validate marker'}
                </button>
              </div>
            </div>
          )}

          <div className="mt-5 space-y-2">
            {issues.length === 0 ? (
              <div className="rounded-lg border border-success/25 bg-success/5 p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-success">Audio passed quality review</p>
                  <p className="text-[10px] text-text-secondary mt-0.5">
                    {activeAudit.boundaries?.length || 0} narration boundaries and the full waveform were checked.
                  </p>
                </div>
              </div>
            ) : issues.map(issue => (
              <label key={issue.id} className="flex gap-3 rounded-lg border border-border bg-surface-raised/55 p-3">
                <input
                  type="checkbox"
                  checked={selectedIssueIds.includes(issue.id)}
                  disabled={!issue.autoFix || variant === 'repaired'}
                  onChange={event => setSelectedIssueIds(current => (
                    event.target.checked ? [...current, issue.id] : current.filter(id => id !== issue.id)
                  ))}
                  className="mt-1 accent-accent"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold text-text-primary">{issue.title}</p>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded border ${issueBadge[issue.severity] || issueBadge.low}`}>
                      {issue.severity}
                    </span>
                    {!issue.autoFix && <span className="text-[9px] text-text-disabled">review only</span>}
                  </div>
                  <p className="text-[10px] text-text-secondary mt-1">{issue.description}</p>
                  <p className="text-[10px] text-text-disabled mt-1">{issue.suggestion}</p>
                </div>
                <button
                  onClick={(event) => {
                    event.preventDefault()
                    player.toggle({ id: 'full-audio', source: activeUrl, startAt: Math.max(0, issue.timeSeconds - 1.5) }).catch(() => {})
                  }}
                  className="text-[10px] text-accent self-start"
                >
                  {formatTime(issue.timeSeconds)}
                </button>
              </label>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[10px] text-text-disabled max-w-2xl">
              Source audio is immutable. Repairs create a lossless new master and are re-audited before approval.
              Prosody or pitch concerns remain review-only because automatic pitch correction can damage voice identity.
            </p>
            <div className="flex items-center gap-2">
              {variant === 'source' && selectedRepairable.length > 0 && (
                <button
                  onClick={() => onRepair(selectedRepairable.map(issue => issue.id))}
                  disabled={isBusy}
                  className="btn-secondary px-4 py-2 text-xs disabled:opacity-40"
                >
                  Create improved version ({selectedRepairable.length})
                </button>
              )}
              {variant === 'source' && (
                <button
                  onClick={() => onApprove('source')}
                  disabled={isBusy}
                  className={`${issues.length ? 'btn-secondary' : 'btn-primary'} px-4 py-2 text-xs disabled:opacity-40`}
                >
                  Approve source & split
                </button>
              )}
              {variant === 'repaired' && (
                <button
                  onClick={() => onApprove('repaired')}
                  disabled={isBusy}
                  className="btn-primary px-4 py-2 text-xs disabled:opacity-40"
                >
                  Approve improved & split
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
