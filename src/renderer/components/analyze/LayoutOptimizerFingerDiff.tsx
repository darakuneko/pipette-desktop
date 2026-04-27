// SPDX-License-Identifier: GPL-2.0-or-later
//
// Per-finger load delta between the user's current layout (treated as
// `targets[0]` by convention) and a candidate target (`targets[1]`).
// Renders one signed bar per finger so the user can spot which
// fingers gain or lose typing volume on the candidate layout. Bars
// are colour-coded by sign — red = more load, green = less.

import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  type TooltipProps,
  XAxis,
  YAxis,
} from 'recharts'
import { FINGER_LIST } from '../../../shared/kle/kle-ergonomics'
import type { LayoutOptimizerTargetResult } from '../../../shared/types/typing-analytics'

interface Props {
  current: LayoutOptimizerTargetResult
  target: LayoutOptimizerTargetResult
  /** Display name for the candidate target column. */
  targetLabel: string
}

interface DiffDatum {
  finger: string
  label: string
  diff: number
}

// Float arithmetic on share fractions can leave ~1e-17 noise in
// otherwise-equal values; without a tolerance every "no change"
// finger would flicker between the increase / decrease colours.
const ZERO_EPSILON = 1e-6

function colorForDiff(diff: number): string {
  if (diff > ZERO_EPSILON) return 'var(--color-danger)'
  if (diff < -ZERO_EPSILON) return 'var(--color-success)'
  return 'var(--color-content-muted)'
}

function DiffTooltip({
  active,
  payload,
}: TooltipProps<number, string>): JSX.Element | null {
  if (!active || !payload || payload.length === 0) return null
  const datum = payload[0].payload as DiffDatum
  const sign = datum.diff > 0 ? '+' : ''
  return (
    <div className="rounded border border-edge bg-surface px-2 py-1 text-[12px] text-content shadow">
      <div className="font-medium">{datum.label}</div>
      <div className="tabular-nums">{`${sign}${(datum.diff * 100).toFixed(1)}%`}</div>
    </div>
  )
}

export function LayoutOptimizerFingerDiff({ current, target, targetLabel }: Props): JSX.Element {
  const { t } = useTranslation()
  const data = useMemo<DiffDatum[]>(() => {
    return FINGER_LIST.map((finger) => {
      const currentValue = current.fingerLoad?.[finger] ?? 0
      const targetValue = target.fingerLoad?.[finger] ?? 0
      return {
        finger,
        label: t(`analyze.ergonomics.finger.${finger}`),
        diff: targetValue - currentValue,
      }
    })
  }, [current, target, t])

  return (
    <div className="flex w-full min-w-0 flex-col gap-1" data-testid="analyze-layout-optimizer-finger-diff">
      <h4 className="text-[13px] font-semibold text-content-secondary">
        {t('analyze.layoutOptimizer.fingerDiffTitle', { target: targetLabel })}
      </h4>
      <div style={{ height: 240 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 4, right: 16, bottom: 4, left: 8 }}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-edge)" />
            <XAxis
              type="category"
              dataKey="label"
              stroke="var(--color-content-muted)"
              fontSize={11}
            />
            <YAxis
              type="number"
              stroke="var(--color-content-muted)"
              fontSize={11}
              tickFormatter={(value: number) => `${value >= 0 ? '+' : ''}${(value * 100).toFixed(0)}%`}
            />
            <ReferenceLine y={0} stroke="var(--color-content-muted)" />
            <Tooltip
              cursor={{ fill: 'var(--color-surface-dim)' }}
              content={DiffTooltip}
            />
            <Bar dataKey="diff" isAnimationActive={false}>
              {data.map((entry) => (
                <Cell key={entry.finger} fill={colorForDiff(entry.diff)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}
