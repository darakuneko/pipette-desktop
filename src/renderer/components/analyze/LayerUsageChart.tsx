// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Layer — per-layer keystroke totals AND layer-op
// activations, switched via the view mode toggle.
//
// - Keystrokes: reads `typing_matrix_minute.layer` (GROUP BY layer),
//   so MO / LT / TG activations are already reflected without keycode
//   decoding. Works without a snapshot.
// - Activations: aggregates per-cell matrix totals, looks up each
//   cell's serialized QMK id in the keymap snapshot, and dispatches
//   layer-op keycodes to their target layer. Requires a snapshot;
//   falls back to the "snapshot needed" state without one.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  TypingKeymapSnapshot,
  TypingLayerUsageRow,
  TypingMatrixCellRow,
} from '../../../shared/types/typing-analytics'
import { primaryDeviceScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type { DeviceScope, LayerViewMode, RangeMs } from './analyze-types'
import { listLayerUsageForScope, listMatrixCellsForScope } from './analyze-fetch'
import {
  aggregateLayerActivations,
  aggregateLayerKeystrokes,
  buildLayerBarsFromCounts,
  type LayerBar,
} from './analyze-layer-usage'
import { KeystrokeCountTooltip } from './analyze-tooltip'
import { FILTER_SELECT } from './analyze-filter-styles'

interface AxisTickProps {
  x?: number
  y?: number
  payload?: { value?: string | number }
}

// Matches recharts' default tick typography so the axis stays
// visually consistent with Ergonomics / Activity / WPM tabs.
const AXIS_TICK_FONT_SIZE = 11
const AXIS_TICK_LINE_HEIGHT = 13
// Small inward padding from the axis line so single-line labels line
// up with the tick itself (empirical, matches recharts' stock tick).
const AXIS_TICK_FIRST_LINE_DY = 4
const AXIS_TICK_X_OFFSET = -4

/** Wrap a YAxis tick's value onto multiple lines using `\n`. recharts
 * ships a single-line default; we need two lines here so a bar tagged
 * with a layer name (e.g. "Layer 0\nBase") doesn't squish the axis
 * width out to 200+px. Keeps the font styling identical to the stock
 * tick so the chart looks consistent with the other Analyze tabs. */
function MultiLineYAxisTick({ x, y, payload }: AxisTickProps): JSX.Element {
  const raw = payload?.value
  const text = typeof raw === 'string' ? raw : String(raw ?? '')
  const lines = text.split('\n')
  // Vertical-center the block around the tick's y coordinate so the
  // label stays aligned with its bar regardless of line count.
  const startDy = -((lines.length - 1) * AXIS_TICK_LINE_HEIGHT) / 2
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      <text
        x={AXIS_TICK_X_OFFSET}
        y={0}
        dy={startDy}
        textAnchor="end"
        fill="var(--color-content-muted)"
        fontSize={AXIS_TICK_FONT_SIZE}
      >
        {lines.map((line, i) => (
          <tspan key={i} x={AXIS_TICK_X_OFFSET} dy={i === 0 ? AXIS_TICK_FIRST_LINE_DY : AXIS_TICK_LINE_HEIGHT}>
            {line}
          </tspan>
        ))}
      </text>
    </g>
  )
}

interface Props {
  uid: string
  range: RangeMs
  /** Device filter (capped at MAX_DEVICE_SCOPES = 1). The single scope
   * drives the layer bars. */
  deviceScopes: readonly DeviceScope[]
  /** App filter — see WpmChart.Props.appScopes. */
  appScopes: string[]
  /** Optional snapshot. Keystrokes mode still works without one
   * (zero-fills against the max observed layer); activations mode
   * needs it to resolve layer-op keycodes. */
  snapshot: TypingKeymapSnapshot | null
  viewMode: LayerViewMode
  /** Base layer the user is analyzing against. Activations mode
   * drops this layer from both the aggregation and the bar list so
   * "layer X held while already on X" (e.g. `LT0(KC_ESC)` hold with
   * base=0) doesn't masquerade as a transition. Keystrokes mode
   * ignores this field and shows every layer. */
  baseLayer: number
  /** When provided alongside `viewMode === 'activations'`, the chart
   * title row renders an inline base-layer select so the control
   * lives next to the section it controls instead of in the global
   * filter bar. Omit on the keystrokes instance. */
  onBaseLayerChange?: (baseLayer: number) => void
}

export function LayerUsageChart({ uid, range, deviceScopes, appScopes, snapshot, viewMode, baseLayer, onBaseLayerChange }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TypingLayerUsageRow[]>([])
  const [cells, setCells] = useState<TypingMatrixCellRow[]>([])
  const [layerNames, setLayerNames] = useState<string[]>([])
  const [loading, setLoading] = useState(true)

  const deviceScope = primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(deviceScope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const promise = viewMode === 'activations'
      ? listMatrixCellsForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes)
      : listLayerUsageForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes)
    void promise
      .then((result) => {
        if (cancelled) return
        if (viewMode === 'activations') setCells(Array.isArray(result) ? (result as TypingMatrixCellRow[]) : [])
        else setRows(Array.isArray(result) ? (result as TypingLayerUsageRow[]) : [])
      })
      .catch(() => {
        if (cancelled) return
        if (viewMode === 'activations') setCells([])
        else setRows([])
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // `scopeKey` carries `deviceScope` identity — adding the object
    // would refetch on every parent rerender.
  }, [uid, range, scopeKey, viewMode, appScopes])

  // Settings tracks `uid` only — layer names don't change per range /
  // deviceScope / viewMode, so merging this with the rows fetch would
  // re-hit the settings store on every filter tweak.
  useEffect(() => {
    let cancelled = false
    void window.vialAPI
      .pipetteSettingsGet(uid)
      .then((prefs) => {
        if (cancelled) return
        setLayerNames(Array.isArray(prefs?.layerNames) ? prefs.layerNames : [])
      })
      .catch(() => {
        if (!cancelled) setLayerNames([])
      })
    return () => {
      cancelled = true
    }
  }, [uid])

  // Activations is the only mode that excludes the base layer; any
  // other mode should behave as if no exclusion is active so the
  // `useMemo` doesn't re-aggregate when the (hidden) Base Layer
  // select changes in keystrokes mode.
  const effectiveExcludeLayer = viewMode === 'activations' ? baseLayer : undefined

  const bars = useMemo(() => {
    const fallbackLabel = (layer: number): string =>
      t('analyze.layer.layerLabel', { layer })
    const byLayer = ((): Map<number, number> => {
      switch (viewMode) {
        case 'keystrokes':
          return aggregateLayerKeystrokes(rows)
        case 'activations':
          return snapshot !== null
            ? aggregateLayerActivations(cells, snapshot, { excludeLayer: effectiveExcludeLayer })
            : new Map()
      }
    })()
    return buildLayerBarsFromCounts(byLayer, snapshot?.layers ?? 0, layerNames, fallbackLabel, {
      excludeLayer: effectiveExcludeLayer,
    })
  }, [viewMode, snapshot, cells, rows, layerNames, t, effectiveExcludeLayer])

  const title =
    viewMode === 'activations'
      ? t('analyze.layer.activationsTitle')
      : t('analyze.layer.title')

  // Title row stays rendered for every state so the section heading
  // (and the inline base-layer select for the activations chart) is
  // always visible — the empty-state notice now nests under the title
  // instead of replacing the section outright.
  const inlineBaseLayerSelect =
    viewMode === 'activations' &&
    snapshot !== null &&
    snapshot.layers > 1 &&
    onBaseLayerChange !== undefined ? (
      <span className="ml-3 inline-flex items-center gap-1.5 text-[12px] font-normal text-content-muted">
        <span>{t('analyze.filters.layerBaseLayer')}</span>
        <select
          className={FILTER_SELECT}
          value={baseLayer}
          onChange={(e) => onBaseLayerChange(Number(e.target.value))}
          data-testid="analyze-filter-layer-base-layer"
        >
          {Array.from({ length: snapshot.layers }, (_, i) => (
            <option key={i} value={i}>
              {t('analyze.layer.layerLabel', { layer: i })}
            </option>
          ))}
        </select>
      </span>
    ) : null
  const titleRow = (
    <h4 className="mb-1 flex items-center text-[13px] font-semibold text-content-secondary">
      <span>{title}</span>
      {inlineBaseLayerSelect}
    </h4>
  )
  const sectionWrap = (body: ReactNode) => (
    <div className="flex flex-col gap-2" data-testid="analyze-layer">
      {titleRow}
      {body}
    </div>
  )

  if (viewMode === 'activations' && snapshot === null) {
    return sectionWrap(
      <div
        className="py-4 text-center text-[13px] text-content-muted"
        data-testid="analyze-layer-no-snapshot"
      >
        {t('analyze.layer.requiresSnapshot')}
      </div>,
    )
  }
  if (loading) {
    return sectionWrap(
      <div
        className="py-4 text-center text-[13px] text-content-muted"
        data-testid="analyze-layer-loading"
      >
        {t('common.loading')}
      </div>,
    )
  }
  const totalValue = bars.reduce((acc, b) => acc + b.value, 0)
  if (bars.length === 0 || totalValue === 0) {
    return sectionWrap(
      <div
        className="py-4 text-center text-[13px] text-content-muted"
        data-testid="analyze-layer-empty"
      >
        {t(viewMode === 'activations' ? 'analyze.layer.noActivations' : 'analyze.layer.noData')}
      </div>,
    )
  }

  // Fixed per-bar height so the ResponsiveContainer parent has a
  // stable size. With `flex-1 + min-h + overflow-y-auto` the chart
  // wrapper would oscillate: the recharts measurement could trigger
  // the outer scrollbar to appear, the scrollbar would shrink the
  // wrapper width, the chart would re-measure, the scrollbar would
  // disappear, and the cycle repeated.
  const BAR_ROW_HEIGHT_PX = 44
  const CHART_VPADDING_PX = 32
  const chartHeightPx = Math.max(220, bars.length * BAR_ROW_HEIGHT_PX + CHART_VPADDING_PX)

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="analyze-layer"
    >
      {titleRow}
      <div style={{ height: chartHeightPx }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={bars}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
            <XAxis type="number" stroke="var(--color-content-muted)" fontSize={11} />
            <YAxis
              type="category"
              dataKey="axisLabel"
              stroke="var(--color-content-muted)"
              fontSize={11}
              width={120}
              tick={<MultiLineYAxisTick />}
            />
            <Tooltip
              cursor={{ fill: 'var(--color-surface-dim)' }}
              content={(props) => {
                // The axis uses the multi-line `axisLabel`, but the
                // tooltip should show the original "Layer 0 · Base"
                // single-line form — read it from the hovered bar's
                // datum rather than recharts' category label.
                const hovered = props.payload?.[0]?.payload as LayerBar | undefined
                return (
                  <KeystrokeCountTooltip
                    {...props}
                    label={hovered?.label ?? props.label}
                    unitKey={viewMode === 'activations' ? 'analyze.unit.activations' : 'analyze.unit.keys'}
                  />
                )
              }}
            />
            <Bar
              dataKey="value"
              fill="var(--color-accent)"
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
