// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import type {
  TypingDailySummary,
  TypingSessionRow,
} from '../../../../shared/types/typing-analytics'
import {
  buildCalendarGrid,
  CALENDAR_DOW_COUNT,
} from '../analyze-activity-calendar'

const DAY_MS = 86_400_000

function daily(date: string, keystrokes: number, activeMs: number): TypingDailySummary {
  return { date, keystrokes, activeMs }
}

function session(id: string, startLocal: [number, number, number], durationMs = 5 * 60_000): TypingSessionRow {
  const startMs = new Date(startLocal[0], startLocal[1] - 1, startLocal[2]).getTime() + 9 * 3_600_000
  return { id, startMs, endMs: startMs + durationMs }
}

describe('buildCalendarGrid (keystrokes)', () => {
  // 2026-04-19 is a Sunday (dow=0). A 7-day window starting on Sun
  // anchors weekIndex=0 with no leading blanks — easy to reason about
  // for the basic shape tests.
  const dateFromIso = '2026-04-19'
  const dateToIso = '2026-04-25'
  const dailyRows: TypingDailySummary[] = [
    daily('2026-04-19', 100, 60_000),
    daily('2026-04-20', 50, 30_000),
    daily('2026-04-22', 200, 120_000),
    // Out of range — must not contribute to summary or weeks.
    daily('2026-05-01', 999, 999_000),
  ]

  it('produces a 1-week 7-cell grid with no leading blanks for a Sun-aligned range', () => {
    const grid = buildCalendarGrid({
      daily: dailyRows,
      sessions: [],
      dateFromIso,
      dateToIso,
      valueMetric: 'keystrokes',
      normalization: 'absolute',
    })
    expect(grid.weekCount).toBe(1)
    expect(grid.weeks).toHaveLength(1)
    expect(grid.weeks[0]).toHaveLength(CALENDAR_DOW_COUNT)
    expect(grid.cellsByDate.size).toBe(7)
  })

  it('aggregates daily.keystrokes per cell and skips out-of-range rows', () => {
    const grid = buildCalendarGrid({
      daily: dailyRows,
      sessions: [],
      dateFromIso,
      dateToIso,
      valueMetric: 'keystrokes',
      normalization: 'absolute',
    })
    expect(grid.cellsByDate.get('2026-04-19')?.value).toBe(100)
    expect(grid.cellsByDate.get('2026-04-20')?.value).toBe(50)
    expect(grid.cellsByDate.get('2026-04-22')?.value).toBe(200)
    expect(grid.summary.totalValue).toBe(350)
    expect(grid.summary.activeDays).toBe(3)
    expect(grid.summary.peakDate).toBe('2026-04-22')
    expect(grid.summary.peakValue).toBe(200)
  })

  it('marks empty cells qualified=false with intensity=0', () => {
    const grid = buildCalendarGrid({
      daily: dailyRows,
      sessions: [],
      dateFromIso,
      dateToIso,
      valueMetric: 'keystrokes',
      normalization: 'absolute',
    })
    const empty = grid.cellsByDate.get('2026-04-21')
    expect(empty?.qualified).toBe(false)
    expect(empty?.intensity).toBe(0)
  })

  it('inserts leading blanks when range starts mid-week', () => {
    // 2026-04-21 is a Tuesday → 2 leading blanks (Sun, Mon).
    const grid = buildCalendarGrid({
      daily: dailyRows,
      sessions: [],
      dateFromIso: '2026-04-21',
      dateToIso: '2026-04-25',
      valueMetric: 'keystrokes',
      normalization: 'absolute',
    })
    expect(grid.weeks[0][0]).toBeNull() // Sun
    expect(grid.weeks[0][1]).toBeNull() // Mon
    expect(grid.weeks[0][2]?.date).toBe('2026-04-21')
    expect(grid.weeks[0][6]?.date).toBe('2026-04-25')
  })
})

describe('buildCalendarGrid (normalization)', () => {
  // Two-week sample: week 1 = [10, 0, 0, 0, 0, 0, 0], week 2 = [40, 0, 0, 0, 0, 0, 0].
  // Sundays only. shareOfWeekly should give intensity = 1 for both
  // populated cells (they're alone in their weeks); shareOfTotal
  // should split 0.2 vs 0.8.
  const dailyRows: TypingDailySummary[] = [
    daily('2026-04-19', 10, 60_000), // Sun, week 1
    daily('2026-04-26', 40, 60_000), // Sun, week 2
  ]

  it('absolute normalization scales by peak across the grid', () => {
    const grid = buildCalendarGrid({
      daily: dailyRows,
      sessions: [],
      dateFromIso: '2026-04-19',
      dateToIso: '2026-05-02',
      valueMetric: 'keystrokes',
      normalization: 'absolute',
    })
    expect(grid.cellsByDate.get('2026-04-19')?.intensity).toBeCloseTo(0.25, 5)
    expect(grid.cellsByDate.get('2026-04-26')?.intensity).toBe(1)
  })

  it('shareOfWeekly normalization saturates lonely weekly cells', () => {
    const grid = buildCalendarGrid({
      daily: dailyRows,
      sessions: [],
      dateFromIso: '2026-04-19',
      dateToIso: '2026-05-02',
      valueMetric: 'keystrokes',
      normalization: 'shareOfWeekly',
    })
    expect(grid.cellsByDate.get('2026-04-19')?.intensity).toBe(1)
    expect(grid.cellsByDate.get('2026-04-26')?.intensity).toBe(1)
  })

  it('shareOfTotal normalization scales by grand total', () => {
    const grid = buildCalendarGrid({
      daily: dailyRows,
      sessions: [],
      dateFromIso: '2026-04-19',
      dateToIso: '2026-05-02',
      valueMetric: 'keystrokes',
      normalization: 'shareOfTotal',
    })
    expect(grid.cellsByDate.get('2026-04-19')?.intensity).toBeCloseTo(0.2, 5)
    expect(grid.cellsByDate.get('2026-04-26')?.intensity).toBeCloseTo(0.8, 5)
  })
})

describe('buildCalendarGrid (wpm)', () => {
  it('derives wpm from keystrokes / activeMs (5 chars per word)', () => {
    // 100 keys in 60_000 ms → 60_000 / 1000 = 60 sec → 100 chars / 5 = 20 words → 20 WPM.
    const grid = buildCalendarGrid({
      daily: [daily('2026-04-19', 100, 60_000)],
      sessions: [],
      dateFromIso: '2026-04-19',
      dateToIso: '2026-04-19',
      valueMetric: 'wpm',
      normalization: 'absolute',
    })
    const cell = grid.cellsByDate.get('2026-04-19')
    expect(cell?.value).toBe(20)
    expect(cell?.qualified).toBe(true)
  })
})

describe('buildCalendarGrid (sessions)', () => {
  it('counts sessions whose startMs falls on each local date', () => {
    const sessions: TypingSessionRow[] = [
      session('a', [2026, 4, 19]),
      session('b', [2026, 4, 19]),
      session('c', [2026, 4, 22]),
      // Out-of-range: ignored.
      session('d', [2026, 5, 1]),
    ]
    const grid = buildCalendarGrid({
      daily: [],
      sessions,
      dateFromIso: '2026-04-19',
      dateToIso: '2026-04-25',
      valueMetric: 'sessions',
      normalization: 'absolute',
    })
    expect(grid.cellsByDate.get('2026-04-19')?.value).toBe(2)
    expect(grid.cellsByDate.get('2026-04-22')?.value).toBe(1)
    expect(grid.summary.totalValue).toBe(3)
    expect(grid.summary.peakValue).toBe(2)
  })
})

describe('buildCalendarGrid (edge cases)', () => {
  it('returns an empty grid when from > to', () => {
    const grid = buildCalendarGrid({
      daily: [daily('2026-04-19', 100, 60_000)],
      sessions: [],
      dateFromIso: '2026-04-25',
      dateToIso: '2026-04-19',
      valueMetric: 'keystrokes',
      normalization: 'absolute',
    })
    expect(grid.weekCount).toBe(0)
    expect(grid.weeks).toHaveLength(0)
    expect(grid.summary.totalDays).toBe(0)
  })

  it('grows to 54 columns for a leap year that opens on a Saturday', () => {
    // 2028-01-01 is Saturday (dow=6) and 2028 is a leap year (366 days).
    // 6 leading blanks + 366 days = 372 → ceil(372/7) = 54 columns.
    // The grid must paint the full range without dropping the tail.
    const dailyRows: TypingDailySummary[] = []
    let cur = new Date(2028, 0, 1)
    for (let i = 0; i < 366; i += 1) {
      const yyyy = cur.getFullYear()
      const mm = String(cur.getMonth() + 1).padStart(2, '0')
      const dd = String(cur.getDate()).padStart(2, '0')
      dailyRows.push(daily(`${yyyy}-${mm}-${dd}`, i % 2 === 0 ? 1 : 0, i % 2 === 0 ? 1000 : 0))
      cur = new Date(cur.getTime() + DAY_MS)
    }
    const grid = buildCalendarGrid({
      daily: dailyRows,
      sessions: [],
      dateFromIso: '2028-01-01',
      dateToIso: '2028-12-31',
      valueMetric: 'keystrokes',
      normalization: 'absolute',
    })
    expect(grid.weekCount).toBe(54)
    expect(grid.cellsByDate.size).toBe(366)
    // Last day must be present and aligned to dow=0 (2028-12-31 = Sun).
    const last = grid.cellsByDate.get('2028-12-31')
    expect(last).toBeDefined()
    expect(last?.dow).toBe(0)
    expect(last?.weekIndex).toBe(53)
  })

  it('summary.avgPerActiveDay is total / activeDays (zero when none)', () => {
    const grid = buildCalendarGrid({
      daily: [daily('2026-04-19', 200, 60_000), daily('2026-04-20', 100, 30_000)],
      sessions: [],
      dateFromIso: '2026-04-19',
      dateToIso: '2026-04-25',
      valueMetric: 'keystrokes',
      normalization: 'absolute',
    })
    expect(grid.summary.avgPerActiveDay).toBe(150)
  })

  it('summary.avgPerActiveDay is 0 when range has no activity', () => {
    const grid = buildCalendarGrid({
      daily: [],
      sessions: [],
      dateFromIso: '2026-04-19',
      dateToIso: '2026-04-25',
      valueMetric: 'keystrokes',
      normalization: 'absolute',
    })
    expect(grid.summary.avgPerActiveDay).toBe(0)
    expect(grid.summary.totalDays).toBe(7)
    expect(grid.summary.activeDays).toBe(0)
  })

  it('emits a month label at the first day of each month visible in range', () => {
    const grid = buildCalendarGrid({
      daily: [],
      sessions: [],
      dateFromIso: '2026-04-19',
      dateToIso: '2026-05-15',
      valueMetric: 'keystrokes',
      normalization: 'absolute',
    })
    // Range straddles April → May; we expect labels for both months.
    expect(grid.monthLabels).toContainEqual(expect.objectContaining({ year: 2026, month: 4 }))
    expect(grid.monthLabels).toContainEqual(expect.objectContaining({ year: 2026, month: 5 }))
  })
})
