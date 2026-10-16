// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI typing analytics members that read the cache for the Analyze
// view and the Data modal (src-tauri/src/analytics_commands/queries.rs):
// the keyboards with data, the reads for every device, this device
// (`…Local`) or one device (`…ForHash`), the typing-view heatmap, the
// devices of a keyboard and the local day files. Each passes its arguments
// as they are; the backend checks them as the Electron handlers do. A
// filter list the renderer leaves out is sent as the empty list, as the
// preload's defaults send it.

import type {
  PeakRecords,
  TypingActivityCell,
  TypingAnalyticsDeviceInfoBundle,
  TypingBksMinuteRow,
  TypingDailySummary,
  TypingHeatmapByCell,
  TypingIntervalDailySummary,
  TypingKeyboardSummary,
  TypingLayerUsageRow,
  TypingMatrixCellDailyRow,
  TypingMatrixCellRow,
  TypingMinuteStatsRow,
  TypingSessionRow,
} from '../../shared/types/typing-analytics'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const typingAnalyticsApi = {
  typingAnalyticsListKeyboards: () => call<TypingKeyboardSummary[]>('typing_analytics_list_keyboards'),
  typingAnalyticsListItems: (uid, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingDailySummary[]>('typing_analytics_list_items', { uid, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListItemsLocal: (uid, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingDailySummary[]>('typing_analytics_list_items_local', { uid, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListItemsForHash: (uid, machineHash, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingDailySummary[]>('typing_analytics_list_items_for_hash', { uid, machineHash, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListIntervalItems: (uid) =>
    call<TypingIntervalDailySummary[]>('typing_analytics_list_interval_items', { uid }),
  typingAnalyticsListIntervalItemsLocal: (uid) =>
    call<TypingIntervalDailySummary[]>('typing_analytics_list_interval_items_local', { uid }),
  typingAnalyticsListIntervalItemsForHash: (uid, machineHash) =>
    call<TypingIntervalDailySummary[]>('typing_analytics_list_interval_items_for_hash', { uid, machineHash }),
  typingAnalyticsListActivityGrid: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingActivityCell[]>('typing_analytics_list_activity_grid', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListActivityGridLocal: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingActivityCell[]>('typing_analytics_list_activity_grid_local', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListActivityGridForHash: (uid, machineHash, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingActivityCell[]>('typing_analytics_list_activity_grid_for_hash', { uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListLayerUsage: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingLayerUsageRow[]>('typing_analytics_list_layer_usage', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListLayerUsageLocal: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingLayerUsageRow[]>('typing_analytics_list_layer_usage_local', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListLayerUsageForHash: (uid, machineHash, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingLayerUsageRow[]>('typing_analytics_list_layer_usage_for_hash', { uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListMatrixCells: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingMatrixCellRow[]>('typing_analytics_list_matrix_cells', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListMatrixCellsLocal: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingMatrixCellRow[]>('typing_analytics_list_matrix_cells_local', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListMatrixCellsForHash: (uid, machineHash, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingMatrixCellRow[]>('typing_analytics_list_matrix_cells_for_hash', { uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListMatrixCellsByDay: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingMatrixCellDailyRow[]>('typing_analytics_list_matrix_cells_by_day', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListMatrixCellsByDayLocal: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingMatrixCellDailyRow[]>('typing_analytics_list_matrix_cells_by_day_local', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListMatrixCellsByDayForHash: (uid, machineHash, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingMatrixCellDailyRow[]>('typing_analytics_list_matrix_cells_by_day_for_hash', { uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListMinuteStats: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingMinuteStatsRow[]>('typing_analytics_list_minute_stats', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListMinuteStatsLocal: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingMinuteStatsRow[]>('typing_analytics_list_minute_stats_local', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListMinuteStatsForHash: (uid, machineHash, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingMinuteStatsRow[]>('typing_analytics_list_minute_stats_for_hash', { uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListSessions: (uid, sinceMs, untilMs) =>
    call<TypingSessionRow[]>('typing_analytics_list_sessions', { uid, sinceMs, untilMs }),
  typingAnalyticsListSessionsLocal: (uid, sinceMs, untilMs) =>
    call<TypingSessionRow[]>('typing_analytics_list_sessions_local', { uid, sinceMs, untilMs }),
  typingAnalyticsListSessionsForHash: (uid, machineHash, sinceMs, untilMs) =>
    call<TypingSessionRow[]>('typing_analytics_list_sessions_for_hash', { uid, machineHash, sinceMs, untilMs }),
  typingAnalyticsListBksMinute: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingBksMinuteRow[]>('typing_analytics_list_bks_minute', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListBksMinuteLocal: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingBksMinuteRow[]>('typing_analytics_list_bks_minute_local', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsListBksMinuteForHash: (uid, machineHash, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingBksMinuteRow[]>('typing_analytics_list_bks_minute_for_hash', { uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsGetPeakRecords: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<PeakRecords>('typing_analytics_get_peak_records', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsGetPeakRecordsLocal: (uid, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<PeakRecords>('typing_analytics_get_peak_records_local', { uid, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsGetPeakRecordsForHash: (uid, machineHash, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<PeakRecords>('typing_analytics_get_peak_records_for_hash', { uid, machineHash, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes }),
  typingAnalyticsGetMatrixHeatmap: (uid, layer, sinceMs) =>
    call<TypingHeatmapByCell>('typing_analytics_get_matrix_heatmap', { uid, layer, sinceMs }),
  typingAnalyticsListDeviceInfos: (uid) =>
    call<TypingAnalyticsDeviceInfoBundle | null>('typing_analytics_list_device_infos', { uid }),
  typingAnalyticsListLocalDeviceDays: (uid, machineHash) =>
    call<string[]>('typing_analytics_list_local_device_days', { uid, machineHash }),
} satisfies Partial<VialAPI>
