// SPDX-License-Identifier: GPL-2.0-or-later
// Scope-aware fetch helpers for the Analyze charts. The renderer
// charts pick between three IPC variants (`*ForHash`, `*Local`, and
// the all-devices aggregate) based on the discriminated `DeviceScope`;
// without this helper every chart hand-rolled the same `isHashScope ?
// ... : isOwnScope ? ... : ...` ternary, and adding compare-range to
// WpmChart in C2 would have meant six near-identical copies in one
// file alone.

import type {
  LayoutComparisonOptions,
  LayoutComparisonResult,
  TypingBigramAggregateOptions,
  TypingBigramAggregateResult,
  TypingBigramAggregateView,
  TypingBksMinuteRow,
  TypingHeatmapByCell,
  TypingKeymapSnapshot,
  TypingLayerUsageRow,
  TypingMatrixCellRow,
  TypingMatrixCellDailyRow,
  TypingMinuteStatsRow,
} from '../../../shared/types/typing-analytics'
import type { DeviceScope } from '../../../shared/types/analyze-filters'
import { isHashScope, isOwnScope } from '../../../shared/types/analyze-filters'

export function listMinuteStatsForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
): Promise<TypingMinuteStatsRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListMinuteStatsForHash(uid, scope.machineHash, fromMs, toMs, appScopes)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListMinuteStatsLocal(uid, fromMs, toMs, appScopes)
  return window.vialAPI.typingAnalyticsListMinuteStats(uid, fromMs, toMs, appScopes)
}

export function listBksMinuteForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
): Promise<TypingBksMinuteRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListBksMinuteForHash(uid, scope.machineHash, fromMs, toMs, appScopes)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListBksMinuteLocal(uid, fromMs, toMs, appScopes)
  return window.vialAPI.typingAnalyticsListBksMinute(uid, fromMs, toMs, appScopes)
}

export function listMatrixCellsForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
): Promise<TypingMatrixCellRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListMatrixCellsForHash(uid, scope.machineHash, fromMs, toMs, appScopes)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListMatrixCellsLocal(uid, fromMs, toMs, appScopes)
  return window.vialAPI.typingAnalyticsListMatrixCells(uid, fromMs, toMs, appScopes)
}

/** Per-(localDay, layer, row, col) totals for the Analyze Ergonomic
 * Learning Curve. Routed through the same scope discriminator as the
 * range-aggregated `listMatrixCellsForScope`; the renderer buckets
 * the resulting rows by week / month and folds each bucket into
 * ergonomic sub-scores. */
export function listMatrixCellsByDayForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
): Promise<TypingMatrixCellDailyRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListMatrixCellsByDayForHash(uid, scope.machineHash, fromMs, toMs, appScopes)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListMatrixCellsByDayLocal(uid, fromMs, toMs, appScopes)
  return window.vialAPI.typingAnalyticsListMatrixCellsByDay(uid, fromMs, toMs, appScopes)
}

export function listLayerUsageForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
): Promise<TypingLayerUsageRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListLayerUsageForHash(uid, scope.machineHash, fromMs, toMs, appScopes)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListLayerUsageLocal(uid, fromMs, toMs, appScopes)
  return window.vialAPI.typingAnalyticsListLayerUsage(uid, fromMs, toMs, appScopes)
}

/** Fetch the matrix heatmap for every layer in `snapshot.keymap`,
 * returned as `Record<layer, cells>`. Per-layer failures fall back to
 * an empty cells object rather than failing the entire batch — the
 * caller can still render the layers that did resolve. Each layer
 * fires concurrently; the consumer sees a single resolution covering
 * all of them. */
export async function fetchMatrixHeatmapAllLayers(
  uid: string,
  snapshot: TypingKeymapSnapshot,
  fromMs: number,
  toMs: number,
  scope: DeviceScope,
  appScopes: string[] = [],
): Promise<Record<number, TypingHeatmapByCell>> {
  const layerCount = Array.isArray(snapshot.keymap) ? snapshot.keymap.length : 0
  if (layerCount === 0) return {}
  const layerIdxs = Array.from({ length: layerCount }, (_, i) => i)
  const results = await Promise.all(
    layerIdxs.map((l) =>
      window.vialAPI
        .typingAnalyticsGetMatrixHeatmapForRange(uid, l, fromMs, toMs, scope, appScopes)
        .catch(() => ({} as TypingHeatmapByCell)),
    ),
  )
  const next: Record<number, TypingHeatmapByCell> = {}
  layerIdxs.forEach((l, i) => { next[l] = results[i] })
  return next
}

/** Bigram aggregate fetch. The IPC channel is single-variant — the
 * main-side handler resolves `DeviceScope` to own / all / hash, so the
 * renderer does not need the three-fold ternary other helpers carry. */
export function fetchBigramAggregateForRange(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  view: TypingBigramAggregateView,
  options?: TypingBigramAggregateOptions,
  appScopes: string[] = [],
): Promise<TypingBigramAggregateResult> {
  return window.vialAPI.typingAnalyticsGetBigramAggregateForRange(uid, fromMs, toMs, view, scope, options, appScopes)
}

/** Layout Comparison metrics fetch. Single channel; the main-side
 * handler resolves the scope to own / all / hash and pairs the
 * matrix counts with the recorded snapshot. Returns null when the
 * input is malformed or no snapshot is available for the range. */
export function fetchLayoutComparisonForRange(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  options: LayoutComparisonOptions,
  appScopes: string[] = [],
): Promise<LayoutComparisonResult | null> {
  return window.vialAPI.typingAnalyticsGetLayoutComparisonForRange(uid, fromMs, toMs, scope, options, appScopes)
}
