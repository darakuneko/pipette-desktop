// SPDX-License-Identifier: GPL-2.0-or-later
// Weekly Report aggregation. Derives "last 7 days" vs "the 7 days
// before that" totals from the same daily-summary payload the Summary
// tab already pulls. The trend is suppressed (no arrow, no percent)
// when the comparison sample is too small to be meaningful — the
// minimum sample threshold lives here so the renderer doesn't have
// to encode it.

import type { TypingDailySummary } from '../../../shared/types/typing-analytics'
import { computeWpm } from './analyze-wpm'
import { filterDailyWindow, shiftLocalDate } from './analyze-streak-goal'

/** Day window: most recent (today) is `[today - 6, today]`, the
 * comparison window is `[today - 13, today - 7]`. Inclusive on both
 * ends. */
export const REPORT_DAYS = 7
/** When the previous period has fewer keystrokes than this, we suppress
 * the percentage and arrow. The threshold matches the Phase 2 task doc
 * sketch ("前期間 100 events 未満なら N/A"); kept low so a single
 * decent typing day already counts. */
export const REPORT_MIN_SAMPLE_KEYSTROKES = 100
/** Below this absolute relative change the trend is rendered as
 * "flat". The number matches the task doc sketch (`±5%`). */
export const REPORT_FLAT_TOLERANCE_PCT = 5

export type Trend = 'up' | 'down' | 'flat'

export interface WeeklyTotals {
  keystrokes: number
  activeMs: number
  /** Days within the window that recorded any keystrokes. */
  activeDays: number
}

export interface WeeklyDelta {
  /** `null` when previous-period keystrokes are below the minimum
   * sample — the renderer should show a single "no comparison" line in
   * that case instead of a possibly misleading percentage. */
  changePct: number | null
  /** Always populated, even when `changePct` is null, so the renderer
   * can still show a neutral arrow if it wants. */
  trend: Trend
}

export interface WeeklyReport {
  current: WeeklyTotals
  previous: WeeklyTotals
  /** WPM is derived from the period totals (not averaged across days)
   * so the metric matches the time-weighted figures shown elsewhere. */
  currentWpm: number
  previousWpm: number
  /** Per-metric deltas, all gated by the same `previous.keystrokes`
   * sample threshold so a "weak" comparison week suppresses every
   * arrow at once. */
  keystrokesDelta: WeeklyDelta
  wpmDelta: WeeklyDelta
  activeDaysDelta: WeeklyDelta
}

function emptyTotals(): WeeklyTotals {
  return { keystrokes: 0, activeMs: 0, activeDays: 0 }
}

function sumWindow(
  daily: ReadonlyArray<TypingDailySummary>,
  fromDate: string,
  toDate: string,
): WeeklyTotals {
  const totals = emptyTotals()
  for (const d of filterDailyWindow(daily, fromDate, toDate)) {
    totals.keystrokes += d.keystrokes
    totals.activeMs += d.activeMs
    if (d.keystrokes > 0) totals.activeDays += 1
  }
  return totals
}

function computeDelta(
  current: number,
  previous: number,
  previousKeystrokes: number,
): WeeklyDelta {
  if (previousKeystrokes < REPORT_MIN_SAMPLE_KEYSTROKES) {
    return { changePct: null, trend: 'flat' }
  }
  if (previous === 0) {
    return current > 0
      ? { changePct: null, trend: 'up' }
      : { changePct: 0, trend: 'flat' }
  }
  const pct = ((current - previous) / previous) * 100
  if (Math.abs(pct) < REPORT_FLAT_TOLERANCE_PCT) {
    return { changePct: pct, trend: 'flat' }
  }
  return { changePct: pct, trend: pct > 0 ? 'up' : 'down' }
}

/** Compute the weekly report for the local-day pivot `today`. The
 * caller passes the cross-machine `daily` array — the comparison logic
 * is data-source agnostic, so swapping in scoped data changes only the
 * inputs, not this function. */
export function computeWeeklyReport(
  daily: ReadonlyArray<TypingDailySummary>,
  today: string,
): WeeklyReport {
  const currentFrom = shiftLocalDate(today, -(REPORT_DAYS - 1))
  const previousTo = shiftLocalDate(today, -REPORT_DAYS)
  const previousFrom = shiftLocalDate(today, -(REPORT_DAYS * 2 - 1))
  const current = sumWindow(daily, currentFrom, today)
  const previous = sumWindow(daily, previousFrom, previousTo)
  const currentWpm = computeWpm(current.keystrokes, current.activeMs)
  const previousWpm = computeWpm(previous.keystrokes, previous.activeMs)
  return {
    current,
    previous,
    currentWpm,
    previousWpm,
    keystrokesDelta: computeDelta(current.keystrokes, previous.keystrokes, previous.keystrokes),
    wpmDelta: computeDelta(currentWpm, previousWpm, previous.keystrokes),
    activeDaysDelta: computeDelta(current.activeDays, previous.activeDays, previous.keystrokes),
  }
}
