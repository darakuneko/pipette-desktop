// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  computeWeeklyReport,
  REPORT_FLAT_TOLERANCE_PCT,
  REPORT_MIN_SAMPLE_KEYSTROKES,
} from '../analyze-weekly-report'

const TODAY = '2026-04-27'

function day(date: string, keystrokes: number, activeMs: number) {
  return { date, keystrokes, activeMs }
}

describe('computeWeeklyReport', () => {
  it('separates current 7 days from the previous 7 days', () => {
    const daily = [
      // Current window: 2026-04-21..27 (today included)
      day('2026-04-27', 1000, 600_000),
      day('2026-04-26', 2000, 1_200_000),
      day('2026-04-21', 500, 300_000),
      // Previous window: 2026-04-14..20
      day('2026-04-20', 800, 500_000),
      day('2026-04-14', 200, 100_000),
      // Older — must be ignored.
      day('2026-04-13', 9_999, 9_999_000),
    ]
    const r = computeWeeklyReport(daily, TODAY)
    expect(r.current.keystrokes).toBe(3500)
    expect(r.current.activeDays).toBe(3)
    expect(r.previous.keystrokes).toBe(1000)
    expect(r.previous.activeDays).toBe(2)
  })

  it('classifies trends within and outside the flat tolerance', () => {
    const flat = [
      // Need previous keystrokes >= REPORT_MIN_SAMPLE_KEYSTROKES so the
      // delta isn't suppressed.
      day('2026-04-27', 1020, 600_000),
      day('2026-04-20', 1000, 600_000),
    ]
    expect(computeWeeklyReport(flat, TODAY).keystrokesDelta.trend).toBe('flat')
    const up = [
      day('2026-04-27', 2000, 600_000),
      day('2026-04-20', 1000, 600_000),
    ]
    expect(computeWeeklyReport(up, TODAY).keystrokesDelta.trend).toBe('up')
    const down = [
      day('2026-04-27', 500, 600_000),
      day('2026-04-20', 1000, 600_000),
    ]
    expect(computeWeeklyReport(down, TODAY).keystrokesDelta.trend).toBe('down')
    // Sanity: the flat tolerance constant is the contract this test
    // depends on; a future change should break the comparison above.
    expect(REPORT_FLAT_TOLERANCE_PCT).toBeGreaterThan(0)
  })

  it('suppresses the percentage when the previous period is below the min sample', () => {
    const daily = [
      day('2026-04-27', 5000, 600_000),
      day('2026-04-20', REPORT_MIN_SAMPLE_KEYSTROKES - 1, 60_000),
    ]
    const r = computeWeeklyReport(daily, TODAY)
    expect(r.keystrokesDelta.changePct).toBeNull()
    expect(r.wpmDelta.changePct).toBeNull()
    expect(r.activeDaysDelta.changePct).toBeNull()
  })

  it('suppresses both percent and arrow when the previous week has no data at all', () => {
    // First-data-week edge case: current window has rows but the
    // comparison window is empty. The min-sample gate fires (previous
    // keystrokes is 0 < 100), so the trend lands on `flat` with a null
    // percent — the renderer's `deltaInsufficient` branch shows
    // `→ —` rather than a misleading "up from zero".
    const daily = [
      day('2026-04-27', 5000, 600_000),
    ]
    const r = computeWeeklyReport(daily, TODAY)
    expect(r.keystrokesDelta.trend).toBe('flat')
    expect(r.keystrokesDelta.changePct).toBeNull()
  })

  it('does not double-count days outside the windows', () => {
    // Day exactly between the two windows (today - 7) belongs to the
    // previous window. Verify we don't accidentally include it in
    // both, which would inflate both totals.
    const daily = [
      day('2026-04-20', 100, 60_000), // previous window's last day
    ]
    const r = computeWeeklyReport(daily, TODAY)
    expect(r.current.keystrokes).toBe(0)
    expect(r.previous.keystrokes).toBe(100)
  })
})
