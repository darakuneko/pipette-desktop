// SPDX-License-Identifier: GPL-2.0-or-later

import type { TypingTestResult } from '../../shared/types/pipette-settings'

/** History modal period filter — scopes every view below the tab row (WPM
 *  Trend chart, stats summary, Results table, CSV export, and the entire
 *  Analysis tab) to a rolling window ending at a caller-supplied `now`.
 *  Ordered oldest-window-first, matching the rendered `<select>` option
 *  order in TypingTestHistory's header. */
export type PeriodFilter = '1w' | '1m' | '3m' | '1y' | 'all'
export const PERIOD_FILTERS: PeriodFilter[] = ['1w', '1m', '3m', '1y', 'all']
export const DEFAULT_PERIOD_FILTER: PeriodFilter = '1m'

/** Rolling cutoff timestamp (ms) for `period`, anchored at `now` — `null`
 *  for 'all' (no lower bound). Uses calendar month/year subtraction
 *  (`setMonth`/`setFullYear`) rather than a fixed day count, so "1 month"
 *  and "1 year" track actual calendar months/years instead of a 30/365-day
 *  approximation. Note: `Date` normalizes day-of-month overflow (e.g. Mar
 *  31 minus 1 month lands on Mar 3, not Feb 28) — an accepted quirk for a
 *  coarse period filter, not a full calendar library. */
export function cutoffForPeriod(period: PeriodFilter, now: number): number | null {
  if (period === 'all') return null
  const d = new Date(now)
  switch (period) {
    case '1w':
      d.setDate(d.getDate() - 7)
      break
    case '1m':
      d.setMonth(d.getMonth() - 1)
      break
    case '3m':
      d.setMonth(d.getMonth() - 3)
      break
    case '1y':
      d.setFullYear(d.getFullYear() - 1)
      break
  }
  return d.getTime()
}

/** Filters `results` to those dated on/after the period's cutoff. Inclusive
 *  boundary — a result timestamped exactly at the cutoff counts as "within"
 *  the window (see cutoffForPeriod's doc for the calendar-math it's
 *  measured against). A result with an unparseable `date` is dropped rather
 *  than kept, so a malformed row can't silently bypass the filter. */
export function filterResultsByPeriod(
  results: TypingTestResult[],
  period: PeriodFilter,
  now: number,
): TypingTestResult[] {
  const cutoff = cutoffForPeriod(period, now)
  if (cutoff === null) return results
  return results.filter((r) => {
    const t = new Date(r.date).getTime()
    return !Number.isNaN(t) && t >= cutoff
  })
}
