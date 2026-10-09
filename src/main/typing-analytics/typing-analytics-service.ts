// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics service — orchestrates the per-minute in-memory buffer,
// session detector, and SQLite persistence.
//
// This file is the facade: it owns async bootstrap (`setupTypingAnalytics`),
// the top-level IPC registration entry point (`setupTypingAnalyticsIpc`,
// which keeps the handful of core event/flush/list handlers inline and
// delegates the rest to `registerAnalyzeIpc`/`registerRangeIpc`), and
// re-exports the full public surface from the sibling modules in this
// directory. New IPC channels belong in `typing-analytics-ipc-analyze.ts`
// or `typing-analytics-ipc-range.ts` depending on which family they extend
// — not here. The Data modal's delete handlers hold the sync lock, so they
// are registered on the sync side (sync/sync-reset-ipc.ts). External
// consumers (main/index.ts, hub/hub-analytics.ts, sync/sync-ipc.ts,
// sync/sync-reset-ipc.ts, typing-run-log-store.ts, and this module's test
// mocks) must keep importing this facade path, never a submodule directly.

import { app } from 'electron'
import { IpcChannels } from '../../shared/ipc/channels'
import { secureHandle } from '../ipc-guard'
import type {
  TypingDailySummary,
  TypingKeyboardSummary,
} from './db/typing-analytics-db'
import { getTypingAnalyticsDB } from './db/typing-analytics-db'
import { normalizeAppScopes } from '../../shared/types/analyze-filters'
import { ensureCacheIsFresh } from './cache-rebuild'
import { getMachineHash } from './machine-hash'
import { taState } from './typing-analytics-state'
import {
  closeSessionsForUid,
  flushNow,
  ingestEvent,
  isValidEvent,
} from './typing-analytics-pipeline'
import { listTypingDailySummaries, listTypingKeyboards } from './typing-analytics-queries'
import { registerAnalyzeIpc } from './typing-analytics-ipc-analyze'
import { registerRangeIpc } from './typing-analytics-ipc-range'
import { applyOwnDeletedRangesForAllKeyboards } from './deleted-ranges-apply'
import { resetHoldsKeyboard } from '../sync/sync-runtime-state'
import { log } from '../logger'

async function initialize(): Promise<void> {
  // getMachineHash transitively warms getInstallationId (and caches its
  // own hash), so later sync notifications can `await` without triggering
  // fresh I/O.
  const machineHash = await getMachineHash()
  const db = getTypingAnalyticsDB()
  const userDataDir = app.getPath('userData')
  // A schema migration that dropped tables (e.g. the run_id PK change)
  // leaves the cache empty, so force a rebuild from the JSONL masters
  // regardless of the usual sync-state freshness check.
  const { state } = await ensureCacheIsFresh(db, userDataDir, machineHash, {
    force: db.cacheNeedsRebuild,
  })
  taState.syncState = state
  // Ranges other devices deleted from this device's data while it was off.
  // Not awaited, so a long apply does not hold back the end of startup.
  void applyOwnDeletedRangesForAllKeyboards(userDataDir, machineHash, resetHoldsKeyboard).catch((err: unknown) => {
    log('warn', `typing-analytics: deleted ranges not applied at startup: ${String(err)}`)
  })
}

/**
 * Warm the installation-id cache and other lazy resources. Concurrent callers
 * share the in-flight promise; a failed initialization clears the cached
 * promise so the next call can retry.
 */
export function setupTypingAnalytics(): Promise<void> {
  let promise = taState.initialization
  if (!promise) {
    promise = initialize().catch((err) => {
      taState.initialization = null
      throw err
    })
    taState.initialization = promise
  }
  return promise
}

/**
 * Register typing-analytics IPC handlers. Called synchronously at startup so
 * the handler is in place before the renderer creates the first BrowserWindow;
 * independent from the async initialization performed by setupTypingAnalytics.
 */
export function setupTypingAnalyticsIpc(): void {
  if (taState.ipcRegistered) return
  taState.ipcRegistered = true

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_EVENT,
    async (_event, payload: unknown): Promise<void> => {
      if (!isValidEvent(payload)) return
      await ingestEvent(payload)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_FLUSH,
    async (_event, uid: unknown): Promise<void> => {
      if (typeof uid !== 'string' || uid.length === 0) return
      closeSessionsForUid(uid)
      await flushNow({ final: true })
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_KEYBOARDS,
    async (): Promise<TypingKeyboardSummary[]> => listTypingKeyboards(),
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_ITEMS,
    async (_event, uid: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingDailySummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      return listTypingDailySummaries(uid, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  registerAnalyzeIpc()
  registerRangeIpc()
}

// --- Public re-exports -------------------------------------------------
// Explicit named re-exports only (never `export *`) so the facade's public
// surface is grep-able in one place and stays byte-identical to what it was
// before the split.

export {
  setTypingAnalyticsSyncNotifier,
  resetTypingAnalyticsForTests,
  getMinuteBufferForTests,
} from './typing-analytics-state'

export {
  hasTypingAnalyticsPendingWork,
  flushTypingAnalyticsBeforeQuit,
  flushTypingAnalyticsNowForTests,
  isValidRowColKeycode,
  runOnFlushChain,
} from './typing-analytics-pipeline'

export {
  listTypingKeyboards,
  listTypingDailySummaries,
  listTypingIntervalSummaries,
  listTypingIntervalSummariesForHash,
  listTypingActivityGrid,
  listTypingActivityGridForHash,
  listTypingLayerUsageInRange,
  listTypingLayerUsageInRangeForHash,
  listTypingMatrixCellsInRange,
  listTypingMatrixCellsInRangeForHash,
  listTypingMatrixCellsByDayInRange,
  listTypingMatrixCellsByDayInRangeForHash,
  listTypingMinuteStatsInRange,
  listTypingMinuteStatsInRangeForHash,
  listTypingSessionsInRange,
  listTypingSessionsInRangeForHash,
  listTypingBksMinuteInRange,
  listTypingBksMinuteInRangeForHash,
  getTypingPeakRecordsInRange,
  getTypingPeakRecordsInRangeForHash,
  listTypingDailySummariesForHash,
  listTypingDeviceInfosForUid,
  getMatrixHeatmap,
} from './typing-analytics-queries'

export {
  deleteTypingDailySummaries,
  deleteAllTypingForKeyboard,
} from './typing-analytics-retention'

export { parseLayoutComparisonOptionsForTests } from './typing-analytics-ipc-range'
