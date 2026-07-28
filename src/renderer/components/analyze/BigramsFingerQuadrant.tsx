// SPDX-License-Identifier: GPL-2.0-or-later
// Finger IKI quadrant for the Analyze Bigrams tab, plus the horizontal
// bar-chart primitives (bar chart + cell tooltip) it renders through.
// Split out of BigramsChart.tsx — see that file for the surrounding
// grid.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type {
  TypingBigramTopEntry,
  TypingKeymapSnapshot,
} from '../../../shared/types/typing-analytics'
import { aggregateFingerPairs } from './analyze-bigram-finger'
import { useKeycodeFingerMap } from './use-keycode-finger-map'
import { avgIkiAtOrAboveThreshold } from './analyze-bigram-heatmap'
import { Stat, TooltipShell } from './analyze-tooltip'
import { CHART_TICK_FONT_SIZE } from '../../utils/chart-palette'
import { EmptyQuadrant } from './bigrams-quadrant-ui'

/** Finger IKI sort direction. Owned by this quadrant rather than
 * its parent so the parent doesn't have to re-export a type only this
 * file's props use. */
export type FingerSort = 'desc' | 'asc'

interface FingerBarChartProps {
  entries: readonly TypingBigramTopEntry[]
  snapshot: TypingKeymapSnapshot | null
  fingerOverrides?: Record<string, FingerType>
  listLimit: number
  sort: FingerSort
  /** Shared threshold from `pairIntervalThresholdMs` — see
   * `avgIkiAtOrAboveThreshold` for the bucket-center caveat. */
  minAvgIkiMs: number
}

function BigramFingerBarChart({
  entries,
  snapshot,
  fingerOverrides,
  listLimit,
  sort,
  minAvgIkiMs,
}: FingerBarChartProps): JSX.Element {
  const { t } = useTranslation()
  const fingerMap = useKeycodeFingerMap(snapshot, fingerOverrides)
  const data = useMemo<BarDatum[]>(() => {
    if (fingerMap.size === 0) return []
    const totals = aggregateFingerPairs(entries, fingerMap)
    const ranked: BarDatum[] = []
    for (const [pairKey, total] of totals) {
      const avg = avgIkiAtOrAboveThreshold(total.hist, minAvgIkiMs)
      if (avg === null) continue
      const [fromFinger, toFinger] = pairKey.split('_') as [FingerType, FingerType]
      const fromLabel = t(`analyze.finger.short.${fromFinger}`)
      const toLabel = t(`analyze.finger.short.${toFinger}`)
      ranked.push({
        id: pairKey,
        label: `${fromLabel} → ${toLabel}`,
        value: avg,
        count: total.count,
        color: fromFinger.startsWith('left-') ? BAR_LEFT : BAR_RIGHT,
      })
    }
    const dir = sort === 'desc' ? 1 : -1
    ranked.sort((a, b) => dir * (b.value - a.value) || a.id.localeCompare(b.id))
    return ranked.slice(0, Math.max(listLimit, 0))
  }, [entries, fingerMap, listLimit, minAvgIkiMs, sort, t])

  if (snapshot === null) {
    return (
      <EmptyQuadrant
        text={t('analyze.bigrams.fingerIki.noSnapshot')}
        testId="analyze-bigrams-finger-no-snapshot"
      />
    )
  }
  if (data.length === 0) {
    return <EmptyQuadrant text={t('analyze.bigrams.empty')} />
  }
  return (
    <div data-testid="analyze-bigrams-finger-bars">
      <BigramBarChart data={data} yAxisWidth={100} unit="ms" />
    </div>
  )
}

const BAR_LEFT = 'var(--color-accent-hover)'
const BAR_RIGHT = 'var(--color-danger)'

interface BarDatum {
  id: string
  label: string
  value: number
  count: number
  color: string
}

const BAR_ROW_PX = 24
const CHART_VERTICAL_PADDING_PX = 16

interface BigramBarChartProps {
  data: BarDatum[]
  yAxisWidth: number
  unit: string
}

/** Horizontal bar chart shared by the Finger and Key bigram quadrants.
 * Each row is one categorical bar; height is sized to fit the row count
 * so the parent quadrant's `overflow-auto` handles long lists. recharts'
 * native Tooltip provides the cursor-following bubble that matches the
 * Ergonomics tab's bar charts. */
function BigramBarChart({ data, yAxisWidth, unit }: BigramBarChartProps): JSX.Element {
  // Floor at 120px so single-row charts don't squeeze the axis labels.
  const height = Math.max(120, data.length * BAR_ROW_PX + CHART_VERTICAL_PADDING_PX * 2 + 24)
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: CHART_VERTICAL_PADDING_PX, right: 40, bottom: CHART_VERTICAL_PADDING_PX, left: 4 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" horizontal={false} />
          <XAxis
            type="number"
            stroke="var(--color-content-muted)"
            fontSize={CHART_TICK_FONT_SIZE}
            tickFormatter={(v) => `${Math.round(Number(v))}`}
          />
          <YAxis
            type="category"
            dataKey="label"
            stroke="var(--color-content-muted)"
            fontSize={CHART_TICK_FONT_SIZE}
            width={yAxisWidth}
            interval={0}
          />
          <Tooltip
            cursor={{ fill: 'var(--color-surface-dim)' }}
            content={(p) => <BigramCellTooltip {...p} />}
          />
          <Bar dataKey="value" isAnimationActive={false}>
            {data.map((row) => (
              <Cell key={row.id} fill={row.color} />
            ))}
            <LabelList
              dataKey="value"
              position="right"
              formatter={(v: unknown) => `${Math.round(Number(v))} ${unit}`}
              style={{ fill: 'var(--color-content-muted)', fontSize: CHART_TICK_FONT_SIZE }}
            />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

interface BigramCellTooltipProps {
  active?: boolean
  label?: unknown
  payload?: ReadonlyArray<{ payload?: BarDatum }>
}

/** recharts content renderer — the default `formatter` path renders a
 * leading separator when the item name is empty, and threading a name
 * through every row would obscure the per-bigram label that's already
 * on the Y axis. Owning the markup keeps the bubble compact. */
function BigramCellTooltip({ active, label, payload }: BigramCellTooltipProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!active || !payload?.length) return null
  const datum = payload[0]?.payload
  if (!datum) return null
  const displayLabel = typeof label === 'string' || typeof label === 'number' ? label : datum.label
  return (
    <TooltipShell header={displayLabel}>
      <Stat
        label={t('analyze.bigrams.cellTooltipOccurrencesLabel')}
        value={datum.count.toLocaleString()}
      />
      <Stat
        label={t('analyze.bigrams.cellTooltipAvgIkiLabel')}
        value={`${Math.round(datum.value)} ms`}
      />
    </TooltipShell>
  )
}

export type { FingerBarChartProps, BarDatum, BigramBarChartProps, BigramCellTooltipProps }
export {
  BigramFingerBarChart,
  BAR_ROW_PX,
  CHART_VERTICAL_PADDING_PX,
  BigramBarChart,
  BigramCellTooltip,
  BAR_LEFT,
  BAR_RIGHT,
}
