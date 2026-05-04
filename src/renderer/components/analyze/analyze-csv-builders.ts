// SPDX-License-Identifier: GPL-2.0-or-later
// Per-category CSV builders for the Analyze export modal. Each
// function fetches its own data via the existing IPC bridges and
// runs it through the same aggregator helpers the live charts use,
// so the export reflects the chart the user is looking at — date
// range, device scope, view mode, normalization etc. Callers in the
// modal pass the same filter state that drives the rendered chart.
//
// Builders return `{ slug, content }`. The modal joins `slug` onto
// the `{keyboard}_{hash}_{start}_{end}_` prefix and ships the result
// via `vialAPI.exportCsvBundle`. Slugs cover view-mode variations
// (e.g. WPM time-series vs time-of-day) so each export lands in a
// uniquely named file.

import type { TFunction } from 'i18next'
import type {
  TypingHeatmapByCell,
  TypingHeatmapCell,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import type { HeatmapFilters } from '../../../shared/types/analyze-filters'
import { isHashScope, isOwnScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import { buildCsv } from '../../../shared/csv-export'
import { LAYOUT_BY_ID } from '../../data/keyboard-layouts'

/**
 * Async resolver that prefers the built-in `KEYBOARD_LAYOUTS` map and
 * falls back to the local Key Label store via IPC. Returns `null`
 * when neither side has the id (the caller writes an empty CSV).
 */
async function resolveComparisonInput(
  id: string,
): Promise<{ id: string; map: Record<string, string> } | null> {
  const builtin = LAYOUT_BY_ID.get(id)
  if (builtin) return { id: builtin.id, map: builtin.map }
  try {
    const result = await window.vialAPI.keyLabelStoreGet(id)
    if (result.success && result.data) return { id, map: result.data.data.map }
  } catch {
    // fall through
  }
  return null
}

async function resolveLayoutLabel(id: string): Promise<string> {
  const builtin = LAYOUT_BY_ID.get(id)
  if (builtin) return builtin.name
  try {
    const result = await window.vialAPI.keyLabelStoreGet(id)
    if (result.success && result.data) return result.data.data.name
  } catch {
    // fall through
  }
  return id
}
import { toLocalDate } from './analyze-streak-goal'
import {
  fetchBigramAggregateForRange,
  fetchLayoutComparisonForRange,
  fetchMatrixHeatmapAllLayers,
  listBksMinuteForScope,
  listDailyForScope,
  listLayerUsageForScope,
  listMatrixCellsForScope,
  listMinuteStatsForScope,
} from './analyze-fetch'
import { bucketMinuteStats, pickBucketMs } from './analyze-bucket'
import { buildBksRateBuckets } from './analyze-error-proxy'
import { buildHourOfDayWpm, computeWpm } from './analyze-wpm'
import { buildIntervalHistogram } from './analyze-histogram'
import { buildActivityGrid } from './analyze-activity'
import { buildSessionHistogram } from './analyze-sessions'
import {
  aggregateLayerActivations,
  aggregateLayerKeystrokes,
  buildLayerBarsFromCounts,
} from './analyze-layer-usage'
import { aggregateErgonomics, FINGER_LIST, ROW_ORDER } from './analyze-ergonomics'
import { LAYOUT_COMPARISON_PHASE_1_METRICS } from './layout-comparison-metrics'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import {
  buildGroupRankings,
  buildLayerKeycodes,
  layoutPositions,
  type LayerKeycodes,
} from './key-heatmap-helpers'
import type {
  ActivityMetric,
  DeviceScope,
  GranularityChoice,
  IntervalViewMode,
  RangeMs,
  WpmViewMode,
} from './analyze-types'

export interface CsvBundleEntry {
  slug: string
  content: string
}

// Filename slugs appended to the per-export prefix in the modal. The
// modal yields `{prefix}_{slug}.csv` so the user can tell the files
// apart at a glance and the slug also acts as the only place a typo
// can drift from the rest of the codebase.
const SLUG = {
  summary: 'analyze-summary',
  heatmapRanking: 'analyze-heatmap-ranking',
  wpm: 'analyze-wpm',
  wpmTimeOfDay: 'analyze-wpm-time-of-day',
  interval: 'analyze-interval',
  intervalDistribution: 'analyze-interval-distribution',
  activityKeystrokes: 'analyze-activity-keystrokes',
  activityWpm: 'analyze-activity-wpm',
  activitySessions: 'analyze-activity-sessions',
  byApp: 'analyze-by-app',
  layer: 'analyze-layer',
  ergonomics: 'analyze-ergonomics',
  bigrams: 'analyze-bigrams',
  layoutComparison: 'analyze-layout-comparison',
} as const

interface ScopeArgs {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
  /** Restrict every IPC the builder issues to single-app minutes
   * matching this name. `null` (or absent) means "no app filter" so
   * the existing all-apps export shape is preserved. */
  appScopes?: string[]
}

// --- Heatmap ranking ---------------------------------------------

export async function buildHeatmapCsv(args: ScopeArgs & {
  snapshot: TypingKeymapSnapshot
  heatmap: Required<HeatmapFilters>
  t: TFunction
}): Promise<CsvBundleEntry> {
  const { uid, range, deviceScope, appScopes = [], snapshot, heatmap, t } = args
  const { selectedLayers, groups, frequentUsedN, aggregateMode, normalization, keyGroupFilter } = heatmap

  const layerCells = new Map<number, TypingHeatmapByCell>()
  await Promise.all(selectedLayers.map(async (layer) => {
    try {
      const cells = await window.vialAPI.typingAnalyticsGetMatrixHeatmapForRange(uid, layer, range.fromMs, range.toMs, deviceScope, appScopes)
      layerCells.set(layer, cells)
    } catch {
      layerCells.set(layer, {})
    }
  }))

  const layerKeycodes = new Map<number, LayerKeycodes>()
  for (const layer of selectedLayers) layerKeycodes.set(layer, buildLayerKeycodes(snapshot, layer))

  const layout = snapshot.layout as KeyboardLayout | null
  const positions = layout ? layoutPositions(layout) : []

  const groupRankings = groups.map((group) => buildGroupRankings(
    group, layerCells, layerKeycodes, positions, range, normalization,
    aggregateMode, keyGroupFilter, frequentUsedN,
  ))

  const rows: unknown[][] = []
  groups.forEach((group, gIdx) => {
    const groupLabel = group.length === 1
      ? t('analyze.keyHeatmap.layerOption', { i: group[0] })
      : t('analyze.keyHeatmap.layerOptionMulti', { layers: group.join(', ') })
    const entries = groupRankings[gIdx] ?? []
    entries.forEach((entry, rankIdx) => {
      rows.push([gIdx, groupLabel, rankIdx + 1, entry.keyLabel, entry.layerLabel, entry.matrixLabel, entry.count])
    })
  })

  return {
    slug: SLUG.heatmapRanking,
    content: buildCsv(
      ['group_idx', 'group_label', 'rank', 'key_label', 'layer_label', 'matrix_label', 'count'],
      rows,
    ),
  }
}

// --- WPM (timeSeries / timeOfDay) --------------------------------

export async function buildWpmCsv(args: ScopeArgs & {
  granularity: GranularityChoice
  viewMode: WpmViewMode
  minActiveMs: number
}): Promise<CsvBundleEntry> {
  const { uid, range, deviceScope, appScopes = [], granularity, viewMode, minActiveMs } = args
  const rows = await listMinuteStatsForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes).catch(() => [])

  if (viewMode === 'timeOfDay') {
    const hourOfDay = buildHourOfDayWpm({ rows, range, minActiveMs })
    const csvRows = hourOfDay.bins.map((b) => [
      b.hour,
      Math.round(b.wpm * 10) / 10,
      b.keystrokes,
      b.activeMs,
      b.qualified ? 1 : 0,
    ])
    return {
      slug: SLUG.wpmTimeOfDay,
      content: buildCsv(['hour', 'wpm', 'keystrokes', 'active_ms', 'qualified'], csvRows),
    }
  }

  const bucketMs = granularity === 'auto' ? pickBucketMs(range) : granularity
  const buckets = bucketMinuteStats(rows, range, bucketMs)
  const bksRows = await listBksMinuteForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes).catch(() => [])
  const bksRate = buildBksRateBuckets({ bksRows, minuteRows: rows, range, bucketMs })
  const bksByBucket = new Map<number, number | null>()
  for (const b of bksRate.buckets) bksByBucket.set(b.bucketStartMs, b.bksPercent)

  const csvRows = buckets.map((b) => {
    const bks = bksByBucket.get(b.bucketStartMs) ?? null
    return [
      b.bucketStartMs,
      new Date(b.bucketStartMs).toISOString(),
      Math.round(computeWpm(b.keystrokes, b.activeMs) * 10) / 10,
      b.keystrokes,
      b.activeMs,
      bks === null ? '' : Math.round(bks * 10) / 10,
    ]
  })
  return {
    slug: SLUG.wpm,
    content: buildCsv(
      ['bucket_start_ms', 'bucket_iso', 'wpm', 'keystrokes', 'active_ms', 'bks_percent'],
      csvRows,
    ),
  }
}

// --- Interval (timeSeries / distribution) ------------------------

export async function buildIntervalCsv(args: ScopeArgs & {
  granularity: GranularityChoice
  viewMode: IntervalViewMode
}): Promise<CsvBundleEntry> {
  const { uid, range, deviceScope, appScopes = [], granularity, viewMode } = args
  // Distribution forces own scope to match the live chart's
  // anti-meta-aggregate rule (see IntervalChart.tsx).
  const effectiveScope: DeviceScope = viewMode === 'distribution' ? 'own' : deviceScope
  const rows = await listMinuteStatsForScope(uid, effectiveScope, range.fromMs, range.toMs, appScopes).catch(() => [])

  if (viewMode === 'distribution') {
    const histogram = buildIntervalHistogram(rows, range)
    const csvRows = histogram.bins.map((b) => [b.id, b.weight, b.share, b.band])
    return {
      slug: SLUG.intervalDistribution,
      content: buildCsv(['bin_id', 'weight', 'share', 'band'], csvRows),
    }
  }

  const bucketMs = granularity === 'auto' ? pickBucketMs(range) : granularity
  const buckets = bucketMinuteStats(rows, range, bucketMs)
  const csvRows = buckets.map((b) => [
    b.bucketStartMs,
    new Date(b.bucketStartMs).toISOString(),
    b.intervalMinMs ?? '',
    b.intervalP25Ms ?? '',
    b.intervalP50Ms ?? '',
    b.intervalP75Ms ?? '',
    b.intervalMaxMs ?? '',
  ])
  return {
    slug: SLUG.interval,
    content: buildCsv(
      ['bucket_start_ms', 'bucket_iso', 'min_ms', 'p25_ms', 'p50_ms', 'p75_ms', 'max_ms'],
      csvRows,
    ),
  }
}

// --- Activity (keystrokes / wpm grid, sessions) ------------------

export async function buildActivityCsv(args: ScopeArgs & {
  metric: ActivityMetric
  minActiveMs: number
}): Promise<CsvBundleEntry> {
  const { uid, range, deviceScope, appScopes = [], metric, minActiveMs } = args

  if (metric === 'sessions') {
    // Sessions stay un-filtered by app: the typing_sessions table
    // tracks "started typing → idle gap" boundaries and has no
    // app_name column; routing the filter through here would silently
    // drop every session, which would read as a bug. Match the
    // SessionDistribution chart's behaviour and ignore appScopes.
    const sessions = isHashScope(deviceScope)
      ? await window.vialAPI.typingAnalyticsListSessionsForHash(uid, deviceScope.machineHash, range.fromMs, range.toMs).catch(() => [])
      : isOwnScope(deviceScope)
        ? await window.vialAPI.typingAnalyticsListSessionsLocal(uid, range.fromMs, range.toMs).catch(() => [])
        : await window.vialAPI.typingAnalyticsListSessions(uid, range.fromMs, range.toMs).catch(() => [])
    const histogram = buildSessionHistogram(sessions)
    const csvRows = histogram.bins.map((b) => [b.id, b.count, b.share])
    return {
      slug: SLUG.activitySessions,
      content: buildCsv(['bin_id', 'count', 'share'], csvRows),
    }
  }

  const rows = await listMinuteStatsForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes).catch(() => [])
  const grid = buildActivityGrid({ rows, range, minActiveMs })
  const csvRows = grid.cells.map((c) => [c.dow, c.hour, c.keystrokes, c.activeMs, c.wpm, c.qualified ? 1 : 0])
  return {
    slug: metric === 'wpm' ? SLUG.activityWpm : SLUG.activityKeystrokes,
    content: buildCsv(['dow', 'hour', 'keystrokes', 'active_ms', 'wpm', 'qualified'], csvRows),
  }
}

// --- Layer (keystrokes + activations combined) -------------------

export async function buildLayerCsv(args: ScopeArgs & {
  snapshot: TypingKeymapSnapshot | null
  baseLayer: number
  t: TFunction
}): Promise<CsvBundleEntry> {
  const { uid, range, deviceScope, appScopes = [], snapshot, baseLayer, t } = args

  const [keystrokeRows, activationCells, prefs] = await Promise.all([
    listLayerUsageForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes).catch(() => []),
    listMatrixCellsForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes).catch(() => []),
    window.vialAPI.pipetteSettingsGet(uid).catch(() => null),
  ])
  const layerNames = Array.isArray(prefs?.layerNames) ? prefs.layerNames : []
  const layers = snapshot?.layers ?? 0
  const fallbackLabel = (layer: number): string => t('analyze.layer.layerLabel', { layer })

  const keystrokeBars = buildLayerBarsFromCounts(
    aggregateLayerKeystrokes(keystrokeRows), layers, layerNames, fallbackLabel, {},
  )
  const activationBars = snapshot !== null
    ? buildLayerBarsFromCounts(
        aggregateLayerActivations(activationCells, snapshot, { excludeLayer: baseLayer }),
        layers, layerNames, fallbackLabel, { excludeLayer: baseLayer },
      )
    : []

  const rows: unknown[][] = []
  for (const b of keystrokeBars) rows.push(['keystrokes', b.layer, b.label, b.value])
  for (const b of activationBars) rows.push(['activations', b.layer, b.label, b.value])

  return {
    slug: SLUG.layer,
    content: buildCsv(['view', 'layer', 'layer_label', 'count'], rows),
  }
}

// --- Ergonomics (finger / hand / row in one file) ----------------

function mergeLayerHeatmaps(layerCells: Record<number, TypingHeatmapByCell>): Map<string, TypingHeatmapCell> {
  const merged = new Map<string, TypingHeatmapCell>()
  for (const cells of Object.values(layerCells)) {
    for (const [posKey, c] of Object.entries(cells)) {
      const entry = merged.get(posKey) ?? { total: 0, tap: 0, hold: 0 }
      entry.total += c.total
      entry.tap += c.tap
      entry.hold += c.hold
      merged.set(posKey, entry)
    }
  }
  return merged
}

export async function buildErgonomicsCsv(args: ScopeArgs & {
  snapshot: TypingKeymapSnapshot
  fingerOverrides: Record<string, FingerType>
  t: TFunction
}): Promise<CsvBundleEntry> {
  const { uid, range, deviceScope, appScopes = [], snapshot, fingerOverrides, t } = args
  const layout = snapshot.layout as KeyboardLayout | null
  const keys = layout?.keys ?? []
  const layerCells = await fetchMatrixHeatmapAllLayers(uid, snapshot, range.fromMs, range.toMs, deviceScope, appScopes)
  const merged = mergeLayerHeatmaps(layerCells)
  const aggregation = aggregateErgonomics(merged, keys, fingerOverrides)

  const rows: unknown[][] = []
  for (const f of FINGER_LIST) {
    rows.push(['finger', f, t(`analyze.ergonomics.finger.${f}`), aggregation.finger[f]])
  }
  rows.push(['hand', 'left', t('analyze.ergonomics.hand.left'), aggregation.hand.left])
  rows.push(['hand', 'right', t('analyze.ergonomics.hand.right'), aggregation.hand.right])
  for (const r of ROW_ORDER) {
    rows.push(['row', r, t(`analyze.ergonomics.rowCategory.${r}`), aggregation.row[r]])
  }
  return {
    slug: SLUG.ergonomics,
    content: buildCsv(['metric', 'id', 'label', 'value'], rows),
  }
}

// --- Bigrams (top-N pairs) ---------------------------------------

// The live BigramsChart fetches the same `top` view with this limit
// to derive Top / Slow / Finger / Heatmap quadrants from a single
// IPC call; matching the cap keeps the export aligned with what the
// user sees on screen instead of cutting off at the 30-row default.
const BIGRAMS_EXPORT_LIMIT = 5000

export async function buildBigramsCsv(args: ScopeArgs): Promise<CsvBundleEntry> {
  const { uid, range, deviceScope, appScopes = [] } = args
  const result = await fetchBigramAggregateForRange(
    uid, deviceScope, range.fromMs, range.toMs, 'top', { limit: BIGRAMS_EXPORT_LIMIT }, appScopes,
  ).catch(() => ({ view: 'top' as const, entries: [] }))
  const entries = result.view === 'top' ? result.entries : []
  const rows = entries.map((e) => [
    e.bigramId,
    e.count,
    e.avgIki === null ? '' : Math.round(e.avgIki),
  ])
  return {
    slug: SLUG.bigrams,
    content: buildCsv(['bigram_id', 'count', 'avg_iki_ms'], rows),
  }
}

// --- Layout Comparison (per-target × metric breakdown) -----------

export async function buildLayoutComparisonCsv(args: ScopeArgs & {
  sourceLayoutId: string
  targetLayoutId: string
  t: TFunction
}): Promise<CsvBundleEntry> {
  const { uid, range, deviceScope, appScopes = [], sourceLayoutId, targetLayoutId, t } = args
  const header = ['layout_id', 'layout_label', 'metric', 'key', 'label', 'value']
  const [source, target] = await Promise.all([
    resolveComparisonInput(sourceLayoutId),
    resolveComparisonInput(targetLayoutId),
  ])
  if (!source || !target) {
    return { slug: SLUG.layoutComparison, content: buildCsv(header, []) }
  }
  const result = await fetchLayoutComparisonForRange(uid, deviceScope, range.fromMs, range.toMs, {
    source, targets: [source, target], metrics: [...LAYOUT_COMPARISON_PHASE_1_METRICS],
  }, appScopes).catch(() => null)

  const rows: unknown[][] = []
  // Resolve display labels up front; downloaded entries hit the
  // Key Label store via IPC, so caching the label here avoids a
  // duplicate fetch per row inside the loop.
  const labelCache = new Map<string, string>()
  for (const targetResult of result?.targets ?? []) {
    if (!labelCache.has(targetResult.layoutId)) {
      labelCache.set(targetResult.layoutId, await resolveLayoutLabel(targetResult.layoutId))
    }
    const layoutLabel = labelCache.get(targetResult.layoutId) ?? targetResult.layoutId
    const push = (metric: string, key: string, label: string, value: unknown): void => {
      rows.push([targetResult.layoutId, layoutLabel, metric, key, label, value])
    }
    push('totals', 'totalEvents', '', targetResult.totalEvents)
    push('totals', 'skippedEvents', '', targetResult.skippedEvents)
    push('totals', 'skipRate', '', targetResult.skipRate)
    // FINGER_LIST / ROW_ORDER iteration (instead of Object.entries)
    // keeps the CSV column ordering stable across runs and matches
    // `buildErgonomicsCsv`, so spreadsheet diffs stay meaningful.
    if (targetResult.fingerLoad) {
      for (const finger of FINGER_LIST) {
        const value = targetResult.fingerLoad[finger]
        if (value === undefined) continue
        push('fingerLoad', finger, t(`analyze.ergonomics.finger.${finger}`), value)
      }
    }
    if (targetResult.handBalance) {
      push('handBalance', 'left', t('analyze.ergonomics.hand.left'), targetResult.handBalance.left)
      push('handBalance', 'right', t('analyze.ergonomics.hand.right'), targetResult.handBalance.right)
    }
    if (targetResult.rowDist) {
      for (const row of ROW_ORDER) {
        const value = targetResult.rowDist[row]
        if (value === undefined) continue
        push('rowDist', row, t(`analyze.ergonomics.rowCategory.${row}`), value)
      }
    }
    if (typeof targetResult.homeRowStay === 'number') {
      push('homeRowStay', 'share', '', targetResult.homeRowStay)
    }
  }

  return { slug: SLUG.layoutComparison, content: buildCsv(header, rows) }
}

// --- Summary (daily summary within range) --------------------------

export async function buildSummaryCsv(args: ScopeArgs): Promise<CsvBundleEntry> {
  const { uid, range, deviceScope, appScopes = [] } = args
  const allDaily = await listDailyForScope(uid, deviceScope, appScopes).catch(() => [])

  const fromDate = toLocalDate(range.fromMs)
  const toDate = toLocalDate(range.toMs)
  const filtered = allDaily.filter((d) => d.date >= fromDate && d.date <= toDate)

  const csvRows = filtered.map((d) => [
    d.date,
    d.keystrokes,
    d.activeMs,
    Math.round(computeWpm(d.keystrokes, d.activeMs) * 10) / 10,
  ])
  return {
    slug: SLUG.summary,
    content: buildCsv(['date', 'keystrokes', 'active_ms', 'wpm'], csvRows),
  }
}

// --- By App (app usage + WPM per app) ------------------------------

export async function buildByAppCsv(args: ScopeArgs): Promise<CsvBundleEntry> {
  const { uid, range, deviceScope } = args
  const scope = scopeToSelectValue(deviceScope)
  const [usage, wpmRows] = await Promise.all([
    window.vialAPI.typingAnalyticsGetAppUsageForRange(uid, range.fromMs, range.toMs, scope).catch(() => []),
    window.vialAPI.typingAnalyticsGetWpmByAppForRange(uid, range.fromMs, range.toMs, scope).catch(() => []),
  ])

  const wpmMap = new Map(wpmRows.map((r) => [r.name, computeWpm(r.keystrokes, r.activeMs)]))
  const totalKeystrokes = usage.reduce((sum, r) => sum + r.keystrokes, 0)
  const csvRows = usage
    .toSorted((a, b) => b.keystrokes - a.keystrokes)
    .map((r) => {
      const wpm = wpmMap.get(r.name)
      return [
        r.name,
        r.keystrokes,
        r.activeMs,
        totalKeystrokes > 0 ? Math.round(r.keystrokes / totalKeystrokes * 1000) / 10 : 0,
        wpm !== undefined ? Math.round(wpm * 10) / 10 : '',
      ]
    })
  return {
    slug: SLUG.byApp,
    content: buildCsv(['app_name', 'keystrokes', 'active_ms', 'share_percent', 'wpm'], csvRows),
  }
}
