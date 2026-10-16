// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the deleted ranges of local days in
// src-tauri/crates/pipette-typing-analytics (src/deleted_ranges/model.rs),
// in the zone this process runs in (run-time-zones.ts):
// `deletedRangesForLocalDays` (deleted-ranges.ts) for runs of days across
// daylight saving changes, a missing and a doubled midnight, a year end,
// two-digit years and days that carry.
//
// Run: pnpm run generate:analytics-db-fixtures

import { describe, it } from 'vitest'
import { join } from 'node:path'
import { deletedRangesForLocalDays } from '../../src/main/typing-analytics/deleted-ranges'
import { writeJsonFixture } from '../fixture-files'
import { ANALYTICS_FIXTURES_DIR } from './paths'
import { recordingTimeZone, zoneSlug } from './time-zones'

const CUTOFF = 1_776_643_200_000

const CASES: string[][] = [
  [],
  ['2026-04-03', '2026-04-01', '2026-04-02', '2026-04-05', '2026-04-02'],
  ['2026-03-07', '2026-03-08', '2026-03-09', '2026-11-01'],
  ['2024-09-07', '2024-09-08', '2024-09-09'],
  ['2025-04-05', '2025-04-06'],
  ['2024-03-09', '2024-03-10', '2024-11-02', '2024-11-03', '2024-11-04'],
  ['2026-12-31', '2027-01-01', '2026-01-01'],
  ['0050-01-01', '1950-01-02', '0099-12-31'],
  ['2026-02-30', '2026-03-02', '2026-13-01', '2027-01-02'],
  ['1948-05-01', '1948-05-02', '1948-09-11', '1948-09-12'],
  ['2026-4-1'],
  ['2026-04-01', ''],
]

describe('deleted range fixtures', () => {
  it('records the ranges of local days in this time zone', () => {
    const timeZone = recordingTimeZone()
    const cases = CASES.map((dates) => {
      let n = 0
      try {
        return { dates, entries: deletedRangesForLocalDays(dates, CUTOFF, () => `id-${++n}`) }
      } catch {
        return { dates, entries: null }
      }
    })
    writeJsonFixture(join(ANALYTICS_FIXTURES_DIR, 'deleted_ranges_local_days', `${zoneSlug(timeZone)}.json`), {
      timeZone,
      cutoffMs: CUTOFF,
      cases,
    })
  })
})
