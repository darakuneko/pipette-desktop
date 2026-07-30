// SPDX-License-Identifier: GPL-2.0-or-later
// Typing analytics service — orchestrates the per-minute in-memory buffer,
// session detector, and SQLite persistence. See
// .claude/plans/typing-analytics.md for the design rationale.

import { app } from 'electron'
import { unlink } from 'node:fs/promises'
import { platform, release } from 'node:os'
import { IpcChannels } from '../../shared/ipc/channels'
import { secureHandle } from '../ipc-guard'
import type {
  LayoutComparisonInputLayout,
  LayoutComparisonMetric,
  LayoutComparisonOptions,
  LayoutComparisonResult,
  TypingAnalyticsDeviceInfo,
  TypingAnalyticsDeviceInfoBundle,
  TypingAnalyticsEvent,
  TypingAnalyticsFingerprint,
  TypingAnalyticsKeyboard,
  TypingHeatmapByCell,
  TypingKeymapSnapshot,
  TypingKeymapSnapshotSummary,
  TypingBigramAggregateOptions,
  TypingBigramAggregateResult,
  TypingBigramAggregateView,
  TypingDurationCell,
} from '../../shared/types/typing-analytics'
import type { KleKey } from '../../shared/kle/types'
import { isFingerType, isPosKey, type FingerType } from '../../shared/kle/kle-ergonomics'
import { canonicalScopeKey, emptyTombstoneResult } from '../../shared/types/typing-analytics'
import { OBSERVATION_HOLE_MS } from '../../shared/typing-analytics-timing'
import { isHashScope, isOwnScope, normalizeAppScopes, parseDeviceScope } from '../../shared/types/analyze-filters'
import { log } from '../logger'
import { getCurrentAppName } from './app-monitor'
import { ensureCacheIsFresh } from './cache-rebuild'
import {
  getKeymapSnapshotForRange,
  listKeymapSnapshotSummaries,
  saveKeymapSnapshotIfChanged,
} from './keymap-snapshots'
import { buildFingerprint } from './fingerprint'
import {
  MinuteBuffer,
  MINUTE_MS,
  type MinuteSnapshot,
} from './minute-buffer'
import { SessionDetector, type FinalizedSession } from './session-detector'
import {
  getTypingAnalyticsDB,
  type TypingActivityCell,
  type TypingDailySummary,
  type TypingIntervalDailySummary,
  type TypingKeyboardSummary,
  type TypingLayerUsageRow,
  type TypingMatrixCellRow,
  type TypingMatrixCellDailyRow,
  type TypingMinuteStatsRow,
  type TypingRolloverMinuteRow,
  type TypingSessionRow,
  type TypingBksMinuteRow,
  type TypingTombstoneResult,
  type PeakRecords,
} from './db/typing-analytics-db'
import { typingAnalyticsDeviceDaySyncUnit } from './sync'
import { getMachineHash } from './machine-hash'
import { applyRowsToCache } from './jsonl/apply-to-cache'
import {
  bigramMinuteRowId,
  charMinuteRowId,
  matrixMinuteRowId,
  minuteStatsRowId,
  scopeRowId,
  sessionRowId,
  trigramMinuteRowId,
  type JsonlBigramMinuteEntry,
  type JsonlRow,
} from './jsonl/jsonl-row'
import { appendRowsToFile } from './jsonl/jsonl-writer'
import { bucketizeDurations, bucketizeIki, sumAndSumSquares } from './bigram-bucket'
import {
  aggregateMatrixDurationTotals,
  aggregatePairTotals,
  observedRolloverRatio,
  rankBigramsByCount,
  rankBigramsBySlow,
} from './bigram-aggregate'
import { computeLayoutComparison } from './compute-layout-comparison'
import {
  deviceDayJsonlPath,
  listDeviceDays,
} from './jsonl/paths'
import { utcDayFromMs, type UtcDay } from './jsonl/utc-day'
import {
  emptySyncState,
  saveSyncState,
  type TypingSyncState,
} from './sync-state'

const FLUSH_DEBOUNCE_MS = 1_000


let initialization: Promise<void> | null = null
let ipcRegistered = false

/** Injected sync-change notifier. Kept as a callback instead of a direct
 * import to avoid coupling the analytics service to sync-service at module
 * load time — the main-process bootstrap wires in the real implementation
 * via {@link setTypingAnalyticsSyncNotifier}. */
type SyncNotifier = (syncUnit: string) => void
let syncNotifier: SyncNotifier | null = null

export function setTypingAnalyticsSyncNotifier(notifier: SyncNotifier | null): void {
  syncNotifier = notifier
}

interface ResolvedScope {
  fingerprint: TypingAnalyticsFingerprint
  scopeKey: string
}

let minuteBuffer = new MinuteBuffer()
const sessionDetector = new SessionDetector()
const scopeCache = new Map<string, ResolvedScope>()
const pendingSessions: FinalizedSession[] = []

let dirty = false
let flushChain: Promise<void> = Promise.resolve()
let inFlightFlushCount = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null
let syncState: TypingSyncState | null = null

/** Last `updatedAt` a flush pass wrote. The DB's LWW merge only accepts a
 * row when `excluded.updated_at > current.updated_at` (strict), so two
 * passes landing in the same millisecond would make the second one — the
 * cumulative, corrected re-send of a retained minute — silently lose to
 * the first. Forcing each pass's `updatedAt` strictly past the previous
 * one closes that race regardless of how fast passes run back to back.
 *
 * A backwards clock correction (e.g. NTP) does not roll `updatedAt` back:
 * it stays pinned above the pre-correction value (potentially reading as
 * up to that offset in the future) and flows into `state.last_synced_at`
 * too. This is harmless — rows are scoped per `machineHash`, so there is
 * no cross-machine contention over what "future" means — and required:
 * without it, a re-send after the clock jumps backward would lose the
 * strict `>` LWW race against its own earlier, partial write. Do not
 * "fix" an apparently future-dated row by removing this bump. */
let lastFlushUpdatedAt = 0

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
  syncState = state
}

/**
 * Warm the installation-id cache and other lazy resources. Concurrent callers
 * share the in-flight promise; a failed initialization clears the cached
 * promise so the next call can retry.
 */
export function setupTypingAnalytics(): Promise<void> {
  if (!initialization) {
    initialization = initialize().catch((err) => {
      initialization = null
      throw err
    })
  }
  return initialization
}

/** Factory for the "no records found" sentinel shared by every
 * peak-records handler. Module-level so the FOR_HASH handler (registered
 * before the other peak handlers in source order) can reference it
 * without hitting the temporal-dead-zone of a function-scoped `const`. */
const emptyPeakRecords = (): PeakRecords => ({
  peakWpm: null,
  lowestWpm: null,
  peakKeystrokesPerMin: null,
  peakKeystrokesPerDay: null,
  longestSession: null,
})

/** "No result" sentinel for the bigram-aggregate IPC — every validation
 * failure before the DB query returns this, so `truncated` always has
 * a defined value regardless of how far the handler got. */
const emptyBigramResult = (view: TypingBigramAggregateView): TypingBigramAggregateResult =>
  view === 'slow'
    ? { view: 'slow', entries: [], truncated: false, observedRolloverRatio: null }
    : { view: 'top', entries: [], truncated: false, observedRolloverRatio: null }

/**
 * Register typing-analytics IPC handlers. Called synchronously at startup so
 * the handler is in place before the renderer creates the first BrowserWindow;
 * independent from the async initialization performed by setupTypingAnalytics.
 */
export function setupTypingAnalyticsIpc(): void {
  if (ipcRegistered) return
  ipcRegistered = true

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

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_MATRIX_HEATMAP,
    async (_event, uid: unknown, layer: unknown, sinceMs: unknown): Promise<TypingHeatmapByCell> => {
      if (typeof uid !== 'string' || uid.length === 0) return {}
      if (typeof layer !== 'number' || !Number.isFinite(layer) || layer < 0) return {}
      if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return {}
      return getMatrixHeatmap(uid, layer, sinceMs)
    },
  )

  // Local / Sync split handlers. The Local tab filters to own hash,
  // the Sync tab iterates remote hashes. Cloud-facing handlers are
  // wired into sync-service so they share the same credential check.
  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_ITEMS_LOCAL,
    async (_event, uid: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingDailySummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const ownHash = await getMachineHash()
      return listTypingDailySummariesForHash(uid, ownHash, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_DEVICE_INFOS,
    async (_event, uid: unknown): Promise<TypingAnalyticsDeviceInfoBundle | null> => {
      if (typeof uid !== 'string' || uid.length === 0) return null
      return listTypingDeviceInfosForUid(uid)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_ITEMS_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingDailySummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      return listTypingDailySummariesForHash(uid, machineHash, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_INTERVAL_ITEMS_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown): Promise<TypingIntervalDailySummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      return listTypingIntervalSummariesForHash(uid, machineHash)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_ACTIVITY_GRID_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingActivityCell[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingActivityGridForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_LAYER_USAGE_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingLayerUsageRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingLayerUsageInRangeForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingMatrixCellRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingMatrixCellsInRangeForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingMatrixCellDailyRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingMatrixCellsByDayInRangeForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MINUTE_STATS_FOR_HASH,
    async (
      _event,
      uid: unknown,
      machineHash: unknown,
      sinceMs: unknown,
      untilMs: unknown,
      appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown,
    ): Promise<TypingMinuteStatsRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const apps = normalizeAppScopes(appScopes)
      const typingTests = normalizeAppScopes(typingTestScopes)
      const runIds = normalizeAppScopes(runIdScopes)
      return listTypingMinuteStatsInRangeForHash(uid, machineHash, since, until, apps, typingTests, runIds)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_SESSIONS_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown): Promise<TypingSessionRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingSessionsInRangeForHash(uid, machineHash, since, until)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_BKS_MINUTE_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingBksMinuteRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingBksMinuteInRangeForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_PEAK_RECORDS_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<PeakRecords> => {
      if (typeof uid !== 'string' || uid.length === 0) return emptyPeakRecords()
      if (typeof machineHash !== 'string' || machineHash.length === 0) return emptyPeakRecords()
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return getTypingPeakRecordsInRangeForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_LOCAL_DEVICE_DAYS,
    async (_event, uid: unknown, machineHash: unknown): Promise<UtcDay[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      return listDeviceDays(app.getPath('userData'), uid, machineHash)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_INTERVAL_ITEMS,
    async (_event, uid: unknown): Promise<TypingIntervalDailySummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      return listTypingIntervalSummaries(uid)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_INTERVAL_ITEMS_LOCAL,
    async (_event, uid: unknown): Promise<TypingIntervalDailySummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const ownHash = await getMachineHash()
      return listTypingIntervalSummariesForHash(uid, ownHash)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_ACTIVITY_GRID,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingActivityCell[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingActivityGrid(uid, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_ACTIVITY_GRID_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingActivityCell[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingActivityGridForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_LAYER_USAGE,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingLayerUsageRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingLayerUsageInRange(uid, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_LAYER_USAGE_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingLayerUsageRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingLayerUsageInRangeForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingMatrixCellRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingMatrixCellsInRange(uid, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingMatrixCellRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingMatrixCellsInRangeForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingMatrixCellDailyRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingMatrixCellsByDayInRange(uid, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingMatrixCellDailyRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingMatrixCellsByDayInRangeForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MINUTE_STATS,
    async (
      _event,
      uid: unknown,
      sinceMs: unknown,
      untilMs: unknown,
      appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown,
    ): Promise<TypingMinuteStatsRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const apps = normalizeAppScopes(appScopes)
      const typingTests = normalizeAppScopes(typingTestScopes)
      const runIds = normalizeAppScopes(runIdScopes)
      return listTypingMinuteStatsInRange(uid, since, until, apps, typingTests, runIds)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MINUTE_STATS_LOCAL,
    async (
      _event,
      uid: unknown,
      sinceMs: unknown,
      untilMs: unknown,
      appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown,
    ): Promise<TypingMinuteStatsRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      const apps = normalizeAppScopes(appScopes)
      const typingTests = normalizeAppScopes(typingTestScopes)
      const runIds = normalizeAppScopes(runIdScopes)
      return listTypingMinuteStatsInRangeForHash(uid, ownHash, since, until, apps, typingTests, runIds)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_SESSIONS,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown): Promise<TypingSessionRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingSessionsInRange(uid, since, until)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_SESSIONS_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown): Promise<TypingSessionRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingSessionsInRangeForHash(uid, ownHash, since, until)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_BKS_MINUTE,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingBksMinuteRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingBksMinuteInRange(uid, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_BKS_MINUTE_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<TypingBksMinuteRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingBksMinuteInRangeForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_PEAK_RECORDS,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<PeakRecords> => {
      if (typeof uid !== 'string' || uid.length === 0) return emptyPeakRecords()
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return getTypingPeakRecordsInRange(uid, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_PEAK_RECORDS_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown): Promise<PeakRecords> => {
      if (typeof uid !== 'string' || uid.length === 0) return emptyPeakRecords()
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return getTypingPeakRecordsInRangeForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes), normalizeAppScopes(typingTestScopes), normalizeAppScopes(runIdScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_SAVE_KEYMAP_SNAPSHOT,
    async (_event, partial: unknown): Promise<{ saved: boolean; savedAt: number | null }> => {
      if (!partial || typeof partial !== 'object') return { saved: false, savedAt: null }
      const s = partial as Partial<TypingKeymapSnapshot>
      if (typeof s.uid !== 'string' || s.uid.length === 0) return { saved: false, savedAt: null }
      try {
        const machineHash = await getMachineHash()
        const full: TypingKeymapSnapshot = {
          uid: s.uid,
          machineHash,
          productName: typeof s.productName === 'string' ? s.productName : '',
          savedAt: typeof s.savedAt === 'number' && Number.isFinite(s.savedAt) ? s.savedAt : Date.now(),
          layers: typeof s.layers === 'number' ? s.layers : 0,
          matrix: s.matrix ?? { rows: 0, cols: 0 },
          keymap: Array.isArray(s.keymap) ? s.keymap : [],
          layout: s.layout ?? null,
          vialProtocol: typeof s.vialProtocol === 'number' ? s.vialProtocol : undefined,
        }
        return await saveKeymapSnapshotIfChanged(app.getPath('userData'), full)
      } catch (err) {
        log('warn', `[typing-analytics] saveKeymapSnapshot failed: ${String(err)}`)
        return { saved: false, savedAt: null }
      }
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_MATRIX_HEATMAP_FOR_RANGE,
    async (
      _event,
      uid: unknown,
      layer: unknown,
      sinceMs: unknown,
      untilMs: unknown,
      scope: unknown,
      appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown,
    ): Promise<TypingHeatmapByCell> => {
      if (typeof uid !== 'string' || uid.length === 0) return {}
      if (typeof layer !== 'number' || !Number.isFinite(layer) || layer < 0) return {}
      if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return {}
      if (typeof untilMs !== 'number' || !Number.isFinite(untilMs) || untilMs <= sinceMs) return {}
      const parsedScope = parseDeviceScope(scope)
      if (parsedScope === null) return {}
      const db = getTypingAnalyticsDB()
      const sinceMinuteMs = Math.floor(sinceMs / MINUTE_MS) * MINUTE_MS
      const untilMinuteMs = Math.ceil(untilMs / MINUTE_MS) * MINUTE_MS
      // `undefined` means "all hashes merged" at the DB layer; own scope
      // injects the local hash so the same API shape covers all three
      // scope kinds without caller gymnastics.
      const machineHash = isOwnScope(parsedScope)
        ? await getMachineHash()
        : isHashScope(parsedScope)
          ? parsedScope.machineHash
          : undefined
      const apps = normalizeAppScopes(appScopes)
      const typingTests = normalizeAppScopes(typingTestScopes)
      const runIds = normalizeAppScopes(runIdScopes)
      const totals = db.aggregateMatrixCountsForUidInRange(uid, layer, sinceMinuteMs, untilMinuteMs, machineHash, apps, typingTests, runIds)
      const out: TypingHeatmapByCell = {}
      for (const [key, cell] of totals) {
        out[key] = { total: cell.total, tap: cell.tap, hold: cell.hold }
      }
      return out
    },
  )

  // --- Monitor App range aggregates ---------------------------------
  // Shared validator so the three sister handlers below stay terse and
  // share one source of truth for "what does a valid range query look
  // like." Returns null on any rejection; callers translate that to []
  // since the renderer expects a list shape regardless of failure mode.
  const parseAppRangeArgs = async (
    uid: unknown,
    sinceMs: unknown,
    untilMs: unknown,
    scope: unknown,
  ): Promise<{ uid: string; machineHash: string | null; sinceMs: number; untilMs: number } | null> => {
    if (typeof uid !== 'string' || uid.length === 0) return null
    if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return null
    if (typeof untilMs !== 'number' || !Number.isFinite(untilMs) || untilMs <= sinceMs) return null
    const parsedScope = parseDeviceScope(scope)
    if (parsedScope === null) return null
    const machineHash = isOwnScope(parsedScope)
      ? await getMachineHash()
      : isHashScope(parsedScope)
        ? parsedScope.machineHash
        : null
    return {
      uid,
      machineHash,
      sinceMs: Math.floor(sinceMs / MINUTE_MS) * MINUTE_MS,
      untilMs: Math.ceil(untilMs / MINUTE_MS) * MINUTE_MS,
    }
  }

  // Shared validator for the single-variant "resolve DeviceScope
  // main-side" IPC pattern (GET_BIGRAM_AGGREGATE_FOR_RANGE and
  // LIST_ROLLOVER_MINUTES) — sibling to `parseAppRangeArgs` above, but
  // returns `machineHash: null` for the "all devices" scope (matching
  // this pattern's own `machineHash === null` dispatch convention)
  // instead of `parseAppRangeArgs`'s `undefined`, and does NOT snap
  // sinceMs/untilMs to minute boundaries — both handlers on this side
  // already pass raw ms bounds straight through to a SQL range compare
  // that doesn't need snapping, and rounding here would change their
  // existing behavior.
  const parseScopedRangeArgs = async (
    uid: unknown,
    sinceMs: unknown,
    untilMs: unknown,
    scope: unknown,
    appScopes: unknown,
    typingTestScopes: unknown,
    runIdScopes: unknown,
  ): Promise<{
    uid: string
    machineHash: string | null
    sinceMs: number
    untilMs: number
    apps: string[]
    typingTests: string[]
    runIds: string[]
  } | null> => {
    if (typeof uid !== 'string' || uid.length === 0) return null
    if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return null
    if (typeof untilMs !== 'number' || !Number.isFinite(untilMs) || untilMs <= sinceMs) return null
    const parsedScope = parseDeviceScope(scope)
    if (parsedScope === null) return null
    const machineHash = isOwnScope(parsedScope)
      ? await getMachineHash()
      : isHashScope(parsedScope)
        ? parsedScope.machineHash
        : null
    return {
      uid,
      machineHash,
      sinceMs,
      untilMs,
      apps: normalizeAppScopes(appScopes),
      typingTests: normalizeAppScopes(typingTestScopes),
      runIds: normalizeAppScopes(runIdScopes),
    }
  }

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_APPS_FOR_RANGE,
    async (_event, uid, sinceMs, untilMs, scope): Promise<{ name: string; keystrokes: number; activeMs: number }[]> => {
      const args = await parseAppRangeArgs(uid, sinceMs, untilMs, scope)
      if (!args) return []
      return getTypingAnalyticsDB().listAppsForUidInRange(args.uid, args.machineHash, args.sinceMs, args.untilMs)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_TYPING_TESTS_FOR_RANGE,
    async (_event, uid, sinceMs, untilMs, scope): Promise<{ name: string; keystrokes: number; activeMs: number }[]> => {
      const args = await parseAppRangeArgs(uid, sinceMs, untilMs, scope)
      if (!args) return []
      return getTypingAnalyticsDB().listTypingTestsForUidInRange(args.uid, args.machineHash, args.sinceMs, args.untilMs)
    },
  )

  // Distinct run ids in range — the per-run ("Results") filter's options.
  // The analytics DB is the source of truth for which runs exist;
  // `typingTestScopes` narrows them to the selected material(s).
  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_TYPING_TEST_RUNS_FOR_RANGE,
    async (_event, uid, sinceMs, untilMs, scope, typingTestScopes): Promise<{ runId: string; keystrokes: number; firstMs: number }[]> => {
      const args = await parseAppRangeArgs(uid, sinceMs, untilMs, scope)
      if (!args) return []
      return getTypingAnalyticsDB().listTypingTestRunsForUidInRange(
        args.uid,
        args.machineHash,
        args.sinceMs,
        args.untilMs,
        normalizeAppScopes(typingTestScopes),
      )
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_APP_USAGE_FOR_RANGE,
    async (_event, uid, sinceMs, untilMs, scope): Promise<{ name: string; keystrokes: number; activeMs: number }[]> => {
      const args = await parseAppRangeArgs(uid, sinceMs, untilMs, scope)
      if (!args) return []
      return getTypingAnalyticsDB().getAppUsageForUidInRange(args.uid, args.machineHash, args.sinceMs, args.untilMs)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_WPM_BY_APP_FOR_RANGE,
    async (_event, uid, sinceMs, untilMs, scope): Promise<{ name: string; keystrokes: number; activeMs: number }[]> => {
      const args = await parseAppRangeArgs(uid, sinceMs, untilMs, scope)
      if (!args) return []
      return getTypingAnalyticsDB().getWpmByAppForUidInRange(args.uid, args.machineHash, args.sinceMs, args.untilMs)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_BIGRAM_AGGREGATE_FOR_RANGE,
    async (
      _event,
      uid: unknown,
      sinceMs: unknown,
      untilMs: unknown,
      view: unknown,
      scope: unknown,
      options: unknown,
      appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown,
    ): Promise<TypingBigramAggregateResult> => {
      // Reject unknown views up front so parsedView is the trusted union
      // and downstream branches can return literal-typed empty results.
      if (view !== 'top' && view !== 'slow') {
        return emptyBigramResult('top')
      }
      const parsedView: TypingBigramAggregateView = view
      const args = await parseScopedRangeArgs(uid, sinceMs, untilMs, scope, appScopes, typingTestScopes, runIdScopes)
      if (!args) return emptyBigramResult(parsedView)
      const opts = parseBigramAggregateOptions(options)
      const limit = opts.limit ?? 30
      const minSample = opts.minSampleCount ?? 5
      const gram = opts.gram ?? 2

      const db = getTypingAnalyticsDB()
      const rows = args.machineHash === null
        ? db.listNgramMinutesInRangeForUid(gram, args.uid, args.sinceMs, args.untilMs, args.apps, args.typingTests, args.runIds)
        : db.listNgramMinutesInRangeForUidAndHash(gram, args.uid, args.machineHash, args.sinceMs, args.untilMs, args.apps, args.typingTests, args.runIds)
      const totals = aggregatePairTotals(rows)
      // Ranking always slices to `limit`; when the period holds more
      // distinct pairs than that, low-frequency-but-slow entries can
      // fall outside both the top-N and the avgIki re-ranking. Computed
      // here (against the full pair universe) rather than left for the
      // renderer to infer from `entries.length`.
      const truncated = totals.size > limit
      // Trigram rows never carry overlap columns (see NgramMinuteCellRow),
      // so every entry would be null-poisoned anyway — skip the full-map
      // pass entirely instead of walking it just to get null back.
      const rolloverRatio = gram === 3 ? null : observedRolloverRatio(totals)
      if (parsedView === 'slow') {
        return { view: 'slow', entries: rankBigramsBySlow(totals, minSample, limit), truncated, observedRolloverRatio: rolloverRatio }
      }
      return { view: 'top', entries: rankBigramsByCount(totals, limit), truncated, observedRolloverRatio: rolloverRatio }
    },
  )

  // Per-minute oc/on for the Analyze rollover trend chart. Single-variant
  // channel like GET_BIGRAM_AGGREGATE_FOR_RANGE above — `scope` is
  // resolved to own/all/hash here instead of the renderer picking
  // between `*Local`/`*ForHash` siblings. `parseScopedRangeArgs` already
  // resolves `machineHash` to the exact `string | null` shape
  // `listRolloverMinutesInRange` takes, so no further branching is needed.
  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_ROLLOVER_MINUTES,
    async (
      _event,
      uid: unknown,
      scope: unknown,
      sinceMs: unknown,
      untilMs: unknown,
      appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown,
    ): Promise<TypingRolloverMinuteRow[]> => {
      const args = await parseScopedRangeArgs(uid, sinceMs, untilMs, scope, appScopes, typingTestScopes, runIdScopes)
      if (!args) return []
      return getTypingAnalyticsDB().listRolloverMinutesInRange(args.uid, args.machineHash, args.sinceMs, args.untilMs, args.apps, args.typingTests, args.runIds)
    },
  )

  // Per-(row,col,layer) keypress-duration totals for the Analyze
  // duration distribution chart (Interval tab) and the Heatmap duration
  // mode. Single-variant channel, same `parseScopedRangeArgs` resolution
  // as LIST_ROLLOVER_MINUTES above. Unlike that channel, the underlying
  // DB methods are split by uid/uid+hash (matching listMatrixCellsForUid /
  // *ForUidAndHash) rather than taking a nullable machineHash directly,
  // so the dispatch happens here instead of inside the DB layer. The raw
  // per-minute rows are folded into one total per cell via
  // aggregateMatrixDurationTotals — the same aggregation
  // GET_BIGRAM_AGGREGATE_FOR_RANGE runs for n-gram pairs — before
  // shipping, so the renderer never re-derives cross-minute sums itself.
  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_DURATION_CELLS,
    async (
      _event,
      uid: unknown,
      scope: unknown,
      sinceMs: unknown,
      untilMs: unknown,
      appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown,
    ): Promise<TypingDurationCell[]> => {
      const args = await parseScopedRangeArgs(uid, sinceMs, untilMs, scope, appScopes, typingTestScopes, runIdScopes)
      if (!args) return []
      const db = getTypingAnalyticsDB()
      const rows = args.machineHash === null
        ? db.listMatrixDurationCellsForUid(args.uid, args.sinceMs, args.untilMs, args.apps, args.typingTests, args.runIds)
        : db.listMatrixDurationCellsForUidAndHash(args.uid, args.machineHash, args.sinceMs, args.untilMs, args.apps, args.typingTests, args.runIds)
      const totals = aggregateMatrixDurationTotals(rows)
      return Array.from(totals.values()).map((total) => ({
        row: total.row,
        col: total.col,
        layer: total.layer,
        durationSamples: total.count,
        hist: total.hist,
        sum: total.sum,
        sumSq: total.sumSq,
      }))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_LAYOUT_COMPARISON_FOR_RANGE,
    async (
      _event,
      uid: unknown,
      sinceMs: unknown,
      untilMs: unknown,
      scope: unknown,
      options: unknown,
      appScopes: unknown, typingTestScopes: unknown, runIdScopes: unknown,
    ): Promise<LayoutComparisonResult | null> => {
      if (typeof uid !== 'string' || uid.length === 0) return null
      if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return null
      if (typeof untilMs !== 'number' || !Number.isFinite(untilMs) || untilMs <= sinceMs) return null
      const parsedScope = parseDeviceScope(scope)
      if (parsedScope === null) return null
      const opts = parseLayoutComparisonOptions(options)
      if (!opts) return null
      const apps = normalizeAppScopes(appScopes)
      const typingTests = normalizeAppScopes(typingTestScopes)
      const runIds = normalizeAppScopes(runIdScopes)
      // Snapshots are only stored for the own device, so we always
      // resolve the source layer + KleKey geometry against the local
      // machine hash regardless of which scope the metric counts use.
      const ownHash = await getMachineHash()
      const snapshot = await getKeymapSnapshotForRange(app.getPath('userData'), uid, ownHash, sinceMs, untilMs)
      if (!snapshot) return null
      const kleKeys = extractKleKeysFromSnapshot(snapshot)
      const matrixHash = isOwnScope(parsedScope)
        ? ownHash
        : isHashScope(parsedScope)
          ? parsedScope.machineHash
          : undefined
      const sinceMinuteMs = Math.floor(sinceMs / MINUTE_MS) * MINUTE_MS
      const untilMinuteMs = Math.ceil(untilMs / MINUTE_MS) * MINUTE_MS
      const matrixCounts = getTypingAnalyticsDB().aggregateMatrixCountsForUidInRange(
        uid,
        0,
        sinceMinuteMs,
        untilMinuteMs,
        matrixHash,
        apps,
        typingTests,
        runIds,
      )
      return computeLayoutComparison({
        matrixCounts,
        snapshot,
        kleKeys,
        source: opts.source,
        targets: opts.targets,
        metrics: opts.metrics,
        fingerOverrides: opts.fingerOverrides,
      })
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_KEYMAP_SNAPSHOT_FOR_RANGE,
    async (_event, uid: unknown, fromMs: unknown, toMs: unknown): Promise<TypingKeymapSnapshot | null> => {
      if (typeof uid !== 'string' || uid.length === 0) return null
      if (typeof fromMs !== 'number' || !Number.isFinite(fromMs)) return null
      if (typeof toMs !== 'number' || !Number.isFinite(toMs)) return null
      // Snapshots are only written by the own device (Record-start runs
      // on connected devices), so the Analyze view looks up the own
      // machineHash. Remote snapshots aren't transferred today.
      const machineHash = await getMachineHash()
      return getKeymapSnapshotForRange(app.getPath('userData'), uid, machineHash, fromMs, toMs)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_KEYMAP_SNAPSHOTS,
    async (_event, uid: unknown): Promise<TypingKeymapSnapshotSummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      // Only own-device snapshots are persisted locally; the timeline
      // mirrors `getKeymapSnapshotForRange` and resolves the machine
      // hash internally so callers don't pass it across IPC.
      const machineHash = await getMachineHash()
      return listKeymapSnapshotSummaries(app.getPath('userData'), uid, machineHash)
    },
  )
}

/**
 * True when there is unsaved analytics state — either live (buffer entries,
 * queued session records, active sessions) or work currently in flight on
 * the flush chain. Both must be visible so the before-quit finalizer waits
 * even when a flush snapshot has already cleared the live state.
 */
export function hasTypingAnalyticsPendingWork(): boolean {
  return (
    dirty ||
    pendingSessions.length > 0 ||
    !minuteBuffer.isEmpty() ||
    sessionDetector.hasAnyActiveSession() ||
    inFlightFlushCount > 0
  )
}

/**
 * Drain everything for a clean shutdown. Closes any active sessions,
 * persists all minute buckets (including the live one), and writes any queued
 * session records. Safe to call when there is nothing pending — no-op then.
 */
export async function flushTypingAnalyticsBeforeQuit(): Promise<void> {
  pendingSessions.push(...sessionDetector.closeAll())
  if (pendingSessions.length > 0) dirty = true
  await flushNow({ final: true })
}

// --- Data modal API --------------------------------------------------

/** Keyboards that currently have live typing analytics rows, aggregated
 * across every machine that has synced to this device. */
export function listTypingKeyboards(): TypingKeyboardSummary[] {
  return getTypingAnalyticsDB().listKeyboardsWithTypingData()
}

/** Day-level summaries for one keyboard uid, newest first. */
export function listTypingDailySummaries(
  uid: string,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingDailySummary[] {
  return getTypingAnalyticsDB().listDailySummariesForUid(uid, appScopes, typingTestScopes, runIdScopes)
}

/** Pure-cache lookup for the Analyze > Interval chart. Returns every
 * day's envelope + mean quartile across every scope that shares `uid`. */
export function listTypingIntervalSummaries(uid: string): TypingIntervalDailySummary[] {
  return getTypingAnalyticsDB().listIntervalSummariesForUid(uid)
}

/** Same as {@link listTypingIntervalSummaries} but restricted to one
 * machine hash — powers the Analyze device filter when scoped to this
 * device only. */
export function listTypingIntervalSummariesForHash(
  uid: string,
  machineHash: string,
): TypingIntervalDailySummary[] {
  return getTypingAnalyticsDB().listIntervalSummariesForUidAndHash(uid, machineHash)
}

/** Hour × day-of-week activity grid for the Analyze > Heatmap view
 * over the inclusive-lower, exclusive-upper `[sinceMs, untilMs)`
 * window. Pass `sinceMs=0, untilMs=Number.MAX_SAFE_INTEGER` for the
 * full history. */
export function listTypingActivityGrid(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingActivityCell[] {
  return getTypingAnalyticsDB().listActivityGridForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingActivityGridForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingActivityCell[] {
  return getTypingAnalyticsDB().listActivityGridForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Per-layer keystroke totals for the Analyze > Layer tab. Covers
 * `[sinceMs, untilMs)` and aggregates across every machine hash. */
export function listTypingLayerUsageInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingLayerUsageRow[] {
  return getTypingAnalyticsDB().listLayerUsageForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingLayerUsageInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingLayerUsageRow[] {
  return getTypingAnalyticsDB().listLayerUsageForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Per-cell matrix totals for the Analyze > Layer activations mode.
 * Aggregates across every machine hash. */
export function listTypingMatrixCellsInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMatrixCellRow[] {
  return getTypingAnalyticsDB().listMatrixCellsForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingMatrixCellsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMatrixCellRow[] {
  return getTypingAnalyticsDB().listMatrixCellsForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Per-(localDay, layer, row, col) totals for the Analyze Ergonomic
 * Learning Curve. The renderer buckets these by week / month before
 * folding them into ergonomic sub-scores; we keep `dayMs` numeric so
 * the bucketing stays purely arithmetic on the renderer side. */
export function listTypingMatrixCellsByDayInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMatrixCellDailyRow[] {
  return getTypingAnalyticsDB().listMatrixCellsByDayForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingMatrixCellsByDayInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMatrixCellDailyRow[] {
  return getTypingAnalyticsDB().listMatrixCellsByDayForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Minute-raw stats for the Analyze WPM / Interval charts over the
 * `[sinceMs, untilMs)` window. Callers bucket these on the renderer.
 * Empty `appScopes` (or omitted) keeps the pre-filter behaviour; a
 * non-empty array restricts the query to minutes whose tagged app
 * matches one of the listed names. */
export function listTypingMinuteStatsInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMinuteStatsRow[] {
  return getTypingAnalyticsDB().listMinuteStatsInRangeForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingMinuteStatsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingMinuteStatsRow[] {
  return getTypingAnalyticsDB().listMinuteStatsInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Live sessions that intersect `[sinceMs, untilMs)`. Powers the
 * Analyze session-distribution histogram. */
export function listTypingSessionsInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
): TypingSessionRow[] {
  return getTypingAnalyticsDB().listSessionsInRangeForUid(uid, sinceMs, untilMs)
}

export function listTypingSessionsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
): TypingSessionRow[] {
  return getTypingAnalyticsDB().listSessionsInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs)
}

/** Per-minute character counts for the Analyze error-proxy overlay. */
export function listTypingBksMinuteInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingBksMinuteRow[] {
  return getTypingAnalyticsDB().listBksMinuteInRangeForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function listTypingBksMinuteInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingBksMinuteRow[] {
  return getTypingAnalyticsDB().listBksMinuteInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function getTypingPeakRecordsInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): PeakRecords {
  return getTypingAnalyticsDB().getPeakRecordsInRangeForUid(uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

export function getTypingPeakRecordsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): PeakRecords {
  return getTypingAnalyticsDB().getPeakRecordsInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes)
}

/** Day-level summaries restricted to a single `machineHash`. When
 * called with the local machine hash it powers the Local tab; with a
 * remote hash it powers the Sync > Device tab. */
export function listTypingDailySummariesForHash(
  uid: string,
  machineHash: string,
  appScopes: readonly string[] = [],
  typingTestScopes: readonly string[] = [],
  runIdScopes: readonly string[] = [],
): TypingDailySummary[] {
  return getTypingAnalyticsDB().listDailySummariesForUidAndHash(uid, machineHash, appScopes, typingTestScopes, runIdScopes)
}

/** Per-keyboard device infos for the Analyze > Device filter: own
 * machine + every remote machine that has live data. The own entry
 * is built from the local OS module so the filter can label it even
 * before the first event has been persisted to typing_scopes. */
export async function listTypingDeviceInfosForUid(
  uid: string,
): Promise<TypingAnalyticsDeviceInfoBundle> {
  const ownHash = await getMachineHash()
  const remotes = getTypingAnalyticsDB().listRemoteDeviceInfosForUid(uid, ownHash)
  const own: TypingAnalyticsDeviceInfo = {
    machineHash: ownHash,
    osPlatform: platform(),
    osRelease: release(),
  }
  return { own, remotes }
}

/** Heatmap intensity for the typing-view overlay: summed matrix counts
 * per (row, col) on a single keyboard + machine + layer, covering the
 * window `[floorMinute(sinceMs), now]`. Values are the sum of:
 *
 *  - DB rows flushed for that window (closed minutes), and
 *  - the live current-minute entries still sitting in the `MinuteBuffer`.
 *
 * Each cell carries a `{ total, tap, hold }` triple so the UI can
 * colour the outer (hold) and inner (tap) rects of LT/MT keys
 * independently while non-tap-hold keys stay painted by `total`.
 * The live-minute path is what keeps a 5s poll usable — without it
 * the heatmap would lag the debounced flush by up to ~59 seconds.
 * Serializes the Map as a plain keyed object so the triple round-trips
 * through IPC unchanged. */
export async function getMatrixHeatmap(
  uid: string,
  layer: number,
  sinceMs: number,
): Promise<TypingHeatmapByCell> {
  const machineHash = await getMachineHash()
  const sinceMinuteMs = Math.floor(sinceMs / MINUTE_MS) * MINUTE_MS

  const db = getTypingAnalyticsDB()
  const totals = db.aggregateMatrixCountsForUid(uid, machineHash, layer, sinceMinuteMs)
  const live = minuteBuffer.peekMatrixCountsForUid(uid, machineHash, layer)
  for (const [key, cell] of live) {
    const existing = totals.get(key)
    if (existing) {
      existing.total += cell.total
      existing.tap += cell.tap
      existing.hold += cell.hold
    } else {
      totals.set(key, { total: cell.total, tap: cell.tap, hold: cell.hold })
    }
  }

  const result: TypingHeatmapByCell = {}
  for (const [key, cell] of totals) result[key] = cell
  return result
}

/** Convert a 'YYYY-MM-DD' local-calendar date into a [startMs, endMs)
 * window that matches the strftime('%Y-%m-%d', ..., 'localtime') buckets
 * used by listDailySummariesForUid. */
function localDayRangeMs(date: string): { startMs: number; endMs: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  const startMs = new Date(y, mo - 1, d).getTime()
  const endMs = new Date(y, mo - 1, d + 1).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return { startMs, endMs }
}

/** Append rows to a per-day JSONL master file and replay them into the
 * local cache. The caller batches `saveSyncState` afterwards so a
 * multi-uid flush hits disk once. */
async function persistOwnJsonlDay(
  uid: string,
  utcDay: UtcDay,
  rows: readonly JsonlRow[],
  machineHash: string,
  userDataDir: string,
): Promise<void> {
  const path = deviceDayJsonlPath(userDataDir, uid, machineHash, utcDay)
  await appendRowsToFile(path, rows)
  applyRowsToCache(getTypingAnalyticsDB(), rows)
}

/** Delete the local per-day JSONL files covering the requested
 * calendar dates and tombstone the matching cache rows for an
 * immediate list refresh. The owning device's `uploaded` bookkeeping
 * still holds the day, so the next sync pass drops the cloud copy via
 * reconcile rule 2. `is_deleted` on cache rows is retained so the
 * upcoming list query can hide the affected minutes before the next
 * rebuild runs. */
export async function deleteTypingDailySummaries(
  uid: string,
  dates: string[],
): Promise<TypingTombstoneResult> {
  await flushNow({ final: true })
  const ranges: Array<{ startMs: number; endMs: number }> = []
  for (const date of dates) {
    const range = localDayRangeMs(date)
    if (range) ranges.push(range)
  }
  if (ranges.length === 0) {
    return emptyTombstoneResult()
  }
  const machineHash = await getMachineHash()
  const userDataDir = app.getPath('userData')
  // Map each local-calendar range to the UTC days it overlaps. A local
  // date typically covers one UTC day, but near midnight UTC in
  // non-zero offsets it spans two, so we unlink both.
  const utcDays = new Set<UtcDay>()
  for (const range of ranges) {
    utcDays.add(utcDayFromMs(range.startMs))
    utcDays.add(utcDayFromMs(range.endMs - 1))
  }
  for (const day of utcDays) {
    try {
      await unlinkOwnDayFile(userDataDir, uid, machineHash, day)
    } catch (err) {
      log('warn', `typing-analytics per-day unlink failed for ${uid}/${machineHash}/${day}: ${String(err)}`)
    }
  }
  const db = getTypingAnalyticsDB()
  const updatedAt = Date.now()
  const result = emptyTombstoneResult()
  for (const range of ranges) {
    const r = db.tombstoneRowsForUidInRange(uid, range.startMs, range.endMs, updatedAt)
    result.charMinutes += r.charMinutes
    result.matrixMinutes += r.matrixMinutes
    result.minuteStats += r.minuteStats
    result.bigramMinutes += r.bigramMinutes
    result.trigramMinutes += r.trigramMinutes
    result.sessions += r.sessions
  }
  await notifySyncIfTouched(uid, result, [...utcDays])
  return result
}

/** Delete every per-day JSONL file owned by this device for the given
 * keyboard uid and tombstone all of that uid's cache rows. Other
 * devices' files are untouched — they clear themselves on their own
 * Delete All action. */
export async function deleteAllTypingForKeyboard(uid: string): Promise<TypingTombstoneResult> {
  // Finalize this keyboard's active session first so flushNow persists it and
  // the cache tombstone below covers it; otherwise closeAll() on quit would
  // re-persist the open session and resurrect the deleted keyboard in Analyze.
  closeSessionsForUid(uid)
  await flushNow({ final: true })
  const machineHash = await getMachineHash()
  const userDataDir = app.getPath('userData')
  // Snapshot the days *before* unlinking so the post-tombstone notify
  // can still iterate over them — once the unlink loop has removed every
  // per-day file, a fresh listDeviceDays would only see the now-empty
  // directory and return [].
  const days = await listDeviceDays(userDataDir, uid, machineHash)
  for (const day of days) {
    try {
      await unlinkOwnDayFile(userDataDir, uid, machineHash, day)
    } catch (err) {
      log('warn', `typing-analytics per-day unlink failed for ${uid}/${machineHash}/${day}: ${String(err)}`)
    }
  }
  const db = getTypingAnalyticsDB()
  const updatedAt = Date.now()
  const result = db.tombstoneAllRowsForUid(uid, updatedAt)
  await notifySyncIfTouched(uid, result, days)
  return result
}

async function unlinkOwnDayFile(
  userDataDir: string,
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): Promise<void> {
  try {
    await unlink(deviceDayJsonlPath(userDataDir, uid, machineHash, utcDay))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}

/** Emit one per-day sync-unit per affected day so the upload pipeline
 * picks up the new rows for each `(uid, machineHash, day)` independently.
 * Caller is responsible for materialising the affected `days` *before*
 * any unlink so a delete-and-notify flow doesn't lose the day list. */
async function notifySyncIfTouched(
  uid: string,
  result: TypingTombstoneResult,
  days: readonly UtcDay[],
): Promise<void> {
  const touched =
    result.charMinutes + result.matrixMinutes + result.minuteStats +
    result.bigramMinutes + result.trigramMinutes + result.sessions
  if (touched === 0 || days.length === 0) return
  const notifier = syncNotifier
  if (!notifier) return
  try {
    const machineHash = await getMachineHash()
    for (const day of days) {
      notifier(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, day))
    }
  } catch (err) {
    log('warn', `typing-analytics sync notify failed for ${uid}: ${String(err)}`)
  }
}

function isValidKeyboard(value: unknown): value is TypingAnalyticsKeyboard {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.uid === 'string' && obj.uid.length > 0 &&
    typeof obj.vendorId === 'number' && Number.isFinite(obj.vendorId) &&
    typeof obj.productId === 'number' && Number.isFinite(obj.productId) &&
    typeof obj.productName === 'string'
  )
}

/** Longest duration (ms) a single keypress is allowed to report. Well
 * above any real tap or held layer key, but low enough to reject a
 * clearly corrupt/fabricated sample (e.g. a renderer bug feeding a stale
 * press record) instead of letting it skew the per-cell histogram. */
const MAX_MATRIX_RELEASE_DURATION_MS = 60_000

function isValidMatrixCommon(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.row === 'number' && Number.isInteger(obj.row) && obj.row >= 0 &&
    typeof obj.col === 'number' && Number.isInteger(obj.col) && obj.col >= 0 &&
    typeof obj.layer === 'number' && Number.isInteger(obj.layer) && obj.layer >= 0 &&
    typeof obj.keycode === 'number' && Number.isFinite(obj.keycode)
  )
}

/** Strip an invalid optional auxiliary field from a `matrix` event
 * payload in place, rather than rejecting the whole keystroke over it.
 * `action`/`overlap`/`pollGapMs` are all best-effort classification data
 * layered on top of a real physical press — an out-of-range value there
 * (a stale/misordered pollGapMs sample, a corrupted boolean) is a timing
 * or classification artifact, not evidence the press itself didn't
 * happen. Rejecting the whole event over it would lose a real keystroke
 * to something the renderer could compute wrong — precisely the class of
 * bug #322/#323 already fixed elsewhere in this pipeline. Core fields
 * (row/col/layer/keycode, checked by isValidMatrixCommon before this
 * runs) are NOT sanitized: there is no safe fallback for "which cell was
 * this", so those still reject the whole event as before.
 *
 * The pollGapMs bound (`0 < pollGapMs <= OBSERVATION_HOLE_MS`) reuses the
 * same shared constant the renderer's hole detection is built on (see
 * matrix-press-duration.ts's onFrame) — by construction, any pollGapMs
 * the renderer ever legitimately attaches already satisfies it, so this
 * is a self-consistency check on the wire value, not an independent
 * policy choice that could drift from the renderer's own threshold. */
function sanitizeMatrixAuxFields(obj: Record<string, unknown>): void {
  if (obj.action !== undefined && obj.action !== 'tap' && obj.action !== 'hold') delete obj.action
  if (obj.overlap !== undefined && typeof obj.overlap !== 'boolean') delete obj.overlap
  if (obj.pollGapMs !== undefined) {
    const gap = obj.pollGapMs
    if (typeof gap !== 'number' || !Number.isFinite(gap) || gap <= 0 || gap > OBSERVATION_HOLE_MS) delete obj.pollGapMs
  }
}

function isValidEvent(value: unknown): value is TypingAnalyticsEvent {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) return false
  if (!isValidKeyboard(obj.keyboard)) return false
  if (obj.kind === 'char') {
    return typeof obj.key === 'string' && obj.key.length > 0
  }
  if (obj.kind === 'matrix') {
    if (!isValidMatrixCommon(obj)) return false
    sanitizeMatrixAuxFields(obj)
    return true
  }
  if (obj.kind === 'matrix-release') {
    if (!isValidMatrixCommon(obj)) return false
    return (
      typeof obj.durationMs === 'number' && Number.isFinite(obj.durationMs) &&
      obj.durationMs > 0 && obj.durationMs < MAX_MATRIX_RELEASE_DURATION_MS
    )
  }
  return false
}

async function resolveScope(keyboard: TypingAnalyticsKeyboard): Promise<ResolvedScope> {
  const cached = scopeCache.get(keyboard.uid)
  if (cached) return cached
  const fingerprint = await buildFingerprint(keyboard)
  const resolved: ResolvedScope = { fingerprint, scopeKey: canonicalScopeKey(fingerprint) }
  scopeCache.set(keyboard.uid, resolved)
  return resolved
}

async function ingestEvent(event: TypingAnalyticsEvent): Promise<void> {
  const { fingerprint, scopeKey } = await resolveScope(event.keyboard)
  minuteBuffer.addEvent(event, fingerprint, Date.now())
  // matrix-release events are duration-only by contract (see the shared
  // event type's doc comment) — they carry no new keystroke, so they
  // must not participate in session detection. A held key's release can
  // land minutes after its press (a long hold, or a press near a poll
  // gap); if it counted here, that gap-spanning release could silently
  // extend — or even re-open — a session a press-only stream would have
  // already let idle-close.
  if (event.kind !== 'matrix-release') {
    const finalized = sessionDetector.recordEvent(event.keyboard.uid, scopeKey, event.ts)
    if (finalized.length > 0) pendingSessions.push(...finalized)
  }
  dirty = true
  scheduleFlush()
}

function closeSessionsForUid(uid: string): void {
  const finalized = sessionDetector.closeForUid(uid)
  if (finalized.length === 0) return
  pendingSessions.push(...finalized)
  dirty = true
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flushNow({ final: false })
  }, FLUSH_DEBOUNCE_MS)
}

function buildScopeRow(
  scopeKey: string,
  fingerprint: TypingAnalyticsFingerprint,
  updatedAt: number,
): JsonlRow {
  return {
    id: scopeRowId(scopeKey),
    kind: 'scope',
    updated_at: updatedAt,
    payload: {
      id: scopeKey,
      machineHash: fingerprint.machineHash,
      osPlatform: fingerprint.os.platform,
      osRelease: fingerprint.os.release,
      osArch: fingerprint.os.arch,
      keyboardUid: fingerprint.keyboard.uid,
      keyboardVendorId: fingerprint.keyboard.vendorId,
      keyboardProductId: fingerprint.keyboard.productId,
      keyboardProductName: fingerprint.keyboard.productName,
    },
  }
}

/** Coerce the IPC `options` payload to a typed shape, dropping
 * non-finite or non-positive values. Returning an empty object lets
 * the handler fall through to its defaults without per-field guards. */
function parseBigramAggregateOptions(value: unknown): TypingBigramAggregateOptions {
  if (typeof value !== 'object' || value === null) return {}
  const o = value as Record<string, unknown>
  const out: TypingBigramAggregateOptions = {}
  if (typeof o.minSampleCount === 'number' && Number.isFinite(o.minSampleCount) && o.minSampleCount >= 0) {
    out.minSampleCount = Math.floor(o.minSampleCount)
  }
  if (typeof o.limit === 'number' && Number.isFinite(o.limit) && o.limit > 0) {
    out.limit = Math.floor(o.limit)
  }
  if (o.gram === 2 || o.gram === 3) {
    out.gram = o.gram
  }
  return out
}

const LAYOUT_COMPARISON_METRICS = new Set<LayoutComparisonMetric>([
  'fingerLoad',
  'handBalance',
  'rowDist',
  'homeRow',
])

function isLayoutInputLayout(value: unknown): value is LayoutComparisonInputLayout {
  if (typeof value !== 'object' || value === null) return false
  const o = value as Record<string, unknown>
  if (typeof o.id !== 'string' || o.id.length === 0) return false
  if (typeof o.map !== 'object' || o.map === null) return false
  return true
}

// Strict reject-whole-map policy (unlike hub-analytics.ts's
// sanitizeFingerOverrides, which drops invalid entries instead): a
// malformed fingerOverrides here fails the whole IPC call the same way
// a malformed source/targets does.
function isValidFingerOverrides(value: unknown): value is Record<string, FingerType> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isPosKey(key)) return false
    if (!isFingerType(v)) return false
  }
  return true
}

function parseLayoutComparisonOptions(value: unknown): LayoutComparisonOptions | null {
  if (typeof value !== 'object' || value === null) return null
  const o = value as Record<string, unknown>
  if (!isLayoutInputLayout(o.source)) return null
  if (!Array.isArray(o.targets) || !o.targets.every(isLayoutInputLayout)) return null
  if (!Array.isArray(o.metrics)) return null
  const metrics: LayoutComparisonMetric[] = []
  for (const m of o.metrics) {
    if (typeof m === 'string' && LAYOUT_COMPARISON_METRICS.has(m as LayoutComparisonMetric)) {
      metrics.push(m as LayoutComparisonMetric)
    }
  }
  let fingerOverrides: Record<string, FingerType> | undefined
  if (o.fingerOverrides !== undefined) {
    if (!isValidFingerOverrides(o.fingerOverrides)) return null
    fingerOverrides = o.fingerOverrides
  }
  return { source: o.source, targets: o.targets, metrics, fingerOverrides }
}

/** snapshot.layout is wire-shaped (`{ keys: KleKey[] }` from the
 * renderer). Pull the keys array out defensively in case a future
 * snapshot format change leaves it absent. */
function extractKleKeysFromSnapshot(snapshot: TypingKeymapSnapshot): KleKey[] {
  const layout = snapshot.layout as { keys?: unknown } | null
  if (!layout || !Array.isArray(layout.keys)) return []
  return layout.keys as KleKey[]
}

function buildSnapshotRows(snapshot: MinuteSnapshot, updatedAt: number): JsonlRow[] {
  // appName carries through to every per-minute row so the JSONL master
  // file is the source of truth for app filtering after a cache rebuild.
  // Older master files predate this field; the readers fall back to
  // null on missing.
  const appName = snapshot.appName
  // typing_test carries through identically to appName so the JSONL master
  // stays the source of truth for TypingTest filtering after a rebuild.
  const typingTest = snapshot.typingTest
  // run_id is part of every per-minute row's identity (id + SQLite PK) so
  // two runs in one minute stay distinct. '' for non-test (REC) input.
  const runId = snapshot.runId
  const rows: JsonlRow[] = []
  // A minute whose only contribution is a matrix-release event (a press
  // near :59.9 released at :00.1 of the NEXT minute — see the
  // matrix-release event type's doc comment on release-vs-press minute
  // attribution) has keystrokes === 0 and no charCounts: nothing was
  // actually typed IN this minute, only a duration sample that happens
  // to land here. Shipping a minute-stats row for it would fabricate a
  // phantom day in selectDailySummariesForUid — a day appears in Analyze
  // solely because a key held across midnight happened to release a
  // fraction of a second into the next day. The matrix-minute row for
  // that cell (carrying the duration data) still ships in the loop
  // below regardless; only this per-minute stats rollup is skipped.
  if (snapshot.keystrokes > 0 || snapshot.charCounts.size > 0) {
    rows.push({
      id: minuteStatsRowId(snapshot.scopeId, snapshot.minuteTs, runId),
      kind: 'minute-stats',
      updated_at: updatedAt,
      payload: {
        scopeId: snapshot.scopeId,
        minuteTs: snapshot.minuteTs,
        keystrokes: snapshot.keystrokes,
        activeMs: snapshot.activeMs,
        intervalAvgMs: snapshot.intervalAvgMs,
        intervalMinMs: snapshot.intervalMinMs,
        intervalP25Ms: snapshot.intervalP25Ms,
        intervalP50Ms: snapshot.intervalP50Ms,
        intervalP75Ms: snapshot.intervalP75Ms,
        intervalMaxMs: snapshot.intervalMaxMs,
        // Absent (not null) when the minute recorded no poll-gap samples
        // at all — mirrors the matrix-minute dh/ds/dq convention below:
        // "no data" stays absent on the wire rather than an explicit
        // null pair, keeping pre-v8 rows and "genuinely no samples" rows
        // indistinguishable on disk — readers already treat both
        // identically (see isValidPollStatsPair).
        ...(snapshot.pollP50Ms !== null ? { pollP50Ms: snapshot.pollP50Ms, pollP95Ms: snapshot.pollP95Ms } : {}),
        appName,
        typingTest,
        runId,
      },
    })
  }
  for (const [char, count] of snapshot.charCounts) {
    rows.push({
      id: charMinuteRowId(snapshot.scopeId, snapshot.minuteTs, runId, char),
      kind: 'char-minute',
      updated_at: updatedAt,
      payload: { scopeId: snapshot.scopeId, minuteTs: snapshot.minuteTs, char, count, appName, typingTest, runId },
    })
  }
  for (const cell of snapshot.matrixCounts.values()) {
    // Built once as a complete triple (or left undefined) rather than
    // computed piecemeal — present only when this cell had at least one
    // matrix-release sample this minute; see JsonlMatrixMinutePayload's
    // doc comment for why absent (not a zeroed histogram) is correct.
    let dur: { dh: number[]; ds: number; dq: number } | undefined
    if (cell.durations.length > 0) {
      const { sum, sumSq } = sumAndSumSquares(cell.durations)
      dur = { dh: bucketizeDurations(cell.durations), ds: sum, dq: sumSq }
    }
    rows.push({
      id: matrixMinuteRowId(snapshot.scopeId, snapshot.minuteTs, runId, cell.row, cell.col, cell.layer),
      kind: 'matrix-minute',
      updated_at: updatedAt,
      payload: {
        scopeId: snapshot.scopeId,
        minuteTs: snapshot.minuteTs,
        row: cell.row,
        col: cell.col,
        layer: cell.layer,
        keycode: cell.keycode,
        count: cell.count,
        tapCount: cell.tapCount,
        holdCount: cell.holdCount,
        ...dur,
        appName,
        typingTest,
        runId,
      },
    })
  }
  if (snapshot.bigrams.size > 0) {
    rows.push({
      id: bigramMinuteRowId(snapshot.scopeId, snapshot.minuteTs, runId),
      kind: 'bigram-minute',
      updated_at: updatedAt,
      payload: {
        scopeId: snapshot.scopeId,
        minuteTs: snapshot.minuteTs,
        bigrams: toNgramEntries(snapshot.bigrams, snapshot.overlaps),
        appName,
        typingTest,
        runId,
      },
    })
  }
  if (snapshot.trigrams.size > 0) {
    rows.push({
      id: trigramMinuteRowId(snapshot.scopeId, snapshot.minuteTs, runId),
      kind: 'trigram-minute',
      updated_at: updatedAt,
      payload: {
        scopeId: snapshot.scopeId,
        minuteTs: snapshot.minuteTs,
        // Overlap is a bigram-only concept — see JsonlBigramMinuteEntry's
        // doc comment on why trigram entries never carry oc/on.
        trigrams: toNgramEntries(snapshot.trigrams),
        appName,
        typingTest,
        runId,
      },
    })
  }
  return rows
}

/** Bucketize each pair/triple's raw IKI samples into the JSONL entry
 * shape (`c`/`h`/`s`/`sq`) shared by bigram-minute and trigram-minute
 * rows — see {@link buildSnapshotRows}. `overlaps` is supplied for the
 * bigram call site only; when present, a pair with a recorded overlap
 * accumulator gains `oc`/`on` (absent — not zeroed — for a pair whose
 * every contributing event had an undetermined overlap, since "never
 * observed" must not collapse into "observed as never overlapping"). */
function toNgramEntries(
  ikisByKey: ReadonlyMap<string, number[]>,
  overlaps?: ReadonlyMap<string, { oc: number; on: number }>,
): Record<string, JsonlBigramMinuteEntry> {
  const entries: Record<string, JsonlBigramMinuteEntry> = {}
  for (const [key, ikis] of ikisByKey) {
    const { sum, sumSq } = sumAndSumSquares(ikis)
    const overlap = overlaps?.get(key)
    entries[key] = {
      c: ikis.length,
      h: bucketizeIki(ikis),
      s: sum,
      sq: sumSq,
      ...(overlap ? { oc: overlap.oc, on: overlap.on } : {}),
    }
  }
  return entries
}

function buildSessionRow(
  session: FinalizedSession,
  resolved: ResolvedScope,
  updatedAt: number,
): JsonlRow {
  return {
    id: sessionRowId(session.id),
    kind: 'session',
    updated_at: updatedAt,
    payload: {
      id: session.id,
      scopeId: resolved.scopeKey,
      startMs: session.startMs,
      endMs: session.endMs,
    },
  }
}

/** Partition the flush's rows into per-(uid, UTC-day) buckets.
 *
 * The UTC day is derived from the row's native timestamp:
 *   - snapshot rows (minute-stats / char-minute / matrix-minute) use
 *     `minuteTs` so every row in the same minute bucket lands on the
 *     same day regardless of how long the flush takes to run.
 *   - session rows use `startMs`; a session that spans 00:00 UTC is
 *     kept whole on the start day (no splitting).
 *   - scope rows don't carry a timestamp, so they're replicated into
 *     every day that references the scope in this flush. The LWW merge
 *     makes the duplicates idempotent on the cache side. */
function groupRowsByUidDay(
  scopesToUpsert: Map<string, TypingAnalyticsFingerprint>,
  snapshots: MinuteSnapshot[],
  sessionsWithScope: Array<{ session: FinalizedSession; resolved: ResolvedScope }>,
  updatedAt: number,
): Map<string, Map<UtcDay, JsonlRow[]>> {
  const rowsByUidDay = new Map<string, Map<UtcDay, JsonlRow[]>>()
  const scopeDays = new Map<string, Set<UtcDay>>()
  const scopeDayKey = (uid: string, scopeId: string): string => `${uid}\0${scopeId}`

  const addRow = (uid: string, day: UtcDay, row: JsonlRow): void => {
    let byDay = rowsByUidDay.get(uid)
    if (!byDay) {
      byDay = new Map<UtcDay, JsonlRow[]>()
      rowsByUidDay.set(uid, byDay)
    }
    const list = byDay.get(day)
    if (list) list.push(row)
    else byDay.set(day, [row])
  }

  const recordScopeDay = (uid: string, scopeId: string, day: UtcDay): void => {
    const key = scopeDayKey(uid, scopeId)
    const set = scopeDays.get(key)
    if (set) set.add(day)
    else scopeDays.set(key, new Set([day]))
  }

  for (const snapshot of snapshots) {
    const uid = snapshot.fingerprint.keyboard.uid
    const day = utcDayFromMs(snapshot.minuteTs)
    recordScopeDay(uid, snapshot.scopeId, day)
    for (const row of buildSnapshotRows(snapshot, updatedAt)) {
      addRow(uid, day, row)
    }
  }
  for (const { session, resolved } of sessionsWithScope) {
    const uid = resolved.fingerprint.keyboard.uid
    const day = utcDayFromMs(session.startMs)
    recordScopeDay(uid, resolved.scopeKey, day)
    addRow(uid, day, buildSessionRow(session, resolved, updatedAt))
  }
  for (const [scopeId, fingerprint] of scopesToUpsert) {
    const uid = fingerprint.keyboard.uid
    const days = scopeDays.get(scopeDayKey(uid, scopeId))
    if (!days) continue
    const scopeRow = buildScopeRow(scopeId, fingerprint, updatedAt)
    for (const day of days) addRow(uid, day, scopeRow)
  }
  return rowsByUidDay
}

/**
 * Run a single flush pass: drain the live buffer + session queue, append
 * every row to the per-device JSONL master file, and apply the same rows
 * to the local SQLite cache via the LWW merge helpers. On `final: true`
 * every buffered minute is drained; otherwise only minutes strictly
 * older than the current wall-clock minute are drained so the live
 * minute keeps accumulating.
 */
async function doFlushPass(options: { final: boolean }): Promise<void> {
  if (!dirty && pendingSessions.length === 0) return
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }

  // Confirm the DB is usable BEFORE draining the buffer. A failed open here
  // would otherwise throw the drained counts away with no way to recover.
  // persistOwnJsonlRows resolves the singleton on each call, so the return
  // value isn't captured here.
  try {
    getTypingAnalyticsDB()
  } catch (err) {
    log('error', `typing-analytics DB open failed: ${String(err)}`)
    return
  }

  // Resolve the active application name once per flush, then tag every
  // open buffer entry. Done before the drain so the snapshot finalize
  // sees the up-to-date app set. Errors inside getCurrentAppName are
  // swallowed there (returns null), so this never blocks a flush.
  try {
    const appName = await getCurrentAppName()
    minuteBuffer.markAppName(appName)
  } catch (err) {
    // Defensive — getCurrentAppName already catches its own errors,
    // but a bug in markAppName shouldn't drop the whole flush either.
    log('warn', `typing-analytics app-name tag failed: ${String(err)}`)
  }

  // No await may be introduced between this drain and buildSnapshotRows /
  // groupRowsByUidDay below: those functions copy each snapshot's Maps
  // into plain row payloads synchronously, and a retained entry can be
  // reopened (mutated) by the very next ingestEvent. Without that
  // synchronous handoff, a snapshot already handed to a caller could be
  // mutated out from under it before its rows are built.
  const snapshots = options.final
    ? minuteBuffer.drainAll()
    : minuteBuffer.drainClosed(Date.now())
  const sessionsToWrite = pendingSessions.splice(0)

  if (snapshots.length === 0 && sessionsToWrite.length === 0) {
    dirty = !minuteBuffer.isEmpty()
    return
  }

  // Resolve the scope for each session up front. A missing scope is only
  // reachable after a reset (tests) or if the uid never produced an event —
  // drop with a warning rather than requeueing, otherwise the session would
  // loop forever on every subsequent pass.
  const validSessions: Array<{ session: FinalizedSession; resolved: ResolvedScope }> = []
  for (const session of sessionsToWrite) {
    const resolved = scopeCache.get(session.uid)
    if (!resolved) {
      log('warn', `typing-analytics session dropped — scope missing for ${session.uid} (${session.keystrokeCount} keystrokes)`)
      continue
    }
    validSessions.push({ session, resolved })
  }

  // Deduplicate scope upserts: a burst of snapshots or sessions for one
  // scope only needs a single row write per pass.
  const scopesToUpsert = new Map<string, TypingAnalyticsFingerprint>()
  for (const snapshot of snapshots) {
    scopesToUpsert.set(snapshot.scopeId, snapshot.fingerprint)
  }
  for (const { resolved } of validSessions) {
    scopesToUpsert.set(resolved.scopeKey, resolved.fingerprint)
  }

  // Strictly increasing across passes — see lastFlushUpdatedAt's docblock.
  const updatedAt = Math.max(Date.now(), lastFlushUpdatedAt + 1)
  lastFlushUpdatedAt = updatedAt
  const rowsByUidDay = groupRowsByUidDay(scopesToUpsert, snapshots, validSessions, updatedAt)
  if (rowsByUidDay.size === 0) {
    dirty = !minuteBuffer.isEmpty()
    return
  }

  const machineHash = await getMachineHash()
  const userDataDir = app.getPath('userData')
  const state = syncState ?? emptySyncState(machineHash)
  syncState = state

  const touchedUids: string[] = []
  const touchedByUid = new Map<string, UtcDay[]>()
  try {
    // JSONL master write happens first: the file is the source of truth.
    // If the cache apply later fails we still have the data on disk, and
    // the next startup rebuild replays it. Days are written in ascending
    // order so the pointer lands on the most recent row id.
    for (const [uid, byDay] of rowsByUidDay) {
      const orderedDays = Array.from(byDay.keys()).sort()
      const writtenDays: UtcDay[] = []
      for (const day of orderedDays) {
        const rows = byDay.get(day)
        if (!rows || rows.length === 0) continue
        await persistOwnJsonlDay(uid, day, rows, machineHash, userDataDir)
        writtenDays.push(day)
      }
      if (writtenDays.length === 0) continue
      touchedUids.push(uid)
      touchedByUid.set(uid, writtenDays)
      // `state.uploaded` is intentionally NOT updated here — that map
      // tracks days confirmed to be in cloud, and is bumped by the
      // sync layer after a successful upload. Flush only guarantees
      // local disk + cache coherence, so writing here would conflate
      // the two states and break reconcile's "uploaded but cloud
      // missing" signal in C5b.
    }
    state.last_synced_at = updatedAt
    await saveSyncState(userDataDir, state)
  } catch (err) {
    log('error', `typing-analytics flush failed: ${String(err)}`)
    // Re-queue sessions so the next pass can retry. The drained snapshots
    // themselves are NOT lost: minuteBuffer.reopenAll() flips every
    // 'retained' entry back to 'reopened', so the next drain re-finalizes
    // and re-sends the full cumulative minute rather than just whatever
    // arrives after this point — a failed persist is no longer lossy for
    // retained minutes. (Reopening entries that weren't actually part of
    // this failed pass is harmless — see reopenAll's docblock — so this
    // can run unconditionally.) The one gap this doesn't cover: an entry
    // both finalized and evicted within this same failed pass is already
    // gone from the map and cannot be recovered here — a rare boundary
    // case, accepted.
    minuteBuffer.reopenAll()
    pendingSessions.push(...sessionsToWrite)
    dirty = true
    return
  }

  // Notify the sync layer that new rows are ready for upload. One
  // notify per (uid, hash, day) so cloud storage tracks days as
  // independent units. Capture the notifier into a local so a reset
  // between iterations cannot null it mid-loop.
  const notifier = syncNotifier
  if (notifier) {
    for (const uid of touchedUids) {
      const days = touchedByUid.get(uid) ?? []
      for (const day of days) {
        try {
          notifier(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, day))
        } catch (notifyErr) {
          log('warn', `typing-analytics sync notify failed for ${uid} ${day}: ${String(notifyErr)}`)
        }
      }
    }
  }

  dirty = !minuteBuffer.isEmpty()
}

/**
 * Schedule a flush behind any in-flight one. Concurrent callers (the
 * debounce timer, the FLUSH IPC, the before-quit finalizer) all await the
 * same chain so quit-time persistence cannot race with an in-flight pass.
 * Tracks an in-flight counter so hasTypingAnalyticsPendingWork() reports
 * pending work even after a snapshot has cleared the live state.
 */
function flushNow(options: { final: boolean }): Promise<void> {
  inFlightFlushCount++
  const next = flushChain
    .catch(() => undefined)
    .then(() => doFlushPass(options))
    .finally(() => {
      inFlightFlushCount--
      if (dirty || pendingSessions.length > 0) {
        scheduleFlush()
      }
    })
  flushChain = next
  return next
}

// --- Test helpers ---

export function resetTypingAnalyticsForTests(): void {
  initialization = null
  ipcRegistered = false
  // Not drainAll(): with retention, drainAll only finalizes dirty entries
  // and retains the rest, so it would leak clean entries from one test
  // case into the next case's identically-keyed scope/minute. Reassigning
  // the singleton (mirrors flushChain's reset below) starts every case
  // from a real empty buffer.
  minuteBuffer = new MinuteBuffer()
  sessionDetector.closeAll()
  scopeCache.clear()
  pendingSessions.length = 0
  dirty = false
  flushChain = Promise.resolve()
  inFlightFlushCount = 0
  lastFlushUpdatedAt = 0
  syncNotifier = null
  syncState = null
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
}

export function getMinuteBufferForTests(): MinuteBuffer {
  return minuteBuffer
}

export function flushTypingAnalyticsNowForTests(): Promise<void> {
  return flushNow({ final: true })
}

/** Test-only escape hatch so the Layout Comparison options parser's
 * validation rules (key / value shape of `fingerOverrides` in
 * particular) can be unit-tested without wiring a full IPC handler +
 * keymap snapshot fixture. */
export function parseLayoutComparisonOptionsForTests(value: unknown): LayoutComparisonOptions | null {
  return parseLayoutComparisonOptions(value)
}
