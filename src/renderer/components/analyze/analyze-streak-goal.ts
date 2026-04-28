// SPDX-License-Identifier: GPL-2.0-or-later
// Pure helpers for the Analyze Streak / Goal summary cards.
//
// Daily summaries carry a local-calendar `date` (`YYYY-MM-DD`) produced
// by `strftime('%Y-%m-%d', ..., 'localtime')` on the main side, so all
// day-boundary logic here stays in the string domain — no TZ math at
// the renderer. Local `Date` arithmetic is only used to walk the
// calendar via `shiftLocalDate`, where DST-safe day stepping matters.
//
// goalHistory stores *retired* goal values keyed by the local date on
// which they were replaced (`effectiveFrom`). The active goal is
// `currentGoal`. `resolveGoalAt(history, currentGoal, date)` finds the
// retired entry whose local date is *strictly after* `date` (the
// entry was still authoritative for dates before its retirement); if
// none qualify, the active `currentGoal` applies.

import type { GoalHistoryEntry } from '../../../shared/types/pipette-settings'
import type { TypingDailySummary } from '../../../shared/types/typing-analytics'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** `YYYY-MM` (zero-padded). Mirrors `DATE_RE` for the YYYY-MM-DD case
 * — used by the calendar's monthly window cursor. */
export const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

export interface GoalPair {
  days: number
  keystrokes: number
}

export interface GoalCycleProgress {
  /** Consecutive goal-met days inside the current cycle (0..goalDays). */
  current: number
  /** Goal threshold active for the current cycle's last counted day.
   * Falls back to `currentGoal.days` when no run is in progress. */
  goalDays: number
}

export interface GoalAchievement {
  startDate: string
  endDate: string
  consecutiveDays: number
  keystrokesTotal: number
  averagePerDay: number
  goal: GoalPair
}

export function toLocalDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear().toString().padStart(4, '0')
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function shiftLocalDate(date: string, deltaDays: number): string {
  const d = parseLocalDate(date)
  if (!d) return date
  const shifted = new Date(d.getFullYear(), d.getMonth(), d.getDate() + deltaDays)
  return toLocalDate(shifted.getTime())
}

/** Local-wall-clock `YYYY-MM` for `ms`. Companion to `toLocalDate`. */
export function toLocalMonth(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear().toString().padStart(4, '0')
  const m = (d.getMonth() + 1).toString().padStart(2, '0')
  return `${y}-${m}`
}

/** Shift a `YYYY-MM` cursor by `deltaMonths`. Returns the input on
 * malformed strings so a one-off bad write can't crash the caller. */
export function shiftLocalMonth(month: string, deltaMonths: number): string {
  const m = MONTH_RE.exec(month)
  if (!m) return month
  const year = Number(m[1])
  const monthIdx = Number(m[2]) - 1
  const shifted = new Date(year, monthIdx + deltaMonths, 1)
  return toLocalMonth(shifted.getTime())
}

/** Parse `YYYY-MM-DD` into a local-midnight `Date`. Returns `null` for
 * malformed input so callers can short-circuit on bad data without a
 * try/catch. */
export function parseLocalDate(iso: string): Date | null {
  const m = DATE_RE.exec(iso)
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
}

export function daysBetween(a: string, b: string): number {
  const dA = parseLocalDate(a)
  const dB = parseLocalDate(b)
  if (dA === null || dB === null) return 0
  const diff = Math.abs(dA.getTime() - dB.getTime())
  return Math.round(diff / 86_400_000) + 1
}

/** Build a `date → keystrokes` map from a list of daily summaries. */
export function byDate(daily: ReadonlyArray<TypingDailySummary>): Map<string, number> {
  const map = new Map<string, number>()
  for (const row of daily) {
    const prev = map.get(row.date) ?? 0
    map.set(row.date, prev + row.keystrokes)
  }
  return map
}

/** Slice a daily-summary list to entries whose `date` falls inside
 * `[fromDate, toDate]` inclusive (lexicographic comparison works since
 * both ends use `YYYY-MM-DD`). The Summary cards (Today / WeeklyReport
 * via `sumWindow` / TypingProfile) all need the same windowed view —
 * this keeps the bounds check in one spot. */
export function filterDailyWindow(
  daily: ReadonlyArray<TypingDailySummary>,
  fromDate: string,
  toDate: string,
): TypingDailySummary[] {
  return daily.filter((d) => d.date >= fromDate && d.date <= toDate)
}

function hit(keystrokes: number | undefined, goalKeystrokes: number): boolean {
  return (keystrokes ?? 0) >= goalKeystrokes
}

/** Goal that was active on `targetDate`. `goalHistory` holds retired
 * values indexed by the local date when they were replaced — pick the
 * earliest retirement whose date is strictly after `targetDate`. When
 * nothing qualifies, the active `currentGoal` applies. */
export function resolveGoalAt(
  history: ReadonlyArray<GoalHistoryEntry>,
  currentGoal: GoalPair,
  targetDate: string,
): GoalPair {
  let best: GoalHistoryEntry | null = null
  let bestTs = Number.POSITIVE_INFINITY
  for (const entry of history) {
    const ts = Date.parse(entry.effectiveFrom)
    if (!Number.isFinite(ts)) continue
    if (toLocalDate(ts) <= targetDate) continue
    if (ts < bestTs) {
      best = entry
      bestTs = ts
    }
  }
  return best
    ? { days: best.days, keystrokes: best.keystrokes }
    : currentGoal
}

function sameGoal(a: GoalPair, b: GoalPair): boolean {
  return a.days === b.days && a.keystrokes === b.keystrokes
}

/** Longest-ever consecutive streak of goal-met days. Ignores
 * achievement reset semantics — answers "the most days I ever hit in a
 * row", not "the biggest completed cycle". Goal threshold follows
 * whatever was active on each date via `resolveGoalAt`. Gaps in the
 * calendar break the run; a goal change mid-run does *not* break the
 * counting ("was hit" is evaluated per-day independently). */
export function calcLongestStreak(
  map: Map<string, number>,
  history: ReadonlyArray<GoalHistoryEntry>,
  currentGoal: GoalPair,
): number {
  const dates = Array.from(map.keys()).sort()
  let longest = 0
  let run = 0
  let prevDate: string | null = null
  for (const date of dates) {
    const goal = resolveGoalAt(history, currentGoal, date)
    if (!hit(map.get(date), goal.keystrokes)) {
      run = 0
      prevDate = date
      continue
    }
    if (prevDate === null || shiftLocalDate(prevDate, 1) !== date) run = 1
    else run += 1
    if (run > longest) longest = run
    prevDate = date
  }
  return longest
}

/** Walk daily ASC, emit one achievement entry each time a run hits the
 * goal-days threshold, reset in place. Runs break on miss, gap, or
 * goal change — the goal in force at each date drives the comparison,
 * so a mid-run change invalidates the run (matches the UI's "reset
 * counter on settings change" contract). Runs that are still in
 * progress at the newest date are *not* emitted; the Current card
 * keeps them. */
export function detectGoalAchievements(
  map: Map<string, number>,
  history: ReadonlyArray<GoalHistoryEntry>,
  currentGoal: GoalPair,
): GoalAchievement[] {
  const dates = Array.from(map.keys()).sort()
  const out: GoalAchievement[] = []
  let runStart: string | null = null
  let runLen = 0
  let runKeystrokes = 0
  let runGoal: GoalPair | null = null
  let prevDate: string | null = null

  for (const date of dates) {
    const goal = resolveGoalAt(history, currentGoal, date)
    const ok = hit(map.get(date), goal.keystrokes)
    const broken = prevDate !== null && shiftLocalDate(prevDate, 1) !== date
    const goalChanged = runGoal !== null && !sameGoal(goal, runGoal)

    if (!ok || broken || goalChanged) {
      runStart = null
      runLen = 0
      runKeystrokes = 0
      runGoal = null
    }
    if (ok) {
      if (runGoal === null) {
        runStart = date
        runGoal = goal
      }
      runLen += 1
      runKeystrokes += map.get(date) ?? 0
      if (runLen >= runGoal.days && runStart !== null) {
        out.push({
          startDate: runStart,
          endDate: date,
          consecutiveDays: runLen,
          keystrokesTotal: runKeystrokes,
          averagePerDay: Math.round(runKeystrokes / runLen),
          goal: runGoal,
        })
        runStart = null
        runLen = 0
        runKeystrokes = 0
        runGoal = null
      }
    }
    prevDate = date
  }
  return out
}

/** Progress of the in-flight achievement cycle. Mirrors the scan in
 * `detectGoalAchievements` but stops at `today` and exposes the
 * leftover run that hasn't earned an achievement yet. Returns `0` when
 * the most recent hit day is older than yesterday — the "streak still
 * counts until tomorrow" rule. */
export function calcGoalCycleProgress(
  map: Map<string, number>,
  history: ReadonlyArray<GoalHistoryEntry>,
  currentGoal: GoalPair,
  today: string,
): GoalCycleProgress {
  const dates = Array.from(map.keys()).sort().filter((d) => d <= today)
  let runLen = 0
  let runGoal: GoalPair | null = null
  let prevDate: string | null = null

  for (const date of dates) {
    const goal = resolveGoalAt(history, currentGoal, date)
    const ok = hit(map.get(date), goal.keystrokes)
    const broken = prevDate !== null && shiftLocalDate(prevDate, 1) !== date
    const goalChanged = runGoal !== null && !sameGoal(goal, runGoal)

    if (!ok || broken || goalChanged) {
      runLen = 0
      runGoal = null
    }
    if (ok) {
      if (runGoal === null) runGoal = goal
      runLen += 1
      if (runLen >= runGoal.days) {
        runLen = 0
        runGoal = null
      }
    }
    prevDate = date
  }

  const yesterday = shiftLocalDate(today, -1)
  if (runLen > 0 && prevDate !== today && prevDate !== yesterday) {
    runLen = 0
    runGoal = null
  }

  return {
    current: runLen,
    goalDays: runGoal?.days ?? currentGoal.days,
  }
}
