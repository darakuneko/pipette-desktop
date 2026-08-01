// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handlers for the Monitor App / range-aggregate family: per-range app
// usage, bigram/trigram aggregates, rollover-minute trend, duration-cell
// distributions, and the Layout Comparison feature. Registered by the
// facade's `setupTypingAnalyticsIpc` via `registerRangeIpc()`.

import { app } from 'electron'
import { IpcChannels } from '../../shared/ipc/channels'
import { secureHandle } from '../ipc-guard'
import type {
  LayoutComparisonInputLayout,
  LayoutComparisonMetric,
  LayoutComparisonOptions,
  LayoutComparisonResult,
  TypingBigramAggregateOptions,
  TypingBigramAggregateResult,
  TypingBigramAggregateView,
  TypingDurationCell,
  TypingHeatmapByCell,
  TypingKeymapSnapshot,
} from '../../shared/types/typing-analytics'
import type { KleKey } from '../../shared/kle/types'
import { isFingerType, isPosKey, type FingerType } from '../../shared/kle/kle-ergonomics'
import { isHashScope, isOwnScope, normalizeAppScopes, parseDeviceScope } from '../../shared/types/analyze-filters'
import { getKeymapSnapshotForRange } from './keymap-snapshots'
import { MINUTE_MS } from './minute-buffer'
import { getTypingAnalyticsDB, type TypingRolloverMinuteRow } from './db/typing-analytics-db'
import { getMachineHash } from './machine-hash'
import {
  aggregateMatrixDurationTotals,
  aggregatePairTotals,
  observedRolloverRatio,
  rankBigramsByCount,
  rankBigramsBySlow,
} from './bigram-aggregate'
import { computeLayoutComparison } from './compute-layout-comparison'

/** "No result" sentinel for the bigram-aggregate IPC — every validation
 * failure before the DB query returns this, so `truncated` always has
 * a defined value regardless of how far the handler got. */
const emptyBigramResult = (view: TypingBigramAggregateView): TypingBigramAggregateResult =>
  view === 'slow'
    ? { view: 'slow', entries: [], truncated: false, observedRolloverRatio: null }
    : { view: 'top', entries: [], truncated: false, observedRolloverRatio: null }

// --- Monitor App range aggregates ---------------------------------
// Shared validator so the three sister handlers below stay terse and
// share one source of truth for "what does a valid range query look
// like." Returns null on any rejection; callers translate that to []
// since the renderer expects a list shape regardless of failure mode.
async function parseAppRangeArgs(
  uid: unknown,
  sinceMs: unknown,
  untilMs: unknown,
  scope: unknown,
): Promise<{ uid: string; machineHash: string | null; sinceMs: number; untilMs: number } | null> {
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
async function parseScopedRangeArgs(
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
} | null> {
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

/**
 * Register the Monitor App range-aggregate IPC handlers. Called once from
 * the facade's `setupTypingAnalyticsIpc`.
 */
export function registerRangeIpc(): void {
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
}

/** Test-only escape hatch so the Layout Comparison options parser's
 * validation rules (key / value shape of `fingerOverrides` in
 * particular) can be unit-tested without wiring a full IPC handler +
 * keymap snapshot fixture. */
export function parseLayoutComparisonOptionsForTests(value: unknown): LayoutComparisonOptions | null {
  return parseLayoutComparisonOptions(value)
}
