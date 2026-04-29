// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > WPM by App. Horizontal bar chart of average WPM per app
// across the analyze range. Only single-app minutes contribute (the
// SQL excludes NULL app_name on purpose) so coding-vs-chatting
// patterns aren't blended with mixed minutes.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import {
  primaryDeviceScope,
  scopeToSelectValue,
} from '../../../shared/types/analyze-filters'
import type { DeviceScope, RangeMs } from './analyze-types'
import { computeWpm, formatWpm } from './analyze-wpm'
import { Stat, TooltipShell } from './analyze-tooltip'

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
}

interface ApiRow {
  name: string
  keystrokes: number
  activeMs: number
}

interface BarDatum {
  name: string
  wpm: number
  keystrokes: number
}

interface WpmByAppTooltipProps {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: BarDatum }>
}

function WpmByAppTooltip({ active, payload }: WpmByAppTooltipProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!active || !payload?.length) return null
  const datum = payload[0]?.payload
  if (!datum) return null
  return (
    <TooltipShell header={datum.name}>
      <Stat label={t('analyze.wpmByApp.tooltipWpmLabel')} value={formatWpm(datum.wpm)} />
      <Stat label={t('analyze.wpmByApp.tooltipKeystrokesLabel')} value={datum.keystrokes.toLocaleString()} />
    </TooltipShell>
  )
}

const MAX_BAR_COUNT = 12

export function WpmByAppChart({ uid, range, deviceScopes }: Props) {
  const { t } = useTranslation()
  const [rows, setRows] = useState<ApiRow[]>([])
  const [loading, setLoading] = useState(true)

  // Stable string key — same reasoning as AppUsageChart: depending on
  // the object would refetch on every parent re-render.
  const scope = scopeToSelectValue(primaryDeviceScope(deviceScopes))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.vialAPI
      .typingAnalyticsGetWpmByAppForRange(uid, range.fromMs, range.toMs, scope)
      .then((r) => {
        if (cancelled) return
        setRows(r)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setRows([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [uid, range.fromMs, range.toMs, scope])

  const data = useMemo<BarDatum[]>(() => {
    return rows
      .map((r): BarDatum => ({
        name: r.name,
        wpm: computeWpm(r.keystrokes, r.activeMs),
        keystrokes: r.keystrokes,
      }))
      // Drop apps with no measurable activeMs — the formula returns 0
      // there and a row of zero-length bars is just visual noise.
      .filter((d) => d.wpm > 0)
      .sort((a, b) => b.wpm - a.wpm)
      .slice(0, MAX_BAR_COUNT)
  }, [rows])

  if (loading) {
    return (
      <div className="text-center text-sm text-content-muted">
        {t('analyze.wpmByApp.loading')}
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div className="rounded border border-edge bg-surface-alt px-3 py-2 text-center text-sm text-content-muted">
        {t('analyze.wpmByApp.empty')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-content">
        {t('analyze.wpmByApp.title')}
      </h3>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 80 }}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis type="number" domain={[0, 'auto']} tickFormatter={(n: number) => formatWpm(n)} />
            <YAxis type="category" dataKey="name" width={80} interval={0} />
            <Tooltip
              cursor={{ fill: 'var(--color-surface-dim)' }}
              content={(props) => <WpmByAppTooltip {...props} />}
            />
            <Bar dataKey="wpm" fill="var(--color-accent)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
