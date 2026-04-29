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
import type {
  PeakRecords,
  TypingBksMinuteRow,
  TypingMinuteStatsRow,
} from '../../../shared/types/typing-analytics'
import { formatDateTime } from '../editors/store-modal-shared'
import { isHashScope, isOwnScope, primaryDeviceScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type { DeviceScope, GranularityChoice, RangeMs, WpmViewMode } from './analyze-types'
import { bucketMinuteStats, pickBucketMs } from './analyze-bucket'
import { listBksMinuteForScope, listMinuteStatsForScope } from './analyze-fetch'
import { buildBksRateBuckets, type BksRateSummary } from './analyze-error-proxy'
import { formatActiveDuration, formatBucketAxisLabel, formatHourLabel } from './analyze-format'
import { ANALYZE_TOOLTIP_DEFAULTS, boldValue } from './analyze-tooltip'
import {
  buildHourOfDayWpm,
  buildWpmTimeSeriesSummaryFromBuckets,
  computeWpm,
  formatWpm,
  type HourOfDayWpmSummary,
  type WpmTimeSeriesSummary,
} from './analyze-wpm'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { AnalyzeStatGrid } from './stat-card'
import { Tooltip as UITooltip } from '../ui/Tooltip'

interface Props {
  uid: string
  range: RangeMs
  /** Single-entry Device filter (own / all / one remote hash). */
  deviceScopes: readonly DeviceScope[]
  /** Restrict the data to minutes whose tagged app matches one of
   * these names. Empty array = no app filter (all minutes including
   * mixed/unknown). */
  appScopes: string[]
  granularity: GranularityChoice
  viewMode: WpmViewMode
  /** Minimum `activeMs` (ms) a bucket / hour must clear to count
   * toward peak / lowest / weighted-median WPM. Does not gate the
   * chart itself — every bucket is still plotted. */
  minActiveMs: number
}

const ERROR_PROXY_COLOR = '#ef4444'

const INACTIVE_BAR_COLOR = 'var(--color-surface-dim)'

function formatHourWithWpm(hour: number, wpm: number): string {
  return `${formatHourLabel(hour)} (${formatWpm(wpm)} WPM)`
}

type WpmLineKey = 'wpm' | 'bksPercent'

export function WpmChart({ uid, range, deviceScopes, appScopes, granularity, viewMode, minActiveMs }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TypingMinuteStatsRow[]>([])
  const [bksRows, setBksRows] = useState<TypingBksMinuteRow[]>([])
  const [peakRecords, setPeakRecords] = useState<PeakRecords | null>(null)
  const [loading, setLoading] = useState(true)
  // Legend toggle state — same pattern the Interval chart uses so the
  // user can dim a line by clicking its legend entry.
  const [hidden, setHidden] = useState<Record<WpmLineKey, boolean>>({
    wpm: false, bksPercent: false,
  })
  const toggleSeries = (key: string): void => {
    if (key === 'wpm' || key === 'bksPercent') {
      setHidden((prev) => ({ ...prev, [key]: !prev[key] }))
    }
  }

  const deviceScope = primaryDeviceScope(deviceScopes)
  // Encode the scope into a stable primitive so effect dependencies
  // don't retrigger on every render when the parent rebuilds the
  // discriminated union object.
  const scopeKey = scopeToSelectValue(deviceScope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listMinuteStatsForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes)
      .then((data) => { if (!cancelled) setRows(data) })
      .catch(() => { if (!cancelled) setRows([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // `scopeKey` is the canonical identity for `deviceScope`.
  }, [uid, scopeKey, range, appScopes])

  // The Bksp% overlay is always available in timeSeries mode; users
  // who don't want it click the legend to hide the line instead of
  // toggling a separate filter.
  const errorProxyActive = viewMode === 'timeSeries'
  useEffect(() => {
    if (!errorProxyActive) {
      setBksRows([])
      return
    }
    let cancelled = false
    listBksMinuteForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes)
      .then((data) => { if (!cancelled) setBksRows(data) })
      .catch(() => { if (!cancelled) setBksRows([]) })
    return () => { cancelled = true }
  }, [uid, scopeKey, range, errorProxyActive, appScopes])

  // Peak / lowest WPM come from a narrow aggregation IPC rather than
  // the timeseries rows so they reflect the entire range (including
  // minutes the bucket granularity may collapse away). The summary
  // below surfaces them as time-stamped cards.
  useEffect(() => {
    if (!uid) {
      setPeakRecords(null)
      return
    }
    let cancelled = false
    const peakPromise = isHashScope(deviceScope)
      ? window.vialAPI.typingAnalyticsGetPeakRecordsForHash(uid, deviceScope.machineHash, range.fromMs, range.toMs, appScopes)
      : isOwnScope(deviceScope)
        ? window.vialAPI.typingAnalyticsGetPeakRecordsLocal(uid, range.fromMs, range.toMs, appScopes)
        : window.vialAPI.typingAnalyticsGetPeakRecords(uid, range.fromMs, range.toMs, appScopes)
    void peakPromise
      .then((r) => { if (!cancelled) setPeakRecords(r) })
      .catch(() => { if (!cancelled) setPeakRecords(null) })
    return () => { cancelled = true }
  }, [uid, scopeKey, range, appScopes])

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
  const bksRate = useMemo(
    () => (errorProxyActive
      ? buildBksRateBuckets({ bksRows, minuteRows: rows, range, bucketMs })
      : null),
    [errorProxyActive, bksRows, rows, range, bucketMs],
  )
  const bksByBucket = useMemo(() => {
    const map = new Map<number, number | null>()
    if (bksRate === null) return map
    for (const b of bksRate.buckets) map.set(b.bucketStartMs, b.bksPercent)
    return map
  }, [bksRate])

  const chartData = useMemo(
    () => buckets === null
      ? []
      : buckets.map((b) => {
          const bks = bksByBucket.get(b.bucketStartMs)
          return {
            bucketStartMs: b.bucketStartMs,
            wpm: Math.round(computeWpm(b.keystrokes, b.activeMs) * 10) / 10,
            bksPercent: bks === undefined || bks === null
              ? null
              : Math.round(bks * 10) / 10,
          }
        }),
    [buckets, bksByBucket],
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
    return toTimeSeriesItems(timeSeriesSummary, errorProxyActive ? bksRate?.summary ?? null : null, peakRecords)
  }, [timeSeriesSummary, errorProxyActive, bksRate, peakRecords])

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
      label: formatHourLabel(b.hour),
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
                {...ANALYZE_TOOLTIP_DEFAULTS}
                formatter={(_value, _name, item) => {
                  const wpm = Number(item?.payload?.wpm ?? 0)
                  const ks = Number(item?.payload?.keystrokes ?? 0)
                  const ms = Number(item?.payload?.activeMs ?? 0)
                  return [
                    boldValue(`${formatWpm(wpm)} WPM — ${ks.toLocaleString()} ${t('analyze.unit.keys')} / ${formatActiveDuration(ms)}`),
                    t('analyze.wpm.timeOfDay.tooltipLabel'),
                  ]
                }}
              />
              <Bar dataKey="wpm" name={t('analyze.wpm.legend')} isAnimationActive={false}>
                {barData.map((d) => (
                  <Cell
                    key={d.hour}
                    fill={d.qualified ? 'var(--color-accent)' : INACTIVE_BAR_COLOR}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {hourOfDayItems !== null && (
          <AnalyzeStatGrid
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
            <YAxis yAxisId="wpm" tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }} stroke="var(--color-edge)" allowDecimals />
            {errorProxyActive && (
              <YAxis
                yAxisId="bks"
                orientation="right"
                domain={[0, 'auto']}
                tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
                stroke="var(--color-edge)"
                tickFormatter={(v: number) => `${v}%`}
                width={40}
              />
            )}
            <Tooltip
              {...ANALYZE_TOOLTIP_DEFAULTS}
              labelFormatter={(v: number) => formatBucketAxisLabel(v, bucketMs)}
              formatter={(value, _name, item) => {
                if (item?.dataKey === 'bksPercent') {
                  if (value === null || value === undefined) return [boldValue('—'), t('analyze.wpm.errorProxy.legend')]
                  const n = typeof value === 'number' ? value : Number(value)
                  return [boldValue(`${n.toFixed(1)}%`), t('analyze.wpm.errorProxy.legend')]
                }
                return [boldValue(value as string | number), t('analyze.wpm.legend')]
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
              onClick={(entry) => toggleSeries(String(entry.dataKey ?? ''))}
              formatter={(value, entry) => {
                const key = String(entry.dataKey ?? '') as WpmLineKey
                const description = key === 'bksPercent'
                  ? t('analyze.wpm.errorProxy.description')
                  : key === 'wpm'
                    ? t('analyze.wpm.description')
                    : ''
                return (
                  <UITooltip
                    content={description}
                    disabled={!description}
                    wrapperAs="span"
                    bubbleAs="span"
                  >
                    <span
                      style={{ color: hidden[key] ? 'var(--color-content-muted)' : 'var(--color-content)' }}
                    >
                      {value}
                    </span>
                  </UITooltip>
                )
              }}
            />
            <Line
              yAxisId="wpm"
              type="monotone"
              dataKey="wpm"
              name={t('analyze.wpm.legend')}
              stroke="var(--color-accent)"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
              hide={hidden.wpm}
            />
            {errorProxyActive && (
              <Line
                yAxisId="bks"
                type="monotone"
                dataKey="bksPercent"
                name={t('analyze.wpm.errorProxy.legend')}
                stroke={ERROR_PROXY_COLOR}
                strokeWidth={1.5}
                strokeDasharray="4 3"
                dot={false}
                connectNulls
                activeDot={{ r: 4 }}
                isAnimationActive={false}
                hide={hidden.bksPercent}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {timeSeriesItems !== null && (
        <AnalyzeStatGrid
          items={timeSeriesItems}
          ariaLabelKey="analyze.wpm.timeSeries.summary.label"
          testId="analyze-wpm-summary"
        />
      )}
    </div>
  )
}

function toTimeSeriesItems(
  summary: WpmTimeSeriesSummary,
  bks: BksRateSummary | null,
  peaks: PeakRecords | null,
): AnalyzeSummaryItem[] {
  const items: AnalyzeSummaryItem[] = [
    {
      labelKey: 'analyze.wpm.timeSeries.summary.peakWpm',
      value: peaks?.peakWpm ? formatWpm(peaks.peakWpm.value) : '—',
      context: peaks?.peakWpm ? formatDateTime(peaks.peakWpm.atMs) : undefined,
    },
    {
      labelKey: 'analyze.wpm.timeSeries.summary.lowestWpm',
      value: peaks?.lowestWpm ? formatWpm(peaks.lowestWpm.value) : '—',
      context: peaks?.lowestWpm ? formatDateTime(peaks.lowestWpm.atMs) : undefined,
    },
    {
      labelKey: 'analyze.wpm.timeSeries.summary.overallWpm',
      value: formatWpm(summary.overallWpm),
    },
    {
      labelKey: 'analyze.wpm.timeSeries.summary.weightedMedianWpm',
      value: summary.weightedMedianWpm === null ? '—' : formatWpm(summary.weightedMedianWpm),
    },
    // Row break at 4-column grid — everything below is keystroke volume.
    {
      labelKey: 'analyze.wpm.timeSeries.summary.totalKeystrokes',
      value: summary.totalKeystrokes.toLocaleString(),
    },
    {
      labelKey: 'analyze.wpm.timeSeries.summary.activeDuration',
      value: formatActiveDuration(summary.activeMs),
    },
    {
      labelKey: 'analyze.peak.peakKeystrokesPerMin',
      value: peaks?.peakKeystrokesPerMin ? peaks.peakKeystrokesPerMin.value.toLocaleString() : '—',
      context: peaks?.peakKeystrokesPerMin ? formatDateTime(peaks.peakKeystrokesPerMin.atMs) : undefined,
    },
    {
      labelKey: 'analyze.peak.peakKeystrokesPerDay',
      value: peaks?.peakKeystrokesPerDay ? peaks.peakKeystrokesPerDay.value.toLocaleString() : '—',
      context: peaks?.peakKeystrokesPerDay ? peaks.peakKeystrokesPerDay.day : undefined,
    },
  ]
  if (bks !== null) {
    items.push(
      {
        labelKey: 'analyze.wpm.timeSeries.summary.totalBackspaces',
        value: bks.totalBackspaces.toLocaleString(),
      },
      {
        labelKey: 'analyze.wpm.timeSeries.summary.overallBksPercent',
        descriptionKey: 'analyze.wpm.timeSeries.summary.overallBksPercentDesc',
        value: bks.overallBksPercent === null ? '—' : `${bks.overallBksPercent.toFixed(1)}%`,
      },
    )
  }
  return items
}

function toHourOfDayItems(summary: HourOfDayWpmSummary): AnalyzeSummaryItem[] {
  return [
    {
      labelKey: 'analyze.wpm.timeOfDay.summary.totalKeystrokes',
      value: summary.totalKeystrokes.toLocaleString(),
    },
    {
      labelKey: 'analyze.wpm.timeOfDay.summary.activeDuration',
      value: formatActiveDuration(summary.activeMs),
    },
    {
      labelKey: 'analyze.wpm.timeOfDay.summary.overallWpm',
      value: formatWpm(summary.overallWpm),
    },
    {
      labelKey: 'analyze.wpm.timeOfDay.summary.peakHour',
      descriptionKey: 'analyze.wpm.timeOfDay.summary.peakHourDesc',
      value: summary.peakHour === null ? '—' : formatHourWithWpm(summary.peakHour.hour, summary.peakHour.wpm),
    },
    {
      labelKey: 'analyze.wpm.timeOfDay.summary.lowestHour',
      descriptionKey: 'analyze.wpm.timeOfDay.summary.lowestHourDesc',
      value: summary.lowestHour === null ? '—' : formatHourWithWpm(summary.lowestHour.hour, summary.lowestHour.wpm),
    },
    {
      labelKey: 'analyze.wpm.timeOfDay.summary.activeHours',
      descriptionKey: 'analyze.wpm.timeOfDay.summary.activeHoursDesc',
      value: `${summary.activeHours} / 24`,
    },
  ]
}
