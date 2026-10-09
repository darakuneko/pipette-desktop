// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, afterEach } from 'vitest'
import { localDayRangeMs } from '../local-day-range'

describe('localDayRangeMs', () => {
  const originalTz = process.env.TZ
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  })

  it('returns local midnight to the next local midnight', () => {
    process.env.TZ = 'Asia/Tokyo'
    expect(localDayRangeMs('2026-10-09')).toEqual({ startMs: Date.UTC(2026, 9, 8, 15), endMs: Date.UTC(2026, 9, 9, 15) })
  })

  it('is 23 hours long on the day summer time starts', () => {
    process.env.TZ = 'America/New_York'
    expect(localDayRangeMs('2026-03-08')).toEqual({ startMs: Date.UTC(2026, 2, 8, 5), endMs: Date.UTC(2026, 2, 9, 4) })
  })

  it('returns null for anything that is not a date', () => {
    expect(localDayRangeMs('2026-10')).toBeNull()
    expect(localDayRangeMs('')).toBeNull()
  })
})
