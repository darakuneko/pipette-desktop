// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import { filterByPeriod, periodCutoffDay, periodSinceMs } from '../analyze-period'

// Local-time Date — periodCutoffDay mirrors `strftime(..., 'localtime')`
// on the SQL side, so the tests have to commit to a local timezone too.
const NOW = new Date(2026, 3, 20, 12, 0, 0, 0)

describe('analyze-period', () => {
  describe('periodCutoffDay', () => {
    it('returns null for "all"', () => {
      expect(periodCutoffDay('all', NOW)).toBeNull()
    })

    it('returns the day N-1 days ago for a N-day window so today is included', () => {
      expect(periodCutoffDay('7d', NOW)).toBe('2026-04-14')
      expect(periodCutoffDay('30d', NOW)).toBe('2026-03-22')
    })

    it('respects month / year boundaries', () => {
      const earlyApr = new Date(2026, 3, 2, 6, 0, 0, 0)
      expect(periodCutoffDay('7d', earlyApr)).toBe('2026-03-27')
    })
  })

  describe('filterByPeriod', () => {
    const rows = [
      { date: '2026-04-10', value: 1 },
      { date: '2026-04-14', value: 2 },
      { date: '2026-04-18', value: 3 },
      { date: '2026-04-20', value: 4 },
    ]

    it('returns everything for "all"', () => {
      expect(filterByPeriod(rows, 'all', NOW)).toEqual(rows)
    })

    it('keeps rows whose date is on or after the cutoff', () => {
      expect(filterByPeriod(rows, '7d', NOW).map((r) => r.date)).toEqual([
        '2026-04-14', '2026-04-18', '2026-04-20',
      ])
    })

    it('returns a fresh array (callers are safe to sort in place)', () => {
      const out = filterByPeriod(rows, 'all', NOW)
      expect(out).not.toBe(rows)
    })
  })

  describe('periodSinceMs', () => {
    it('returns 0 for "all"', () => {
      expect(periodSinceMs('all', NOW)).toBe(0)
    })

    it('returns local midnight of the N-day window start', () => {
      expect(periodSinceMs('7d', NOW)).toBe(new Date(2026, 3, 14, 0, 0, 0, 0).getTime())
      expect(periodSinceMs('30d', NOW)).toBe(new Date(2026, 2, 22, 0, 0, 0, 0).getTime())
    })
  })
})
