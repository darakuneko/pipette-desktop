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
} from '../../shared/types/typing-analytics'
import type { KleKey } from '../../shared/kle/types'
import { canonicalScopeKey } from '../../shared/types/typing-analytics'
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
  type JsonlRow,
} from './jsonl/jsonl-row'
import { appendRowsToFile } from './jsonl/jsonl-writer'
import { bucketizeIki } from './bigram-bucket'
import {
  aggregatePairTotals,
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

const minuteBuffer = new MinuteBuffer()
const sessionDetector = new SessionDetector()
const scopeCache = new Map<string, ResolvedScope>()
const pendingSessions: FinalizedSession[] = []

let dirty = false
let flushChain: Promise<void> = Promise.resolve()
let inFlightFlushCount = 0
let flushTimer: ReturnType<typeof setTimeout> | null = null
let syncState: TypingSyncState | null = null

async function initialize(): Promise<void> {
  // getMachineHash transitively warms getInstallationId (and caches its
  // own hash), so later sync notifications can `await` without triggering
  // fresh I/O.
  const machineHash = await getMachineHash()
  const db = getTypingAnalyticsDB()
  const userDataDir = app.getPath('userData')
  const { state } = await ensureCacheIsFresh(db, userDataDir, machineHash)
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
    async (_event, uid: unknown, appScopes: unknown): Promise<TypingDailySummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      return listTypingDailySummaries(uid, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_DELETE_ITEMS,
    async (_event, uid: unknown, dates: unknown): Promise<TypingTombstoneResult> => {
      const empty: TypingTombstoneResult = { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
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
      const empty: TypingTombstoneResult = { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
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
    async (_event, uid: unknown, appScopes: unknown): Promise<TypingDailySummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const ownHash = await getMachineHash()
      return listTypingDailySummariesForHash(uid, ownHash, normalizeAppScopes(appScopes))
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
    async (_event, uid: unknown, machineHash: unknown, appScopes: unknown): Promise<TypingDailySummary[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      return listTypingDailySummariesForHash(uid, machineHash, normalizeAppScopes(appScopes))
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
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingActivityCell[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingActivityGridForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_LAYER_USAGE_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingLayerUsageRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingLayerUsageInRangeForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingMatrixCellRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingMatrixCellsInRangeForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingMatrixCellDailyRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingMatrixCellsByDayInRangeForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes))
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
      appScopes: unknown,
    ): Promise<TypingMinuteStatsRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const apps = normalizeAppScopes(appScopes)
      return listTypingMinuteStatsInRangeForHash(uid, machineHash, since, until, apps)
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
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingBksMinuteRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      if (typeof machineHash !== 'string' || machineHash.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingBksMinuteInRangeForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_PEAK_RECORDS_FOR_HASH,
    async (_event, uid: unknown, machineHash: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<PeakRecords> => {
      if (typeof uid !== 'string' || uid.length === 0) return emptyPeakRecords()
      if (typeof machineHash !== 'string' || machineHash.length === 0) return emptyPeakRecords()
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return getTypingPeakRecordsInRangeForHash(uid, machineHash, since, until, normalizeAppScopes(appScopes))
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
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingActivityCell[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingActivityGrid(uid, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_ACTIVITY_GRID_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingActivityCell[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingActivityGridForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_LAYER_USAGE,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingLayerUsageRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingLayerUsageInRange(uid, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_LAYER_USAGE_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingLayerUsageRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingLayerUsageInRangeForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingMatrixCellRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingMatrixCellsInRange(uid, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingMatrixCellRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingMatrixCellsInRangeForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingMatrixCellDailyRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingMatrixCellsByDayInRange(uid, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MATRIX_CELLS_BY_DAY_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingMatrixCellDailyRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingMatrixCellsByDayInRangeForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MINUTE_STATS,
    async (
      _event,
      uid: unknown,
      sinceMs: unknown,
      untilMs: unknown,
      appScopes: unknown,
    ): Promise<TypingMinuteStatsRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const apps = normalizeAppScopes(appScopes)
      return listTypingMinuteStatsInRange(uid, since, until, apps)
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_MINUTE_STATS_LOCAL,
    async (
      _event,
      uid: unknown,
      sinceMs: unknown,
      untilMs: unknown,
      appScopes: unknown,
    ): Promise<TypingMinuteStatsRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      const apps = normalizeAppScopes(appScopes)
      return listTypingMinuteStatsInRangeForHash(uid, ownHash, since, until, apps)
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
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingBksMinuteRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return listTypingBksMinuteInRange(uid, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_BKS_MINUTE_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<TypingBksMinuteRow[]> => {
      if (typeof uid !== 'string' || uid.length === 0) return []
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return listTypingBksMinuteInRangeForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_PEAK_RECORDS,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<PeakRecords> => {
      if (typeof uid !== 'string' || uid.length === 0) return emptyPeakRecords()
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      return getTypingPeakRecordsInRange(uid, since, until, normalizeAppScopes(appScopes))
    },
  )

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_GET_PEAK_RECORDS_LOCAL,
    async (_event, uid: unknown, sinceMs: unknown, untilMs: unknown, appScopes: unknown): Promise<PeakRecords> => {
      if (typeof uid !== 'string' || uid.length === 0) return emptyPeakRecords()
      const since = typeof sinceMs === 'number' && Number.isFinite(sinceMs) && sinceMs >= 0 ? sinceMs : 0
      const until = typeof untilMs === 'number' && Number.isFinite(untilMs) && untilMs > since ? untilMs : Number.MAX_SAFE_INTEGER
      const ownHash = await getMachineHash()
      return getTypingPeakRecordsInRangeForHash(uid, ownHash, since, until, normalizeAppScopes(appScopes))
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
        log.warn('[typing-analytics] saveKeymapSnapshot failed', err)
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
      appScopes: unknown,
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
      const totals = db.aggregateMatrixCountsForUidInRange(uid, layer, sinceMinuteMs, untilMinuteMs, machineHash, apps)
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

  secureHandle(
    IpcChannels.TYPING_ANALYTICS_LIST_APPS_FOR_RANGE,
    async (_event, uid, sinceMs, untilMs, scope): Promise<{ name: string; keystrokes: number; activeMs: number }[]> => {
      const args = await parseAppRangeArgs(uid, sinceMs, untilMs, scope)
      if (!args) return []
      return getTypingAnalyticsDB().listAppsForUidInRange(args.uid, args.machineHash, args.sinceMs, args.untilMs)
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
      appScopes: unknown,
    ): Promise<TypingBigramAggregateResult> => {
      // Reject unknown views up front so parsedView is the trusted union
      // and downstream branches can return literal-typed empty results.
      if (view !== 'top' && view !== 'slow') {
        return { view: 'top', entries: [] }
      }
      const parsedView: TypingBigramAggregateView = view
      if (typeof uid !== 'string' || uid.length === 0) return { view: parsedView, entries: [] }
      if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return { view: parsedView, entries: [] }
      if (typeof untilMs !== 'number' || !Number.isFinite(untilMs) || untilMs <= sinceMs) {
        return { view: parsedView, entries: [] }
      }
      const parsedScope = parseDeviceScope(scope)
      if (parsedScope === null) return { view: parsedView, entries: [] }
      const opts = parseBigramAggregateOptions(options)
      const limit = opts.limit ?? 30
      const minSample = opts.minSampleCount ?? 5
      const apps = normalizeAppScopes(appScopes)

      const db = getTypingAnalyticsDB()
      const machineHash = isOwnScope(parsedScope)
        ? await getMachineHash()
        : isHashScope(parsedScope)
          ? parsedScope.machineHash
          : undefined
      const rows = machineHash === undefined
        ? db.listBigramMinutesInRangeForUid(uid, sinceMs, untilMs, apps)
        : db.listBigramMinutesInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs, apps)
      const totals = aggregatePairTotals(rows)
      if (parsedView === 'slow') {
        return { view: 'slow', entries: rankBigramsBySlow(totals, minSample, limit) }
      }
      return { view: 'top', entries: rankBigramsByCount(totals, limit) }
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
      appScopes: unknown,
    ): Promise<LayoutComparisonResult | null> => {
      if (typeof uid !== 'string' || uid.length === 0) return null
      if (typeof sinceMs !== 'number' || !Number.isFinite(sinceMs)) return null
      if (typeof untilMs !== 'number' || !Number.isFinite(untilMs) || untilMs <= sinceMs) return null
      const parsedScope = parseDeviceScope(scope)
      if (parsedScope === null) return null
      const opts = parseLayoutComparisonOptions(options)
      if (!opts) return null
      const apps = normalizeAppScopes(appScopes)
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
      )
      return computeLayoutComparison({
        matrixCounts,
        snapshot,
        kleKeys,
        source: opts.source,
        targets: opts.targets,
        metrics: opts.metrics,
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
): TypingDailySummary[] {
  return getTypingAnalyticsDB().listDailySummariesForUid(uid, appScopes)
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
): TypingActivityCell[] {
  return getTypingAnalyticsDB().listActivityGridForUid(uid, sinceMs, untilMs, appScopes)
}

export function listTypingActivityGridForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
): TypingActivityCell[] {
  return getTypingAnalyticsDB().listActivityGridForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes)
}

/** Per-layer keystroke totals for the Analyze > Layer tab. Covers
 * `[sinceMs, untilMs)` and aggregates across every machine hash. */
export function listTypingLayerUsageInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
): TypingLayerUsageRow[] {
  return getTypingAnalyticsDB().listLayerUsageForUid(uid, sinceMs, untilMs, appScopes)
}

export function listTypingLayerUsageInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
): TypingLayerUsageRow[] {
  return getTypingAnalyticsDB().listLayerUsageForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes)
}

/** Per-cell matrix totals for the Analyze > Layer activations mode.
 * Aggregates across every machine hash. */
export function listTypingMatrixCellsInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
): TypingMatrixCellRow[] {
  return getTypingAnalyticsDB().listMatrixCellsForUid(uid, sinceMs, untilMs, appScopes)
}

export function listTypingMatrixCellsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
): TypingMatrixCellRow[] {
  return getTypingAnalyticsDB().listMatrixCellsForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes)
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
): TypingMatrixCellDailyRow[] {
  return getTypingAnalyticsDB().listMatrixCellsByDayForUid(uid, sinceMs, untilMs, appScopes)
}

export function listTypingMatrixCellsByDayInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
): TypingMatrixCellDailyRow[] {
  return getTypingAnalyticsDB().listMatrixCellsByDayForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes)
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
): TypingMinuteStatsRow[] {
  return getTypingAnalyticsDB().listMinuteStatsInRangeForUid(uid, sinceMs, untilMs, appScopes)
}

export function listTypingMinuteStatsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
): TypingMinuteStatsRow[] {
  return getTypingAnalyticsDB().listMinuteStatsInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes)
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
): TypingBksMinuteRow[] {
  return getTypingAnalyticsDB().listBksMinuteInRangeForUid(uid, sinceMs, untilMs, appScopes)
}

export function listTypingBksMinuteInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
): TypingBksMinuteRow[] {
  return getTypingAnalyticsDB().listBksMinuteInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes)
}

export function getTypingPeakRecordsInRange(
  uid: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
): PeakRecords {
  return getTypingAnalyticsDB().getPeakRecordsInRangeForUid(uid, sinceMs, untilMs, appScopes)
}

export function getTypingPeakRecordsInRangeForHash(
  uid: string,
  machineHash: string,
  sinceMs: number,
  untilMs: number,
  appScopes: readonly string[] = [],
): PeakRecords {
  return getTypingAnalyticsDB().getPeakRecordsInRangeForUidAndHash(uid, machineHash, sinceMs, untilMs, appScopes)
}

/** Day-level summaries restricted to a single `machineHash`. When
 * called with the local machine hash it powers the Local tab; with a
 * remote hash it powers the Sync > Device tab. */
export function listTypingDailySummariesForHash(
  uid: string,
  machineHash: string,
  appScopes: readonly string[] = [],
): TypingDailySummary[] {
  return getTypingAnalyticsDB().listDailySummariesForUidAndHash(uid, machineHash, appScopes)
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
    return { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
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
  const result: TypingTombstoneResult = { charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 }
  for (const range of ranges) {
    const r = db.tombstoneRowsForUidInRange(uid, range.startMs, range.endMs, updatedAt)
    result.charMinutes += r.charMinutes
    result.matrixMinutes += r.matrixMinutes
    result.minuteStats += r.minuteStats
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
  const touched = result.charMinutes + result.matrixMinutes + result.minuteStats + result.sessions
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

function isValidEvent(value: unknown): value is TypingAnalyticsEvent {
  if (typeof value !== 'object' || value === null) return false
  const obj = value as Record<string, unknown>
  if (typeof obj.ts !== 'number' || !Number.isFinite(obj.ts)) return false
  if (!isValidKeyboard(obj.keyboard)) return false
  if (obj.kind === 'char') {
    return typeof obj.key === 'string' && obj.key.length > 0
  }
  if (obj.kind === 'matrix') {
    return (
      typeof obj.row === 'number' && Number.isInteger(obj.row) && obj.row >= 0 &&
      typeof obj.col === 'number' && Number.isInteger(obj.col) && obj.col >= 0 &&
      typeof obj.layer === 'number' && Number.isInteger(obj.layer) && obj.layer >= 0 &&
      typeof obj.keycode === 'number' && Number.isFinite(obj.keycode)
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
  minuteBuffer.addEvent(event, fingerprint)
  const finalized = sessionDetector.recordEvent(event.keyboard.uid, scopeKey, event.ts)
  if (finalized.length > 0) pendingSessions.push(...finalized)
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
  return { source: o.source, targets: o.targets, metrics }
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
  const rows: JsonlRow[] = [
    {
      id: minuteStatsRowId(snapshot.scopeId, snapshot.minuteTs),
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
        appName,
      },
    },
  ]
  for (const [char, count] of snapshot.charCounts) {
    rows.push({
      id: charMinuteRowId(snapshot.scopeId, snapshot.minuteTs, char),
      kind: 'char-minute',
      updated_at: updatedAt,
      payload: { scopeId: snapshot.scopeId, minuteTs: snapshot.minuteTs, char, count, appName },
    })
  }
  for (const cell of snapshot.matrixCounts.values()) {
    rows.push({
      id: matrixMinuteRowId(snapshot.scopeId, snapshot.minuteTs, cell.row, cell.col, cell.layer),
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
        appName,
      },
    })
  }
  if (snapshot.bigrams.size > 0) {
    const bigrams: Record<string, { c: number; h: number[] }> = {}
    for (const [pairKey, ikis] of snapshot.bigrams) {
      bigrams[pairKey] = { c: ikis.length, h: bucketizeIki(ikis) }
    }
    rows.push({
      id: bigramMinuteRowId(snapshot.scopeId, snapshot.minuteTs),
      kind: 'bigram-minute',
      updated_at: updatedAt,
      payload: {
        scopeId: snapshot.scopeId,
        minuteTs: snapshot.minuteTs,
        bigrams,
        appName,
      },
    })
  }
  return rows
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

  const snapshots = options.final
    ? minuteBuffer.drainAll()
    : minuteBuffer.drainClosed(Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS)
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

  const updatedAt = Date.now()
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
    // Re-queue sessions so the next pass can retry. Snapshots are already
    // drained and cannot be cheaply reinserted, so their counts are
    // accepted as lost (the JSONL append for the failed uid may or may
    // not have landed; an eventual cache rebuild reconciles).
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
  minuteBuffer.drainAll()
  sessionDetector.closeAll()
  scopeCache.clear()
  pendingSessions.length = 0
  dirty = false
  flushChain = Promise.resolve()
  inFlightFlushCount = 0
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
