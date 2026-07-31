// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze -> Typing Test handoff for the "open timeline" action
// (Task: Analyze run filter jump). Mirrors App.tsx's own
// `pendingTypingTestReentryRef` deferred-ref pattern used by
// `handleAnalyticsBack`'s typingTest-origin branch: `openRunTimeline`
// arms that same ref so App.tsx's existing remount effect re-enters the
// full typing test for us once KeymapEditor (unmounted while the
// analytics page is open) comes back.
//
// The runId itself needs NO equivalent parking/promotion step: it lives
// in this hook's own state, which belongs to App.tsx (never unmounted),
// not to KeymapEditor/TypingTestPane/HistoryToggle — so it survives that
// unmount/remount cycle for free and is already the correct value by the
// time HistoryToggle (however many renders later) actually mounts and
// reads it as a prop.

import { useCallback, useMemo, useState, type MutableRefObject } from 'react'
import type { ViewMode } from '../../shared/types/pipette-settings'

interface Params {
  setAnalyticsPageOpen: (open: boolean) => void
  setViewMode: (mode: ViewMode) => void
  /** Same ref App.tsx's Back-button reentry effect consumes — reusing
   * it means the existing remount effect re-enters the full typing
   * test for us; we only need to additionally track the runId. */
  pendingTypingTestReentryRef: MutableRefObject<boolean>
}

/** Consume-once runId + its own close handler, bundled so a runId is
 * never representable without something to clear it — see
 * `HistoryToggle`, the sole consumer. */
export interface TimelineHandoff {
  runId: string
  onConsumed: () => void
}

export interface UseRunTimelineHandoffReturn {
  /** Non-null while a run's timeline should auto-open in History. */
  timelineHandoff: TimelineHandoff | null
  /** Analyze's "open timeline" action calls this with the single
   * selected runId. */
  openRunTimeline: (runId: string) => void
}

export function useRunTimelineHandoff({
  setAnalyticsPageOpen,
  setViewMode,
  pendingTypingTestReentryRef,
}: Params): UseRunTimelineHandoffReturn {
  const [runId, setRunId] = useState<string | null>(null)

  const openRunTimeline = useCallback((nextRunId: string) => {
    setRunId(nextRunId)
    setAnalyticsPageOpen(false)
    setViewMode('typingTest')
    pendingTypingTestReentryRef.current = true
  }, [setAnalyticsPageOpen, setViewMode, pendingTypingTestReentryRef])

  const clearRunId = useCallback(() => setRunId(null), [])

  const timelineHandoff = useMemo<TimelineHandoff | null>(
    () => (runId !== null ? { runId, onConsumed: clearRunId } : null),
    [runId, clearRunId],
  )

  return { timelineHandoff, openRunTimeline }
}
