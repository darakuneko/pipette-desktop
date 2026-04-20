// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest'
import { filterByRange } from '../analyze-period'

function dayStartLocal(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

const NOW = new Date(2026, 3, 20, 14, 0, 0, 0) // 2026-04-20 14:00 local
const NOW_MS = NOW.getTime()

describe('analyze-period', () => {
  describe('filterByRange', () => {
    const rows = [
      { date: '2026-04-17', value: 1 },
      { date: '2026-04-19', value: 2 },
      { date: '2026-04-20', value: 3 },
    ]

    it('keeps only days whose local span overlaps the window', () => {
      const from = dayStartLocal(2026, 4, 19)
      const toMs = NOW_MS
      expect(filterByRange(rows, { fromMs: from, toMs }).map((r) => r.value)).toEqual([2, 3])
    })

    it('keeps the day that contains a sub-day boundary', () => {
      // 2026-04-20 08:00 → 2026-04-20 14:00 still lives within the
      // 2026-04-20 local day, so that day is kept.
      const from = new Date(2026, 3, 20, 8, 0, 0, 0).getTime()
      expect(filterByRange(rows, { fromMs: from, toMs: NOW_MS }).map((r) => r.value)).toEqual([3])
    })

    it('drops rows with malformed dates', () => {
      const bad = [{ date: 'not-a-date', value: 1 }, { date: '2026-04-20', value: 2 }]
      expect(filterByRange(bad, { fromMs: dayStartLocal(2026, 4, 20), toMs: NOW_MS }).map((r) => r.value)).toEqual([2])
    })

    it('returns an empty array when the window sits before all rows', () => {
      const from = dayStartLocal(2020, 1, 1)
      const to = dayStartLocal(2020, 1, 2)
      expect(filterByRange(rows, { fromMs: from, toMs: to })).toEqual([])
    })
  })
})
