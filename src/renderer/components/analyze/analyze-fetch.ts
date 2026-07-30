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
  TypingDailySummary,
  TypingHeatmapByCell,
  TypingKeymapSnapshot,
  TypingLayerUsageRow,
  TypingMatrixCellRow,
  TypingMatrixCellDailyRow,
  TypingMinuteStatsRow,
  TypingRolloverMinuteRow,
  TypingDurationCell,
} from '../../../shared/types/typing-analytics'
import type { DeviceScope } from '../../../shared/types/analyze-filters'
import { isHashScope, isOwnScope } from '../../../shared/types/analyze-filters'

export function listDailyForScope(
  uid: string,
  scope: DeviceScope,
  appScopes: string[] = [],
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<TypingDailySummary[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListItemsForHash(uid, scope.machineHash, appScopes, typingTestScopes, runIdScopes)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListItemsLocal(uid, appScopes, typingTestScopes, runIdScopes)
  return window.vialAPI.typingAnalyticsListItems(uid, appScopes, typingTestScopes, runIdScopes)
}

/** Generic in-flight de-dupe: concurrent callers with the same `key`
 * share one underlying `request()` promise instead of each firing their
 * own IPC round trip (and, main-side, their own synchronous DB
 * aggregate) for what turns out to be identical rows. Keyed by
 * whatever the caller considers "identical" (typically
 * `JSON.stringify` over the full argument tuple); the entry is deleted
 * the instant its promise settles (success or failure), so this is
 * deliberately NOT a result cache — there is no staleness window. A
 * call made after the in-flight one has already settled always misses
 * `store` and triggers a fresh `request()`, exactly as if de-dupe
 * didn't exist; only genuinely concurrent callers ever share a
 * promise. One `store` per fetch — sharing a single map across
 * unrelated fetches would risk a key collision between two functions
 * that happen to serialize the same argument shapes. */
function dedupeInFlight<T>(store: Map<string, Promise<T>>, key: string, request: () => Promise<T>): Promise<T> {
  const inFlight = store.get(key)
  if (inFlight) return inFlight
  const deduped = request().finally(() => { store.delete(key) })
  store.set(key, deduped)
  return deduped
}

// IntervalChart and RolloverSection mount together with byte-identical
// filter args and both call this.
const inFlightMinuteStats = new Map<string, Promise<TypingMinuteStatsRow[]>>()

export function listMinuteStatsForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<TypingMinuteStatsRow[]> {
  const key = JSON.stringify([uid, scope, fromMs, toMs, appScopes, typingTestScopes, runIdScopes])
  return dedupeInFlight(inFlightMinuteStats, key, () =>
    isHashScope(scope)
      ? window.vialAPI.typingAnalyticsListMinuteStatsForHash(uid, scope.machineHash, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
      : isOwnScope(scope)
        ? window.vialAPI.typingAnalyticsListMinuteStatsLocal(uid, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
        : window.vialAPI.typingAnalyticsListMinuteStats(uid, fromMs, toMs, appScopes, typingTestScopes, runIdScopes))
}

export function listBksMinuteForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<TypingBksMinuteRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListBksMinuteForHash(uid, scope.machineHash, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListBksMinuteLocal(uid, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
  return window.vialAPI.typingAnalyticsListBksMinute(uid, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
}

// Split View renders two independent AnalyzePanes, each with its own
// DurationSection/TappingTermCard pair; picking the same keyboard,
// range and scope in both (a very ordinary thing to do when comparing
// "this range vs itself" on two keyboards, or just re-opening the same
// keyboard in both panes) fires this with byte-identical args from
// both panes at once. StrictMode's dev-only double-invoke of effects
// is the same shape on a single pane. Same de-dupe as
// `listMinuteStatsForScope` / `fetchDurationCellsForRange`.
const inFlightMatrixCells = new Map<string, Promise<TypingMatrixCellRow[]>>()

export function listMatrixCellsForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<TypingMatrixCellRow[]> {
  const key = JSON.stringify([uid, scope, fromMs, toMs, appScopes, typingTestScopes, runIdScopes])
  return dedupeInFlight(inFlightMatrixCells, key, () =>
    isHashScope(scope)
      ? window.vialAPI.typingAnalyticsListMatrixCellsForHash(uid, scope.machineHash, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
      : isOwnScope(scope)
        ? window.vialAPI.typingAnalyticsListMatrixCellsLocal(uid, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
        : window.vialAPI.typingAnalyticsListMatrixCells(uid, fromMs, toMs, appScopes, typingTestScopes, runIdScopes))
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
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<TypingMatrixCellDailyRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListMatrixCellsByDayForHash(uid, scope.machineHash, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListMatrixCellsByDayLocal(uid, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
  return window.vialAPI.typingAnalyticsListMatrixCellsByDay(uid, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
}

export function listLayerUsageForScope(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<TypingLayerUsageRow[]> {
  if (isHashScope(scope)) return window.vialAPI.typingAnalyticsListLayerUsageForHash(uid, scope.machineHash, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
  if (isOwnScope(scope)) return window.vialAPI.typingAnalyticsListLayerUsageLocal(uid, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
  return window.vialAPI.typingAnalyticsListLayerUsage(uid, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
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
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<Record<number, TypingHeatmapByCell>> {
  const layerCount = Array.isArray(snapshot.keymap) ? snapshot.keymap.length : 0
  if (layerCount === 0) return {}
  const layerIdxs = Array.from({ length: layerCount }, (_, i) => i)
  const results = await Promise.all(
    layerIdxs.map((l) =>
      window.vialAPI
        .typingAnalyticsGetMatrixHeatmapForRange(uid, l, fromMs, toMs, scope, appScopes, typingTestScopes, runIdScopes)
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
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<TypingBigramAggregateResult> {
  return window.vialAPI.typingAnalyticsGetBigramAggregateForRange(uid, fromMs, toMs, view, scope, options, appScopes, typingTestScopes, runIdScopes)
}

/** Per-minute observed-rollover fetch for the Analyze rollover trend
 * chart. Single-variant IPC, same reasoning as
 * {@link fetchBigramAggregateForRange} — the main-side handler resolves
 * `DeviceScope` itself. */
export function fetchRolloverMinutesForRange(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<TypingRolloverMinuteRow[]> {
  return window.vialAPI.typingAnalyticsListRolloverMinutes(uid, scope, fromMs, toMs, appScopes, typingTestScopes, runIdScopes)
}

// DurationSection and TappingTermCard mount under the same
// distribution-mode gate, but their first fetch isn't actually
// concurrent — TappingTermCard also waits on the snapshot (an
// independent, later-arriving fetch) before it calls this at all. The
// de-dupe instead pays off once both are already mounted and loaded:
// any later range/filter change both react to together (plus the same
// split-view / StrictMode double-invoke shapes `listMatrixCellsForScope`
// documents above) still fires this with byte-identical args from two
// call sites at once.
const inFlightDurationCells = new Map<string, Promise<TypingDurationCell[]>>()

/** Per-(row,col,layer) keypress-duration fetch for the Analyze duration
 * distribution chart, the Heatmap duration mode, and the TAPPING_TERM
 * advisor. Single-variant IPC, same reasoning as
 * {@link fetchRolloverMinutesForRange} — the main-side handler resolves
 * `DeviceScope` itself and folds the raw per-minute rows into one total
 * per cell before returning. De-duped the same way as
 * `listMinuteStatsForScope` / `listMatrixCellsForScope`. */
export function fetchDurationCellsForRange(
  uid: string,
  scope: DeviceScope,
  fromMs: number,
  toMs: number,
  appScopes: string[] = [],
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<TypingDurationCell[]> {
  const key = JSON.stringify([uid, scope, fromMs, toMs, appScopes, typingTestScopes, runIdScopes])
  return dedupeInFlight(inFlightDurationCells, key, () =>
    window.vialAPI.typingAnalyticsListDurationCells(uid, scope, fromMs, toMs, appScopes, typingTestScopes, runIdScopes))
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
  typingTestScopes: string[] = [],
  runIdScopes: string[] = [],
): Promise<LayoutComparisonResult | null> {
  return window.vialAPI.typingAnalyticsGetLayoutComparisonForRange(uid, fromMs, toMs, scope, options, appScopes, typingTestScopes, runIdScopes)
}
