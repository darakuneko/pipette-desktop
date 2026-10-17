// SPDX-License-Identifier: GPL-2.0-or-later
// Golden generator for the Analyze post handlers of src-tauri/crates/
// pipette-hub: the scenarios of ../scenarios/analytics.ts recorded as
// ../record-scenario.ts records every domain, with the real better-sqlite3
// holding the seed of the Analyze export golden (cases.ts), so the uploads
// carry a real export. The cache groups days by local time, so this runs
// in UTC like the export golden.
//
// Writes tests/fixtures/ts_hub_handlers_analytics.json.
//
// Run: pnpm run generate:hub-fixtures

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXED_NOW } from '../../sync-fixtures/harness'
import { FIXED_MACHINE_HASH, setAnswerActions } from '../hub-harness'
import { recordDomain, restoreFetch } from '../record-scenario'
import { ANALYTICS_POST_SCENARIOS, ANALYTICS_SCENARIOS } from '../scenarios/analytics'
import { buildExportSeed } from './cases'
import { TypingAnalyticsDB, setTypingAnalyticsDBForTests } from '../../../src/main/typing-analytics/db/typing-analytics-db'
import { applyRowsToCache } from '../../../src/main/typing-analytics/jsonl/apply-to-cache'
import { readRows } from '../../../src/main/typing-analytics/jsonl/jsonl-reader'
import { setupHubIpc, clearHubTokenCache } from '../../../src/main/hub/hub-ipc'

let dbDir = ''
let db: TypingAnalyticsDB | null = null

describe('hub analytics handler fixtures', () => {
  beforeAll(async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'pipette-hub-analytics-handlers-'))
    const seedPath = join(dbDir, 'seed.jsonl')
    writeFileSync(seedPath, buildExportSeed())
    db = new TypingAnalyticsDB(join(dbDir, 'cache.db'))
    applyRowsToCache(db, (await readRows(seedPath)).rows)
    setTypingAnalyticsDBForTests(db)
    setupHubIpc()
    setAnswerActions({ clearHubTokenCache })
  })

  afterEach(() => {
    restoreFetch()
  })

  afterAll(() => {
    setAnswerActions({})
    db?.close()
    if (dbDir) rmSync(dbDir, { recursive: true, force: true })
  })

  it('records the analytics handlers', async () => {
    // The zone in effect, as the export golden checks it.
    expect(process.env.TZ).toBe('UTC')
    expect(new Date(FIXED_NOW).getTimezoneOffset()).toBe(0)
    const sqlite = (db as unknown as { db: { prepare(sql: string): { get(): unknown } } }).db
    expect(sqlite.prepare("SELECT strftime('%H:%M', 0, 'unixepoch', 'localtime') AS t").get()).toEqual({ t: '00:00' })
    await recordDomain('analytics', [...ANALYTICS_SCENARIOS, ...ANALYTICS_POST_SCENARIOS], {
      generator: 'scripts/hub-fixtures/analytics-export/record-analytics-handlers.test.ts',
      about: 'The scenarios on the export golden\'s userData run on its seed (ts_hub_analytics_export_seed.jsonl) with ownHash as this device, in the time zone timeZone.',
      extra: { ownHash: FIXED_MACHINE_HASH, timeZone: 'UTC' },
    })
  })
})
