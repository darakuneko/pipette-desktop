// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for the Rust port of the typing-analytics DB layer
// (src-tauri/crates/pipette-typing-analytics-db). Every value comes from the
// real TypeScript code on the real better-sqlite3:
//
// - tests/fixtures/day.jsonl — one seeded day (e2e/helpers/analyze-seed.ts,
//   clock and machine hash pinned) plus the lines of edge-rows.ts.
// - tests/fixtures/orphan.jsonl — a file whose foreign key fails.
// - tests/fixtures/expected.json — for each scenario the per-step apply
//   counts, every table in canonical form (canonical.ts) and the Analyze
//   minute-stats query.
// - data/sql.rs — the SQL text the Rust crate runs (sql-source.ts).
// - <CARGO_TARGET_TMPDIR>/pipette-typing-analytics-db/heavy.jsonl,
//   heavy-expected.json and ts-timings.json — the 21 seeded days in one
//   file for the benchmark, never committed.
//
// Run: pnpm run generate:analytics-db-fixtures

import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import type { Database as DatabaseType } from 'better-sqlite3'
import { DUMMY_TA_UID, seedDummyTypingAnalytics } from '../../e2e/helpers/analyze-seed'
import { TypingAnalyticsDB } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { DATA_TABLE_NAMES } from '../../src/main/typing-analytics/db/schema'
import { applyRowsToCache, type ApplyRowsResult } from '../../src/main/typing-analytics/jsonl/apply-to-cache'
import { readRows } from '../../src/main/typing-analytics/jsonl/jsonl-reader'
import { deletedRangesPath } from '../../src/main/typing-analytics/jsonl/paths'
import { replayDayRowsHidingDeletedRanges } from '../../src/main/typing-analytics/deleted-ranges-cache'
import { readDeletedRangesSync } from '../../src/main/typing-analytics/deleted-ranges-store'
import { clipToUtcDay, serializeDeletedRanges, type DeleteRange } from '../../src/main/typing-analytics/deleted-ranges'
import { writeFixture, writeJsonFixture } from '../fixture-files'
import { dumpTable, numberCell, type TableDump } from './canonical'
import { buildEdgeLines, buildOrphanFile } from './edge-rows'
import { BENCH_DIR, COMMITTED_FIXTURES_DIR, GENERATED_SQL_PATH } from './paths'
import { buildSqlSource } from './sql-source'

const SEEDED_NOW = Date.UTC(2026, 9, 1, 23, 0, 0)
const SEED_MACHINE_HASH = 'a'.repeat(64)
const HIDE_UPDATED_AT = SEEDED_NOW + 60_000
const SEEDED_DAY_INDEX = 2
const HOUR_MS = 3_600_000
const BENCH_RUNS = 7

interface HideStep {
  uid: string
  machineHash: string
  utcDay: string
  /** The ranges clipped to the file's UTC day, as the replay uses them. */
  ranges: DeleteRange[]
  updatedAt: number
}

interface Step {
  input: string
  hide?: HideStep
}

interface QueryCase {
  name: string
  uid: string
  sinceMs: number
  untilMs: number
  appScopes: string[]
  typingTestScopes: string[]
  runIdScopes: string[]
}

/** The ranges file for the seeded machine: one range inside the 13:00
 * session, one 17:00 range whose cutoff keeps the later minutes, and one
 * range on another day that clipping drops. */
function writeRangesFile(userData: string, dayStartMs: number): void {
  writeFixture(deletedRangesPath(userData, DUMMY_TA_UID, SEED_MACHINE_HASH), serializeDeletedRanges([
    { id: 'r-13', startMs: dayStartMs + 13 * HOUR_MS, endMs: dayStartMs + 13 * HOUR_MS + 3 * 60_000, cutoffMs: SEEDED_NOW },
    { id: 'r-17', startMs: dayStartMs + 17 * HOUR_MS, endMs: dayStartMs + 18 * HOUR_MS, cutoffMs: dayStartMs + 17 * HOUR_MS + 2 * 60_000 },
    { id: 'r-other-day', startMs: dayStartMs - 5 * HOUR_MS, endMs: dayStartMs - HOUR_MS, cutoffMs: SEEDED_NOW },
  ]))
}

function queryCases(dayStartMs: number): QueryCase[] {
  const base = { uid: DUMMY_TA_UID, appScopes: [], typingTestScopes: [], runIdScopes: [] }
  return [
    { ...base, name: 'all', sinceMs: 0, untilMs: Number.MAX_SAFE_INTEGER },
    { ...base, name: 'window', sinceMs: dayStartMs + 12 * HOUR_MS, untilMs: dayStartMs + 18 * HOUR_MS },
    { ...base, name: 'apps', sinceMs: 0, untilMs: Number.MAX_SAFE_INTEGER, appScopes: ['Code', 'Slack'] },
    { ...base, name: 'typing-test', sinceMs: 0, untilMs: Number.MAX_SAFE_INTEGER, typingTestScopes: ['tatoeba-japanese'] },
    { ...base, name: 'run', sinceMs: 0, untilMs: Number.MAX_SAFE_INTEGER, runIdScopes: ['doc-run-tatoeba-1', ''] },
  ]
}

function runQuery(db: TypingAnalyticsDB, q: QueryCase): Array<Record<string, string>> {
  return db.listMinuteStatsInRangeForUid(q.uid, q.sinceMs, q.untilMs, q.appScopes, q.typingTestScopes, q.runIdScopes)
    .map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, numberCell(v)])))
}

function dumpAll(db: TypingAnalyticsDB, withRows: boolean): Record<string, TableDump> {
  const connection: DatabaseType = db.getConnection()
  return Object.fromEntries(DATA_TABLE_NAMES.map((t) => [t, dumpTable(connection, t, withRows)]))
}

async function applyStep(db: TypingAnalyticsDB, dir: string, step: Step, userData: string): Promise<ApplyRowsResult | { error: true }> {
  const { rows } = await readRows(join(dir, step.input))
  try {
    if (!step.hide) return applyRowsToCache(db, rows)
    const { uid, machineHash, utcDay, updatedAt } = step.hide
    vi.setSystemTime(updatedAt)
    return replayDayRowsHidingDeletedRanges(db, rows, { uid, machineHash, utcDay }, userData, 'own-hash')
  } catch {
    return { error: true }
  }
}

describe('typing-analytics DB fixtures', () => {
  it('records the day, the expected tables and the query results', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const userData = mkdtempSync(join(tmpdir(), 'pipette-ta-fixtures-'))
    try {
      writeFixture(join(userData, 'local', 'typing-analytics', 'sync_state.json'), JSON.stringify({ my_device_id: SEED_MACHINE_HASH }))
      const seed = await seedDummyTypingAnalytics(userData, SEEDED_NOW)
      const seededPaths = [...seed.currentWindowJsonlPaths].sort()
      const dayPath = seededPaths[SEEDED_DAY_INDEX]
      const seededUtcDay = basename(dayPath, '.jsonl')
      const dayStartMs = Date.parse(`${seededUtcDay}T00:00:00Z`)
      const dayText = readFileSync(dayPath, 'utf8')
      const firstRow = JSON.parse(dayText.split('\n')[0]) as { updated_at: number; payload: { id: string } }
      const ctx = { uid: DUMMY_TA_UID, scopeId: firstRow.payload.id, dayStartMs, seededAt: firstRow.updated_at }

      writeFixture(join(COMMITTED_FIXTURES_DIR, 'day.jsonl'), dayText + buildEdgeLines(ctx))
      writeFixture(join(COMMITTED_FIXTURES_DIR, 'orphan.jsonl'), buildOrphanFile(ctx))
      writeRangesFile(userData, dayStartMs)
      const hide: HideStep = {
        uid: DUMMY_TA_UID,
        machineHash: SEED_MACHINE_HASH,
        utcDay: seededUtcDay,
        ranges: clipToUtcDay(readDeletedRangesSync(userData, DUMMY_TA_UID, SEED_MACHINE_HASH), seededUtcDay),
        updatedAt: HIDE_UPDATED_AT,
      }
      expect(hide.ranges).toHaveLength(2)

      const scenarios: Array<{ name: string; steps: Step[] }> = [
        { name: 'day', steps: [{ input: 'day.jsonl' }] },
        { name: 'reapply-then-rollback', steps: [{ input: 'day.jsonl' }, { input: 'day.jsonl' }, { input: 'orphan.jsonl' }] },
        { name: 'day-hiding-ranges', steps: [{ input: 'day.jsonl', hide }] },
      ]
      const queries = queryCases(dayStartMs)
      const out = []
      let sqliteVersion = ''
      for (const scenario of scenarios) {
        const db = new TypingAnalyticsDB(join(userData, `${scenario.name}.db`))
        sqliteVersion = (db.getConnection().prepare('SELECT sqlite_version() AS v').get() as { v: string }).v
        const applied = []
        for (const step of scenario.steps) applied.push(await applyStep(db, COMMITTED_FIXTURES_DIR, step, userData))
        out.push({
          name: scenario.name,
          steps: scenario.steps,
          applied,
          tables: dumpAll(db, scenario.name === 'day'),
          queries: queries.map((q) => ({ ...q, rows: runQuery(db, q) })),
        })
        db.close()
      }
      writeJsonFixture(join(COMMITTED_FIXTURES_DIR, 'expected.json'), { sqliteVersion, scenarios: out })
      writeFixture(GENERATED_SQL_PATH, buildSqlSource())

      await recordBench(userData, seededPaths, dayStartMs, queries)
    } finally {
      vi.useRealTimers()
      rmSync(userData, { recursive: true, force: true })
    }
  })
})

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** The 21 seeded days in one file, applied BENCH_RUNS times into a fresh
 * file-backed DB each (the first run is a warm-up and not counted). Records
 * the expected tables (digest only) and the TypeScript timings. */
async function recordBench(userData: string, seededPaths: string[], dayStartMs: number, queries: QueryCase[]): Promise<void> {
  writeFixture(join(BENCH_DIR, 'heavy.jsonl'), seededPaths.map((p) => readFileSync(p, 'utf8')).join(''))
  const timings: Record<string, { applyMs: number[]; queryMs: number[] }> = {}
  let pragmas: Record<string, unknown> = {}
  for (const input of ['day.jsonl', 'heavy.jsonl']) {
    const dir = input === 'heavy.jsonl' ? BENCH_DIR : COMMITTED_FIXTURES_DIR
    const applyMs: number[] = []
    const queryMs: number[] = []
    for (let run = 0; run <= BENCH_RUNS; run += 1) {
      const dbPath = join(userData, `bench-${run}.db`)
      const db = new TypingAnalyticsDB(dbPath)
      pragmas = {
        journalMode: db.getConnection().pragma('journal_mode', { simple: true }),
        synchronous: db.getConnection().pragma('synchronous', { simple: true }),
      }
      const t0 = performance.now()
      const { rows } = await readRows(join(dir, input))
      applyRowsToCache(db, rows)
      const t1 = performance.now()
      for (const q of queries) runQuery(db, q)
      const t2 = performance.now()
      if (run > 0) {
        applyMs.push(t1 - t0)
        queryMs.push(t2 - t1)
      }
      if (input === 'heavy.jsonl' && run === BENCH_RUNS) {
        writeJsonFixture(join(BENCH_DIR, 'heavy-expected.json'), {
          tables: dumpAll(db, false),
          queries: queries.map((q) => ({ ...q, rows: runQuery(db, q) })),
        })
      }
      db.close()
      rmSync(dbPath, { force: true })
      rmSync(`${dbPath}-wal`, { force: true })
      rmSync(`${dbPath}-shm`, { force: true })
    }
    timings[input] = { applyMs, queryMs }
  }
  const summary = Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, {
    runs: v.applyMs.length,
    medianApplyMs: median(v.applyMs),
    medianQueryMs: median(v.queryMs),
    applyMs: v.applyMs,
    queryMs: v.queryMs,
  }]))
  writeJsonFixture(join(BENCH_DIR, 'ts-timings.json'), { dayStartMs, runtime: process.versions, pragmas, timings: summary })
  console.log('TypeScript timings', JSON.stringify(summary))
}
