// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI typing analytics range members (src-tauri/src/
// analytics_commands/range.rs): the Monitor App lists, the key heatmap,
// the bigram ranking, the rollover trend, the keypress durations and the
// Layout Comparison over a window and a device scope. Each passes its
// arguments as they are and the backend checks them as the Electron
// handlers do; a filter list the renderer leaves out is sent as the empty
// list, as the preload's defaults send it.
//
// The Layout Comparison options cross as the text of
// JSON.stringify(options), taken when the member is called: the order of a
// layout map's keys decides which keycode types a character two keycodes
// type, and the backend keeps it only from the text.

import type {
  LayoutComparisonResult,
  TypingBigramAggregateResult,
  TypingDurationCell,
  TypingHeatmapByCell,
  TypingRolloverMinuteRow,
} from '../../shared/types/typing-analytics'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

type NamedTotals = { name: string; keystrokes: number; activeMs: number }[]

export const typingAnalyticsRangeApi = {
  typingAnalyticsListAppsForRange: (uid, sinceMs, untilMs, scope) =>
    call<NamedTotals>('typing_analytics_list_apps_for_range', { uid, sinceMs, untilMs, scope }),
  typingAnalyticsListTypingTestsForRange: (uid, sinceMs, untilMs, scope) =>
    call<NamedTotals>('typing_analytics_list_typing_tests_for_range', { uid, sinceMs, untilMs, scope }),
  typingAnalyticsListTypingTestRunsForRange: (uid, sinceMs, untilMs, scope, typingTestScopes) =>
    call<{ runId: string; keystrokes: number; firstMs: number }[]>('typing_analytics_list_typing_test_runs_for_range', {
      uid, sinceMs, untilMs, scope, typingTestScopes,
    }),
  typingAnalyticsGetAppUsageForRange: (uid, sinceMs, untilMs, scope) =>
    call<NamedTotals>('typing_analytics_get_app_usage_for_range', { uid, sinceMs, untilMs, scope }),
  typingAnalyticsGetWpmByAppForRange: (uid, sinceMs, untilMs, scope) =>
    call<NamedTotals>('typing_analytics_get_wpm_by_app_for_range', { uid, sinceMs, untilMs, scope }),
  typingAnalyticsGetMatrixHeatmapForRange: (uid, layer, sinceMs, untilMs, scope, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingHeatmapByCell>('typing_analytics_get_matrix_heatmap_for_range', {
      uid, layer, sinceMs, untilMs, scope, appScopes, typingTestScopes, runIdScopes,
    }),
  typingAnalyticsGetBigramAggregateForRange: (uid, sinceMs, untilMs, view, scope, options, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingBigramAggregateResult>('typing_analytics_get_bigram_aggregate_for_range', {
      uid, sinceMs, untilMs, view, scope, options, appScopes, typingTestScopes, runIdScopes,
    }),
  typingAnalyticsListRolloverMinutes: (uid, scope, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingRolloverMinuteRow[]>('typing_analytics_list_rollover_minutes', {
      uid, scope, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes,
    }),
  typingAnalyticsListDurationCells: (uid, scope, sinceMs, untilMs, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<TypingDurationCell[]>('typing_analytics_list_duration_cells', {
      uid, scope, sinceMs, untilMs, appScopes, typingTestScopes, runIdScopes,
    }),
  typingAnalyticsGetLayoutComparisonForRange: (uid, sinceMs, untilMs, scope, options, appScopes = [], typingTestScopes = [], runIdScopes = []) =>
    call<LayoutComparisonResult | null>('typing_analytics_get_layout_comparison_for_range', {
      uid, sinceMs, untilMs, scope,
      options: JSON.stringify(options) as string | undefined,
      appScopes, typingTestScopes, runIdScopes,
    }),
} satisfies Partial<VialAPI>
