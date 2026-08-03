// SPDX-License-Identifier: GPL-2.0-or-later

import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { formatDate, formatDateShort } from '../components/editors/store-modal-shared'
import { ANALYZE_TOOLTIP_DEFAULTS, boldValue } from '../components/analyze/analyze-tooltip'
import { CHART_TICK_FONT_SIZE } from '../utils/chart-palette'

interface Props {
  /** Results in any order (sorted ascending by date here, mirroring
   *  AccuracyTrendChart) so the trend reads oldest-to-newest left to right. */
  results: TypingTestResult[]
}

interface WpmPoint {
  timestampMs: number
  wpm: number
}

function WpmTrendChartInner({ results }: Props) {
  const { t } = useTranslation()

  const data = useMemo<WpmPoint[]>(
    () => results
      .map((r) => ({ timestampMs: new Date(r.date).getTime(), wpm: r.wpm }))
      .sort((a, b) => a.timestampMs - b.timestampMs),
    [results],
  )

  // Mirrors AccuracyTrendChart: a trend line needs at least 2 points.
  if (data.length < 2) return null

  return (
    // The `[&_*]:focus:outline-none` pair suppresses the browser's default
    // focus ring that recharts v3's `accessibilityLayer` (on by default)
    // draws on the chart surface once it's focused via click/tab — same
    // fix AnalyzePane.tsx already applies to its own chart wrapper, so a
    // trend chart living outside that container doesn't regress the same way.
    <div className="h-32 w-full [&_*]:focus:outline-none [&_*]:focus-visible:outline-none" data-testid="wpm-trend-chart">
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
            tick={{ fontSize: CHART_TICK_FONT_SIZE, fill: 'var(--color-content-muted)' }}
            stroke="var(--color-edge)"
            width={40}
          />
          <Tooltip
            {...ANALYZE_TOOLTIP_DEFAULTS}
            labelFormatter={(v) => formatDate(v as number)}
            formatter={(value) => [boldValue(String(value)), t('editor.typingTest.wpm')]}
          />
          <Line
            type="monotone"
            dataKey="wpm"
            name={t('editor.typingTest.wpm')}
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

export const WpmTrendChart = memo(WpmTrendChartInner)
