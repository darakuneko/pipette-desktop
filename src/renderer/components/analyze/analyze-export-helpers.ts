// SPDX-License-Identifier: GPL-2.0-or-later
// Export context type, per-category filter-snippet builders, and the
// `pickBuilders` dispatcher backing AnalyzeExportModal.tsx.

import type { TFunction } from 'i18next'
import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { HeatmapFilters, LayoutComparisonFilters } from '../../../shared/types/analyze-filters'
import { LAYOUT_BY_ID } from '../../data/keyboard-layouts'
import {
  buildActivityCsv,
  buildBigramsCsv,
  buildByAppCsv,
  buildDurationDistributionCsv,
  buildErgonomicsCsv,
  buildHeatmapCsv,
  buildIntervalCsv,
  buildLayerCsv,
  buildLayoutComparisonCsv,
  buildSummaryCsv,
  buildWpmCsv,
  type CsvBundleEntry,
} from './analyze-csv-builders'
import type {
  ActivityMetric,
  DeviceScope,
  GranularityChoice,
  IntervalViewMode,
  RangeMs,
  WpmViewMode,
} from './analyze-types'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'

export interface AnalyzeExportContext {
  uid: string
  keyboardName: string
  /** Full machine hash for filename. Use the literal `'all'` when the
   * device scope spans every machine; `own`/specific-hash both
   * resolve to the underlying hash. */
  machineHashOrAll: string
  range: RangeMs
  deviceScope: DeviceScope
  /** App filter forwarded to every builder so the CSV mirrors what
   * the on-screen chart shows for the current selection. Empty array
   * = "All apps" — same row set as the pre-Monitor-App export. */
  appScopes: string[]
  typingTestScopes: string[]
  runIdScopes: string[]
  snapshot: TypingKeymapSnapshot | null
  heatmap: Required<HeatmapFilters>
  wpm: { granularity: GranularityChoice; viewMode: WpmViewMode; minActiveMs: number }
  interval: { viewMode: IntervalViewMode; granularity: GranularityChoice }
  activity: { metric: ActivityMetric; minActiveMs: number }
  layer: { baseLayer: number }
  bigrams: { gram: 2 | 3 }
  // `Required<>` only strips the `?`, so `targetLayoutId` is still
  // `string | null`. The runtime guard in pickBuilders here (and in
  // `isCategoryAvailable` in AnalyzeExportModal.tsx) narrows it before
  // passing to the builder.
  layoutComparison: Required<LayoutComparisonFilters>
  fingerOverrides: Record<string, FingerType>
  /** Pre-formatted human-readable filter snapshot for the modal's
   * per-category context line. Computed in the parent so the modal
   * stays decoupled from device-info / snapshot-timeline lookups. */
  conditions: {
    device: string
    keymap: string
    range: string
    /** Pre-formatted "App: VSCode" / "App: All apps" line shown next
     * to device / keymap / range in every category's specifics
     * footer so the user can tell at a glance which app filter the
     * export is anchored to. */
    app: string
  }
}

/** Per-category result reported back to the parent for the Hub upload
 * flow. The export flow stays self-contained (writes CSV files via
 * exportCsvBundle), so no callback is needed there. */
export interface AnalyzeUploadCallbacks {
  /** Whether an upload IPC is currently in flight for the same entry —
   * disables the confirm button + swaps the label to "Uploading…". */
  isUploading: boolean
  /** Last upload result for the active entry. Surfaced as a status
   * banner under the categories list. `null` hides the banner. */
  uploadResult: { kind: 'success' | 'error'; message: string } | null
  /** Confirm handler invoked with the user's category selection. The
   * parent runs the actual upload IPC and resolves with `{ ok }` so
   * the modal can decide whether to close itself. */
  onConfirm: (categories: ReadonlySet<Category>, options?: { targetLayoutIds?: string[]; appDataApps?: string[] }) => Promise<{ ok: boolean }>
  /** Whether the active entry already lives on Hub. Switches the
   * confirm button label between "Upload" and "Update". */
  isExisting: boolean
}

export type Category = 'summary' | 'wpm' | 'interval' | 'activity' | 'byApp' | 'heatmap' | 'ergonomics' | 'bigrams' | 'layer' | 'layoutComparison'

export const CATEGORIES: readonly Category[] = [
  'summary', 'wpm', 'interval', 'activity', 'byApp', 'heatmap', 'ergonomics', 'bigrams', 'layer', 'layoutComparison',
]
export type AnalyzeExportCategory = Category

// Heatmap, Ergonomics, and Layout Comparison need a keymap snapshot
// (the comparison aligns target positions against the recorded
// keymap); the rest read raw minute / session / bigram counters and
// are always available once the keyboard has any analytics rows.
export const REQUIRES_SNAPSHOT: Record<Category, boolean> = {
  summary: false,
  wpm: false,
  interval: false,
  activity: false,
  byApp: false,
  heatmap: true,
  ergonomics: true,
  bigrams: false,
  layer: false,
  layoutComparison: true,
}

export const allOn = (): Record<Category, boolean> =>
  Object.fromEntries(CATEGORIES.map((c) => [c, true])) as Record<Category, boolean>

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

export function formatLocalCompact(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}`
}

export function sanitizeKeyboardName(name: string): string {
  const collapsed = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return collapsed.length > 0 ? collapsed : 'keyboard'
}

export function categoryRowClass(active: boolean): string {
  const base = 'flex flex-col items-stretch gap-1 rounded-md border px-3 py-2 text-left transition-colors'
  return active
    ? `${base} border-accent bg-accent/10 text-content`
    : `${base} border-edge text-content-muted hover:bg-surface-dim`
}

export const TARGET_POPOVER_MAX_H = 288 // matches Tailwind max-h-72 (18rem)
export const TARGET_POPOVER_MIN_H = 120
export const VIEWPORT_EDGE_GAP = 16

const DAY_MS_LOCAL = 24 * 60 * 60 * 1000

// Mirrors GRANULARITY_OPTIONS in TypingAnalyticsView. Both lists must
// stay in lock-step or the modal will fall back to the raw ms number.
const GRANULARITY_LABEL_BY_VALUE: Map<GranularityChoice, string> = new Map<GranularityChoice, string>([
  ['auto', 'auto'],
  [60_000, 'min1'],
  [60_000 * 5, 'min5'],
  [60_000 * 10, 'min10'],
  [60_000 * 15, 'min15'],
  [60_000 * 30, 'min30'],
  [3_600_000, 'hour1'],
  [3_600_000 * 3, 'hour3'],
  [3_600_000 * 6, 'hour6'],
  [3_600_000 * 12, 'hour12'],
  [DAY_MS_LOCAL, 'day1'],
  [DAY_MS_LOCAL * 3, 'day3'],
  [DAY_MS_LOCAL * 7, 'week1'],
  [DAY_MS_LOCAL * 30, 'month1'],
])

function granularityLabel(value: GranularityChoice, t: TFunction): string {
  const key = GRANULARITY_LABEL_BY_VALUE.get(value)
  return key ? t(`analyze.filters.granularityOption.${key}`) : String(value)
}

// Per-category filter snippets — the bits unique to each chart that
// affect the CSV output (slug or column shape). Common conditions
// (device / keymap / range) are rendered in AnalyzeExportModal's header.
export function specificsFor(c: Category, ctx: AnalyzeExportContext, t: TFunction): string[] {
  switch (c) {
    case 'summary':
    case 'byApp':
      return []
    case 'heatmap': {
      const h = ctx.heatmap
      return [
        `${t('analyze.filters.normalization')}: ${t(`analyze.filters.normalizationOption.${h.normalization}`)}`,
        `${t('analyze.keyHeatmap.ranking.aggregate')}: ${t(`analyze.keyHeatmap.ranking.aggregateOption.${h.aggregateMode}`)}`,
        `${t('analyze.keyHeatmap.ranking.keyGroup')}: ${t(`analyze.keyHeatmap.ranking.keyGroupOption.${h.keyGroupFilter}`)}`,
        `${t('analyze.keyHeatmap.ranking.frequentUsedN')}: ${h.frequentUsedN}`,
      ]
    }
    case 'wpm': {
      const out = [`${t('analyze.filters.wpmViewMode')}: ${t(`analyze.filters.wpmViewModeOption.${ctx.wpm.viewMode}`)}`]
      if (ctx.wpm.viewMode === 'timeSeries') {
        out.push(`${t('analyze.filters.granularity')}: ${granularityLabel(ctx.wpm.granularity, t)}`)
      }
      return out
    }
    case 'interval': {
      const out = [`${t('analyze.filters.intervalViewMode')}: ${t(`analyze.filters.intervalViewModeOption.${ctx.interval.viewMode}`)}`]
      if (ctx.interval.viewMode === 'timeSeries') {
        out.push(`${t('analyze.filters.granularity')}: ${granularityLabel(ctx.interval.granularity, t)}`)
      }
      return out
    }
    case 'activity':
      return [`${t('analyze.filters.activityMetric')}: ${t(`analyze.filters.activityMetricOption.${ctx.activity.metric}`)}`]
    case 'layer':
      return [`${t('analyze.filters.layerBaseLayer')}: ${t('analyze.layer.layerLabel', { layer: ctx.layer.baseLayer })}`]
    case 'ergonomics': {
      const overrideCount = Object.keys(ctx.fingerOverrides).length
      const value = overrideCount > 0
        ? t('analyze.export.fingerOverridesCustomized', { count: overrideCount })
        : t('analyze.export.fingerOverridesDefault')
      return [`${t('analyze.export.fingerOverrides')}: ${value}`]
    }
    case 'bigrams':
      // Skip per-category specifics — the export pulls every pair
      // (subject to the builder's safety cap) regardless of the
      // chart's per-quadrant limits, so echoing those numbers would
      // misrepresent the CSV slice.
      return []
    case 'layoutComparison': {
      const sourceLabel = LAYOUT_BY_ID.get(ctx.layoutComparison.sourceLayoutId)?.name ?? ctx.layoutComparison.sourceLayoutId
      const targetId = ctx.layoutComparison.targetLayoutId
      const targetLabel = targetId === null
        ? t('analyze.layoutComparison.noTargetOption')
        : LAYOUT_BY_ID.get(targetId)?.name ?? targetId
      return [
        `${t('analyze.layoutComparison.sourceLabel')}: ${sourceLabel}`,
        `${t('analyze.layoutComparison.targetLabel')}: ${targetLabel}`,
      ]
    }
  }
}

// Resolve which builders should run for the modal's current toggle
// state. Snapshot-gated categories return an empty list when the
// snapshot is missing so handleExport doesn't have to repeat the
// availability check.
export function pickBuilders(
  ctx: AnalyzeExportContext,
  selected: Record<Category, boolean>,
  t: TFunction,
): Array<Promise<CsvBundleEntry>> {
  const out: Array<Promise<CsvBundleEntry>> = []
  // Bundle the scope axes once so every builder gets the same
  // (uid, range, deviceScope, appScopes) tuple without each call site
  // repeating the per-axis fan-out.
  const scope = {
    uid: ctx.uid,
    range: ctx.range,
    deviceScope: ctx.deviceScope,
    appScopes: ctx.appScopes,
    typingTestScopes: ctx.typingTestScopes,
    runIdScopes: ctx.runIdScopes,
  }
  if (selected.summary) {
    out.push(buildSummaryCsv(scope))
  }
  if (selected.heatmap && ctx.snapshot !== null) {
    out.push(buildHeatmapCsv({ ...scope, snapshot: ctx.snapshot, heatmap: ctx.heatmap, t }))
  }
  if (selected.wpm) {
    out.push(buildWpmCsv({
      ...scope,
      granularity: ctx.wpm.granularity, viewMode: ctx.wpm.viewMode, minActiveMs: ctx.wpm.minActiveMs,
    }))
  }
  if (selected.interval) {
    out.push(buildIntervalCsv({
      ...scope,
      granularity: ctx.interval.granularity, viewMode: ctx.interval.viewMode,
    }))
    // Duration pairs with the distribution view only — DurationSection
    // is likewise mounted only in `distribution` mode (see AnalyzePane).
    // A separate builder/push (rather than buildIntervalCsv returning an
    // array) keeps every builder in this list to the same one-entry shape.
    if (ctx.interval.viewMode === 'distribution') {
      out.push(buildDurationDistributionCsv(scope))
    }
  }
  if (selected.activity) {
    out.push(buildActivityCsv({
      ...scope,
      metric: ctx.activity.metric, minActiveMs: ctx.activity.minActiveMs,
    }))
  }
  if (selected.ergonomics && ctx.snapshot !== null) {
    out.push(buildErgonomicsCsv({
      ...scope,
      snapshot: ctx.snapshot, fingerOverrides: ctx.fingerOverrides, t,
    }))
  }
  if (selected.layer) {
    out.push(buildLayerCsv({
      ...scope,
      snapshot: ctx.snapshot, baseLayer: ctx.layer.baseLayer, t,
    }))
  }
  if (selected.byApp) {
    out.push(buildByAppCsv(scope))
  }
  if (selected.bigrams) {
    out.push(buildBigramsCsv({
      ...scope, gram: ctx.bigrams.gram, snapshot: ctx.snapshot, fingerOverrides: ctx.fingerOverrides,
    }))
  }
  if (selected.layoutComparison && ctx.snapshot !== null && ctx.layoutComparison.targetLayoutId !== null) {
    out.push(buildLayoutComparisonCsv({
      ...scope,
      sourceLayoutId: ctx.layoutComparison.sourceLayoutId,
      targetLayoutId: ctx.layoutComparison.targetLayoutId,
      fingerOverrides: ctx.fingerOverrides,
      t,
    }))
  }
  return out
}
