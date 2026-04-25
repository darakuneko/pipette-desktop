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
import { buildBksRateBuckets, type BksRateSummary } from './analyze-error-proxy'
import { formatActiveDuration, formatBucketAxisLabel, formatHourLabel } from './analyze-format'
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
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme'
import { chartSeriesColor } from '../../utils/chart-palette'

interface Props {
  uid: string
  range: RangeMs
  /** Multi-select Device filter (capped at MAX_DEVICE_SCOPES = 2).
   * The first scope drives the peak / Bksp summary (those stay
   * primary-only on purpose so a noisy secondary doesn't dilute the
   * cards); when a second scope is present the chart paints a parallel
   * series on top using `chartSeriesColor`. */
  deviceScopes: readonly DeviceScope[]
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

type WpmLineKey = 'wpm' | 'wpmB' | 'bksPercent'

export function WpmChart({ uid, range, deviceScopes, granularity, viewMode, minActiveMs }: Props) {
  const { t } = useTranslation()
  const effectiveTheme = useEffectiveTheme()
  const [rows, setRows] = useState<TypingMinuteStatsRow[]>([])
  const [secondaryRows, setSecondaryRows] = useState<TypingMinuteStatsRow[]>([])
  const [bksRows, setBksRows] = useState<TypingBksMinuteRow[]>([])
  const [peakRecords, setPeakRecords] = useState<PeakRecords | null>(null)
  const [loading, setLoading] = useState(true)
  // Legend toggle state — same pattern the Interval chart uses so the
  // user can dim a line by clicking its legend entry.
  const [hidden, setHidden] = useState<Record<WpmLineKey, boolean>>({ wpm: false, wpmB: false, bksPercent: false })
  const toggleSeries = (key: string): void => {
    if (key === 'wpm' || key === 'wpmB' || key === 'bksPercent') {
      setHidden((prev) => ({ ...prev, [key]: !prev[key] }))
    }
  }

  // First scope drives the chart series, the peak / Bksp summary, and
  // the colour of the cool end of the ramp; the second scope rides
  // alongside as the warm end when present.
  const deviceScope = primaryDeviceScope(deviceScopes)
  const secondaryScope: DeviceScope | undefined = deviceScopes.length > 1 ? deviceScopes[1] : undefined
  const hasSecondary = secondaryScope !== undefined
  // Two-device picks switch the primary off `--color-accent` and onto
  // the cool end of the shared ramp so the comparison reads as A/B
  // rather than "real WPM + extra". One-device picks keep the brand
  // accent so the existing single-series view doesn't suddenly recolour.
  const primarySeriesColor = hasSecondary ? chartSeriesColor(0, 2, effectiveTheme) : 'var(--color-accent)'
  const secondarySeriesColor = chartSeriesColor(1, 2, effectiveTheme)
  // Encode each scope into a stable primitive so effect dependencies
  // don't retrigger on every render when the parent rebuilds the
  // discriminated union object.
  const scopeKey = scopeToSelectValue(deviceScope)
  const secondaryScopeKey = secondaryScope ? scopeToSelectValue(secondaryScope) : null

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const data = isHashScope(deviceScope)
          ? await window.vialAPI.typingAnalyticsListMinuteStatsForHash(uid, deviceScope.machineHash, range.fromMs, range.toMs)
          : isOwnScope(deviceScope)
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
  }, [uid, scopeKey, range])

  // Secondary minute-stats fetch — same scope-branching the primary
  // path uses, gated by `secondaryScopeKey` so a no-op render
  // (deviceScopes unchanged) doesn't refetch. We clear the rows up
  // front so a stale dataset can't linger when the user removes the
  // secondary entry.
  useEffect(() => {
    setSecondaryRows([])
    if (!secondaryScope) return
    let cancelled = false
    const load = async () => {
      try {
        const data = isHashScope(secondaryScope)
          ? await window.vialAPI.typingAnalyticsListMinuteStatsForHash(uid, secondaryScope.machineHash, range.fromMs, range.toMs)
          : isOwnScope(secondaryScope)
            ? await window.vialAPI.typingAnalyticsListMinuteStatsLocal(uid, range.fromMs, range.toMs)
            : await window.vialAPI.typingAnalyticsListMinuteStats(uid, range.fromMs, range.toMs)
        if (!cancelled) setSecondaryRows(data)
      } catch {
        if (!cancelled) setSecondaryRows([])
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, secondaryScopeKey, range, secondaryScope])

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
    const load = async () => {
      try {
        const data = isHashScope(deviceScope)
          ? await window.vialAPI.typingAnalyticsListBksMinuteForHash(uid, deviceScope.machineHash, range.fromMs, range.toMs)
          : isOwnScope(deviceScope)
            ? await window.vialAPI.typingAnalyticsListBksMinuteLocal(uid, range.fromMs, range.toMs)
            : await window.vialAPI.typingAnalyticsListBksMinute(uid, range.fromMs, range.toMs)
        if (!cancelled) setBksRows(data)
      } catch {
        if (!cancelled) setBksRows([])
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, scopeKey, range, errorProxyActive])

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
      ? window.vialAPI.typingAnalyticsGetPeakRecordsForHash(uid, deviceScope.machineHash, range.fromMs, range.toMs)
      : isOwnScope(deviceScope)
        ? window.vialAPI.typingAnalyticsGetPeakRecordsLocal(uid, range.fromMs, range.toMs)
        : window.vialAPI.typingAnalyticsGetPeakRecords(uid, range.fromMs, range.toMs)
    void peakPromise
      .then((r) => { if (!cancelled) setPeakRecords(r) })
      .catch(() => { if (!cancelled) setPeakRecords(null) })
    return () => { cancelled = true }
  }, [uid, scopeKey, range])

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
  // Secondary buckets share the primary's `bucketMs` so the two
  // series align on identical x-axis ticks. `bucketMinuteStats` always
  // covers the full range, so a Map lookup by `bucketStartMs` is
  // lossless.
  const secondaryBuckets = useMemo(
    () => (viewMode === 'timeSeries' && hasSecondary
      ? bucketMinuteStats(secondaryRows, range, bucketMs)
      : null),
    [secondaryRows, range, bucketMs, viewMode, hasSecondary],
  )
  const secondaryWpmByBucket = useMemo(() => {
    const map = new Map<number, number>()
    if (secondaryBuckets === null) return map
    for (const b of secondaryBuckets) {
      map.set(b.bucketStartMs, Math.round(computeWpm(b.keystrokes, b.activeMs) * 10) / 10)
    }
    return map
  }, [secondaryBuckets])
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
          const wpmB = secondaryWpmByBucket.get(b.bucketStartMs)
          return {
            bucketStartMs: b.bucketStartMs,
            wpm: Math.round(computeWpm(b.keystrokes, b.activeMs) * 10) / 10,
            // `null` keeps recharts from drawing a point on either
            // series; the Bksp line uses `connectNulls` to bridge
            // gaps. Secondary line keeps gaps visible (no
            // `connectNulls`) so the user can tell when device B was
            // idle while device A was typing.
            wpmB: wpmB === undefined ? null : wpmB,
            bksPercent: bks === undefined || bks === null
              ? null
              : Math.round(bks * 10) / 10,
          }
        }),
    [buckets, bksByBucket, secondaryWpmByBucket],
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

  // Secondary hour-of-day shares `minActiveMs` with the primary so a
  // bucket that fails to qualify on one device fails on the other —
  // keeps the two bars judged under the same "is this enough typing
  // to matter?" rule.
  const secondaryHourOfDay = useMemo(() => {
    if (viewMode !== 'timeOfDay' || !hasSecondary) return null
    return buildHourOfDayWpm({ rows: secondaryRows, range, minActiveMs })
  }, [secondaryRows, range, minActiveMs, viewMode, hasSecondary])
  const secondaryWpmByHour = useMemo(() => {
    const map = new Map<number, number>()
    if (secondaryHourOfDay === null) return map
    for (const b of secondaryHourOfDay.bins) {
      if (b.qualified) map.set(b.hour, Math.round(b.wpm * 10) / 10)
    }
    return map
  }, [secondaryHourOfDay])

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
      // Secondary value is `null` for hours that don't qualify on
      // device B so recharts skips drawing a zero-height bar that
      // would imply "device B was here, with WPM zero" instead of
      // "device B was idle".
      wpmB: secondaryWpmByHour.get(b.hour) ?? null,
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
                formatter={(value, _name, item) => {
                  if (item?.dataKey === 'wpmB') {
                    return [
                      `${formatWpm(Number(value ?? 0))} WPM`,
                      t('analyze.wpm.secondaryLegend'),
                    ]
                  }
                  const wpm = Number(item?.payload?.wpm ?? 0)
                  const ks = Number(item?.payload?.keystrokes ?? 0)
                  const ms = Number(item?.payload?.activeMs ?? 0)
                  return [
                    `${formatWpm(wpm)} WPM — ${ks.toLocaleString()} ${t('analyze.unit.keys')} / ${formatActiveDuration(ms)}`,
                    t('analyze.wpm.timeOfDay.tooltipLabel'),
                  ]
                }}
              />
              {hasSecondary && <Legend wrapperStyle={{ fontSize: 12 }} />}
              <Bar dataKey="wpm" name={t('analyze.wpm.legend')} isAnimationActive={false}>
                {barData.map((d) => (
                  <Cell
                    key={d.hour}
                    fill={d.qualified ? primarySeriesColor : INACTIVE_BAR_COLOR}
                  />
                ))}
              </Bar>
              {hasSecondary && (
                <Bar
                  dataKey="wpmB"
                  name={t('analyze.wpm.secondaryLegend')}
                  fill={secondarySeriesColor}
                  isAnimationActive={false}
                />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
        {hourOfDayItems !== null && (
          <>
            {hasSecondary && (
              <p
                className="text-[11px] text-content-muted"
                data-testid="analyze-wpm-summary-primary-note"
              >
                {t('analyze.wpm.summaryPrimaryOnly')}
              </p>
            )}
            <AnalyzeStatGrid
              items={hourOfDayItems}
              ariaLabelKey="analyze.wpm.timeOfDay.summary.label"
              testId="analyze-wpm-summary"
            />
          </>
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
              contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-edge)', fontSize: 12 }}
              labelStyle={{ color: 'var(--color-content-secondary)' }}
              itemStyle={{ color: 'var(--color-content)' }}
              labelFormatter={(v: number) => formatBucketAxisLabel(v, bucketMs)}
              formatter={(value, _name, item) => {
                if (item?.dataKey === 'bksPercent') {
                  if (value === null || value === undefined) return ['—', t('analyze.wpm.errorProxy.legend')]
                  const n = typeof value === 'number' ? value : Number(value)
                  return [`${n.toFixed(1)}%`, t('analyze.wpm.errorProxy.legend')]
                }
                if (item?.dataKey === 'wpmB') {
                  if (value === null || value === undefined) return ['—', t('analyze.wpm.secondaryLegend')]
                  return [value as string | number, t('analyze.wpm.secondaryLegend')]
                }
                return [value as string | number, t('analyze.wpm.legend')]
              }}
            />
            <Legend
              wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
              onClick={(entry) => toggleSeries(String(entry.dataKey ?? ''))}
              formatter={(value, entry) => {
                const key = String(entry.dataKey ?? '') as WpmLineKey
                return (
                  <UITooltip
                    content={
                      key === 'bksPercent'
                        ? t('analyze.wpm.errorProxy.description')
                        : key === 'wpmB'
                          ? t('analyze.wpm.secondaryDescription')
                          : t('analyze.wpm.description')
                    }
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
              stroke={primarySeriesColor}
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
              hide={hidden.wpm}
            />
            {hasSecondary && (
              <Line
                yAxisId="wpm"
                type="monotone"
                dataKey="wpmB"
                name={t('analyze.wpm.secondaryLegend')}
                stroke={secondarySeriesColor}
                strokeWidth={2}
                strokeDasharray="5 3"
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                connectNulls={false}
                isAnimationActive={false}
                hide={hidden.wpmB}
              />
            )}
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
        <>
          {hasSecondary && (
            <p
              className="text-[11px] text-content-muted"
              data-testid="analyze-wpm-summary-primary-note"
            >
              {t('analyze.wpm.summaryPrimaryOnly')}
            </p>
          )}
          <AnalyzeStatGrid
            items={timeSeriesItems}
            ariaLabelKey="analyze.wpm.timeSeries.summary.label"
            testId="analyze-wpm-summary"
          />
        </>
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
