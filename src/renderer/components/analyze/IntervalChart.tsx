// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Interval — daily rhythm view. Plots five series on a
// logarithmic ms axis so sub-second quartiles stay legible even when
// the day also contains very long pauses in min/max. Clicking a
// legend entry toggles that line; the filled IQR band was dropped
// because it made p25 invisible when the y-axis had to span 0..tens
// of seconds.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TypingIntervalDailySummary } from '../../../shared/types/typing-analytics'
import type { DeviceScope, IntervalUnit, RangeMs } from './analyze-types'
import { filterByRange } from './analyze-period'

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
  unit: IntervalUnit
}

const SERIES_KEYS = ['min', 'p25', 'p50', 'p75', 'max'] as const
type SeriesKey = (typeof SERIES_KEYS)[number]

// Five clearly distinct hues so the min/max whiskers don't fight the
// central tendency lines visually. All series are drawn solid — the
// old dashed whiskers were hard to tell apart at a glance.
const SERIES_STYLE: Record<SeriesKey, string> = {
  min: '#10b981',   // emerald — fastest interval
  p25: '#06b6d4',   // cyan
  p50: '#3b82f6',   // blue (primary median line)
  p75: '#f59e0b',   // amber
  max: '#ef4444',   // red — longest pause
}

export function IntervalChart({ uid, range, deviceScope, unit }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<TypingIntervalDailySummary[]>([])
  const [loading, setLoading] = useState(true)
  const [hidden, setHidden] = useState<Record<SeriesKey, boolean>>({
    min: false, p25: false, p50: false, p75: false, max: false,
  })

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

  // Log-axis can't plot 0 ms, but min often legitimately rounds to 0
  // on fast adjacent keystrokes. Clamp the axis floor at 1 ms so the
  // Min line still shows up at the bottom edge instead of vanishing.
  const clampForLog = (v: number | null): number | null =>
    v === null ? null : Math.max(1, Math.round(v))
  const chartData = useMemo(() => filterByRange(rows, range)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((r) => ({
      date: r.date,
      min: clampForLog(r.intervalMinMs),
      p25: clampForLog(r.intervalP25Ms),
      p50: clampForLog(r.intervalP50Ms),
      p75: clampForLog(r.intervalP75Ms),
      max: clampForLog(r.intervalMaxMs),
    })), [rows, range])

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
        <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }} stroke="var(--color-edge)" />
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
            contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-edge)', fontSize: 12 }}
            labelStyle={{ color: 'var(--color-content-secondary)' }}
            itemStyle={{ color: 'var(--color-content)' }}
            formatter={(value) => {
              const n = typeof value === 'number' ? value : Number(value)
              if (!Number.isFinite(n)) return String(value)
              return unit === 'sec' ? `${(n / 1000).toFixed(3)} s` : `${n} ms`
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 12, cursor: 'pointer' }}
            onClick={(entry) => toggleSeries(String(entry.dataKey ?? ''))}
            formatter={(value, entry) => {
              const key = String(entry.dataKey ?? '') as SeriesKey
              return (
                <span
                  className="inline-flex items-center gap-0.5"
                  title={t(`analyze.interval.description.${key}`, { defaultValue: '' })}
                  style={{ color: hidden[key] ? 'var(--color-content-muted)' : 'var(--color-content)' }}
                >
                  {value}
                </span>
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
  )
}
