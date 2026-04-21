// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import type { TypingMinuteStatsRow } from '../../../../shared/types/typing-analytics'
import { ACTIVITY_CELL_COUNT, buildActivityGrid } from '../analyze-activity'

const MINUTE = 60_000
const HOUR = MINUTE * 60

function row(minuteMs: number, overrides: Partial<TypingMinuteStatsRow> = {}): TypingMinuteStatsRow {
  return {
    minuteMs,
    keystrokes: 30,
    activeMs: 30_000,
    intervalMinMs: null,
    intervalP25Ms: null,
    intervalP50Ms: null,
    intervalP75Ms: null,
    intervalMaxMs: null,
    ...overrides,
  }
}

describe('buildActivityGrid', () => {
  // Base timestamp anchored to a known (dow, hour): 2026-04-21 is a
  // Tuesday (dow=2). Using 00:00 keeps arithmetic predictable regardless
  // of the test machine's locale.
  const base = new Date(2026, 3, 21, 0, 0, 0, 0).getTime()
  const range = { fromMs: base, toMs: base + HOUR * 24 * 8 }

  it('produces 7 × 24 cells even when no rows contribute', () => {
    const out = buildActivityGrid({ rows: [], range, minActiveMs: 60_000 })
    expect(out.cells).toHaveLength(ACTIVITY_CELL_COUNT)
    expect(out.maxKeystrokes).toBe(0)
    expect(out.maxWpm).toBe(0)
    expect(out.keystrokesSummary.peakCell).toBeNull()
    expect(out.wpmSummary.peakCell).toBeNull()
    expect(out.keystrokesSummary.activeCells).toBe(0)
  })

  it('aggregates keystrokes / activeMs by local (dow, hour) cell', () => {
    const rows: TypingMinuteStatsRow[] = [
      row(base + 9 * HOUR, { keystrokes: 100, activeMs: 60_000 }),
      row(base + 9 * HOUR + MINUTE, { keystrokes: 50, activeMs: 30_000 }),
      row(base + 24 * HOUR + 13 * HOUR, { keystrokes: 20, activeMs: 10_000 }),
    ]
    const out = buildActivityGrid({ rows, range, minActiveMs: 1 })
    // Tuesday 09:00 (dow=2, hour=9) received 150 keys / 90s.
    const tue9 = out.cells.find((c) => c.dow === 2 && c.hour === 9)
    expect(tue9?.keystrokes).toBe(150)
    expect(tue9?.activeMs).toBe(90_000)
    // Wednesday 13:00 (dow=3, hour=13) received 20 keys.
    const wed13 = out.cells.find((c) => c.dow === 3 && c.hour === 13)
    expect(wed13?.keystrokes).toBe(20)
    expect(out.keystrokesSummary.totalKeystrokes).toBe(170)
    expect(out.keystrokesSummary.activeMs).toBe(100_000)
    expect(out.keystrokesSummary.peakCell?.dow).toBe(2)
    expect(out.keystrokesSummary.peakCell?.hour).toBe(9)
    expect(out.keystrokesSummary.activeCells).toBe(2)
    expect(out.keystrokesSummary.mostFrequentDow?.dow).toBe(2)
    expect(out.keystrokesSummary.mostFrequentHour?.hour).toBe(9)
  })

  it('gates WPM peak / lowest on minActiveMs but keeps cells in the grid', () => {
    const rows: TypingMinuteStatsRow[] = [
      // Two qualifying cells (well above 60s each):
      row(base + 9 * HOUR, { keystrokes: 400, activeMs: 60_000 }),   // Tue 09:00 → 80 WPM
      row(base + 14 * HOUR, { keystrokes: 200, activeMs: 60_000 }),  // Tue 14:00 → 40 WPM
      // Trivial cell (5s active) — below threshold:
      row(base + 22 * HOUR, { keystrokes: 5, activeMs: 5_000 }),     // Tue 22:00 → 12 WPM
    ]
    const out = buildActivityGrid({ rows, range, minActiveMs: 60_000 })
    const tue22 = out.cells.find((c) => c.dow === 2 && c.hour === 22)
    expect(tue22?.qualified).toBe(false)
    expect(out.wpmSummary.peakCell?.hour).toBe(9)
    expect(out.wpmSummary.lowestCell?.hour).toBe(14)
    expect(out.wpmSummary.activeCells).toBe(3)
  })

  it('ignores rows outside the range', () => {
    const rows: TypingMinuteStatsRow[] = [
      row(range.fromMs - HOUR, { keystrokes: 999, activeMs: 120_000 }),
      row(range.toMs + HOUR, { keystrokes: 999, activeMs: 120_000 }),
      row(base + 10 * HOUR, { keystrokes: 50, activeMs: 30_000 }),
    ]
    const out = buildActivityGrid({ rows, range, minActiveMs: 1 })
    expect(out.keystrokesSummary.totalKeystrokes).toBe(50)
    expect(out.keystrokesSummary.activeCells).toBe(1)
  })

  it('keeps maxWpm non-zero when cells exist but none qualify — peak cell stays null', () => {
    const rows: TypingMinuteStatsRow[] = [
      row(base + 2 * HOUR, { keystrokes: 10, activeMs: 5_000 }),   // 24 WPM, below threshold
      row(base + 5 * HOUR, { keystrokes: 8, activeMs: 6_000 }),    // below threshold
    ]
    const out = buildActivityGrid({ rows, range, minActiveMs: 60_000 })
    expect(out.maxWpm).toBeGreaterThan(0) // ensures the grid renders (not "no data")
    expect(out.wpmSummary.peakCell).toBeNull() // but the peak is absent
    expect(out.wpmSummary.lowestCell).toBeNull()
  })

  it('drops rows with zero keystrokes before aggregating', () => {
    const rows: TypingMinuteStatsRow[] = [
      row(base + 10 * HOUR, { keystrokes: 0, activeMs: 120_000 }),
      row(base + 10 * HOUR, { keystrokes: 40, activeMs: 30_000 }),
    ]
    const out = buildActivityGrid({ rows, range, minActiveMs: 1 })
    expect(out.keystrokesSummary.totalKeystrokes).toBe(40)
  })
})
