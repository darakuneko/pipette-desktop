// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > WPM — words-per-minute line chart. Fetches minute-raw
// rows from the SQL layer and buckets them on the client so the same
// chart can render a single hour or several weeks without the SQL
// layer knowing about a user-chosen bucket size. WPM is derived at
// render time with the classic `keystrokes / 5 * 60000 / activeMs`
// formula so historical rows don't need rewriting if the definition
// ever changes.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TypingMinuteStatsRow } from '../../../shared/types/typing-analytics'
import type { DeviceScope, GranularityChoice, RangeMs } from './analyze-types'
import { bucketMinuteStats, pickBucketMs } from './analyze-bucket'

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
  granularity: GranularityChoice
}

function computeWpm(keystrokes: number, activeMs: number): number {
  if (activeMs <= 0) return 0
  return (keystrokes / 5) * 60_000 / activeMs
}

function formatAxis(ms: number, bucketMs: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  // Below a day: HH:mm. Otherwise MM-DD HH:mm (abbreviate to MM-DD if
  // the bucket itself is at least one day wide, i.e. daily+).
  if (bucketMs >= 86_400_000) return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function WpmChart({ uid, range, deviceScope, granularity }: Props) {
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
  const chartData = useMemo(() => bucketMinuteStats(rows, range, bucketMs)
    .map((b) => ({
      bucketStartMs: b.bucketStartMs,
      wpm: Math.round(computeWpm(b.keystrokes, b.activeMs) * 10) / 10,
    })), [rows, range, bucketMs])

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-wpm-loading">
        {t('common.loading')}
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
    <div className="h-full w-full" data-testid="analyze-wpm-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 10, right: 20, bottom: 20, left: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
          <XAxis
            dataKey="bucketStartMs"
            type="number"
            domain={[range.fromMs, range.toMs]}
            tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }}
            stroke="var(--color-edge)"
            tickFormatter={(v: number) => formatAxis(v, bucketMs)}
          />
          <YAxis tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }} stroke="var(--color-edge)" allowDecimals />
          <Tooltip
            contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-edge)', fontSize: 12 }}
            labelStyle={{ color: 'var(--color-content-secondary)' }}
            itemStyle={{ color: 'var(--color-content)' }}
            labelFormatter={(v: number) => formatAxis(v, bucketMs)}
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
  )
}
