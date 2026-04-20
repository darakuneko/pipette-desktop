// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > WPM — daily words-per-minute line chart for the selected
// keyboard, filtered by the shared period/device pickers. The classic
// WPM formula (keystrokes / 5 per minute of activity) is applied at
// render time so historical rows stay intact if the definition ever
// changes.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TypingDailySummary } from '../../../shared/types/typing-analytics'
import type { DeviceScope, PeriodKey } from './analyze-types'
import { filterByPeriod } from './analyze-period'

interface Props {
  uid: string
  period: PeriodKey
  deviceScope: DeviceScope
}

function computeWpm(keystrokes: number, activeMs: number): number {
  if (activeMs <= 0) return 0
  return (keystrokes / 5) * 60_000 / activeMs
}

export function WpmChart({ uid, period, deviceScope }: Props) {
  const { t } = useTranslation()
  const [summaries, setSummaries] = useState<TypingDailySummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const data = deviceScope === 'own'
          ? await window.vialAPI.typingAnalyticsListItemsLocal(uid)
          : await window.vialAPI.typingAnalyticsListItems(uid)
        if (!cancelled) setSummaries(data)
      } catch {
        if (!cancelled) setSummaries([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, deviceScope])

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-wpm-loading">
        {t('common.loading')}
      </div>
    )
  }

  const chartData = filterByPeriod(summaries, period)
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => ({
      date: s.date,
      wpm: Math.round(computeWpm(s.keystrokes, s.activeMs) * 10) / 10,
    }))

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
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }} stroke="var(--color-edge)" />
          <YAxis tick={{ fontSize: 11, fill: 'var(--color-content-muted)' }} stroke="var(--color-edge)" allowDecimals />
          <Tooltip
            contentStyle={{ background: 'var(--color-surface)', border: '1px solid var(--color-edge)', fontSize: 12 }}
            labelStyle={{ color: 'var(--color-content-secondary)' }}
            itemStyle={{ color: 'var(--color-content)' }}
          />
          <Line type="monotone" dataKey="wpm" stroke="var(--color-accent)" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
