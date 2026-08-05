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
// — not here. External consumers (main/index.ts, hub/hub-analytics.ts,
// sync/sync-ipc.ts, typing-run-log-store.ts, and this module's test mocks)
// must keep importing this facade path, never a submodule directly.

import { app } from 'electron'
import { IpcChannels } from '../../shared/ipc/channels'
import { secureHandle } from '../ipc-guard'
import type {
  TypingDailySummary,
  TypingKeyboardSummary,
  TypingTombstoneResult,
} from './db/typing-analytics-db'
import { getTypingAnalyticsDB } from './db/typing-analytics-db'
import { emptyTombstoneResult } from '../../shared/types/typing-analytics'
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
import { deleteAllTypingForKeyboard, deleteTypingDailySummaries } from './typing-analytics-retention'
import { registerAnalyzeIpc } from './typing-analytics-ipc-analyze'
import { registerRangeIpc } from './typing-analytics-ipc-range'

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

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_DELETE_ITEMS,
    async (_event, uid: unknown, dates: unknown): Promise<TypingTombstoneResult> => {
      const empty = emptyTombstoneResult()
      if (typeof uid !== 'string' || uid.length === 0) return empty
      if (!Array.isArray(dates)) return empty
      const validDates = dates.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d))
      if (validDates.length === 0) return empty
      return deleteTypingDailySummaries(uid, validDates)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_DELETE_ALL,
    async (_event, uid: unknown): Promise<TypingTombstoneResult> => {
      const empty = emptyTombstoneResult()
      if (typeof uid !== 'string' || uid.length === 0) return empty
      return deleteAllTypingForKeyboard(uid)
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
