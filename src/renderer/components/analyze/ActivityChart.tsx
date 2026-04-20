// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Activity — hour-of-day × day-of-week keystroke-count grid.
// Scoped as "activity" to stay clearly separate from the per-key
// matrix intensity view in the typing test. recharts has no dedicated
// grid primitive here, so the chart is a plain CSS-grid of 24 × 7
// rects whose opacity scales with the bucket's keystrokes.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TypingActivityCell } from '../../../shared/types/typing-analytics'
import type { DeviceScope, RangeMs } from './analyze-types'

interface Props {
  uid: string
  range: RangeMs
  deviceScope: DeviceScope
}

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const DOWS = [0, 1, 2, 3, 4, 5, 6] as const

export function ActivityChart({ uid, range, deviceScope }: Props) {
  const { t } = useTranslation()
  const [cells, setCells] = useState<TypingActivityCell[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      try {
        const data = deviceScope === 'own'
          ? await window.vialAPI.typingAnalyticsListActivityGridLocal(uid, range.fromMs, range.toMs)
          : await window.vialAPI.typingAnalyticsListActivityGrid(uid, range.fromMs, range.toMs)
        if (!cancelled) setCells(data)
      } catch {
        if (!cancelled) setCells([])
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [uid, deviceScope, range])

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
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-activity-loading">
        {t('common.loading')}
      </div>
    )
  }

  if (max === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="analyze-activity-empty">
        {t('analyze.noData')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1 text-[11px]" data-testid="analyze-activity-chart">
      <div
        className="grid gap-[2px]"
        style={{ gridTemplateColumns: 'auto repeat(24, minmax(0, 1fr))' }}
        role="table"
        aria-label={t('analyze.activity.tableLabel')}
      >
        <div role="row" className="contents">
          <div role="columnheader" aria-hidden="true" />
          {HOURS.map((h) => (
            <div
              key={`h-${h}`}
              role="columnheader"
              aria-label={t('analyze.activity.hourHeader', { hour: h })}
              className="text-center text-content-muted"
            >
              {h % 3 === 0 ? h.toString().padStart(2, '0') : ''}
            </div>
          ))}
        </div>
        {DOWS.map((d) => (
          <div key={`row-${d}`} role="row" className="contents">
            <div role="rowheader" className="pr-2 text-right text-content-muted">
              {t(`analyze.activity.dow.${d}`)}
            </div>
            {HOURS.map((h) => {
              const v = grid.get(`${d}:${h}`) ?? 0
              const opacity = max === 0 ? 0 : Math.max(v === 0 ? 0 : 0.08, v / max)
              const cellLabel = t('analyze.activity.cellTitle', {
                dow: t(`analyze.activity.dow.${d}`),
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
        <span title={t('analyze.activity.legendLowDesc')}>{t('analyze.activity.legendLow')}</span>
        <div
          className="h-2 flex-1 rounded-sm"
          title={t('analyze.activity.legendScaleDesc')}
          style={{
            background: 'linear-gradient(to right, var(--color-surface-dim), var(--color-accent))',
          }}
        />
        <span title={t('analyze.activity.legendHighDesc', { count: max.toLocaleString() })}>
          {t('analyze.activity.legendHigh', { count: max.toLocaleString() })}
        </span>
      </div>
    </div>
  )
}
