// SPDX-License-Identifier: GPL-2.0-or-later
// Analytics-only sync trigger for the Analyze pane's selected keyboard.
// Runs on mount / keyboard switch (see .claude/rules/settings-persistence.md)
// and exposes the uid-scoped sync progress subscription so the pane's
// ConnectingOverlay can show `syncing` accurately. Split out of
// AnalyzePane.tsx (Task-split-analyze-pane).

import { useEffect, useState } from 'react'
import type { SyncProgress } from '../../../shared/types/sync'

/** How long a successful `syncAnalyticsNow` result satisfies the Analyze
 * panel before the next selection / re-mount re-triggers a pull+push.
 * Only successes count — failures fall through so the next mount can
 * retry immediately. */
const ANALYTICS_SYNC_RATE_LIMIT_MS = 5 * 60_000

/** Module-level so split-view panes that share a uid don't both fire
 * `syncAnalyticsNow` on mount — Drive only needs the pull+push once.
 * Values are millisecond timestamps of the last successful sync per uid;
 * failures stay absent so the next pane to mount retries immediately. */
const lastAnalyticsSyncSuccessAt = new Map<string, number>()

/** Test seam: clear the rate-limit map so consecutive specs that mount
 * the pane multiple times each fire the IPC instead of being suppressed
 * by an earlier spec's success. Production code never calls this. */
export function _resetAnalyticsSyncRateLimitForTests(): void {
  lastAnalyticsSyncSuccessAt.clear()
}

export interface UseAnalyzePaneSyncReturn {
  syncProgress: SyncProgress | null
  syncingAnalytics: boolean
}

export function useAnalyzePaneSync(selectedUid: string | null): UseAnalyzePaneSyncReturn {
  // Uid-prefixed filter — the backend allows parallel per-uid
  // analytics syncs, so a plain analytics-prefix filter would display
  // progress for a keyboard the user is no longer looking at.
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null)
  useEffect(() => {
    if (!selectedUid) { setSyncProgress(null); return }
    const prefix = `keyboards/${selectedUid}/devices/`
    return window.vialAPI.syncOnProgress((p) => {
      if (!p.syncUnit?.startsWith(prefix)) return
      setSyncProgress(p)
    })
  }, [selectedUid])

  // Analytics-only sync runs on Analyze mount (see
  // .claude/rules/settings-persistence.md). The per-uid rate-limit map
  // lives at module scope so split-view panes that share a uid don't
  // both fire the IPC. `syncingAnalytics` gates this pane's filter row
  // the same way `filtersReady` does.
  const [syncingAnalytics, setSyncingAnalytics] = useState(false)

  // Pull + push typing-analytics for the selected keyboard on mount /
  // keyboard switch. Rate-limited to one pass per 5 minutes per uid
  // (success-only) so rapid re-selects don't hammer Drive. Silent
  // failure — filter row lock releases in `finally` regardless, so the
  // user never gets stuck.
  useEffect(() => {
    if (!selectedUid) return
    const last = lastAnalyticsSyncSuccessAt.get(selectedUid) ?? 0
    if (Date.now() - last < ANALYTICS_SYNC_RATE_LIMIT_MS) return
    let cancelled = false
    setSyncingAnalytics(true)
    void window.vialAPI
      .syncAnalyticsNow(selectedUid)
      .then((ok) => {
        if (cancelled) return
        if (ok) {
          lastAnalyticsSyncSuccessAt.set(selectedUid, Date.now())
        }
      })
      .catch(() => { /* silent — next mount retries */ })
      .finally(() => {
        if (cancelled) return
        setSyncingAnalytics(false)
        // Clear any stale progress frame so the next entry does not
        // flash the tail-end of the previous run.
        setSyncProgress(null)
      })
    return () => { cancelled = true }
  }, [selectedUid])

  return { syncProgress, syncingAnalytics }
}
