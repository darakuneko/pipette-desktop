// SPDX-License-Identifier: GPL-2.0-or-later
// Pure helpers for the Analyze period selector — extracted so the
// chart components (WPM / Interval / Heatmap) can share the same
// filter semantics without depending on React.

import type { PeriodKey } from './analyze-types'

function formatLocalDay(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, '0')
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Inclusive lower bound for `period`, in the `YYYY-MM-DD` form used
 * by `TypingDailySummary.date`. `'all'` returns `null` — callers skip
 * filtering entirely. The cutoff is computed in the user's local
 * timezone to match the SQL aggregation (`strftime(..., 'localtime')`);
 * using UTC here drifted the window by a day near local midnight. */
export function periodCutoffDay(period: PeriodKey, now: Date = new Date()): string | null {
  if (period === 'all') return null
  const days = period === '7d' ? 7 : 30
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1)
  return formatLocalDay(cutoff)
}

/** Keep entries whose `.date` is within the selected period. Summaries
 * arriving in any order are tolerated; no sorting is assumed. */
export function filterByPeriod<T extends { date: string }>(rows: readonly T[], period: PeriodKey, now?: Date): T[] {
  const cutoff = periodCutoffDay(period, now)
  if (cutoff === null) return rows.slice()
  return rows.filter((r) => r.date >= cutoff)
}

/** Inclusive lower bound for `period` as epoch ms — used by the
 * activity-grid IPC which groups by local time at the SQL layer and
 * therefore needs the cutoff in the same frame. Returns 0 for "all". */
export function periodSinceMs(period: PeriodKey, now: Date = new Date()): number {
  if (period === 'all') return 0
  const days = period === '7d' ? 7 : 30
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days + 1, 0, 0, 0, 0)
  return cutoff.getTime()
}
