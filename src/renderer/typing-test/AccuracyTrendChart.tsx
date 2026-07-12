// SPDX-License-Identifier: GPL-2.0-or-later

import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { formatDate, formatDateShort } from '../components/editors/store-modal-shared'
import { ANALYZE_TOOLTIP_DEFAULTS, boldValue } from '../components/analyze/analyze-tooltip'
import { CHART_TICK_FONT_SIZE } from '../utils/chart-palette'

interface Props {
  /** Results sharing a single test condition (already filtered by the
   *  caller), in any order — sorted ascending by date here so the
   *  trend reads oldest-to-newest left to right. */
  results: TypingTestResult[]
}

interface AccuracyPoint {
  timestampMs: number
  accuracy: number
}

// Round the y-axis floor down to this step so it lands on a tidy tick
// instead of the exact minimum accuracy.
const Y_AXIS_FLOOR_STEP = 5

function AccuracyTrendChartInner({ results }: Props) {
  const { t } = useTranslation()

  const { data, yMin } = useMemo(() => {
    const points: AccuracyPoint[] = results
      .map((r) => ({ timestampMs: new Date(r.date).getTime(), accuracy: r.accuracy }))
      .sort((a, b) => a.timestampMs - b.timestampMs)
    const minAccuracy = points.length > 0 ? Math.min(...points.map((d) => d.accuracy)) : 0
    return { data: points, yMin: Math.max(0, Math.floor(minAccuracy / Y_AXIS_FLOOR_STEP) * Y_AXIS_FLOOR_STEP) }
  }, [results])

  // Mirrors WpmSparkline: a trend line needs at least 2 points.
  if (data.length < 2) return null

  return (
    <div className="h-40 w-full" data-testid="accuracy-trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 10, right: 20, bottom: 0, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
          <XAxis
            dataKey="timestampMs"
            type="number"
            domain={['dataMin', 'dataMax']}
            tick={{ fontSize: CHART_TICK_FONT_SIZE, fill: 'var(--color-content-muted)' }}
            stroke="var(--color-edge)"
            tickFormatter={(v: number) => formatDateShort(v)}
          />
          <YAxis
            domain={[yMin, 100]}
            tick={{ fontSize: CHART_TICK_FONT_SIZE, fill: 'var(--color-content-muted)' }}
            stroke="var(--color-edge)"
            tickFormatter={(v: number) => `${v}%`}
            width={40}
          />
          <Tooltip
            {...ANALYZE_TOOLTIP_DEFAULTS}
            labelFormatter={(v: number) => formatDate(v)}
            formatter={(value) => [boldValue(`${String(value)}%`), t('editor.typingTest.accuracy')]}
          />
          <Line
            type="monotone"
            dataKey="accuracy"
            name={t('editor.typingTest.accuracy')}
            stroke="var(--color-accent)"
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export const AccuracyTrendChart = memo(AccuracyTrendChartInner)
