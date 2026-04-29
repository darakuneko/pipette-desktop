// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Ergonomics — aggregate keystroke counts by finger, hand,
// and row category. Finger labels are estimated from KLE geometry
// (see shared/kle/kle-ergonomics); users can override the defaults
// in the separate finger-assignment page.

import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
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
  TypingHeatmapByCell,
  TypingHeatmapCell,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import { primaryDeviceScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type {
  DeviceScope,
  ErgonomicsLearningPeriod,
  ErgonomicsViewMode,
  RangeMs,
} from './analyze-types'
import { aggregateErgonomics, ROW_ORDER } from './analyze-ergonomics'
import { fetchMatrixHeatmapAllLayers } from './analyze-fetch'
import { KeystrokeCountTooltip, Stat, TooltipShell } from './analyze-tooltip'
import { ErgonomicsLearningCurveChart } from './ErgonomicsLearningCurveChart'

interface Props {
  uid: string
  range: RangeMs
  /** Device filter (capped at MAX_DEVICE_SCOPES = 1). The single scope
   * drives the finger / hand / row aggregations. */
  deviceScopes: readonly DeviceScope[]
  /** App filter — see WpmChart.Props.appScopes. */
  appScopes: string[]
  snapshot: TypingKeymapSnapshot
  fingerOverrides?: Record<string, FingerType>
  /** Sub-view selector: `'snapshot'` keeps the four-pane summary,
   * `'learning'` swaps in the trend chart. */
  viewMode?: ErgonomicsViewMode
  /** Bucket width for the Learning Curve. Ignored when
   * `viewMode === 'snapshot'`. */
  period?: ErgonomicsLearningPeriod
  /** Threshold for marking a Learning Curve bucket as qualified. */
  learningMinSampleKeystrokes?: number
  /** Snapshot-mode only: invoked from the finger-load chart's title
   * action to open the per-key finger assignment modal. */
  onOpenFingerAssignment?: () => void
}

type BarDatum = { label: string; value: number }

/** Position-only finger kinds for the pyramid view (drops the L/R
 * prefix). Order is symmetric so the pyramid's vertical axis reads
 * outer → inner. */
type FingerKind = 'thumb' | 'index' | 'middle' | 'ring' | 'pinky'
const FINGER_KINDS: readonly FingerKind[] = ['thumb', 'index', 'middle', 'ring', 'pinky']

const PYRAMID_LEFT_COLOR = '#3b82f6'
const PYRAMID_RIGHT_COLOR = '#ef4444'

interface PyramidDatum {
  /** Localised category label (drives YAxis ticks). */
  category: string
  /** Left-hand keystrokes, encoded as a NEGATIVE number so recharts'
   * `stackOffset="sign"` paints the bar to the left of zero. */
  left: number
  /** Right-hand keystrokes (positive). */
  right: number
}

interface SectionProps {
  title: string
  data: BarDatum[]
  orientation: 'horizontal' | 'vertical'
  height: number
  testId: string
}

const Section = memo(function Section({
  title,
  data,
  orientation,
  height,
  testId,
}: SectionProps) {
  return (
    <div data-testid={testId}>
      <h4 className="mb-1 text-[13px] font-semibold text-content-secondary">
        {title}
      </h4>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout={orientation}
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
            {orientation === 'vertical' ? (
              <>
                <XAxis
                  type="number"
                  stroke="var(--color-content-muted)"
                  fontSize={11}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  stroke="var(--color-content-muted)"
                  fontSize={11}
                  width={80}
                />
              </>
            ) : (
              <>
                <XAxis
                  type="category"
                  dataKey="label"
                  stroke="var(--color-content-muted)"
                  fontSize={11}
                />
                <YAxis type="number" stroke="var(--color-content-muted)" fontSize={11} />
              </>
            )}
            <Tooltip
              cursor={{ fill: 'var(--color-surface-dim)' }}
              content={(props) => <KeystrokeCountTooltip {...props} />}
            />
            <Bar dataKey="value" fill="var(--color-accent)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
})

interface HandPyramidChartProps {
  title: string
  data: PyramidDatum[]
  height: number
  yAxisWidth: number
  testId: string
  /** Optional right-aligned action in the title row. Used by the
   * finger-load chart to surface the "open finger assignment" button
   * inside the chart it actually affects, instead of in the global
   * filter bar. */
  titleAction?: ReactNode
}

/** Population-pyramid bar chart for left vs. right keystrokes against
 * an arbitrary category axis (finger kind, row category, …). The X
 * axis is centered at zero with left-hand bars painted negative so the
 * two hands diverge from the spine. Symmetric `domain` (`[-max, max]`)
 * keeps an extreme dominant hand from squeezing the other side flat. */
const HandPyramidChart = memo(function HandPyramidChart({
  title,
  data,
  height,
  yAxisWidth,
  testId,
  titleAction,
}: HandPyramidChartProps) {
  const maxAbs = Math.max(
    ...data.map((d) => Math.max(Math.abs(d.left), d.right)),
    1,
  )
  return (
    <div data-testid={testId}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="text-[13px] font-semibold text-content-secondary">{title}</h4>
        {titleAction}
      </div>
      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            stackOffset="sign"
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" horizontal={false} />
            <XAxis
              type="number"
              domain={[-maxAbs, maxAbs]}
              tickFormatter={(v) => Math.abs(Number(v)).toLocaleString()}
              stroke="var(--color-content-muted)"
              fontSize={11}
            />
            <YAxis
              type="category"
              dataKey="category"
              stroke="var(--color-content-muted)"
              fontSize={11}
              width={yAxisWidth}
            />
            <Tooltip
              cursor={{ fill: 'var(--color-surface-dim)' }}
              content={(p) => <HandPyramidTooltip {...p} />}
            />
            <Bar dataKey="left" stackId="hand" fill={PYRAMID_LEFT_COLOR} isAnimationActive={false} />
            <Bar dataKey="right" stackId="hand" fill={PYRAMID_RIGHT_COLOR} isAnimationActive={false} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
})

interface HandPyramidTooltipProps {
  active?: boolean
  label?: unknown
  payload?: ReadonlyArray<{ payload?: PyramidDatum }>
}

function HandPyramidTooltip({ active, label, payload }: HandPyramidTooltipProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!active || !payload?.length) return null
  const datum = payload[0]?.payload
  if (!datum) return null
  const displayLabel = typeof label === 'string' || typeof label === 'number' ? label : datum.category
  const leftCount = Math.abs(datum.left)
  const rightCount = datum.right
  const unit = t('analyze.unit.keys')
  return (
    <TooltipShell header={displayLabel}>
      <Stat
        label={t('analyze.ergonomics.hand.left')}
        value={`${leftCount.toLocaleString()} ${unit}`}
      />
      <Stat
        label={t('analyze.ergonomics.hand.right')}
        value={`${rightCount.toLocaleString()} ${unit}`}
      />
    </TooltipShell>
  )
}

function mergeLayerHeatmaps(
  layerCells: Record<number, TypingHeatmapByCell>,
): Map<string, TypingHeatmapCell> {
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

/** Dispatcher — routes to the right sub-view. The two views run
 * disjoint hook trees so we keep each as its own component to avoid
 * hook-order pitfalls when the user toggles modes. */
export function ErgonomicsChart({
  uid,
  range,
  deviceScopes,
  appScopes,
  snapshot,
  fingerOverrides,
  viewMode = 'snapshot',
  period = 'week',
  learningMinSampleKeystrokes,
  onOpenFingerAssignment,
}: Props) {
  if (viewMode === 'learning') {
    return (
      <ErgonomicsLearningCurveChart
        uid={uid}
        range={range}
        deviceScopes={deviceScopes}
        appScopes={appScopes}
        snapshot={snapshot}
        period={period}
        minSampleKeystrokes={learningMinSampleKeystrokes}
      />
    )
  }
  return (
    <ErgonomicsSnapshotView
      uid={uid}
      range={range}
      deviceScopes={deviceScopes}
      appScopes={appScopes}
      snapshot={snapshot}
      fingerOverrides={fingerOverrides}
      onOpenFingerAssignment={onOpenFingerAssignment}
    />
  )
}

interface SnapshotViewProps {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  appScopes: string[]
  snapshot: TypingKeymapSnapshot
  fingerOverrides?: Record<string, FingerType>
  onOpenFingerAssignment?: () => void
}

function ErgonomicsSnapshotView({
  uid,
  range,
  deviceScopes,
  appScopes,
  snapshot,
  fingerOverrides,
  onOpenFingerAssignment,
}: SnapshotViewProps) {
  const { t } = useTranslation()
  const [layerCells, setLayerCells] = useState<Record<number, TypingHeatmapByCell>>({})
  const [loading, setLoading] = useState(true)

  const deviceScope = primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(deviceScope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void fetchMatrixHeatmapAllLayers(uid, snapshot, range.fromMs, range.toMs, deviceScope, appScopes)
      .then((next) => {
        if (cancelled) return
        setLayerCells(next)
        setLoading(false)
      })
    return () => { cancelled = true }
    // `scopeKey` carries `deviceScope` identity.
  }, [uid, range, scopeKey, snapshot, appScopes])

  const mergedHeatmap = useMemo(
    () => mergeLayerHeatmaps(layerCells),
    [layerCells],
  )

  const layout = snapshot.layout as KeyboardLayout | null
  const keys = layout?.keys ?? []

  const aggregation = useMemo(
    () => aggregateErgonomics(mergedHeatmap, keys, fingerOverrides),
    [mergedHeatmap, keys, fingerOverrides],
  )

  const handData: BarDatum[] = [
    {
      label: t('analyze.ergonomics.hand.left'),
      value: aggregation.hand.left,
    },
    {
      label: t('analyze.ergonomics.hand.right'),
      value: aggregation.hand.right,
    },
  ]
  const rowData: BarDatum[] = ROW_ORDER.map((r) => ({
    label: t(`analyze.ergonomics.rowCategory.${r}`),
    value: aggregation.row[r],
  }))
  const fingerPyramidData: PyramidDatum[] = FINGER_KINDS.map((kind) => {
    const leftRaw = aggregation.finger[`left-${kind}`]
    return {
      category: t(`analyze.ergonomics.fingerKind.${kind}`),
      // Negate explicitly only for non-zero counts so the row doesn't
      // carry a `-0` that could trip up recharts' sign-based stacking.
      left: leftRaw === 0 ? 0 : -leftRaw,
      right: aggregation.finger[`right-${kind}`],
    }
  })
  const rowPyramidData: PyramidDatum[] = ROW_ORDER.map((r) => {
    const leftRaw = aggregation.rowByHand.left[r]
    return {
      category: t(`analyze.ergonomics.rowCategory.${r}`),
      left: leftRaw === 0 ? 0 : -leftRaw,
      right: aggregation.rowByHand.right[r],
    }
  })

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-ergonomics-loading">
        {t('common.loading')}
      </div>
    )
  }
  if (!layout || keys.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-ergonomics-no-layout">
        {t('analyze.ergonomics.noLayout')}
      </div>
    )
  }
  if (aggregation.total === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-ergonomics-empty">
        {t('analyze.ergonomics.noData')}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto pr-1" data-testid="analyze-ergonomics">
      {/* Row 1: Hand Balance pairs with the per-finger pyramid so the
        * left/right summary sits next to its breakdown. Hand Balance
        * carries only two bars and reads naturally narrow; the pyramid
        * needs the wider column to keep the diverging axis legible.
        * `min-w-0` keeps recharts measurement from forcing either child
        * past its grid track. */}
      <div className="grid grid-cols-[1fr_3fr] gap-4">
        <div className="min-w-0">
          <Section
            title={t('analyze.ergonomics.handBalance')}
            data={handData}
            orientation="horizontal"
            height={280}
            testId="analyze-ergonomics-hand"
          />
        </div>
        <div className="min-w-0">
          <HandPyramidChart
            title={t('analyze.ergonomics.fingerLoad')}
            data={fingerPyramidData}
            height={280}
            yAxisWidth={64}
            testId="analyze-ergonomics-finger"
            titleAction={
              onOpenFingerAssignment ? (
                <button
                  type="button"
                  className="rounded-md border border-edge bg-surface px-3 py-1 text-[12px] text-content-secondary transition-colors hover:border-accent hover:text-content"
                  onClick={onOpenFingerAssignment}
                  data-testid="analyze-finger-assignment-open"
                >
                  {t('analyze.fingerAssignment.button')}
                </button>
              ) : undefined
            }
          />
        </div>
      </div>
      {/* Row 2: Row balance (sum across hands) sits next to its
        * left/right pyramid so the totals and the per-hand split
        * read together. */}
      <div className="grid grid-cols-[1fr_3fr] gap-4">
        <div className="min-w-0">
          <Section
            title={t('analyze.ergonomics.rowUsage')}
            data={rowData}
            orientation="horizontal"
            height={240}
            testId="analyze-ergonomics-row"
          />
        </div>
        <div className="min-w-0">
          <HandPyramidChart
            title={t('analyze.ergonomics.rowLoad')}
            data={rowPyramidData}
            height={240}
            yAxisWidth={72}
            testId="analyze-ergonomics-row-pyramid"
          />
        </div>
      </div>
    </div>
  )
}
