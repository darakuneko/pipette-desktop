// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > WPM — words-per-minute view. Two modes share the same
// minute-raw fetch and scope filter:
//
//  - `timeSeries`: classic line chart, keystrokes per bucket with the
//    `keystrokes / 5 * 60000 / activeMs` formula applied at render
//    time. Buckets come from `analyze-bucket` so we stay consistent
//    with the Interval tab's granularity switch.
//
//  - `timeOfDay`: 24-bar aggregate — WPM per local hour-of-day across
//    the whole range. Useful for surfacing "what time of day do I
//    type fastest?" without having to eyeball the line chart.
//
// A shared `AnalyzeSummaryTable` row sits below the chart in both
// modes. Peak / lowest figures gate on `minActiveMs` so a 5-second
// burst doesn't hijack the extremes.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TypingMinuteStatsRow } from '../../../shared/types/typing-analytics'
import type { DeviceScope, GranularityChoice, RangeMs, WpmViewMode } from './analyze-types'
import { bucketMinuteStats, pickBucketMs } from './analyze-bucket'
import { formatActiveDuration, formatBucketAxisLabel } from './analyze-format'
import {
  buildHourOfDayWpm,
  buildWpmTimeSeriesSummaryFromBuckets,
  computeWpm,
  formatWpm,
  type HourOfDayWpmSummary,
  type WpmTimeSeriesSummary,
} from './analyze-wpm'
import { AnalyzeSummaryTable, type AnalyzeSummaryItem } from './analyze-summary-table'

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
  granularity: GranularityChoice
  viewMode: WpmViewMode
  /** Minimum `activeMs` (ms) a bucket / hour must clear to count
   * toward peak / lowest / weighted-median WPM. Does not gate the
   * chart itself — every bucket is still plotted. */
  minActiveMs: number
}

const ACTIVE_BAR_COLOR = 'var(--color-accent)'
const INACTIVE_BAR_COLOR = 'var(--color-surface-dim)'

function formatHour(hour: number): string {
  return `${hour.toString().padStart(2, '0')}:00`
}

function formatHourWithWpm(hour: number, wpm: number): string {
  return `${formatHour(hour)} (${formatWpm(wpm)} WPM)`
}

export function WpmChart({ uid, range, deviceScope, granularity, viewMode, minActiveMs }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TypingMinuteStatsRow[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const data = deviceScope === 'own'
          ? await window.vialAPI.typingAnalyticsListMinuteStatsLocal(uid, range.fromMs, range.toMs)
          : await window.vialAPI.typingAnalyticsListMinuteStats(uid, range.fromMs, range.toMs)
        if (!cancelled) setRows(data)
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, deviceScope, range])

  const bucketMs = useMemo(
    () => (granularity === 'auto' ? pickBucketMs(range) : granularity),
    [range, granularity],
  )
  // Share a single bucketing pass between the line chart and the
  // summary aggregator — both derive from the same buckets, so running
  // `bucketMinuteStats` twice is wasted work on every render.
  const buckets = useMemo(
    () => (viewMode === 'timeSeries' ? bucketMinuteStats(rows, range, bucketMs) : null),
    [rows, range, bucketMs, viewMode],
  )
  const chartData = useMemo(
    () => buckets === null
      ? []
      : buckets.map((b) => ({
          bucketStartMs: b.bucketStartMs,
          wpm: Math.round(computeWpm(b.keystrokes, b.activeMs) * 10) / 10,
        })),
    [buckets],
  )

  const timeSeriesSummary = useMemo<WpmTimeSeriesSummary | null>(
    () => buckets === null
      ? null
      : buildWpmTimeSeriesSummaryFromBuckets(buckets, minActiveMs),
    [buckets, minActiveMs],
  )

  const hourOfDay = useMemo(() => {
    if (viewMode !== 'timeOfDay') return null
    return buildHourOfDayWpm({ rows, range, minActiveMs })
  }, [rows, range, minActiveMs, viewMode])

  const timeSeriesItems = useMemo<AnalyzeSummaryItem[] | null>(() => {
    if (timeSeriesSummary === null) return null
    return toTimeSeriesItems(timeSeriesSummary)
  }, [timeSeriesSummary])

  const hourOfDayItems = useMemo<AnalyzeSummaryItem[] | null>(() => {
    if (hourOfDay === null) return null
    return toHourOfDayItems(hourOfDay.summary)
  }, [hourOfDay])

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-wpm-loading">
        {t('common.loading')}
      </div>
    )
  }

  if (viewMode === 'timeOfDay') {
    if (hourOfDay === null || hourOfDay.summary.totalKeystrokes <= 0) {
      return (
        <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-wpm-empty">
          {t('analyze.noData')}
        </div>
      )
    }
    const barData = hourOfDay.bins.map((b) => ({
      hour: b.hour,
      label: formatHour(b.hour),
      wpm: Math.round(b.wpm * 10) / 10,
      keystrokes: b.keystrokes,
      activeMs: b.activeMs,
      qualified: b.qualified,
    }))
    return (
      <div className="flex h-full w-full flex-col gap-2" data-testid="analyze-wpm-time-of-day">
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={barData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
                stroke="var(--color-edge)"
                interval={1}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
                stroke="var(--color-edge)"
                allowDecimals
              />
              <Tooltip
                contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-edge)', fontSize: 12 }}
                labelStyle={{ color: 'var(--color-content-secondary)' }}
                itemStyle={{ color: 'var(--color-content)' }}
                formatter={(_, __, entry) => {
                  const wpm = Number(entry?.payload?.wpm ?? 0)
                  const ks = Number(entry?.payload?.keystrokes ?? 0)
                  const ms = Number(entry?.payload?.activeMs ?? 0)
                  return [
                    `${formatWpm(wpm)} WPM — ${ks.toLocaleString()} keys / ${formatActiveDuration(ms)}`,
                    t('analyze.wpm.timeOfDay.tooltipLabel'),
                  ]
                }}
              />
              <Bar dataKey="wpm" isAnimationActive={false}>
                {barData.map((d) => (
                  <Cell key={d.hour} fill={d.qualified ? ACTIVE_BAR_COLOR : INACTIVE_BAR_COLOR} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {hourOfDayItems !== null && (
          <AnalyzeSummaryTable
            items={hourOfDayItems}
            ariaLabelKey="analyze.wpm.timeOfDay.summary.label"
            testId="analyze-wpm-summary"
          />
        )}
      </div>
    )
  }

  if (chartData.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-wpm-empty">
        {t('analyze.noData')}
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col gap-2" data-testid="analyze-wpm-chart">
      <div className="flex-1 min-h-0">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
            <XAxis
              dataKey="bucketStartMs"
              type="number"
              domain={[range.fromMs, range.toMs]}
              tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
              stroke="var(--color-edge)"
              tickFormatter={(v: number) => formatBucketAxisLabel(v, bucketMs)}
            />
            <YAxis tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }} stroke="var(--color-edge)" allowDecimals />
            <Tooltip
              contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-edge)', fontSize: 12 }}
              labelStyle={{ color: 'var(--color-content-secondary)' }}
              itemStyle={{ color: 'var(--color-content)' }}
              labelFormatter={(v: number) => formatBucketAxisLabel(v, bucketMs)}
            />
            <Legend
              wrapperStyle={{ fontSize: 12 }}
              formatter={(value) => (
                <span title={t('analyze.wpm.description')} style={{ color: 'var(--color-content)' }}>
                  {value}
                </span>
              )}
            />
            <Line
              type="monotone"
              dataKey="wpm"
              name={t('analyze.wpm.legend')}
              stroke="var(--color-accent)"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {timeSeriesItems !== null && (
        <AnalyzeSummaryTable
          items={timeSeriesItems}
          ariaLabelKey="analyze.wpm.timeSeries.summary.label"
          testId="analyze-wpm-summary"
        />
      )}
    </div>
  )
}

function toTimeSeriesItems(summary: WpmTimeSeriesSummary): AnalyzeSummaryItem[] {
  return [
    { labelKey: 'analyze.wpm.timeSeries.summary.totalKeystrokes', value: summary.totalKeystrokes.toLocaleString() },
    { labelKey: 'analyze.wpm.timeSeries.summary.activeDuration', value: formatActiveDuration(summary.activeMs) },
    { labelKey: 'analyze.wpm.timeSeries.summary.overallWpm', value: formatWpm(summary.overallWpm) },
    { labelKey: 'analyze.wpm.timeSeries.summary.peakWpm', value: summary.peakWpm === null ? '—' : formatWpm(summary.peakWpm) },
    { labelKey: 'analyze.wpm.timeSeries.summary.lowestWpm', value: summary.lowestWpm === null ? '—' : formatWpm(summary.lowestWpm) },
    { labelKey: 'analyze.wpm.timeSeries.summary.weightedMedianWpm', value: summary.weightedMedianWpm === null ? '—' : formatWpm(summary.weightedMedianWpm) },
  ]
}

function toHourOfDayItems(summary: HourOfDayWpmSummary): AnalyzeSummaryItem[] {
  return [
    { labelKey: 'analyze.wpm.timeOfDay.summary.totalKeystrokes', value: summary.totalKeystrokes.toLocaleString() },
    { labelKey: 'analyze.wpm.timeOfDay.summary.activeDuration', value: formatActiveDuration(summary.activeMs) },
    { labelKey: 'analyze.wpm.timeOfDay.summary.overallWpm', value: formatWpm(summary.overallWpm) },
    { labelKey: 'analyze.wpm.timeOfDay.summary.peakHour', value: summary.peakHour === null ? '—' : formatHourWithWpm(summary.peakHour.hour, summary.peakHour.wpm) },
    { labelKey: 'analyze.wpm.timeOfDay.summary.lowestHour', value: summary.lowestHour === null ? '—' : formatHourWithWpm(summary.lowestHour.hour, summary.lowestHour.wpm) },
    { labelKey: 'analyze.wpm.timeOfDay.summary.activeHours', value: `${summary.activeHours} / 24` },
  ]
}
