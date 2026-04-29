// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Interval — keystroke-interval rhythm view. Two modes:
//
//  - `timeSeries`: fetches minute-raw rows, buckets them on the client,
//    and plots min / p25 / p50 / p75 / max on a logarithmic ms axis so
//    sub-hour ranges can zoom in while multi-day ranges stay readable.
//    Clicking a legend entry toggles that line.
//
//  - `distribution`: treats each minute as four samples at (min, p25,
//    p50, p75) with weight `keystrokes / 4` and rolls them into an
//    interval histogram. See analyze-histogram.ts for the rationale
//    (max is excluded — it picks up idle outliers and is surfaced
//    separately as "longest pause" in the summary line).

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { PeakRecords, TypingMinuteStatsRow } from '../../../shared/types/typing-analytics'
import { isHashScope, isOwnScope, primaryDeviceScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type { DeviceScope, GranularityChoice, IntervalUnit, IntervalViewMode, RangeMs } from './analyze-types'
import { bucketMinuteStats, pickBucketMs } from './analyze-bucket'
import { listMinuteStatsForScope } from './analyze-fetch'
import { formatBucketAxisLabel, formatSharePercent } from './analyze-format'
import { ANALYZE_TOOLTIP_DEFAULTS, boldValue } from './analyze-tooltip'
import { formatDateTime } from '../editors/store-modal-shared'
import {
  buildIntervalHistogram,
  buildIntervalTimeSeriesSummary,
  type IntervalRhythmSummary,
  type IntervalTimeSeriesSummary,
  type RhythmBandId,
} from './analyze-histogram'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { AnalyzeStatGrid } from './stat-card'
import { Tooltip as UITooltip } from '../ui/Tooltip'

interface Props {
  uid: string
  range: RangeMs
  /** Device filter (capped at MAX_DEVICE_SCOPES = 1). The single scope
   * drives the full quartile band. `distribution` mode forces `'own'`
   * regardless of the outer scope (the cross-scope `all` query already
   * pre-aggregates quartiles, so redistributing those meta-aggregates
   * as "four samples per minute" would muddy the histogram). */
  deviceScopes: readonly DeviceScope[]
  /** App filter — see WpmChart.Props.appScopes. */
  appScopes: string[]
  unit: IntervalUnit
  granularity: GranularityChoice
  viewMode: IntervalViewMode
}

const SERIES_KEYS = ['min', 'p25', 'p50', 'p75', 'max'] as const
type SeriesKey = (typeof SERIES_KEYS)[number]

// Five clearly distinct hues so the min/max whiskers don't fight the
// central tendency lines visually. All series are drawn solid — the
// old dashed whiskers were hard to tell apart at a glance.
const SERIES_STYLE: Record<SeriesKey, string> = {
  min: '#10b981',
  p25: '#06b6d4',
  p50: '#3b82f6',
  p75: '#f59e0b',
  max: '#ef4444',
}

// Band palette blended from the timeSeries quartile colours so the
// histogram stays visually related to the line chart.
const RHYTHM_BAND_COLORS: Record<RhythmBandId, string> = {
  fast: '#10b981',
  normal: '#3b82f6',
  slow: '#f59e0b',
  pause: '#ef4444',
}

function formatIntervalValue(ms: number, unit: IntervalUnit): string {
  if (!Number.isFinite(ms)) return '—'
  if (unit === 'sec') {
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${(ms / 1000).toFixed(3)} s`
  }
  return `${Math.round(ms)} ms`
}

function formatShare(v: number): string {
  if (!Number.isFinite(v)) return '—'
  return `${formatSharePercent(v)}%`
}

export function IntervalChart({ uid, range, deviceScopes, appScopes, unit, granularity, viewMode }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TypingMinuteStatsRow[]>([])
  const [peakRecords, setPeakRecords] = useState<PeakRecords | null>(null)
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState<Record<SeriesKey, boolean>>({
    min: false, p25: false, p50: false, p75: false, max: false,
  })

  const deviceScope = primaryDeviceScope(deviceScopes)

  // Distribution mode needs per-scope raw quartiles — the cross-scope
  // `all` query already aggregates MIN / AVG / MAX over contributing
  // scopes, so redistributing those meta-aggregates as "four samples
  // per minute" would muddy the histogram. Force `own` for distribution
  // regardless of the outer scope (including per-hash selections) and
  // hide the device filter at the parent when the user picks
  // Distribution.
  const effectiveDeviceScope: DeviceScope = viewMode === 'distribution' ? 'own' : deviceScope
  const scopeKey = scopeToSelectValue(effectiveDeviceScope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    listMinuteStatsForScope(uid, effectiveDeviceScope, range.fromMs, range.toMs, appScopes)
      .then((data) => { if (!cancelled) setRows(data) })
      .catch(() => { if (!cancelled) setRows([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // `scopeKey` encodes `effectiveDeviceScope` identity; including the
    // object would refetch every parent rerender.
  }, [uid, scopeKey, range, appScopes])

  // Longest session comes from a narrow aggregation IPC rather than
  // the minute-stats rows so it surfaces the run that straddles bucket
  // boundaries. Displayed alongside the interval summary below.
  useEffect(() => {
    if (!uid) {
      setPeakRecords(null)
      return
    }
    let cancelled = false
    const peakPromise = isHashScope(effectiveDeviceScope)
      ? window.vialAPI.typingAnalyticsGetPeakRecordsForHash(uid, effectiveDeviceScope.machineHash, range.fromMs, range.toMs, appScopes)
      : isOwnScope(effectiveDeviceScope)
        ? window.vialAPI.typingAnalyticsGetPeakRecordsLocal(uid, range.fromMs, range.toMs, appScopes)
        : window.vialAPI.typingAnalyticsGetPeakRecords(uid, range.fromMs, range.toMs, appScopes)
    void peakPromise
      .then((r) => { if (!cancelled) setPeakRecords(r) })
      .catch(() => { if (!cancelled) setPeakRecords(null) })
    return () => { cancelled = true }
  }, [uid, scopeKey, range, appScopes])

  // Log-axis can't plot 0 ms, but min often legitimately rounds to 0
  // on fast adjacent keystrokes. Clamp the axis floor at 1 ms so the
  // Min line still shows up at the bottom edge instead of vanishing.
  const clampForLog = (v: number | null): number | null =>
    v === null ? null : Math.max(1, Math.round(v))

  const bucketMs = useMemo(
    () => (granularity === 'auto' ? pickBucketMs(range) : granularity),
    [range, granularity],
  )
  const chartData = useMemo(() => {
    if (viewMode !== 'timeSeries') return []
    return bucketMinuteStats(rows, range, bucketMs).map((b) => ({
      bucketStartMs: b.bucketStartMs,
      min: clampForLog(b.intervalMinMs),
      p25: clampForLog(b.intervalP25Ms),
      p50: clampForLog(b.intervalP50Ms),
      p75: clampForLog(b.intervalP75Ms),
      max: clampForLog(b.intervalMaxMs),
    }))
  }, [rows, range, bucketMs, viewMode])

  const histogram = useMemo(
    () => (viewMode === 'distribution' ? buildIntervalHistogram(rows, range) : null),
    [rows, range, viewMode],
  )
  const timeSeriesSummary = useMemo(
    () => (viewMode === 'timeSeries' ? buildIntervalTimeSeriesSummary(rows, range) : null),
    [rows, range, viewMode],
  )
  // Keep `weight` as the raw float so bar heights stay proportional to
  // the precomputed shares; rounding is applied only for the tooltip
  // display below. Otherwise sub-0.5 bins snap to zero and the bar /
  // share pair disagree.
  const distributionData = useMemo(() => {
    if (histogram === null) return []
    return histogram.bins.map((b) => ({
      id: b.id,
      label: t(`analyze.interval.bin.${b.id}`),
      weight: b.weight,
      share: b.share,
      band: b.band,
    }))
  }, [histogram, t])
  const distributionItems = useMemo(
    () => (histogram === null ? null : toDistributionItems(histogram.summary, unit, peakRecords)),
    [histogram, unit, peakRecords],
  )
  const timeSeriesItems = useMemo(
    () => (timeSeriesSummary === null ? null : toTimeSeriesItems(timeSeriesSummary, unit, peakRecords)),
    [timeSeriesSummary, unit, peakRecords],
  )

  const toggleSeries = (key: string): void => {
    if ((SERIES_KEYS as readonly string[]).includes(key)) {
      setHidden((prev) => ({ ...prev, [key as SeriesKey]: !prev[key as SeriesKey] }))
    }
  }

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-interval-loading">
        {t('common.loading')}
      </div>
    )
  }

  if (viewMode === 'distribution') {
    if (histogram === null || histogram.totalWeight <= 0) {
      return (
        <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-interval-empty">
          {t('analyze.noData')}
        </div>
      )
    }
    return (
      <div className="flex h-full w-full flex-col gap-2" data-testid="analyze-interval-distribution">
        <div className="flex-1 min-h-0">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={distributionData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
                stroke="var(--color-edge)"
                interval={0}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
                stroke="var(--color-edge)"
                tickFormatter={(v: number) => Math.round(v).toLocaleString()}
              />
              <Tooltip
                {...ANALYZE_TOOLTIP_DEFAULTS}
                formatter={(_, __, entry) => {
                  const w = Number(entry?.payload?.weight ?? 0)
                  const s = Number(entry?.payload?.share ?? 0)
                  return [
                    boldValue(`${Math.round(w).toLocaleString()} (${formatShare(s)})`),
                    t('analyze.interval.distribution.tooltipLabel'),
                  ]
                }}
              />
              <Bar dataKey="weight" isAnimationActive={false}>
                {distributionData.map((d) => (
                  <Cell key={d.id} fill={RHYTHM_BAND_COLORS[d.band]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        {distributionItems !== null && (
          <AnalyzeStatGrid
            items={distributionItems}
            ariaLabelKey="analyze.interval.distribution.summary.label"
          />
        )}
      </div>
    )
  }

  if (chartData.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-interval-empty">
        {t('analyze.noData')}
      </div>
    )
  }

  return (
    <div className="flex h-full w-full flex-col gap-2" data-testid="analyze-interval-chart">
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
          <YAxis
            scale="log"
            domain={['auto', 'auto']}
            allowDataOverflow={false}
            tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
            stroke="var(--color-edge)"
            tickFormatter={(v: number) => unit === 'sec' ? (v / 1000).toString() : v.toString()}
            label={{
              value: unit === 'sec' ? 'sec (log)' : 'ms (log)',
              angle: -90,
              position: 'insideLeft',
              style: { fontSize: 11, fill: 'var(--color-content-muted)' },
            }}
          />
          <Tooltip
            {...ANALYZE_TOOLTIP_DEFAULTS}
            labelFormatter={(v: number) => formatBucketAxisLabel(v, bucketMs)}
            formatter={(value) => {
              const n = typeof value === 'number' ? value : Number(value)
              if (!Number.isFinite(n)) return boldValue(String(value))
              return boldValue(unit === 'sec' ? `${(n / 1000).toFixed(3)} s` : `${n} ms`)
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
            onClick={(entry) => toggleSeries(String(entry.dataKey ?? ''))}
            formatter={(value, entry) => {
              const key = String(entry.dataKey ?? '') as SeriesKey
              const description = t(`analyze.interval.description.${key}`, { defaultValue: '' })
              return (
                <UITooltip
                  content={description}
                  disabled={!description}
                  wrapperAs="span"
                  bubbleAs="span"
                  wrapperClassName="inline-flex items-center gap-0.5"
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
          {SERIES_KEYS.map((key) => (
            <Line
              key={key}
              type="monotone"
              dataKey={key}
              stroke={SERIES_STYLE[key]}
              strokeWidth={key === 'p50' ? 2 : 1.5}
              dot={key === 'p50' ? { r: 2 } : false}
              name={t(`analyze.interval.legend.${key}`)}
              hide={hidden[key]}
              connectNulls
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
      </div>
      {timeSeriesItems !== null && (
        <AnalyzeStatGrid
          items={timeSeriesItems}
          ariaLabelKey="analyze.interval.timeSeries.summary.label"
        />
      )}
    </div>
  )
}

function longestSessionItem(peaks: PeakRecords | null): AnalyzeSummaryItem {
  return {
    labelKey: 'analyze.peak.longestSession',
    descriptionKey: 'analyze.peak.longestSessionDesc',
    value: peaks?.longestSession ? String(Math.round(peaks.longestSession.durationMs / 60000)) : '—',
    context: peaks?.longestSession ? formatDateTime(peaks.longestSession.startedAtMs) : undefined,
  }
}

function toDistributionItems(
  summary: IntervalRhythmSummary,
  unit: IntervalUnit,
  peaks: PeakRecords | null,
): AnalyzeSummaryItem[] {
  return [
    {
      labelKey: 'analyze.interval.distribution.summary.medianP50',
      value: summary.weightedMedianP50Ms === null ? '—' : formatIntervalValue(summary.weightedMedianP50Ms, unit),
    },
    {
      labelKey: 'analyze.interval.distribution.summary.fast',
      descriptionKey: 'analyze.interval.distribution.summary.fastDesc',
      value: formatShare(summary.fastShare),
    },
    {
      labelKey: 'analyze.interval.distribution.summary.normal',
      descriptionKey: 'analyze.interval.distribution.summary.normalDesc',
      value: formatShare(summary.normalShare),
    },
    {
      labelKey: 'analyze.interval.distribution.summary.slow',
      descriptionKey: 'analyze.interval.distribution.summary.slowDesc',
      value: formatShare(summary.slowShare),
    },
    {
      labelKey: 'analyze.interval.distribution.summary.pause',
      descriptionKey: 'analyze.interval.distribution.summary.pauseDesc',
      value: formatShare(summary.pauseShare),
    },
    {
      labelKey: 'analyze.interval.distribution.summary.longestPause',
      value: summary.longestPauseMs === null ? '—' : formatIntervalValue(summary.longestPauseMs, unit),
    },
    longestSessionItem(peaks),
  ]
}

function toTimeSeriesItems(
  summary: IntervalTimeSeriesSummary,
  unit: IntervalUnit,
  peaks: PeakRecords | null,
): AnalyzeSummaryItem[] {
  return [
    {
      labelKey: 'analyze.interval.timeSeries.summary.medianP50',
      value: summary.weightedMedianP50Ms === null ? '—' : formatIntervalValue(summary.weightedMedianP50Ms, unit),
    },
    {
      labelKey: 'analyze.interval.timeSeries.summary.shortest',
      value: summary.shortestIntervalMs === null ? '—' : formatIntervalValue(summary.shortestIntervalMs, unit),
    },
    {
      labelKey: 'analyze.interval.timeSeries.summary.longestPause',
      value: summary.longestPauseMs === null ? '—' : formatIntervalValue(summary.longestPauseMs, unit),
    },
    longestSessionItem(peaks),
  ]
}
