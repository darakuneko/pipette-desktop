// SPDX-License-Identifier: GPL-2.0-or-later
// Scope-aware fetch helpers for the Analyze charts. The renderer
// charts pick between three IPC variants (`*ForHash`, `*Local`, and
// the all-devices aggregate) based on the discriminated `DeviceScope`;
// without this helper every chart hand-rolled the same `isHashScope ?
// ... : isOwnScope ? ... : ...` ternary, and adding compare-range to
// WpmChart in C2 would have meant six near-identical copies in one
// file alone.

import type {
  TypingBigramAggregateOptions,
  TypingBigramAggregateResult,
  TypingBigramAggregateView,
  TypingBksMinuteRow,
  TypingHeatmapByCell,
  TypingKeymapSnapshot,
  TypingLayerUsageRow,
  TypingMatrixCellRow,
  TypingMinuteStatsRow,
} from '../../../shared/types/typing-analytics'
import type { DeviceScope } from '../../../shared/types/analyze-filters'
import { isHashScope, isOwnScope } from '../../../shared/types/analyze-filters'

export function listMinuteStatsForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
): Promise<TypingMinuteStatsRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListMinuteStatsForHash(uid, scope.machineHash, fromMs, toMs)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListMinuteStatsLocal(uid, fromMs, toMs)
  return window.vialAPI.typingAnalyticsListMinuteStats(uid, fromMs, toMs)
}

export function listBksMinuteForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
): Promise<TypingBksMinuteRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListBksMinuteForHash(uid, scope.machineHash, fromMs, toMs)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListBksMinuteLocal(uid, fromMs, toMs)
  return window.vialAPI.typingAnalyticsListBksMinute(uid, fromMs, toMs)
}

export function listMatrixCellsForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
): Promise<TypingMatrixCellRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListMatrixCellsForHash(uid, scope.machineHash, fromMs, toMs)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListMatrixCellsLocal(uid, fromMs, toMs)
  return window.vialAPI.typingAnalyticsListMatrixCells(uid, fromMs, toMs)
}

export function listLayerUsageForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
): Promise<TypingLayerUsageRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListLayerUsageForHash(uid, scope.machineHash, fromMs, toMs)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListLayerUsageLocal(uid, fromMs, toMs)
  return window.vialAPI.typingAnalyticsListLayerUsage(uid, fromMs, toMs)
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
): Promise<Record<number, TypingHeatmapByCell>> {
  const layerCount = Array.isArray(snapshot.keymap) ? snapshot.keymap.length : 0
  if (layerCount === 0) return {}
  const layerIdxs = Array.from({ length: layerCount }, (_, i) => i)
  const results = await Promise.all(
    layerIdxs.map((l) =>
      window.vialAPI
        .typingAnalyticsGetMatrixHeatmapForRange(uid, l, fromMs, toMs, scope)
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
): Promise<TypingBigramAggregateResult> {
  return window.vialAPI.typingAnalyticsGetBigramAggregateForRange(uid, fromMs, toMs, view, scope, options)
}
