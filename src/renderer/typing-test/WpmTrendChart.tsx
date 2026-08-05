// SPDX-License-Identifier: GPL-2.0-or-later

import { memo } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatDateShort } from '../components/editors/store-modal-shared'
import { ANALYZE_TOOLTIP_DEFAULTS, boldValue } from '../components/analyze/analyze-tooltip'
import { CHART_LEGEND_FONT_SIZE, CHART_TICK_FONT_SIZE, chartSeriesColor } from '../utils/chart-palette'
import { useEffectiveTheme } from '../hooks/useEffectiveTheme'
import type { DailyWpmPoint } from './wpm-daily-trend'

interface Props {
  /** Already grouped one point PER LOCAL CALENDAR DAY (see
   *  aggregateWpmByDay) — the caller owns that aggregation (and the
   *  "enough days to show a trend" decision that comes with it, e.g. the
   *  "WPM Trend" heading's own visibility) since it's also the caller's
   *  gate for whether to render this component at all; computing the same
   *  grouping twice per render (once to decide, once to draw) would be
   *  redundant work over the same input. */
  data: DailyWpmPoint[]
}

// Series count/order is fixed (best/worst/avg), so each line's color is a
// stable index into the shared wide-hue ramp rather than something picked
// per-render — same convention DurationSection/WpmChart use for their own
// chartSeriesColor calls. Best sits at the cool end, Worst at the warm end
// (an arbitrary but fixed anchor — the ramp itself carries no "good/bad"
// meaning), Avg in between.
const SERIES_TOTAL = 3
const BEST_SERIES_INDEX = 0
const AVG_SERIES_INDEX = 1
const WORST_SERIES_INDEX = 2

function WpmTrendChartInner({ data }: Props) {
  const { t } = useTranslation()
  const theme = useEffectiveTheme()

  const bestColor = chartSeriesColor(BEST_SERIES_INDEX, SERIES_TOTAL, theme)
  const worstColor = chartSeriesColor(WORST_SERIES_INDEX, SERIES_TOTAL, theme)
  const avgColor = chartSeriesColor(AVG_SERIES_INDEX, SERIES_TOTAL, theme)

  const bestLabel = t('editor.typingTest.history.trendBest')
  const worstLabel = t('editor.typingTest.history.trendWorst')
  const avgLabel = t('editor.typingTest.history.trendAvg')
  const labelByKey: Record<'best' | 'worst' | 'avg', string> = {
    best: bestLabel, worst: worstLabel, avg: avgLabel,
  }

  // Mirrors the prior per-result chart: a trend line needs at least 2
  // points to read as a trend — here that's 2 distinct days with data, not
  // 2 raw results (a single busy day now collapses to 1 point). Days with
  // no results are simply absent from `data` (aggregateWpmByDay never
  // inserts a null/gap entry for them), so — same as before this rework —
  // the line draws straight through any gap between the two nearest days
  // that DO have data, rather than breaking. That keeps sparse periods
  // (e.g. a "1 Year" window with only a handful of active days) reading as
  // one continuous trend instead of a field of disconnected segments.
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
            dataKey="dayStartMs"
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
            labelFormatter={(v) => formatDateShort(v as number)}
            formatter={(value, _name, item) => [
              boldValue(String(value)),
              labelByKey[item?.dataKey as keyof typeof labelByKey] ?? '',
            ]}
          />
          <Legend wrapperStyle={{ fontSize: CHART_LEGEND_FONT_SIZE }} />
          <Line
            type="monotone"
            dataKey="best"
            name={bestLabel}
            stroke={bestColor}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="worst"
            name={worstLabel}
            stroke={worstColor}
            strokeWidth={2}
            dot={{ r: 3 }}
            activeDot={{ r: 5 }}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="avg"
            name={avgLabel}
            stroke={avgColor}
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
