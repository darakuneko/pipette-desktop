// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Interval — daily rhythm view. Shows the p25/p75 band as
// an Area, the median (p50) as a line inside it, and faint min/max
// whiskers for context. recharts has no boxplot primitive, but an
// Area + Line stack over a shared time axis conveys the same shape
// (central tendency + spread) without a custom SVG.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Area, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TypingIntervalDailySummary } from '../../../shared/types/typing-analytics'
import type { DeviceScope, PeriodKey } from './analyze-types'
import { filterByPeriod } from './analyze-period'

interface Props {
  uid: string
  period: PeriodKey
  deviceScope: DeviceScope
}

export function IntervalChart({ uid, period, deviceScope }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TypingIntervalDailySummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const data = deviceScope === 'own'
          ? await window.vialAPI.typingAnalyticsListIntervalItemsLocal(uid)
          : await window.vialAPI.typingAnalyticsListIntervalItems(uid)
        if (!cancelled) setRows(data)
      } catch {
        if (!cancelled) setRows([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, deviceScope])

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-interval-loading">
        {t('common.loading')}
      </div>
    )
  }

  const chartData = filterByPeriod(rows, period)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => {
      const p25 = r.intervalP25Ms ?? 0
      const p75 = r.intervalP75Ms ?? 0
      return {
        date: r.date,
        // stackId trick: Area between p25 and p75 = draw p25 (invisible)
        // then a band of width (p75-p25) on top. Both are in the same
        // stack group so recharts fills the gap.
        p25: Math.round(p25),
        iqr: Math.max(0, Math.round(p75 - p25)),
        p50: r.intervalP50Ms === null ? null : Math.round(r.intervalP50Ms),
        min: r.intervalMinMs === null ? null : Math.round(r.intervalMinMs),
        max: r.intervalMaxMs === null ? null : Math.round(r.intervalMaxMs),
      }
    })

  if (chartData.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-interval-empty">
        {t('analyze.noData')}
      </div>
    )
  }

  return (
    <div className="h-full w-full" data-testid="analyze-interval-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }} stroke="var(--color-edge)" />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
            stroke="var(--color-edge)"
            label={{ value: 'ms', angle: -90, position: 'insideLeft', style: { fontSize: 11, fill: 'var(--color-content-muted)' } }}
          />
          <Tooltip
            contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-edge)', fontSize: 12 }}
            labelStyle={{ color: 'var(--color-content-secondary)' }}
            itemStyle={{ color: 'var(--color-content)' }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area type="monotone" dataKey="p25" stackId="iqr" stroke="transparent" fill="transparent" name={t('analyze.interval.legend.p25')} legendType="none" />
          <Area type="monotone" dataKey="iqr" stackId="iqr" stroke="transparent" fill="var(--color-accent)" fillOpacity={0.15} name={t('analyze.interval.legend.iqr')} />
          <Line type="monotone" dataKey="p50" stroke="var(--color-accent)" strokeWidth={2} dot={{ r: 2 }} name={t('analyze.interval.legend.p50')} connectNulls />
          <Line type="monotone" dataKey="min" stroke="var(--color-content-muted)" strokeWidth={1} strokeDasharray="3 3" dot={false} name={t('analyze.interval.legend.min')} connectNulls />
          <Line type="monotone" dataKey="max" stroke="var(--color-content-muted)" strokeWidth={1} strokeDasharray="3 3" dot={false} name={t('analyze.interval.legend.max')} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
