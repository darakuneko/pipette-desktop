// SPDX-License-Identifier: GPL-2.0-or-later
// Activity > Calendar aggregations. Builds a year-style heatmap grid
// (≤ 54 columns × 7 rows) from per-day analytics.
//
// Three independent inputs feed three value metrics:
//   - `keystrokes`: sum of `daily.keystrokes` for the cell's date.
//   - `wpm`: WPM derived from the day's pooled `keystrokes / activeMs`
//     (same formula `computeWpm` uses everywhere else).
//   - `sessions`: count of `TypingSessionRow` whose **start** falls on
//     the cell's local date. The DB returns sessions by `start_ms`
//     window membership (not interval intersection), so the cell value
//     and tooltip wording must say "started", not "active".
//
// The grid axis is anchored at `dateFromIso`: the first week column may
// have leading blanks to keep dow rows aligned (Sun=row 0). Trailing
// blanks appear after `dateToIso`. Total column count is dynamic to
// accommodate the leap year + Sat-Jan-1 case (366 days + 6 blanks = 372,
// which needs 54 columns).

import type {
  TypingDailySummary,
  TypingSessionRow,
} from '../../../shared/types/typing-analytics'
import type {
  ActivityCalendarNormalization,
  ActivityMetric,
} from '../../../shared/types/analyze-filters'
import { computeWpm } from './analyze-wpm'
import { parseLocalDate, shiftLocalDate, toLocalDate } from './analyze-streak-goal'

/** Sun = 0 … Sat = 6 (matches JS `Date.prototype.getDay()`). */
export const CALENDAR_DOW_COUNT = 7

export interface CalendarCell {
  /** Local YYYY-MM-DD. */
  date: string
  /** Sun=0 … Sat=6. */
  dow: number
  /** Column index in the dynamic grid; 0 = the column containing
   * `dateFromIso`. */
  weekIndex: number
  /** Raw metric value. `keystrokes` / `sessions` are non-negative
   * integers; `wpm` is `computeWpm(...)` output (≥ 0, finite). */
  value: number
  /** Color-ramp intensity in `[0, 1]`. Always 0 when `value === 0` so
   * the chart can short-circuit zero cells to a neutral fill. */
  intensity: number
  /** Convenience flag for the chart: `value > 0`. */
  qualified: boolean
  /** Active duration in ms — only populated for `keystrokes` / `wpm`
   * metrics (the source `daily` rows carry it). Cell tooltip uses this
   * to show "minutes active" alongside the keystroke count. */
  activeMs: number
}

export interface CalendarSummary {
  valueMetric: ActivityMetric
  totalDays: number
  activeDays: number
  totalValue: number
  peakDate: string | null
  peakValue: number
  /** `totalValue / activeDays` — undefined when `activeDays === 0`,
   * surfaced as `0` so the UI doesn't have to branch. */
  avgPerActiveDay: number
  /** Pooled active duration across the range — populated for
   * `keystrokes` / `wpm` metrics, `0` for `sessions`. */
  totalActiveMs: number
}

export interface CalendarGrid {
  /** `weeks[w][d]` — `weeks[weekIndex][dow]`. `null` cells are
   * leading / trailing blanks (before `dateFromIso` or after `dateToIso`)
   * the chart uses to keep dow rows aligned. */
  weeks: ReadonlyArray<ReadonlyArray<CalendarCell | null>>
  cellsByDate: Map<string, CalendarCell>
  weekCount: number
  /** Month-label anchors. Each entry pins a month's short label to the
   * column where its first day (or the range start, whichever is later)
   * falls — the chart renders the labels above the grid. Months with
   * no visible cell in the range are omitted. */
  monthLabels: ReadonlyArray<{ year: number; month: number; weekIndex: number }>
  summary: CalendarSummary
}

export interface BuildCalendarGridInput {
  /** Daily summaries spanning at least the requested range. Entries
   * outside `[dateFromIso, dateToIso]` are ignored. */
  daily: ReadonlyArray<TypingDailySummary>
  /** Live session rows. Bucketed by the local date of `startMs`; only
   * consulted when `valueMetric === 'sessions'`. Pass `[]` (or any
   * value) for the other metrics — it's ignored. */
  sessions: ReadonlyArray<TypingSessionRow>
  /** Inclusive start of the visible range (YYYY-MM-DD, local). */
  dateFromIso: string
  /** Inclusive end of the visible range (YYYY-MM-DD, local). */
  dateToIso: string
  valueMetric: ActivityMetric
  normalization: ActivityCalendarNormalization
}

/** Day-of-week (0=Sun..6=Sat) for a `YYYY-MM-DD` local date. Returns
 * `0` for malformed input — the caller's range walk would have already
 * bailed in that case so the value never reaches the grid. */
function dowFromIso(iso: string): number {
  const d = parseLocalDate(iso)
  return d ? d.getDay() : 0
}

/** Inclusive day count between two `YYYY-MM-DD` dates (`from <= to`).
 * Returns `0` when either date is malformed or `from > to`. */
function inclusiveDayCount(fromIso: string, toIso: string): number {
  const a = parseLocalDate(fromIso)
  const b = parseLocalDate(toIso)
  if (!a || !b) return 0
  const diff = Math.round((b.getTime() - a.getTime()) / 86_400_000)
  if (diff < 0) return 0
  return diff + 1
}

/** Walk the inclusive `[fromIso, toIso]` range, yielding each local
 * date's ISO string. DST-safe via `shiftLocalDate` so the walk is
 * stable across spring-forward / fall-back. */
function eachDateInRange(fromIso: string, toIso: string): string[] {
  const total = inclusiveDayCount(fromIso, toIso)
  if (total === 0) return []
  const out: string[] = new Array(total)
  let cur = fromIso
  for (let i = 0; i < total; i += 1) {
    out[i] = cur
    cur = shiftLocalDate(cur, 1)
  }
  return out
}

/** Sum `daily.keystrokes` per local date inside the range. Multiple
 * rows for the same date (e.g. cross-machine aggregation that wasn't
 * collapsed at fetch) contribute additively. */
function bucketKeystrokes(
  daily: ReadonlyArray<TypingDailySummary>,
  fromIso: string,
  toIso: string,
): Map<string, { keystrokes: number; activeMs: number }> {
  const out = new Map<string, { keystrokes: number; activeMs: number }>()
  for (const row of daily) {
    if (row.date < fromIso || row.date > toIso) continue
    const prev = out.get(row.date)
    if (prev) {
      prev.keystrokes += row.keystrokes
      prev.activeMs += Math.max(0, row.activeMs)
    } else {
      out.set(row.date, {
        keystrokes: row.keystrokes,
        activeMs: Math.max(0, row.activeMs),
      })
    }
  }
  return out
}

/** Count sessions that **started** on each local date inside the range.
 * The cell tooltip wording must match this semantic — see file header
 * for the SQL contract that justifies it. */
function bucketSessions(
  sessions: ReadonlyArray<TypingSessionRow>,
  fromIso: string,
  toIso: string,
): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of sessions) {
    if (!Number.isFinite(row.startMs)) continue
    const date = toLocalDate(row.startMs)
    if (date < fromIso || date > toIso) continue
    out.set(date, (out.get(date) ?? 0) + 1)
  }
  return out
}

/** Per-cell value for the chosen metric. WPM is computed from the same
 * `keystrokes / activeMs` pool that minute-stats uses, so the calendar
 * lines up with the existing WPM tab when both are pointed at one day. */
function valueForCell(
  metric: ActivityMetric,
  date: string,
  dailyMap: Map<string, { keystrokes: number; activeMs: number }>,
  sessionsMap: Map<string, number>,
): { value: number; activeMs: number } {
  if (metric === 'sessions') {
    return { value: sessionsMap.get(date) ?? 0, activeMs: 0 }
  }
  const d = dailyMap.get(date)
  if (!d) return { value: 0, activeMs: 0 }
  if (metric === 'keystrokes') return { value: d.keystrokes, activeMs: d.activeMs }
  // WPM
  return { value: computeWpm(d.keystrokes, d.activeMs), activeMs: d.activeMs }
}

export function buildCalendarGrid(input: BuildCalendarGridInput): CalendarGrid {
  const { daily, sessions, dateFromIso, dateToIso, valueMetric, normalization } = input
  const totalDays = inclusiveDayCount(dateFromIso, dateToIso)
  if (totalDays === 0) {
    return {
      weeks: [],
      cellsByDate: new Map(),
      weekCount: 0,
      monthLabels: [],
      summary: emptySummary(valueMetric),
    }
  }

  const dailyMap = bucketKeystrokes(daily, dateFromIso, dateToIso)
  const sessionsMap = valueMetric === 'sessions'
    ? bucketSessions(sessions, dateFromIso, dateToIso)
    : new Map<string, number>()

  // Leading blanks: dow of `dateFromIso` decides how many empty Sun…
  // cells precede the first real day. Range start of Sun → 0 blanks.
  const leadingBlanks = dowFromIso(dateFromIso)
  const occupied = leadingBlanks + totalDays
  const weekCount = Math.ceil(occupied / CALENDAR_DOW_COUNT)

  // Allocate the `weeks[][]` matrix up-front so the chart can index by
  // (weekIndex, dow) without hitting `undefined` for trailing blanks.
  const weeks: (CalendarCell | null)[][] = []
  for (let w = 0; w < weekCount; w += 1) {
    weeks.push(new Array<CalendarCell | null>(CALENDAR_DOW_COUNT).fill(null))
  }

  // First pass: write raw values. Track sums per week (for shareOfWeekly)
  // and grand totals (for shareOfTotal + summary).
  const weekSums = new Array<number>(weekCount).fill(0)
  let totalValue = 0
  let totalActiveMs = 0
  let activeDays = 0
  let peakValue = 0
  let peakDate: string | null = null
  const cellsByDate = new Map<string, CalendarCell>()
  const dates = eachDateInRange(dateFromIso, dateToIso)

  for (let i = 0; i < dates.length; i += 1) {
    const date = dates[i]
    // Derive `dow` from grid position rather than re-parsing the ISO —
    // `leadingBlanks` is already `dateFromIso`'s dow and the loop index
    // walks one calendar day at a time, so column position maps 1:1 to
    // the day-of-week.
    const offset = leadingBlanks + i
    const dow = offset % CALENDAR_DOW_COUNT
    const weekIndex = Math.floor(offset / CALENDAR_DOW_COUNT)
    const { value, activeMs } = valueForCell(valueMetric, date, dailyMap, sessionsMap)
    const qualified = value > 0
    if (qualified) {
      activeDays += 1
      totalValue += value
      weekSums[weekIndex] += value
      if (value > peakValue) {
        peakValue = value
        peakDate = date
      }
    }
    totalActiveMs += activeMs
    const cell: CalendarCell = {
      date,
      dow,
      weekIndex,
      value,
      // Intensity is filled in the second pass once we know the
      // normalization denominator across the whole grid.
      intensity: 0,
      qualified,
      activeMs,
    }
    weeks[weekIndex][dow] = cell
    cellsByDate.set(date, cell)
  }

  // Second pass: fill `intensity` with the chosen normalization. Each
  // mode has its own denominator; clamp to `[0, 1]` so a tiny float
  // overshoot doesn't tilt the color ramp past its top step.
  for (const cell of cellsByDate.values()) {
    if (!cell.qualified) {
      cell.intensity = 0
      continue
    }
    cell.intensity = computeIntensity({
      value: cell.value,
      weekSum: weekSums[cell.weekIndex],
      peakValue,
      totalValue,
      normalization,
    })
  }

  return {
    weeks,
    cellsByDate,
    weekCount,
    monthLabels: buildMonthLabels(dates, leadingBlanks),
    summary: {
      valueMetric,
      totalDays,
      activeDays,
      totalValue,
      peakDate,
      peakValue,
      avgPerActiveDay: activeDays === 0 ? 0 : totalValue / activeDays,
      totalActiveMs,
    },
  }
}

function emptySummary(valueMetric: ActivityMetric): CalendarSummary {
  return {
    valueMetric,
    totalDays: 0,
    activeDays: 0,
    totalValue: 0,
    peakDate: null,
    peakValue: 0,
    avgPerActiveDay: 0,
    totalActiveMs: 0,
  }
}

interface IntensityInput {
  value: number
  weekSum: number
  peakValue: number
  totalValue: number
  normalization: ActivityCalendarNormalization
}

function computeIntensity(i: IntensityInput): number {
  if (!Number.isFinite(i.value) || i.value <= 0) return 0
  const denom =
    i.normalization === 'shareOfWeekly'
      ? i.weekSum
      : i.normalization === 'shareOfTotal'
        ? i.totalValue
        : i.peakValue
  if (!Number.isFinite(denom) || denom <= 0) return 0
  const t = i.value / denom
  if (!Number.isFinite(t) || t <= 0) return 0
  return t > 1 ? 1 : t
}

/** Pin month labels to the leftmost column where each month is visible.
 * `Jan` always lands on the column that contains the range start (or
 * Jan 1 if the range opens mid-month). Months with no visible day in
 * the range are skipped so the label row stays uncluttered. */
function buildMonthLabels(
  dates: ReadonlyArray<string>,
  leadingBlanks: number,
): ReadonlyArray<{ year: number; month: number; weekIndex: number }> {
  const out: { year: number; month: number; weekIndex: number }[] = []
  let lastYearMonth = ''
  for (let i = 0; i < dates.length; i += 1) {
    const d = parseLocalDate(dates[i])
    if (!d) continue
    const year = d.getFullYear()
    const month = d.getMonth() + 1
    const key = `${year}-${month}`
    if (key === lastYearMonth) continue
    lastYearMonth = key
    out.push({
      year,
      month,
      weekIndex: Math.floor((leadingBlanks + i) / CALENDAR_DOW_COUNT),
    })
  }
  return out
}
