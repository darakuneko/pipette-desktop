// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Heatmap — hour-of-day × day-of-week activity grid. recharts
// has no first-class heatmap, so the grid is a plain CSS-grid of
// 24 × 7 rects whose opacity scales with the cell's keystrokes. The
// color token is shared with WPM / Interval so themes stay coherent.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingActivityCell } from '../../../shared/types/typing-analytics'
import { periodSinceMs } from './analyze-period'
import type { DeviceScope, PeriodKey } from './analyze-types'

interface Props {
  uid: string
  period: PeriodKey
  deviceScope: DeviceScope
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DOWS = [0, 1, 2, 3, 4, 5, 6] as const

export function HeatmapChart({ uid, period, deviceScope }: Props) {
  const { t } = useTranslation()
  const [cells, setCells] = useState<TypingActivityCell[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const sinceMs = periodSinceMs(period)
    const load = async () => {
      try {
        const data = deviceScope === 'own'
          ? await window.vialAPI.typingAnalyticsListActivityGridLocal(uid, sinceMs)
          : await window.vialAPI.typingAnalyticsListActivityGrid(uid, sinceMs)
        if (!cancelled) setCells(data)
      } catch {
        if (!cancelled) setCells([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, deviceScope, period])

  const { grid, max } = useMemo(() => {
    const g = new Map<string, number>()
    let m = 0
    for (const c of cells) {
      if (!Number.isInteger(c.dow) || !Number.isInteger(c.hour)) continue
      if (c.dow < 0 || c.dow > 6 || c.hour < 0 || c.hour > 23) continue
      g.set(`${c.dow}:${c.hour}`, c.keystrokes)
      if (c.keystrokes > m) m = c.keystrokes
    }
    return { grid: g, max: m }
  }, [cells])

  if (loading) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-heatmap-loading">
        {t('common.loading')}
      </div>
    )
  }

  if (max === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-heatmap-empty">
        {t('analyze.noData')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 text-[11px]" data-testid="analyze-heatmap-chart">
      <div
        className="grid gap-[2px]"
        style={{ gridTemplateColumns: 'auto repeat(24, minmax(0, 1fr))' }}
        role="table"
        aria-label={t('analyze.heatmap.tableLabel')}
      >
        <div role="row" className="contents">
          <div role="columnheader" aria-hidden="true" />
          {HOURS.map((h) => (
            <div
              key={`h-${h}`}
              role="columnheader"
              aria-label={t('analyze.heatmap.hourHeader', { hour: h })}
              className="text-center text-content-muted"
            >
              {h % 3 === 0 ? h.toString().padStart(2, '0') : ''}
            </div>
          ))}
        </div>
        {DOWS.map((d) => (
          <div key={`row-${d}`} role="row" className="contents">
            <div role="rowheader" className="pr-2 text-right text-content-muted">
              {t(`analyze.heatmap.dow.${d}`)}
            </div>
            {HOURS.map((h) => {
              const v = grid.get(`${d}:${h}`) ?? 0
              const opacity = max === 0 ? 0 : Math.max(v === 0 ? 0 : 0.08, v / max)
              const cellLabel = t('analyze.heatmap.cellTitle', {
                dow: t(`analyze.heatmap.dow.${d}`),
                hour: h,
                keystrokes: v.toLocaleString(),
              })
              return (
                <div
                  key={`c-${d}-${h}`}
                  className="aspect-square rounded-sm"
                  style={{
                    backgroundColor: v === 0 ? 'var(--color-surface-dim)' : 'var(--color-accent)',
                    opacity,
                  }}
                  title={cellLabel}
                  aria-label={cellLabel}
                  role="cell"
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 pt-1 text-content-muted">
        <span>{t('analyze.heatmap.legendLow')}</span>
        <div
          className="h-2 flex-1 rounded-sm"
          style={{
            background: 'linear-gradient(to right, var(--color-surface-dim), var(--color-accent))',
          }}
        />
        <span>{t('analyze.heatmap.legendHigh', { count: max.toLocaleString() })}</span>
      </div>
    </div>
  )
}
