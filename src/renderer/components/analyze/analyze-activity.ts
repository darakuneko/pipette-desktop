// SPDX-License-Identifier: GPL-2.0-or-later
// Activity-tab aggregations. Feeds the 24 × 7 grid in both metric
// modes:
//
//  - `keystrokes`: renders the sum of key presses per (dow, hour) cell
//    with opacity scaling linearly to the peak cell — same behaviour
//    the tab has always had.
//  - `wpm`: same grid, but the cell value is WPM derived from the
//    pooled keystrokes / activeMs of that (dow, hour) pair. Cells
//    below `minActiveMs` are surfaced but tagged `qualified = false`
//    so the chart can de-saturate them and the summary peak / lowest
//    cell skips them.
//
// We always build the grid from minute-raw rows (the WPM mode needs
// `activeMs`, which the `ListActivityGrid` IPC doesn't return), and
// the keystrokes sum matches the SQL aggregate because both end up
// summing `keystrokes` over the same underlying minutes.

import type { TypingMinuteStatsRow } from '../../../shared/types/typing-analytics'
import { computeWpm, isWpmQualified } from './analyze-wpm'
import type { RangeMs } from './analyze-types'

/** Grid axes — 0 = Sun … 6 = Sat (matches SQLite's `strftime('%w')`
 * and JavaScript's `Date.prototype.getDay()`). */
export const ACTIVITY_DOW_COUNT = 7
export const ACTIVITY_HOUR_COUNT = 24
export const ACTIVITY_CELL_COUNT = ACTIVITY_DOW_COUNT * ACTIVITY_HOUR_COUNT

export interface ActivityCell {
  dow: number
  hour: number
  keystrokes: number
  activeMs: number
  /** WPM derived from this cell's keystrokes / activeMs. 0 when the
   * cell has no activity. */
  wpm: number
  /** `true` when the cell meets `minActiveMs` and counts toward the
   * WPM peak / lowest selection. Always true when the threshold is 0. */
  qualified: boolean
}

export interface ActivityKeystrokesSummary {
  totalKeystrokes: number
  activeMs: number
  peakCell: ActivityCell | null
  /** Day-of-week whose cells sum to the highest total keystroke count. */
  mostFrequentDow: { dow: number; keystrokes: number } | null
  /** Hour-of-day (pooled across every dow) with the highest keystroke
   * count — "what time of day do I type the most, regardless of day". */
  mostFrequentHour: { hour: number; keystrokes: number } | null
  activeCells: number
}

export interface ActivityWpmSummary {
  totalKeystrokes: number
  activeMs: number
  overallWpm: number
  peakCell: ActivityCell | null
  lowestCell: ActivityCell | null
  activeCells: number
}

export interface ActivityGridResult {
  cells: ActivityCell[]
  /** Peak keystroke count across every cell — `ActivityChart` uses it
   * as the linear-opacity ceiling in keystrokes mode. */
  maxKeystrokes: number
  /** Peak WPM across every cell — ceiling for WPM-mode opacity. */
  maxWpm: number
  keystrokesSummary: ActivityKeystrokesSummary
  wpmSummary: ActivityWpmSummary
}

export interface ActivityGridInput {
  rows: readonly TypingMinuteStatsRow[]
  range: RangeMs
  minActiveMs: number
}

export function buildActivityGrid({
  rows,
  range,
  minActiveMs,
}: ActivityGridInput): ActivityGridResult {
  const keystrokesPerCell = new Array<number>(ACTIVITY_CELL_COUNT).fill(0)
  const activeMsPerCell = new Array<number>(ACTIVITY_CELL_COUNT).fill(0)
  let totalKeystrokes = 0
  let totalActiveMs = 0

  for (const r of rows) {
    if (r.minuteMs < range.fromMs || r.minuteMs >= range.toMs) continue
    if (r.keystrokes <= 0) continue
    const d = new Date(r.minuteMs)
    const dow = d.getDay()
    const hour = d.getHours()
    if (dow < 0 || dow > 6 || hour < 0 || hour > 23) continue
    const idx = dow * ACTIVITY_HOUR_COUNT + hour
    keystrokesPerCell[idx] += r.keystrokes
    activeMsPerCell[idx] += Math.max(0, r.activeMs)
    totalKeystrokes += r.keystrokes
    totalActiveMs += Math.max(0, r.activeMs)
  }

  const cells: ActivityCell[] = []
  let maxKeystrokes = 0
  let maxWpm = 0
  let peakKsCell: ActivityCell | null = null
  let peakWpmCell: ActivityCell | null = null
  let lowestWpmCell: ActivityCell | null = null
  let activeCells = 0
  const dowTotals = new Array<number>(ACTIVITY_DOW_COUNT).fill(0)
  const hourTotals = new Array<number>(ACTIVITY_HOUR_COUNT).fill(0)

  for (let dow = 0; dow < ACTIVITY_DOW_COUNT; dow += 1) {
    for (let hour = 0; hour < ACTIVITY_HOUR_COUNT; hour += 1) {
      const idx = dow * ACTIVITY_HOUR_COUNT + hour
      const keystrokes = keystrokesPerCell[idx]
      const activeMs = activeMsPerCell[idx]
      const wpm = computeWpm(keystrokes, activeMs)
      const qualified = isWpmQualified(keystrokes, activeMs, wpm, minActiveMs)
      const cell: ActivityCell = { dow, hour, keystrokes, activeMs, wpm, qualified }
      cells.push(cell)
      if (activeMs > 0) activeCells += 1
      dowTotals[dow] += keystrokes
      hourTotals[hour] += keystrokes
      if (keystrokes > maxKeystrokes) {
        maxKeystrokes = keystrokes
        peakKsCell = cell
      }
      // `maxWpm` drives the opacity ceiling and must include every
      // cell with WPM data — otherwise a window where nothing clears
      // `minActiveMs` would collapse to `maxWpm === 0` and the chart
      // would render as "no data" even though there are cells to
      // desaturate. Peak / lowest summaries still respect `qualified`.
      if (wpm > maxWpm) maxWpm = wpm
      if (qualified) {
        if (peakWpmCell === null || wpm > peakWpmCell.wpm) peakWpmCell = cell
        if (lowestWpmCell === null || wpm < lowestWpmCell.wpm) lowestWpmCell = cell
      }
    }
  }

  return {
    cells,
    maxKeystrokes,
    maxWpm,
    keystrokesSummary: {
      totalKeystrokes,
      activeMs: totalActiveMs,
      peakCell: peakKsCell,
      mostFrequentDow: pickMaxIndex(dowTotals, (dow, keystrokes) => ({ dow, keystrokes })),
      mostFrequentHour: pickMaxIndex(hourTotals, (hour, keystrokes) => ({ hour, keystrokes })),
      activeCells,
    },
    wpmSummary: {
      totalKeystrokes,
      activeMs: totalActiveMs,
      overallWpm: computeWpm(totalKeystrokes, totalActiveMs),
      peakCell: peakWpmCell,
      lowestCell: lowestWpmCell,
      activeCells,
    },
  }
}

function pickMaxIndex<T>(
  values: readonly number[],
  build: (index: number, value: number) => T,
): T | null {
  let best = -1
  let bestValue = 0
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > bestValue) {
      bestValue = values[i]
      best = i
    }
  }
  return best < 0 ? null : build(best, bestValue)
}
