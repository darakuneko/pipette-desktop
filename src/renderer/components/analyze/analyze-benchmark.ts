// SPDX-License-Identifier: GPL-2.0-or-later
// Places a measured value against a population {@link BenchmarkStat}
// (see shared/typing-benchmarks.ts) as a signed distance in standard
// deviations. This deliberately reports "how many SDs from the
// population mean" and NEVER a percentile — the study's underlying
// distributions are skewed (skewness 0.51 for WPM, 1.98 for IKI), so a
// percentile derived from z under a normality assumption would be
// false precision the data doesn't support.
//
// Labels are direction-neutral on purpose: for IKI a lower value is
// faster, so 'below' must not read as worse (and 'above' must not read
// as better). Callers that want a value judgement have to add their own
// framing — this function only reports position.

import type { BenchmarkStat } from '../../../shared/typing-benchmarks'
import { CHART_TICK_FONT_SIZE } from '../../utils/chart-palette'

/** Shared props for the population-average ReferenceLine that WpmChart
 * and IntervalChart both render — one place to change the look, same
 * role as ANALYZE_TOOLTIP_DEFAULTS for the shared Tooltip styling.
 * `label` is the already-translated text (callers own the t() call so
 * this module stays hook-free). `ifOverflow: 'extendDomain'` overrides
 * recharts' default of discarding a ReferenceLine that falls outside the
 * axis domain — the line must stay visible even when the user's own data
 * sits entirely below (or above) the population mean; the axis rescaling
 * this causes is the accepted cost. */
export function benchmarkReferenceLineProps(y: number, label: string): {
  y: number
  stroke: string
  strokeDasharray: string
  ifOverflow: 'extendDomain'
  label: { value: string; position: 'insideTopRight'; fontSize: number; fill: string }
} {
  return {
    y,
    stroke: 'var(--color-content-muted)',
    strokeDasharray: '4 4',
    ifOverflow: 'extendDomain',
    label: {
      value: label,
      position: 'insideTopRight',
      fontSize: CHART_TICK_FONT_SIZE,
      fill: 'var(--color-content-muted)',
    },
  }
}

export type BenchmarkPositionLabel = 'farBelow' | 'below' | 'average' | 'above' | 'farAbove'

export interface BenchmarkPosition {
  z: number
  label: BenchmarkPositionLabel
}

export function benchmarkPosition(value: number, stat: BenchmarkStat): BenchmarkPosition | null {
  if (!Number.isFinite(value) || !Number.isFinite(stat.mean) || !Number.isFinite(stat.sd)) return null
  if (stat.sd <= 0) return null
  const z = (value - stat.mean) / stat.sd
  const abs = Math.abs(z)
  const label: BenchmarkPositionLabel = abs <= 0.5
    ? 'average'
    : abs <= 1.5
      ? (z < 0 ? 'below' : 'above')
      : (z < 0 ? 'farBelow' : 'farAbove')
  return { z, label }
}
