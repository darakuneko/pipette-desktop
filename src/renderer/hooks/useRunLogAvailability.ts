// SPDX-License-Identifier: GPL-2.0-or-later
// Which runs (by runId) have a saved keystroke log for this keyboard —
// drives whether `HistoryTimelineCell` shows its "open timeline" button
// at all (Task-tm-phase5-word-timeline-ui requirement 7: a run with no
// log gets no affordance, not a disabled one).

import { useEffect, useState } from 'react'

/** Shared empty-Set singleton — `HistoryToggle` before its first open,
 *  and any caller (e.g. a standalone test render of `TypingTestHistory`)
 *  that wants a stable default without allocating its own empty Set
 *  every render. */
export const EMPTY_RUN_ID_SET: ReadonlySet<string> = new Set()

export interface UseRunLogAvailabilityReturn {
  /** runIds with a saved keystroke log, per `typingRunLogList`. */
  availableRunIds: ReadonlySet<string>
}

/** Fetches once per `uid` AND once per History open (`openSeq`, bumped by
 * `HistoryToggle` every time `showHistory` turns true — see its own call
 * site). The previous design latched fetching to "the first open ever"
 * (a caller-side `everOpened` gate feeding this hook `null` while
 * closed), reasoning that a run's log is already on disk (or not) by the
 * time History reopens — true, but it misses the actual common case: a
 * run that finishes AFTER the user's first History open would then NEVER
 * gain its "open timeline" icon for the rest of the pane's lifetime, no
 * matter how many times History is reopened, since the effect's only
 * dependency (`uid`) never changed again. Re-running the fetch on every
 * open (not just the first) fixes that directly.
 *
 * The Set is deliberately left untouched while History is CLOSED
 * (`openSeq` only changes on an open, never a close) — so closing and
 * reopening shows the last-known set immediately, then refreshes once the
 * new fetch resolves, rather than flashing back to empty in between.
 * There is still no CustomEvent-based cross-instance sync to wire here,
 * unlike e.g. Key Labels, which can be edited by another live instance of
 * the same store while both are mounted — this hook's own re-fetch-per-
 * open is what keeps it current instead. */
export function useRunLogAvailability(uid: string | null, openSeq: number): UseRunLogAvailabilityReturn {
  const [availableRunIds, setAvailableRunIds] = useState<ReadonlySet<string>>(EMPTY_RUN_ID_SET)

  useEffect(() => {
    if (!uid) {
      setAvailableRunIds(EMPTY_RUN_ID_SET)
      return
    }
    let cancelled = false
    window.vialAPI.typingRunLogList(uid)
      .then((res) => {
        if (cancelled) return
        setAvailableRunIds(res.success && res.entries ? new Set(res.entries.map((e) => e.id)) : EMPTY_RUN_ID_SET)
      })
      .catch(() => { if (!cancelled) setAvailableRunIds(EMPTY_RUN_ID_SET) })
    return () => { cancelled = true }
  }, [uid, openSeq])

  return { availableRunIds }
}
