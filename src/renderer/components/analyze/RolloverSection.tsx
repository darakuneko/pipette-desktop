// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Interval > Observed rollover rate — Pipette-only metric
// derived from bigram physical-overlap sampling (see
// .claude/plans/Plan-typing-metrics-chi2018.md Phase 2 and
// bigram-aggregate.ts's `observedRolloverRatio` for the "observed, not
// true" framing this section must never drop). Mounted below
// IntervalChart, only in timeSeries mode — the same gate AnalyzePane
// already applies to the benchmark toggle for that chart.
//
// Deliberately does NOT render benchmarkPosition labels (below/above/
// average): the metric is a structural undercount (see the under-bias
// note below the chart), so a position label implying "you type slow"
// or "you type fast" relative to the population line would misread a
// sampling artifact as a typing-speed signal.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TypingMinuteStatsRow, TypingRolloverMinuteRow } from '../../../shared/types/typing-analytics'
import { BENCHMARK_ROLLOVER_RATIO_PCT } from '../../../shared/typing-benchmarks'
import { benchmarkReferenceLineProps } from './analyze-benchmark'
import { primaryDeviceScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type { DeviceScope, GranularityChoice, RangeMs } from './analyze-types'
import { pickBucketMs } from './analyze-bucket'
import { fetchRolloverMinutesForRange, listMinuteStatsForScope } from './analyze-fetch'
import { bucketRolloverMinutes, effectiveSamplingPeriod, formatRolloverTooltipValue, overallRolloverRatio } from './analyze-rollover'
import { fmtMs, formatBucketAxisLabel, formatPercentLabel } from './analyze-format'
import { ANALYZE_TOOLTIP_DEFAULTS, boldValue } from './analyze-tooltip'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { AnalyzeStatGrid } from './stat-card'
import { CHART_TICK_FONT_SIZE } from '../../utils/chart-palette'

interface Props {
  uid: string
  range: RangeMs
  /** Single-entry Device filter — same convention as WpmChart/IntervalChart. */
  deviceScopes: readonly DeviceScope[]
  appScopes: string[]
  typingTestScopes: string[]
  runIdScopes: string[]
  granularity: GranularityChoice
  /** Same toggle AnalyzePane already threads to IntervalChart — the
   * reference line and the mandatory under-bias note both gate on it. */
  showBenchmark: boolean
}

export function RolloverSection({ uid, range, deviceScopes, appScopes, typingTestScopes, runIdScopes, granularity, showBenchmark }: Props) {
  const { t } = useTranslation()
  const [rolloverRows, setRolloverRows] = useState<TypingRolloverMinuteRow[]>([])
  const [minuteStatsRows, setMinuteStatsRows] = useState<TypingMinuteStatsRow[]>([])
  const [loading, setLoading] = useState(true)

  const deviceScope = primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(deviceScope)

  useEffect(() => {
    if (!uid) {
      setRolloverRows([])
      setMinuteStatsRows([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    // Two independent small fetches instead of threading IntervalChart's
    // minute-stats rows down as a prop — keeps this section's coupling
    // to its sibling at zero (it can be reordered or removed without
    // touching IntervalChart) at the cost of one extra IPC round trip.
    // `allSettled` (not `all` + one shared `.catch`) so the two sources
    // fail independently: `listMinuteStatsForScope` is de-duped and its
    // promise can be literally shared with IntervalChart's own fetch, so
    // a rejection there is out of this section's control and must only
    // degrade the sampling-period caption to "—" — it must never blank
    // the rollover chart/stat, which only depends on the other source.
    Promise.allSettled([
      fetchRolloverMinutesForRange(uid, deviceScope, range.fromMs, range.toMs, appScopes, typingTestScopes, runIdScopes),
      listMinuteStatsForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes, typingTestScopes, runIdScopes),
    ])
      .then(([rolloverResult, minuteStatsResult]) => {
        if (cancelled) return
        setRolloverRows(rolloverResult.status === 'fulfilled' ? rolloverResult.value : [])
        setMinuteStatsRows(minuteStatsResult.status === 'fulfilled' ? minuteStatsResult.value : [])
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // `scopeKey` encodes `deviceScope` identity; the shared-filter
    // reactivity contract requires every filter prop in this array.
  }, [uid, scopeKey, range, appScopes, typingTestScopes, runIdScopes])

  const overallRatio = useMemo(() => overallRolloverRatio(rolloverRows), [rolloverRows])
  const effectivePeriod = useMemo(() => effectiveSamplingPeriod(minuteStatsRows), [minuteStatsRows])

  const bucketMs = useMemo(
    () => (granularity === 'auto' ? pickBucketMs(range) : granularity),
    [range, granularity],
  )
  const buckets = useMemo(
    () => bucketRolloverMinutes(rolloverRows, range, bucketMs),
    [rolloverRows, range, bucketMs],
  )
  // The [0,1] fraction -> percent conversion happens exactly once, here,
  // where the chart series is built — BENCHMARK_ROLLOVER_RATIO_PCT and
  // the Y axis are both already in percent, so every other value on
  // this chart must be too.
  const chartData = useMemo(
    () => buckets.map((b) => ({ bucketStartMs: b.bucketStartMs, ratioPercent: b.ratio === null ? null : b.ratio * 100 })),
    [buckets],
  )

  const statItems: AnalyzeSummaryItem[] = useMemo(() => [
    {
      labelKey: 'analyze.rollover.stat.title',
      value: formatPercentLabel(overallRatio),
      descriptionKey: 'analyze.rollover.stat.description',
      descriptionParams: {
        p50: fmtMs(effectivePeriod.medianP50Ms),
        p95: fmtMs(effectivePeriod.worstP95Ms),
      },
    },
  ], [overallRatio, effectivePeriod])

  if (loading) {
    return (
      <div className="py-4 text-center text-sm text-content-muted" data-testid="analyze-rollover-loading">
        {t('common.loading')}
      </div>
    )
  }

  return (
    <section className="flex flex-col gap-2 border-t border-edge pt-3" data-testid="analyze-rollover-section">
      <h3 className="text-sm font-semibold text-content">{t('analyze.rollover.sectionTitle')}</h3>
      {rolloverRows.length === 0 ? (
        <div className="py-4 text-center text-sm text-content-muted" data-testid="analyze-rollover-empty">
          {t('analyze.noData')}
        </div>
      ) : (
        <>
          <div className="h-64 w-full" data-testid="analyze-rollover-chart">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
                <XAxis
                  dataKey="bucketStartMs"
                  type="number"
                  domain={[range.fromMs, range.toMs]}
                  tick={{ fontSize: CHART_TICK_FONT_SIZE, fill: 'var(--color-content-muted)' }}
                  stroke="var(--color-edge)"
                  tickFormatter={(v: number) => formatBucketAxisLabel(v, bucketMs)}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fontSize: CHART_TICK_FONT_SIZE, fill: 'var(--color-content-muted)' }}
                  stroke="var(--color-edge)"
                  tickFormatter={(v: number) => `${v}%`}
                />
                {showBenchmark && (
                  <ReferenceLine
                    {...benchmarkReferenceLineProps(BENCHMARK_ROLLOVER_RATIO_PCT.mean, t('analyze.benchmark.referenceLineLabel'))}
                  />
                )}
                <Tooltip
                  {...ANALYZE_TOOLTIP_DEFAULTS}
                  labelFormatter={(v) => formatBucketAxisLabel(v as number, bucketMs)}
                  formatter={(value) => [
                    boldValue(formatRolloverTooltipValue(typeof value === 'number' ? value : null)),
                    t('analyze.rollover.chart.legend'),
                  ]}
                />
                <Line
                  type="monotone"
                  dataKey="ratioPercent"
                  name={t('analyze.rollover.chart.legend')}
                  stroke="var(--color-accent)"
                  strokeWidth={2}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {showBenchmark && (
            // Kept directly under the chart (not next to the stat card
            // below) — the note explains how to read the reference line
            // drawn on THIS chart, so it belongs with the chart/
            // reference-line context rather than with the summary number.
            <p className="text-2xs text-content-muted" data-testid="analyze-rollover-under-bias-note">
              {t('analyze.rollover.underBiasNote')}
            </p>
          )}
        </>
      )}
      <AnalyzeStatGrid
        items={statItems}
        ariaLabelKey="analyze.rollover.ariaLabel"
        testId="analyze-rollover-summary"
      />
    </section>
  )
}
