// SPDX-License-Identifier: GPL-2.0-or-later
// Single entry point for exporting the Analyze charts as CSV. The
// modal lists every category as a toggle button (all on by default)
// and runs the corresponding builder for each selected category. All
// resulting files are shipped to the main process in a single bundle
// so the user only sees one directory picker no matter how many
// categories they ticked.
//
// Filenames follow `{keyboard}_{hash|all}_{start}_{end}_{slug}.csv`,
// where the timestamps are local-time YYYYMMDDHHmm so the user can
// see at a glance which range a file covers without reopening it.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import type { TypingKeymapSnapshot } from '../../../shared/types/typing-analytics'
import type { HeatmapFilters, LayoutComparisonFilters } from '../../../shared/types/analyze-filters'
import { LAYOUT_BY_ID } from '../../data/keyboard-layouts'
import { ModalCloseButton } from '../editors/ModalCloseButton'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { FILTER_BUTTON } from './analyze-filter-styles'
import {
  buildActivityCsv,
  buildBigramsCsv,
  buildErgonomicsCsv,
  buildHeatmapCsv,
  buildIntervalCsv,
  buildLayerCsv,
  buildLayoutComparisonCsv,
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
  snapshot: TypingKeymapSnapshot | null
  heatmap: Required<HeatmapFilters>
  wpm: { granularity: GranularityChoice; viewMode: WpmViewMode; minActiveMs: number }
  interval: { viewMode: IntervalViewMode; granularity: GranularityChoice }
  activity: { metric: ActivityMetric; minActiveMs: number }
  layer: { baseLayer: number }
  // `Required<>` only strips the `?`, so `targetLayoutId` is still
  // `string | null`. The runtime guard in pickBuilders (and
  // isCategoryAvailable) narrows it before passing to the builder.
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

interface Props {
  isOpen: boolean
  onClose: () => void
  ctx: AnalyzeExportContext | null
}

type Category = 'heatmap' | 'wpm' | 'interval' | 'activity' | 'ergonomics' | 'bigrams' | 'layoutComparison' | 'layer'

const CATEGORIES: readonly Category[] = [
  'heatmap', 'wpm', 'interval', 'activity', 'ergonomics', 'bigrams', 'layoutComparison', 'layer',
]

// Heatmap, Ergonomics, and Layout Comparison need a keymap snapshot
// (the comparison aligns target positions against the recorded
// keymap); the rest read raw minute / session / bigram counters and
// are always available once the keyboard has any analytics rows.
const REQUIRES_SNAPSHOT: Record<Category, boolean> = {
  heatmap: true,
  wpm: false,
  interval: false,
  activity: false,
  ergonomics: true,
  bigrams: false,
  layoutComparison: true,
  layer: false,
}

const allOn = (): Record<Category, boolean> =>
  Object.fromEntries(CATEGORIES.map((c) => [c, true])) as Record<Category, boolean>

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0')
}

function formatLocalCompact(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1, 2)}${pad(d.getDate(), 2)}${pad(d.getHours(), 2)}${pad(d.getMinutes(), 2)}`
}

function sanitizeKeyboardName(name: string): string {
  const collapsed = name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')
  return collapsed.length > 0 ? collapsed : 'keyboard'
}

function categoryRowClass(active: boolean): string {
  const base = 'flex flex-col items-stretch gap-1 rounded-md border px-3 py-2 text-left transition-colors'
  return active
    ? `${base} border-accent bg-accent/10 text-content`
    : `${base} border-edge text-content-muted hover:bg-surface-dim`
}

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
// (device / keymap / range) live in the modal header.
function specificsFor(c: Category, ctx: AnalyzeExportContext, t: TFunction): string[] {
  switch (c) {
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
function pickBuilders(
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
  if (selected.bigrams) {
    out.push(buildBigramsCsv(scope))
  }
  if (selected.layoutComparison && ctx.snapshot !== null && ctx.layoutComparison.targetLayoutId !== null) {
    out.push(buildLayoutComparisonCsv({
      ...scope,
      sourceLayoutId: ctx.layoutComparison.sourceLayoutId,
      targetLayoutId: ctx.layoutComparison.targetLayoutId,
      t,
    }))
  }
  return out
}

export function AnalyzeExportModal({ isOpen, onClose, ctx }: Props) {
  const { t } = useTranslation()
  const [selected, setSelected] = useState<Record<Category, boolean>>(allOn)
  const [exporting, setExporting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset toggles + error each time the modal reopens so a previous
  // partial selection (or a stale error) doesn't carry across runs.
  useEffect(() => {
    if (!isOpen) return
    setSelected(allOn())
    setError(null)
  }, [isOpen])

  useEscapeClose(onClose, isOpen)

  const snapshotMissing = ctx?.snapshot === null

  const isCategoryAvailable = (c: Category): boolean => {
    if (!ctx) return false
    if (REQUIRES_SNAPSHOT[c] && snapshotMissing) return false
    // Layout Comparison also needs an explicit target — without one
    // there is no "candidate vs current" diff to write to CSV.
    if (c === 'layoutComparison' && ctx.layoutComparison.targetLayoutId === null) return false
    return true
  }

  const anySelected = CATEGORIES.some((c) => selected[c] && isCategoryAvailable(c))

  const handleToggle = (c: Category) => {
    if (!isCategoryAvailable(c)) return
    setSelected((prev) => ({ ...prev, [c]: !prev[c] }))
  }

  const handleExport = async () => {
    if (!ctx || !anySelected || exporting) return
    setExporting(true)
    setError(null)
    try {
      const builders = pickBuilders(ctx, selected, t)
      const entries = await Promise.all(builders)
      const prefix = `${sanitizeKeyboardName(ctx.keyboardName)}_${ctx.machineHashOrAll}_${formatLocalCompact(ctx.range.fromMs)}_${formatLocalCompact(ctx.range.toMs)}`
      const files = entries.map((e) => ({ name: `${prefix}_${e.slug}`, content: e.content }))
      const result = await window.vialAPI.exportCsvBundle(files)
      if (!result.success && result.error !== 'cancelled') {
        setError(result.error ?? t('analyze.export.failed'))
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('analyze.export.failed'))
    } finally {
      setExporting(false)
    }
  }

  if (!isOpen) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="analyze-export-modal"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('analyze.export.categoriesLabel')}
        className="w-[560px] max-w-[95vw] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex justify-end px-3 pt-3 shrink-0">
          <ModalCloseButton testid="analyze-export-close" onClick={onClose} />
        </div>
        <div className="flex flex-col gap-3 px-5 pb-3">
          {ctx !== null && (
            <div
              className="flex flex-col gap-0.5 rounded-md border border-edge bg-surface px-3 py-2 text-[11px] text-content-secondary"
              data-testid="analyze-export-common"
            >
              <div><span className="text-content-muted">{t('analyze.export.conditionLabel.device')}: </span>{ctx.conditions.device}</div>
              <div><span className="text-content-muted">{t('analyze.export.conditionLabel.app')}: </span>{ctx.conditions.app}</div>
              <div><span className="text-content-muted">{t('analyze.export.conditionLabel.keymap')}: </span>{ctx.conditions.keymap}</div>
              <div><span className="text-content-muted">{t('analyze.export.conditionLabel.range')}: </span>{ctx.conditions.range}</div>
            </div>
          )}
          <div className="flex flex-col gap-2" role="group" aria-label={t('analyze.export.categoriesLabel')}>
            {CATEGORIES.map((c) => {
              const available = isCategoryAvailable(c)
              const active = available && selected[c]
              const specifics = ctx !== null ? specificsFor(c, ctx, t) : []
              return (
                <button
                  key={c}
                  type="button"
                  className={categoryRowClass(active)}
                  aria-pressed={active}
                  disabled={!available}
                  onClick={() => handleToggle(c)}
                  data-testid={`analyze-export-toggle-${c}`}
                >
                  <span className="text-[13px] font-semibold">
                    {t(`analyze.export.category.${c}`)}
                  </span>
                  {specifics.length > 0 && (
                    <span className="text-[11px] text-content-muted">
                      {specifics.map((s, i) => (
                        <span key={i} className={i === 0 ? '' : 'ml-3'}>{s}</span>
                      ))}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
          {snapshotMissing && (
            <p className="text-[11px] text-content-muted" data-testid="analyze-export-snapshot-warning">
              {t('analyze.export.snapshotMissing')}
            </p>
          )}
          {error !== null && (
            <p className="text-[12px] text-error" role="alert" data-testid="analyze-export-error">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-edge bg-surface px-5 py-3">
          <button
            type="button"
            className={FILTER_BUTTON}
            onClick={handleExport}
            disabled={!anySelected || exporting || ctx === null}
            data-testid="analyze-export-confirm"
          >
            {t('analyze.export.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
