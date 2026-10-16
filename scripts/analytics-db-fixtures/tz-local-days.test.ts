// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the local days of src-tauri/crates/pipette-time
// (src/local.rs), in the zone this process runs in (run-time-zones.ts):
// `localDayRangeMs` (src/shared/local-day-range.ts) for dates around
// daylight saving changes, month and year ends, two-digit years, carries
// and text of other forms, and `new Date(y, m, d).getTime()` (the local
// midnight of typing-analytics-row-codec.ts) for parts that carry or leave
// the range of a Date.
//
// Run: pnpm run generate:analytics-db-fixtures

import { describe, it } from 'vitest'
import { join } from 'node:path'
import { localDayRangeMs } from '../../src/shared/local-day-range'
import { writeJsonFixture } from '../fixture-files'
import { LOCAL_DAYS_FIXTURES_DIR } from './paths'
import { recordingTimeZone, zoneSlug } from './time-zones'

const DATES = [
  '2026-01-01', '2026-10-16', '1970-01-01', '1969-12-31',
  // New York: 23 and 25 hour days.
  '2026-03-08', '2026-11-01',
  // Santiago: no midnight on 2024-09-08, a 25 hour 2025-04-05.
  '2024-09-07', '2024-09-08', '2025-04-05', '2025-04-06',
  // Havana: no midnight on 2024-03-10, two on 2024-11-03.
  '2024-03-10', '2024-11-02', '2024-11-03',
  // Tokyo: daylight saving time of 1948 to 1951.
  '1948-05-01', '1948-05-02', '1948-09-11', '1948-09-12',
  // Month and year ends.
  '2026-01-31', '2026-02-28', '2024-02-29', '2026-12-31', '9999-12-31',
  // Two-digit years are the 1900s; local mean time before 1900.
  '0000-01-01', '0050-01-01', '0099-12-31', '0100-01-01', '1800-01-01',
  // Parts that carry.
  '2026-02-30', '2026-13-01', '2026-00-00', '2026-99-99',
  // Other forms.
  '2026-1-1', '２０２６-01-01', '', '2026-01-01T00:00', '2026-01-01 ', '+02026-01-01',
]

const LOCAL_DATES: Array<[number, number, number]> = [
  [2026, 0, 1], [2024, 8, 8], [2024, 10, 3], [50, 0, 1], [99, 11, 31], [100, 0, 1], [0, 0, 0], [-1, 0, 1],
  [2026, -13, 1], [2026, 0, -400], [2026, 25, 61], [10000, 0, 1], [275760, 8, 13], [275760, 8, 12],
  [-271821, 3, 20], [-271821, 3, 21], [-10000, 5, 15],
]

describe('local day fixtures', () => {
  it('records the local days of this time zone', () => {
    const timeZone = recordingTimeZone()
    writeJsonFixture(join(LOCAL_DAYS_FIXTURES_DIR, `${zoneSlug(timeZone)}.json`), {
      timeZone,
      localDayRanges: DATES.map((date) => ({ date, range: localDayRangeMs(date) })),
      localDates: LOCAL_DATES.map(([year, monthIndex, day]) => {
        const ms = new Date(year, monthIndex, day).getTime()
        return { year, monthIndex, day, ms: Number.isNaN(ms) ? null : ms }
      }),
    })
  })
})
