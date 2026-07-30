// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Interval > Keypress duration — Pipette-only metric derived
// from matrix-release duration capture (see
// .claude/plans/Plan-typing-metrics-chi2018.md Phase 2 and
// bigram-bucket.ts's DURATION_BUCKET_* grid, now shared via
// shared/duration-buckets.ts). One of the three panes AnalyzePane's
// "Section" filter-row select picks between (see `DistributionSection`
// in shared/types/analyze-filters.ts), only in `distribution` mode —
// the tighter duration grid pairs with a histogram, not a time series,
// and RolloverSection already owns the timeSeries slot.
//
// Deliberately renders NO reference line on the histogram: the X axis
// is categorical (8 fixed buckets), and a vertical line has no honest
// position on a categorical axis the way it does on IntervalChart's
// continuous ms axis. Instead the mean stat card carries an always-on
// population-average subline (see TypingProfileCard's speed cell for
// the same pattern) — always visible, unlike RolloverSection's
// showBenchmark-gated reference line/note: rollover's under-bias note
// exists because that metric has a structural sampling bias, but
// keypress duration has no such bias, and the CHI 2018 paper's Table 3
// finding that duration barely varies between fast and slow typists is
// itself the point of surfacing this comparison unconditionally.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TypingDurationCell } from '../../../shared/types/typing-analytics'
import { BENCHMARK_KEYPRESS_DURATION_MS } from '../../../shared/typing-benchmarks'
import { benchmarkPosition } from './analyze-benchmark'
import { BenchmarkSubline } from './BenchmarkSubline'
import { sdFromSums } from '../../../shared/stat-sums'
import { DURATION_BUCKET_BIN_IDS, sumDurationTotals } from './analyze-duration'
import { distributionForcesOwnDevice, primaryDeviceScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type { DeviceScope, RangeMs } from './analyze-types'
import { fetchDurationCellsForRange } from './analyze-fetch'
import { fmtMs } from './analyze-format'
import { ANALYZE_TOOLTIP_DEFAULTS, boldValue } from './analyze-tooltip'
import type { AnalyzeSummaryItem } from './analyze-summary-table'
import { AnalyzeStatGrid } from './stat-card'
import { EMPTY_STAT_VALUE } from './analyze-constants'
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme'
import { chartSeriesColor, CHART_TICK_FONT_SIZE } from '../../utils/chart-palette'

interface Props {
  uid: string
  range: RangeMs
  /** Single-entry Device filter — same convention as RolloverSection. */
  deviceScopes: readonly DeviceScope[]
  appScopes: string[]
  typingTestScopes: string[]
  runIdScopes: string[]
}

export function DurationSection({ uid, range, deviceScopes, appScopes, typingTestScopes, runIdScopes }: Props) {
  const { t } = useTranslation()
  const theme = useEffectiveTheme()
  const [cells, setCells] = useState<TypingDurationCell[]>([])
  const [loading, setLoading] = useState(true)

  // Routed through the shared `distributionForcesOwnDevice` predicate
  // (called with the literal 'distribution' mode since this component
  // has no live viewMode to consult — it's only ever mounted below
  // IntervalChart in that view, see the file header) so this section
  // can't drift from IntervalChart's distribution mode, the duration
  // CSV builder, and the filter modal's disabled Device row, all of
  // which force the same 'own' scope for the same anti-meta-aggregate
  // reason.
  const deviceScope: DeviceScope = distributionForcesOwnDevice('distribution')
    ? 'own'
    : primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(deviceScope)

  useEffect(() => {
    if (!uid) {
      setCells([])
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    fetchDurationCellsForRange(uid, deviceScope, range.fromMs, range.toMs, appScopes, typingTestScopes, runIdScopes)
      .then((rows) => { if (!cancelled) setCells(rows) })
      .catch(() => { if (!cancelled) setCells([]) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
    // `scopeKey` encodes `deviceScope` identity; the shared-filter
    // reactivity contract requires every filter prop in this array.
  }, [uid, scopeKey, range, appScopes, typingTestScopes, runIdScopes])

  const totals = useMemo(() => sumDurationTotals(cells), [cells])

  const chartData = useMemo(() => totals.hist.map((count, i) => ({
    index: i,
    label: t(`analyze.duration.bin.${DURATION_BUCKET_BIN_IDS[i]}`),
    count,
  })), [totals, t])

  // Folded into one memo keyed on [totals, t]: `benchmark` is a fresh
  // object from `benchmarkPosition` every time it's computed, so if it
  // stayed a separate per-render `const` (as it did before), the
  // `statItems` memo below would see a new dependency value every
  // render and never actually cache.
  const statItems: AnalyzeSummaryItem[] = useMemo(() => {
    const mean = totals.samples > 0 ? totals.sum / totals.samples : null
    const sd = sdFromSums(totals.sum, totals.sumSq, totals.samples)
    const benchmark = mean === null ? null : benchmarkPosition(mean, BENCHMARK_KEYPRESS_DURATION_MS)
    return [
      {
        labelKey: 'analyze.duration.stat.mean',
        value: mean === null ? EMPTY_STAT_VALUE : fmtMs(mean),
        context: benchmark && (
          <BenchmarkSubline
            populationAverageKey="analyze.duration.stat.populationAverage"
            value={BENCHMARK_KEYPRESS_DURATION_MS.mean.toFixed(1)}
            position={benchmark}
          />
        ),
      },
      {
        labelKey: 'analyze.duration.stat.sd',
        value: sd === null ? EMPTY_STAT_VALUE : fmtMs(sd),
        descriptionKey: 'analyze.duration.stat.sdDesc',
      },
      {
        labelKey: 'analyze.duration.stat.samples',
        value: totals.samples.toLocaleString(),
        descriptionKey: 'analyze.duration.stat.samplesDesc',
      },
    ]
  }, [totals, t])

  if (loading) {
    return (
      <div className="py-4 text-center text-sm text-content-muted" data-testid="analyze-duration-loading">
        {t('common.loading')}
      </div>
    )
  }

  return (
    // No visible <h3> here — this section only ever renders under
    // AnalyzePane's "Section" filter-row select, which already labels
    // it (shared `sectionTitle` key), so a second in-body heading would
    // just repeat it. `aria-label` on the section itself keeps the
    // name available to assistive tech (as a named landmark) even
    // without a visible heading to navigate by.
    <section
      className="flex flex-col gap-2 border-t border-edge pt-3"
      data-testid="analyze-duration-section"
      aria-label={t('analyze.duration.sectionTitle')}
    >
      {totals.samples === 0 ? (
        <div className="py-4 text-center text-sm text-content-muted" data-testid="analyze-duration-empty">
          {t('analyze.duration.empty')}
        </div>
      ) : (
        <>
          <div className="h-64 w-full" data-testid="analyze-duration-chart">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: CHART_TICK_FONT_SIZE, fill: 'var(--color-content-muted)' }}
                  stroke="var(--color-edge)"
                  interval={0}
                />
                <YAxis
                  tick={{ fontSize: CHART_TICK_FONT_SIZE, fill: 'var(--color-content-muted)' }}
                  stroke="var(--color-edge)"
                  tickFormatter={(v: number) => Math.round(v).toLocaleString()}
                />
                <Tooltip
                  {...ANALYZE_TOOLTIP_DEFAULTS}
                  formatter={(value) => [
                    boldValue(Number(value).toLocaleString()),
                    t('analyze.duration.tooltipLabel'),
                  ]}
                />
                <Bar dataKey="count" isAnimationActive={false}>
                  {chartData.map((d) => (
                    <Cell key={d.index} fill={chartSeriesColor(d.index, chartData.length, theme)} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <AnalyzeStatGrid
            items={statItems}
            ariaLabelKey="analyze.duration.ariaLabel"
            testId="analyze-duration-summary"
          />
        </>
      )}
    </section>
  )
}
