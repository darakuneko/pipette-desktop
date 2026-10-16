// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the DB methods of the Rust port
// (src-tauri/crates/pipette-typing-analytics-db), from the real TypeScript
// DB layer on the real better-sqlite3 (db-methods.ts):
//
// - tests/fixtures/methods-seed.jsonl — the seed the reads run on.
// - tests/fixtures/methods.json — what applying the seed counted, the
//   answer of every call whose answer does not depend on the time zone,
//   and the write scenarios: each operation's answer and every table
//   afterwards in canonical form (canonical.ts).
//
// The calls that group by local days are recorded per time zone by
// tz-db-methods.test.ts.
//
// Run: pnpm run generate:analytics-db-fixtures

import { describe, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database as DatabaseType } from 'better-sqlite3'
import { TypingAnalyticsDB } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { DATA_TABLE_NAMES } from '../../src/main/typing-analytics/db/schema'
import { applyRowsToCache } from '../../src/main/typing-analytics/jsonl/apply-to-cache'
import { readRows } from '../../src/main/typing-analytics/jsonl/jsonl-reader'
import { writeFixture, writeJsonFixture } from '../fixture-files'
import { dumpTable } from './canonical'
import {
  METHODS_FIXTURE_PATH, METHODS_SEED_PATH, OWN, REMOTE, UID_A, UID_B,
  buildMethodsSeed, independentCalls, runCall, type MethodCall,
} from './db-methods'

const MINUTE = 60_000
const DAY_10H = Date.UTC(2026, 9, 15, 10)

function scope(id: string, machineHash: string, updatedAt: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, machineHash, osPlatform: 'linux', osRelease: '6.8.0', osArch: 'x64', keyboardUid: '0xAABB',
    keyboardVendorId: 0xfeed, keyboardProductId: 0, keyboardProductName: 'Pipette', updatedAt, ...extra,
  }
}

function minute(scopeId: string, minuteTs: number, keystrokes: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scopeId, minuteTs, keystrokes, activeMs: 500,
    intervalAvgMs: 100, intervalMinMs: 50 + keystrokes, intervalP25Ms: 60, intervalP50Ms: 70, intervalP75Ms: 80, intervalMaxMs: 90 + keystrokes,
    ...extra,
  }
}

/** The additive writes on an empty database: a scope kept or replaced by
 * its time, minutes adding up, tags turning mixed, runs kept apart,
 * sessions, and the retention of one device's older rows. */
function ingestOps(): MethodCall[] {
  const c = (method: string, ...args: unknown[]): MethodCall => ({ method, args })
  const at = 60_000
  return [
    c('upsertScope', scope('scope-1', 'hash-abc', 1_000)),
    c('upsertScope', scope('scope-1', 'hash-abc', 500, { keyboardProductName: 'stale' })),
    c('upsertScope', scope('scope-2', 'other-machine', 1_000, { osPlatform: 'darwin' })),
    c('upsertScope', scope('scope-1', 'hash-abc', 2_000, { osRelease: '6.9.0' })),
    c('writeMinute', minute('scope-1', at, 3, { appName: 'Code' }),
      [{ scopeId: 'scope-1', minuteTs: at, char: 'a', count: 2 }, { scopeId: 'scope-1', minuteTs: at, char: 'b', count: 1, appName: 'Other' }],
      [{ scopeId: 'scope-1', minuteTs: at, row: 0, col: 3, layer: 0, keycode: 4, count: 2, tapCount: 1 }],
      2_000),
    c('writeMinute', minute('scope-1', at, 1, { appName: 'Code', intervalMinMs: 10, intervalMaxMs: 999 }),
      [{ scopeId: 'scope-1', minuteTs: at, char: 'a', count: 3 }],
      [{ scopeId: 'scope-1', minuteTs: at, row: 0, col: 3, layer: 0, keycode: 5, count: 3, holdCount: 2 }],
      3_000),
    c('writeMinute', minute('scope-1', at, 2, { appName: 'Slack', typingTest: 'novel.txt' }),
      [{ scopeId: 'scope-1', minuteTs: at, char: 'a', count: 1 }],
      [{ scopeId: 'scope-1', minuteTs: at, row: 0, col: 3, layer: 0, keycode: 5, count: 1, typingTest: 'novel.txt' }],
      4_000),
    c('writeMinute', minute('scope-1', at, 4, { typingTest: 'words (english)', runId: 'run-1' }),
      [{ scopeId: 'scope-1', minuteTs: at, char: 'a', count: 4 }],
      [{ scopeId: 'scope-1', minuteTs: at, row: 1, col: 1, layer: 0, keycode: 5, count: 4, runId: 'run-2' }],
      2_000),
    c('writeMinute', minute('scope-1', 120_000, 2.5, { intervalAvgMs: null, intervalMinMs: null, intervalP25Ms: null, intervalP50Ms: null, intervalP75Ms: null, intervalMaxMs: null }),
      [], [{ scopeId: 'scope-1', minuteTs: 120_000, row: 2, col: 2, layer: 1, keycode: 44.5, count: 1.5, tapCount: 0.5, holdCount: 1 }],
      2_000),
    c('writeMinute', minute('scope-1', 120_000, 1), [], [], 2_500),
    c('insertSession', { id: 'session-1', scopeId: 'scope-1', startMs: 10_000, endMs: 20_000 }, 3_000),
    c('insertSession', { id: 'session-1', scopeId: 'scope-1', startMs: 999, endMs: 999 }, 1_000),
    c('insertSession', { id: 'session-2', scopeId: 'scope-1', startMs: 150_000, endMs: 180_000 }, 2_000),
    c('writeMinute', minute('scope-2', 50_000, 1), [{ scopeId: 'scope-2', minuteTs: 50_000, char: 'z', count: 1 }], [], 1_000),
    c('writeMinute', minute('scope-1', 50_000, 1), [{ scopeId: 'scope-1', minuteTs: 50_000, char: 'y', count: 1 }], [], 1_000),
    c('insertSession', { id: 'session-old', scopeId: 'scope-1', startMs: 10_000, endMs: 52_000 }, 1_000),
    c('insertSession', { id: 'session-remote', scopeId: 'scope-2', startMs: 10_000, endMs: 20_000 }, 1_000),
    c('retainOwnData', 'hash-abc', 55_000),
  ]
}

/** The tombstones on the seed: one device's ranges (a cutoff inside one,
 * again with nothing left to flip, and none), every row of one device,
 * and every row of a keyboard. */
function tombstoneOps(): MethodCall[] {
  const c = (method: string, ...args: unknown[]): MethodCall => ({ method, args })
  const ranges = [
    { startMs: DAY_10H, endMs: DAY_10H + 2 * MINUTE, cutoffMs: Number.MAX_SAFE_INTEGER },
    { startMs: DAY_10H + 4 * MINUTE, endMs: DAY_10H + 8 * MINUTE, cutoffMs: DAY_10H + 4 * MINUTE },
  ]
  return [
    c('tombstoneRowsForUidHashInRanges', UID_A, OWN, ranges, 5_000),
    c('tombstoneRowsForUidHashInRanges', UID_A, OWN, ranges, 9_000),
    c('tombstoneRowsForUidHashInRanges', UID_A, REMOTE, [], 5_000),
    c('tombstoneAllRowsForUidHash', UID_A, REMOTE, 6_000),
    c('tombstoneAllRowsForUid', UID_B, 7_000),
    c('tombstoneAllRowsForUid', UID_A, 8_000),
  ]
}

function dumpAll(db: TypingAnalyticsDB): Record<string, unknown> {
  const connection: DatabaseType = db.getConnection()
  return Object.fromEntries(DATA_TABLE_NAMES.map((t) => [t, dumpTable(connection, t, true)]))
}

describe('typing-analytics DB method fixtures', () => {
  it('records the seed, the answers and the write scenarios', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pipette-ta-methods-'))
    try {
      writeFixture(METHODS_SEED_PATH, buildMethodsSeed())
      const { rows } = await readRows(METHODS_SEED_PATH)
      const open = (name: string, seeded: boolean): { db: TypingAnalyticsDB; seedApplied?: unknown } => {
        const db = new TypingAnalyticsDB(join(dir, `${name}.db`))
        return seeded ? { db, seedApplied: applyRowsToCache(db, rows) } : { db }
      }

      const reads = open('reads', true)
      const calls = independentCalls().map((call) => ({ ...call, result: runCall(reads.db, call) }))
      reads.db.close()

      const scenarios = []
      for (const { name, seeded, ops } of [
        { name: 'ingest', seeded: false, ops: ingestOps() },
        { name: 'tombstones', seeded: true, ops: tombstoneOps() },
        { name: 'retain', seeded: true, ops: [{ method: 'retainOwnData', args: [OWN, DAY_10H + MINUTE] }] },
        { name: 'truncate', seeded: true, ops: [{ method: 'truncateCache', args: [] }] },
      ]) {
        const { db } = open(name, seeded)
        const results = ops.map((op) => runCall(db, op))
        scenarios.push({ name, seeded, ops: ops.map((op, i) => ({ ...op, result: results[i] })), tables: dumpAll(db) })
        db.close()
      }

      writeJsonFixture(METHODS_FIXTURE_PATH, { seedApplied: reads.seedApplied, calls, scenarios })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
