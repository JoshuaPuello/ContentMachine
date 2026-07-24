import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { usePipelineStore } from '../store/pipelineStore'

// Floating real-time activity feed — shows per-item generation events
// (batch progress, per-scene image/video status) pushed via logActivity().
function ActivityFeed() {
  const activityLog = usePipelineStore(s => s.activityLog)
  const generationState = usePipelineStore(s => s.generationState)
  const clearActivityLog = usePipelineStore(s => s.clearActivityLog)
  const [collapsed, setCollapsed] = useState(false)
  const listRef = useRef(null)

  const isRunning = generationState === 'running'

  // Auto-scroll to the newest entry
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [activityLog.length, collapsed])

  if (activityLog.length === 0) return null

  const latest = activityLog[activityLog.length - 1]

  const StatusIcon = ({ status, active }) => {
    if (status === 'running' && active) {
      return <div className="w-2.5 h-2.5 border-[1.5px] border-accent border-t-transparent rounded-full animate-spin shrink-0" />
    }
    if (status === 'success') {
      return (
        <svg className="w-2.5 h-2.5 text-success shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      )
    }
    if (status === 'error') {
      return (
        <svg className="w-2.5 h-2.5 text-error shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      )
    }
    return <span className="w-1.5 h-1.5 rounded-full bg-text-disabled shrink-0" />
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="fixed bottom-20 right-4 z-40 w-[380px] bg-surface border border-border rounded-xl shadow-2xl overflow-hidden"
    >
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 hover:bg-surface-raised/60 transition-colors"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isRunning
            ? <div className="w-2 h-2 rounded-full bg-accent animate-pulse shrink-0" />
            : <div className="w-2 h-2 rounded-full bg-border shrink-0" />}
          <span className="text-xs font-semibold text-text-primary shrink-0">Activity</span>
          {collapsed && (
            <span className="text-[10px] text-text-secondary truncate">{latest.message}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); clearActivityLog() }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); clearActivityLog() } }}
            className="text-[10px] text-text-disabled hover:text-text-secondary cursor-pointer"
          >
            Clear
          </span>
          <svg
            className={`w-3 h-3 text-text-disabled transition-transform ${collapsed ? '' : 'rotate-180'}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Log entries */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div ref={listRef} className="max-h-56 overflow-y-auto px-3.5 pb-3 pt-1 space-y-1.5 border-t border-border">
              {activityLog.slice(-80).map((entry, idx, arr) => {
                const isLast = idx === arr.length - 1
                return (
                  <div key={entry.id} className="flex items-start gap-2">
                    <span className="text-[9px] text-text-disabled font-mono pt-0.5 shrink-0">{entry.time}</span>
                    <span className="pt-1">
                      <StatusIcon status={entry.status} active={isLast && isRunning} />
                    </span>
                    <span className={`text-[10px] leading-relaxed break-words min-w-0 ${
                      entry.status === 'error' ? 'text-error'
                      : entry.status === 'success' ? 'text-text-primary'
                      : 'text-text-secondary'
                    }`}>
                      {entry.message}
                    </span>
                  </div>
                )
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

export default ActivityFeed
