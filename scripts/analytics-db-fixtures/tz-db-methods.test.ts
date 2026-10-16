// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the DB methods of the Rust port that group by
// SQLite's `localtime` (db-methods.ts), in the zone this process runs in
// (run-time-zones.ts): the answer of each call on the seed
// record-db-methods.test.ts wrote, to tests/fixtures/methods_tz/<zone>.json
// of src-tauri/crates/pipette-typing-analytics-db.
//
// Run: pnpm run generate:analytics-db-fixtures

import { describe, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TypingAnalyticsDB } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { applyRowsToCache } from '../../src/main/typing-analytics/jsonl/apply-to-cache'
import { readRows } from '../../src/main/typing-analytics/jsonl/jsonl-reader'
import { writeJsonFixture } from '../fixture-files'
import { METHODS_SEED_PATH, METHODS_TZ_FIXTURES_DIR, localTimeCalls, runCall } from './db-methods'
import { recordingTimeZone, zoneSlug } from './time-zones'

describe('typing-analytics DB local-time fixtures', () => {
  it('records the local-time answers of this time zone', async () => {
    const timeZone = recordingTimeZone()
    const dir = mkdtempSync(join(tmpdir(), 'pipette-ta-methods-tz-'))
    try {
      const db = new TypingAnalyticsDB(join(dir, 'reads.db'))
      applyRowsToCache(db, (await readRows(METHODS_SEED_PATH)).rows)
      const calls = localTimeCalls().map((call) => ({ ...call, result: runCall(db, call) }))
      db.close()
      writeJsonFixture(join(METHODS_TZ_FIXTURES_DIR, `${zoneSlug(timeZone)}.json`), { timeZone, calls })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
