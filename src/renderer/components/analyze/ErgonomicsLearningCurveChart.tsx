// SPDX-License-Identifier: GPL-2.0-or-later
//
// Analyze > Ergonomics > Learning Curve. Buckets per-day matrix-cell
// rows by week / month and folds each bucket into ergonomic
// sub-scores (finger load deviation / hand balance / home row stay).
// The score is a relative-trend indicator only — not a calibrated
// absolute metric — so the UI surfaces a "relative trend" caveat
// next to the chart.

import { memo, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type {
  TypingKeymapSnapshot,
  TypingMatrixCellDailyRow,
} from '../../../shared/types/typing-analytics'
import type { KeyboardLayout } from '../../../shared/kle/types'
import { buildErgonomicsByPos } from '../../../shared/kle/kle-ergonomics'
import { primaryDeviceScope, scopeToSelectValue } from '../../../shared/types/analyze-filters'
import type {
  DeviceScope,
  ErgonomicsLearningPeriod,
  RangeMs,
} from './analyze-types'
import { listMatrixCellsByDayForScope } from './analyze-fetch'
import { Stat, TooltipShell } from './analyze-tooltip'
import {
  buildLearningCurve,
  summarizeLearningCurve,
  type LearningCurveBucket,
  DEFAULT_LEARNING_MIN_SAMPLE,
} from './analyze-ergonomics-curve'

const pct = (v: number): string => `${Math.round(v * 100)}%`
const signedPct = (v: number): string => `${v >= 0 ? '+' : ''}${pct(v)}`

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
  /** App filter — see WpmChart.Props.appScopes. */
  appScopes: string[]
  snapshot: TypingKeymapSnapshot
  period: ErgonomicsLearningPeriod
  minSampleKeystrokes?: number
}

// Recharts reads only the numeric `dataKey` fields off each datum, so
// we pass `LearningCurveBucket[]` straight in instead of cloning into
// a parallel chart-only type.
type ChartDatum = LearningCurveBucket

const LINE_OVERALL = 'var(--color-accent)'
const LINE_FINGER = '#3b82f6'
const LINE_HAND = '#10b981'
const LINE_HOME = '#f59e0b'

function formatDateAxis(ms: number, period: ErgonomicsLearningPeriod): string {
  const d = new Date(ms)
  if (period === 'month') {
    return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`
  }
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

interface LearningCurveTooltipProps {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: ChartDatum }>
}

function LearningCurveTooltip({ active, payload }: LearningCurveTooltipProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!active || !payload?.length) return null
  const datum = payload[0]?.payload
  if (!datum) return null
  const labelDate = new Date(datum.bucketStartMs).toLocaleDateString()
  return (
    <TooltipShell
      header={labelDate}
      footer={
        <>
          {t('analyze.ergonomics.learning.totalKeystrokes', {
            count: datum.totalKeystrokes,
          })}
          {!datum.qualified && (
            <> · {t('analyze.ergonomics.learning.belowMinSample')}</>
          )}
        </>
      }
    >
      <Stat label={t('analyze.ergonomics.learning.score.overall')} value={pct(datum.overall)} />
      <Stat label={t('analyze.ergonomics.learning.score.fingerLoad')} value={pct(datum.fingerLoadDeviation)} />
      <Stat label={t('analyze.ergonomics.learning.score.handBalance')} value={pct(datum.handBalance)} />
      <Stat label={t('analyze.ergonomics.learning.score.homeRowStay')} value={pct(datum.homeRowStay)} />
    </TooltipShell>
  )
}

const TrendCard = memo(function TrendCard({
  label,
  value,
  delta,
}: {
  label: string
  value: string
  delta?: string
}) {
  return (
    <div className="flex flex-col rounded border border-edge bg-surface px-3 py-2 text-[12px]">
      <span className="text-content-muted">{label}</span>
      <span className="text-[16px] font-semibold text-content">{value}</span>
      {delta !== undefined && (
        <span className="text-content-secondary">{delta}</span>
      )}
    </div>
  )
})

export function ErgonomicsLearningCurveChart({
  uid,
  range,
  deviceScopes,
  appScopes,
  snapshot,
  period,
  minSampleKeystrokes = DEFAULT_LEARNING_MIN_SAMPLE,
}: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TypingMatrixCellDailyRow[]>([])
  const [loading, setLoading] = useState(true)

  const deviceScope = primaryDeviceScope(deviceScopes)
  const scopeKey = scopeToSelectValue(deviceScope)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void listMatrixCellsByDayForScope(uid, deviceScope, range.fromMs, range.toMs, appScopes)
      .then((next) => {
        if (cancelled) return
        setRows(next)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setRows([])
        setLoading(false)
      })
    return () => { cancelled = true }
    // `scopeKey` carries `deviceScope` identity.
  }, [uid, range, scopeKey, appScopes])

  const layout = snapshot.layout as KeyboardLayout | null
  const layoutKeys = layout?.keys

  // Pin the dep on `layoutKeys` (the actual snapshot reference) so a
  // re-render with `layout` still null does not bust the memo each
  // time `?? []` mints a fresh empty array.
  const ergonomicsByPos = useMemo(
    () => buildErgonomicsByPos(layoutKeys ?? []),
    [layoutKeys],
  )

  const result = useMemo(() => {
    return buildLearningCurve({
      rows,
      range,
      period,
      ergonomicsByPos,
      minSampleKeystrokes,
    })
  }, [rows, range, period, ergonomicsByPos, minSampleKeystrokes])

  const trend = useMemo(() => summarizeLearningCurve(result.buckets), [result.buckets])
  const data: readonly ChartDatum[] = result.buckets
  const qualifiedCount = useMemo(
    () => result.buckets.reduce((sum, b) => (b.qualified ? sum + 1 : sum), 0),
    [result.buckets],
  )

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-ergonomics-learning-loading">
        {t('common.loading')}
      </div>
    )
  }
  if (!layout || !layoutKeys || layoutKeys.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-ergonomics-learning-no-layout">
        {t('analyze.ergonomics.noLayout')}
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-ergonomics-learning-empty">
        {t('analyze.ergonomics.learning.noData')}
      </div>
    )
  }

  // Safe: `data.length === 0` early-returned above so the array is
  // guaranteed non-empty by the time we read the latest bucket.
  const latestBucket = result.buckets[result.buckets.length - 1]

  return (
    <div
      className="flex h-full flex-col gap-3 overflow-y-auto pr-1"
      data-testid="analyze-ergonomics-learning"
    >
      <div style={{ height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={data}
            margin={{ top: 4, right: 24, bottom: 4, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
            <XAxis
              dataKey="bucketStartMs"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v) => formatDateAxis(Number(v), period)}
              stroke="var(--color-content-muted)"
              fontSize={11}
            />
            <YAxis
              type="number"
              domain={[0, 1]}
              tickFormatter={(v) => pct(Number(v))}
              stroke="var(--color-content-muted)"
              fontSize={11}
              width={48}
            />
            <Tooltip content={(props) => <LearningCurveTooltip {...props} />} />
            <Line
              type="monotone"
              dataKey="overall"
              stroke={LINE_OVERALL}
              strokeWidth={2}
              dot={{ r: 3 }}
              isAnimationActive={false}
              name={t('analyze.ergonomics.learning.score.overall')}
            />
            <Line
              type="monotone"
              dataKey="fingerLoadDeviation"
              stroke={LINE_FINGER}
              strokeWidth={1}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
              name={t('analyze.ergonomics.learning.score.fingerLoad')}
            />
            <Line
              type="monotone"
              dataKey="handBalance"
              stroke={LINE_HAND}
              strokeWidth={1}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
              name={t('analyze.ergonomics.learning.score.handBalance')}
            />
            <Line
              type="monotone"
              dataKey="homeRowStay"
              stroke={LINE_HOME}
              strokeWidth={1}
              strokeDasharray="4 3"
              dot={false}
              isAnimationActive={false}
              name={t('analyze.ergonomics.learning.score.homeRowStay')}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <TrendCard
          label={t('analyze.ergonomics.learning.summary.latestOverall')}
          value={pct(latestBucket.overall)}
        />
        {trend && (
          <TrendCard
            label={t('analyze.ergonomics.learning.summary.delta', {
              count: trend.baselineCount,
            })}
            value={signedPct(trend.delta)}
            delta={t('analyze.ergonomics.learning.summary.baselineMean', {
              value: pct(trend.baselineMean),
            })}
          />
        )}
        <TrendCard
          label={t('analyze.ergonomics.learning.summary.bucketCount')}
          value={String(result.buckets.length)}
        />
        <TrendCard
          label={t('analyze.ergonomics.learning.summary.qualifiedCount')}
          value={String(qualifiedCount)}
        />
      </div>
      <p className="text-[11px] text-content-muted">
        {t('analyze.ergonomics.learning.relativeTrendNote')}
      </p>
    </div>
  )
}
