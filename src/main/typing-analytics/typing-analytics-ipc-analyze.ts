// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handlers for the Analyze view and the Data modal's Local/Sync split:
// every Local tab query filters to the own machine hash, every Sync tab
// query iterates remote hashes, plus the keymap-snapshot handlers used by
// the Layout Comparison feature. Registered by the facade's
// `setupTypingAnalyticsIpc` via `registerAnalyzeIpc()`.

import { app } from 'electron'
import { IpcChannels } from '../../shared/ipc/channels'
import { secureHandle } from '../ipc-guard'
import type {
  TypingAnalyticsDeviceInfoBundle,
  TypingHeatmapByCell,
  TypingKeymapSnapshot,
  TypingKeymapSnapshotSummary,
} from '../../shared/types/typing-analytics'
import { normalizeAppScopes } from '../../shared/types/analyze-filters'
import { log } from '../logger'
import {
  getKeymapSnapshotForRange,
  listKeymapSnapshotSummaries,
  saveKeymapSnapshotIfChanged,
} from './keymap-snapshots'
import type {
  TypingActivityCell,
  TypingDailySummary,
  TypingIntervalDailySummary,
  TypingLayerUsageRow,
  TypingMatrixCellRow,
  TypingMatrixCellDailyRow,
  TypingMinuteStatsRow,
  TypingSessionRow,
  TypingBksMinuteRow,
  PeakRecords,
} from './db/typing-analytics-db'
import { listDeviceDays } from './jsonl/paths'
import type { UtcDay } from './jsonl/utc-day'
import { getMachineHash } from './machine-hash'
import {
  emptyPeakRecords,
  getMatrixHeatmap,
  getTypingPeakRecordsInRange,
  getTypingPeakRecordsInRangeForHash,
  listTypingActivityGrid,
  listTypingActivityGridForHash,
  listTypingBksMinuteInRange,
  listTypingBksMinuteInRangeForHash,
  listTypingDailySummariesForHash,
  listTypingDeviceInfosForUid,
  listTypingIntervalSummaries,
  listTypingIntervalSummariesForHash,
  listTypingLayerUsageInRange,
  listTypingLayerUsageInRangeForHash,
  listTypingMatrixCellsByDayInRange,
  listTypingMatrixCellsByDayInRangeForHash,
  listTypingMatrixCellsInRange,
  listTypingMatrixCellsInRangeForHash,
  listTypingMinuteStatsInRange,
  listTypingMinuteStatsInRangeForHash,
  listTypingSessionsInRange,
  listTypingSessionsInRangeForHash,
} from './typing-analytics-queries'

/**
 * Register the Analyze / Data-modal Local-Sync split IPC handlers plus the
 * keymap-snapshot handlers. Called once from the facade's
 * `setupTypingAnalyticsIpc`.
 */
export function registerAnalyzeIpc(): void {
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
