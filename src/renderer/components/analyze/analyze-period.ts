// SPDX-License-Identifier: GPL-2.0-or-later
// Pure helpers for the Analyze datetime-range filter — extracted so
// the chart components can share the same semantics without depending
// on React.

import type { RangeMs } from './analyze-types'

const DAY_MS = 86_400_000

/** Parse a `YYYY-MM-DD` (local calendar day, as written by the SQL
 * aggregation) into its local midnight epoch-ms. Returns `null` when
 * the input isn't a real Gregorian day so callers can drop the row
 * instead of coercing. */
function parseDayStartLocalMs(date: string): number | null {
  const [y, m, d] = date.split('-').map((s) => Number.parseInt(s, 10))
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

/** Keep rows whose local calendar day overlaps the requested
 * `[fromMs, toMs)` window. A day is kept whenever its span
 * `[dayStart, dayStart + 24h)` intersects the range, so a sub-day
 * window still surfaces the day that contains its boundaries. */
export function filterByRange<T extends { date: string }>(rows: readonly T[], range: RangeMs): T[] {
  return rows.filter((r) => {
    const dayStart = parseDayStartLocalMs(r.date)
    if (dayStart === null) return false
    return dayStart + DAY_MS > range.fromMs && dayStart < range.toMs
  })
}
