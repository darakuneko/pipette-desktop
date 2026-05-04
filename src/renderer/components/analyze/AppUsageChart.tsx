// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > App Usage Distribution. Pie chart of typing time per app
// across the analyze range. Single-app minutes contribute to their
// app's slice; mixed/unknown minutes (Monitor App off, lookup failed,
// or two apps observed) collapse into a single "Unknown" slice so the
// total still adds up to all keystrokes in the range.

import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import {
  primaryDeviceScope,
  scopeToSelectValue,
} from '../../../shared/types/analyze-filters'
import { TYPING_APP_UNKNOWN_NAME } from '../../../shared/types/typing-analytics'
import type { DeviceScope, RangeMs } from './analyze-types'
import { chartSeriesColor } from '../../utils/chart-palette'
import { useEffectiveTheme } from '../../hooks/useEffectiveTheme'
import { formatSharePercent } from './analyze-format'
import { Stat, TooltipShell } from './analyze-tooltip'

interface Props {
  uid: string
  range: RangeMs
  deviceScopes: readonly DeviceScope[]
}

interface AppRow {
  name: string
  keystrokes: number
  activeMs: number
}

/** Slices smaller than this fraction of the total collapse into a
 * single "Other" bucket so the chart stays readable when the user has
 * a long tail of rarely-used apps. */
const OTHER_THRESHOLD = 0.02

interface PieDatum {
  name: string
  value: number
  isUnknown: boolean
}

interface AppUsageTooltipProps {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: PieDatum }>
  total: number
}

function AppUsageTooltip({ active, payload, total }: AppUsageTooltipProps): JSX.Element | null {
  const { t } = useTranslation()
  if (!active || !payload?.length) return null
  const datum = payload[0]?.payload
  if (!datum || total <= 0) return null
  return (
    <TooltipShell header={datum.name}>
      <Stat
        label={t('analyze.appUsage.tooltipKeystrokesLabel')}
        value={datum.value.toLocaleString()}
      />
      <Stat
        label={t('analyze.appUsage.tooltipShareLabel')}
        value={`${formatSharePercent(datum.value / total)}%`}
      />
    </TooltipShell>
  )
}

function rollupForChart(rows: AppRow[], unknownLabel: string, otherLabel: string): PieDatum[] {
  const total = rows.reduce((acc, r) => acc + r.keystrokes, 0)
  if (total === 0) return []
  const result: PieDatum[] = []
  let otherSum = 0
  for (const r of rows) {
    const ratio = r.keystrokes / total
    if (r.name === TYPING_APP_UNKNOWN_NAME) {
      // Unknown is always shown as its own slice — the user wants to
      // see how much of the period was un-tagged so they can judge
      // whether to enable Monitor App more aggressively.
      result.push({ name: unknownLabel, value: r.keystrokes, isUnknown: true })
      continue
    }
    if (ratio < OTHER_THRESHOLD) {
      otherSum += r.keystrokes
      continue
    }
    result.push({ name: r.name, value: r.keystrokes, isUnknown: false })
  }
  if (otherSum > 0) {
    result.push({ name: otherLabel, value: otherSum, isUnknown: false })
  }
  // Recharts honours datum order; sort named slices by size descending
  // so the legend matches the radial order.
  result.sort((a, b) => {
    if (a.isUnknown !== b.isUnknown) return a.isUnknown ? 1 : -1
    return b.value - a.value
  })
  return result
}

export function AppUsageChart({ uid, range, deviceScopes }: Props) {
  const { t } = useTranslation()
  const theme = useEffectiveTheme()
  const [rows, setRows] = useState<AppRow[]>([])
  const [loading, setLoading] = useState(true)

  // Stable string key for the device-scope selection — depending on
  // the object reference would refetch on every parent re-render even
  // when the user's selection didn't change.
  const scope = scopeToSelectValue(primaryDeviceScope(deviceScopes))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.vialAPI
      .typingAnalyticsGetAppUsageForRange(uid, range.fromMs, range.toMs, scope)
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

  const data = useMemo(
    () =>
      rollupForChart(
        rows,
        t('analyze.appUsage.unknown'),
        t('analyze.appUsage.other'),
      ),
    [rows, t],
  )

  const total = data.reduce((acc, d) => acc + d.value, 0)

  // Color palette: known apps cycle through the shared chart palette;
  // the Unknown slice uses a flat neutral grey so the eye treats it
  // as the "missing data" bucket rather than a real app, while still
  // being visible on both themes (the surface-dim fill blended into
  // the panel background and made the slice unreadable).
  const colorFor = (datum: PieDatum, index: number): string => {
    if (datum.isUnknown) return '#9ca3af'
    return chartSeriesColor(index, data.length, theme)
  }

  if (loading) {
    return (
      <div className="text-center text-sm text-content-muted">
        {t('analyze.appUsage.loading')}
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div className="rounded border border-edge bg-surface-alt px-3 py-2 text-center text-sm text-content-muted">
        {t('analyze.appUsage.empty')}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-content">
        {t('analyze.appUsage.title')}
      </h3>
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" outerRadius="80%" label={false} animationDuration={500}>
              {data.map((d, i) => (
                <Cell key={d.name} fill={colorFor(d, i)} />
              ))}
            </Pie>
            <Tooltip content={(props) => <AppUsageTooltip {...props} total={total} />} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
