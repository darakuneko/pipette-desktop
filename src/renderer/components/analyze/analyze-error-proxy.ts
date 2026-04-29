// SPDX-License-Identifier: GPL-2.0-or-later
// Backspace-ratio overlay for the Analyze > WPM tab. The WPM chart is
// agnostic to what caused a keystroke, but "how often do I delete?" is
// a cheap proxy for typing errors — no word-level grading needed.
//
// The SQL layer gives us per-minute Backspace counts sourced from
// `typing_matrix_minute` (covers every capture path, not just the
// typing-test). Total keystrokes come from the same `minute-stats`
// fetch the WPM line chart already runs, so we re-use those rows
// here to compute the ratio without a second trip for totals.

import type {
  TypingBksMinuteRow,
  TypingMinuteStatsRow,
} from '../../../shared/types/typing-analytics'
import { snapBucketStartLocal } from './analyze-bucket'
import type { RangeMs } from './analyze-types'

export interface BksRateBucket {
  bucketStartMs: number
  totalChars: number
  backspaceChars: number
  /** Percentage `backspaceChars / totalChars * 100`. `null` when
   * `totalChars === 0` so consumers render a gap and rely on
   * `connectNulls` to bridge minutes without data. */
  bksPercent: number | null
}

export interface BksRateSummary {
  totalBackspaces: number
  totalChars: number
  /** Range-wide Backspace share. `null` when no keystrokes recorded. */
  overallBksPercent: number | null
}

export interface BksRateResult {
  buckets: BksRateBucket[]
  summary: BksRateSummary
}

export interface BksRateInput {
  bksRows: readonly TypingBksMinuteRow[]
  minuteRows: readonly TypingMinuteStatsRow[]
  range: RangeMs
  bucketMs: number
}

/** Aggregate the per-minute Backspace and keystroke counts into the
 * same local-time buckets the WPM line chart uses so the overlay
 * lines up with the primary series. Buckets inherit the chart's
 * `bucketMs` so a granularity change keeps both in sync. */
export function buildBksRateBuckets({
  bksRows,
  minuteRows,
  range,
  bucketMs,
}: BksRateInput): BksRateResult {
  if (bucketMs <= 0) {
    return { buckets: [], summary: { totalBackspaces: 0, totalChars: 0, overallBksPercent: null } }
  }
  const buckets = new Map<number, { total: number; backspaces: number }>()
  let totalBackspaces = 0
  let totalChars = 0

  const ensure = (bucketStart: number) => {
    let entry = buckets.get(bucketStart)
    if (!entry) {
      entry = { total: 0, backspaces: 0 }
      buckets.set(bucketStart, entry)
    }
    return entry
  }

  for (const r of minuteRows) {
    if (r.minuteMs < range.fromMs || r.minuteMs >= range.toMs) continue
    if (r.keystrokes <= 0) continue
    const bucketStart = snapBucketStartLocal(r.minuteMs, bucketMs)
    ensure(bucketStart).total += r.keystrokes
    totalChars += r.keystrokes
  }
  for (const r of bksRows) {
    if (r.minuteMs < range.fromMs || r.minuteMs >= range.toMs) continue
    if (r.backspaceCount <= 0) continue
    const bucketStart = snapBucketStartLocal(r.minuteMs, bucketMs)
    ensure(bucketStart).backspaces += r.backspaceCount
    totalBackspaces += r.backspaceCount
  }

  const sorted = Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStartMs, e]) => ({
      bucketStartMs,
      totalChars: e.total,
      backspaceChars: e.backspaces,
      bksPercent: e.total > 0 ? (e.backspaces / e.total) * 100 : null,
    }))

  return {
    buckets: sorted,
    summary: {
      totalBackspaces,
      totalChars,
      overallBksPercent: totalChars > 0 ? (totalBackspaces / totalChars) * 100 : null,
    },
  }
}
