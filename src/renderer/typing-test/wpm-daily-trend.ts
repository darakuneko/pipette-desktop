// SPDX-License-Identifier: GPL-2.0-or-later
//
// Per-day WPM aggregation for WpmTrendChart. With many results in a single
// day, plotting every individual result zigzags into unreadable vertical
// clusters (one x-position per day, N stacked y-values) — this groups
// results by LOCAL calendar date and reduces each day to three numbers
// (best/worst/avg WPM), so the chart reads as a smooth day-over-day trend
// instead of a dense per-run scatter.

import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { DAY_MS, snapBucketStartLocal } from '../components/analyze/analyze-bucket'

export interface DailyWpmPoint {
  /** Local midnight timestamp (ms) for this calendar day — the chart's X
   *  axis value (matches WpmTrendChart's prior `timestampMs` convention:
   *  a plain numeric axis, not a category axis). */
  dayStartMs: number
  best: number
  worst: number
  /** Rounded to one decimal — enough precision to distinguish close days
   *  without implying false accuracy (mirrors computeStats' avgWpm, which
   *  rounds to a whole number for the coarser all-time stat card; a
   *  per-day trend point benefits from the extra digit since many days
   *  cluster near the same integer WPM). */
  avg: number
  /** Result count for the day — not plotted, but useful for a tooltip or
   *  future refinement (e.g. dimming single-sample days). */
  count: number
}

/** Groups `results` by local calendar day and reduces each day to
 *  best/worst/avg WPM. Days with zero results are simply absent from the
 *  output (not represented as a null/gap entry) — the chart's line
 *  connects directly between the nearest two days that DO have data, the
 *  same behavior the prior per-result chart already had for sparse
 *  periods (it never inserted gap markers either). Output is sorted
 *  ascending by day, matching the chart's oldest-to-newest left-to-right
 *  convention. Results with an unparseable `date` are dropped, same
 *  treatment `filterResultsByPeriod` gives them.
 *
 *  Local-midnight snapping reuses `snapBucketStartLocal` (Analyze's own
 *  day-bucketing primitive, already imported into this file's sibling
 *  chart components for tooltip/palette helpers) rather than a bespoke
 *  string key — the numeric snap result is itself already a unique,
 *  sortable per-day Map key, so no separate `YYYY-MM-DD` key is needed. */
export function aggregateWpmByDay(results: TypingTestResult[]): DailyWpmPoint[] {
  const byDay = new Map<number, number[]>()
  for (const r of results) {
    const ms = new Date(r.date).getTime()
    if (Number.isNaN(ms)) continue
    const dayStartMs = snapBucketStartLocal(ms, DAY_MS)
    const wpms = byDay.get(dayStartMs)
    if (wpms) wpms.push(r.wpm)
    else byDay.set(dayStartMs, [r.wpm])
  }

  const points = Array.from(byDay, ([dayStartMs, wpms]): DailyWpmPoint => ({
    dayStartMs,
    best: Math.max(...wpms),
    worst: Math.min(...wpms),
    avg: Math.round((wpms.reduce((sum, w) => sum + w, 0) / wpms.length) * 10) / 10,
    count: wpms.length,
  }))
  points.sort((a, b) => a.dayStartMs - b.dayStartMs)
  return points
}
