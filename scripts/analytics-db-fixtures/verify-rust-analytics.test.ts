// SPDX-License-Identifier: GPL-2.0-or-later
// Rust → TypeScript check for src-tauri/crates/pipette-typing-analytics: the
// crate's test tests/rust_user_data.rs (`cargo test -p
// pipette-typing-analytics --test rust_user_data`) records two keyboards,
// applies another device's day files, runs the deletes, an export and an
// import of the Data modal, saves keymap snapshots and quits, and records
// what its queries answer. This reads a copy of that userData tree with the
// Electron build's code and checks:
//
// - the machine hash machine-hash.ts derives from the crate's
//   installation-id (with node-machine-id answering the crate's machine id);
// - sync_state.json, the deleted-ranges files and the applied ids: read as
//   the crate wrote them, and written back by this code byte for byte;
// - the cache the crate left: the freshness check keeps it, every table
//   holds the same rows and every query member answers the same JSON text;
// - a restart without sync_state.json and the cache: the rebuild from the
//   files and the startup apply of this device's own deleted ranges leave
//   the same tables, every member answers the same, and nothing under
//   sync/ changes;
// - the pending units restorePendingFromDisk (sync-pending-store.ts) reads
//   from local/sync-pending.json.
//
// verify-rust-analytics.config.ts runs it on the sql.js adapter, as the
// root config runs the unit tests; under Electron as Node, the config of
// this directory runs it on the real better-sqlite3 too.
//
// Run: pnpm run verify:analytics-rust-user-data

import { afterAll, describe, expect, it, vi } from 'vitest'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cargoTargetTmpDir } from '../fixture-files'
import { readTree } from '../rust-user-data-tree'

const pinned = vi.hoisted(() => ({
  userData: '',
  machineId: '',
  os: { platform: '', release: '', arch: '' },
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({ app: { getPath: () => pinned.userData } }))
vi.mock('node-machine-id', () => {
  const machineId = async (): Promise<string> => pinned.machineId
  return { default: { machineId }, machineId }
})
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: () => pinned.os.platform,
  release: () => pinned.os.release,
  arch: () => pinned.os.arch,
}))
vi.mock('../../src/main/logger', () => ({ log: () => undefined }))
vi.mock('../../src/main/typing-analytics/app-monitor', () => ({ getCurrentAppName: async () => null }))
vi.mock('../../src/main/ipc-guard', () => ({
  secureHandle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    pinned.handlers.set(channel, handler)
  },
}))

import { TypingAnalyticsDB, setTypingAnalyticsDBForTests } from '../../src/main/typing-analytics/db/typing-analytics-db'
import { DATA_TABLE_NAMES } from '../../src/main/typing-analytics/db/schema'
import { ensureCacheIsFresh } from '../../src/main/typing-analytics/cache-rebuild'
import { applyOwnDeletedRangesForAllKeyboards } from '../../src/main/typing-analytics/deleted-ranges-apply'
import { readDeletedRanges } from '../../src/main/typing-analytics/deleted-ranges-store'
import { serializeDeletedRanges } from '../../src/main/typing-analytics/deleted-ranges'
import { getMachineHash } from '../../src/main/typing-analytics/machine-hash'
import { loadSyncState, saveSyncState } from '../../src/main/typing-analytics/sync-state'
import { setupTypingAnalyticsIpc } from '../../src/main/typing-analytics/typing-analytics-service'
import { runOnFlushChain } from '../../src/main/typing-analytics/typing-analytics-pipeline'
import { restorePendingFromDisk, resetPendingStoreForTests } from '../../src/main/sync/sync-pending-store'
import { pendingSnapshot } from '../../src/main/sync/sync-runtime-state'
import { IpcChannels } from '../../src/shared/ipc/channels'
import { realBits } from './canonical'
import { channelKey } from './query-calls'

const RUST_DIR = resolve(cargoTargetTmpDir('pipette-typing-analytics'), 'rust_user_data')

interface Call {
  member: string
  /** The arguments, tagged as tagged.ts tags them. */
  args: unknown[]
  response: Response
}

/** The answer as JSON text; null when the answer has no JSON text
 *  (`undefined`); `{ error: true }` when the call failed. */
type Response = string | null | { error: true }

interface Answers {
  machineId: string
  machineHash: string
  os: { platform: string; release: string; arch: string }
  /** The crate's clock when the tree was finished. */
  clock: number
  syncState: string
  /** Device directory (under userData) → its deleted-ranges.json. */
  deletedRanges: Record<string, string>
  live: Call[]
  liveTables: Record<string, string[]>
  rebuilt: Call[]
  rebuiltTables: Record<string, string[]>
  pendingUnits: string[]
}

function readAnswers(): Answers {
  const path = join(RUST_DIR, 'answers.json')
  if (!existsSync(path)) {
    throw new Error(`${path} is missing; run cargo test -p pipette-typing-analytics --test rust_user_data first`)
  }
  return JSON.parse(readFileSync(path, 'utf-8')) as Answers
}

/** The value tagged.ts recorded, back to what it tagged. */
function untagged(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(untagged)
  if (value === null || typeof value !== 'object') return value
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  if (keys.length === 1 && keys[0] === '$u') return undefined
  if (keys.length === 1 && keys[0] === '$n') {
    return { NaN: Number.NaN, Infinity, '-Infinity': -Infinity, '-0': -0 }[object.$n as string]
  }
  return Object.fromEntries(keys.map((key) => [key, untagged(object[key])]))
}

async function answer(call: Call): Promise<Response> {
  const channel = (IpcChannels as Record<string, string>)[channelKey(call.member)]
  const handler = channel === undefined ? undefined : pinned.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${call.member}`)
  let result: unknown
  try {
    result = await handler(undefined, ...(untagged(call.args) as unknown[]))
  } catch {
    return { error: true }
  }
  return JSON.stringify(result) ?? null
}

async function expectSameAnswers(calls: Call[]): Promise<void> {
  expect(calls.length).toBeGreaterThan(700)
  const mismatches: string[] = []
  for (const [i, call] of calls.entries()) {
    const got = await answer(call)
    if (JSON.stringify(got) !== JSON.stringify(call.response)) mismatches.push(`${i} ${call.member} ${JSON.stringify(call.args)}`)
  }
  expect(mismatches).toEqual([])
}

/** The rows of `table` in the canonical text of canonical.ts. Each cell's
 *  storage class, integer digits and text bytes come from SQL, so the
 *  sql.js adapter, which reads every number as a double and has no raw
 *  mode, gives the same text as better-sqlite3. */
function tableRows(db: TypingAnalyticsDB, table: string): string[] {
  const connection = db.getConnection()
  const info = connection.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>
  const order = info.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name).join(', ')
  const select = info.flatMap(({ name }, i) => [
    `typeof(${name}) AS t${i}`,
    `CASE typeof(${name}) WHEN 'integer' THEN CAST(${name} AS TEXT) WHEN 'real' THEN NULL ELSE lower(hex(${name})) END AS v${i}`,
    `CASE typeof(${name}) WHEN 'real' THEN ${name} END AS r${i}`,
  ])
  const rows = connection.prepare(`SELECT ${select.join(', ')} FROM ${table} ORDER BY ${order}`).all() as Array<Record<string, unknown>>
  const cell = (row: Record<string, unknown>, i: number): string => {
    switch (row[`t${i}`]) {
      case 'null': return 'n'
      case 'integer': return `i:${String(row[`v${i}`])}`
      case 'real': return `r:${realBits(row[`r${i}`] as number)}`
      case 'text': return `t:${String(row[`v${i}`])}`
      default: return `b:${String(row[`v${i}`])}`
    }
  }
  return rows.map((row) => info.map((_, i) => cell(row, i)).join('|'))
}

function expectSameTables(db: TypingAnalyticsDB, expected: Record<string, string[]>): void {
  for (const table of DATA_TABLE_NAMES) {
    expect(tableRows(db, table), table).toEqual(expected[table])
  }
}

function openCache(): TypingAnalyticsDB {
  const db = new TypingAnalyticsDB(join(pinned.userData, 'local', 'typing-analytics.db'))
  setTypingAnalyticsDBForTests(db)
  return db
}

let db: TypingAnalyticsDB | null = null

afterAll(() => {
  db?.close()
  if (pinned.userData) rmSync(pinned.userData, { recursive: true, force: true })
  resetPendingStoreForTests()
})

describe('the userData tree the Rust typing analytics write', () => {
  const answers = readAnswers()
  pinned.userData = mkdtempSync(join(tmpdir(), 'rust-analytics-user-data-'))
  cpSync(join(RUST_DIR, 'user-data'), pinned.userData, { recursive: true })
  pinned.machineId = answers.machineId
  pinned.os = answers.os
  setupTypingAnalyticsIpc()

  it('derives the same machine hash from the installation id', async () => {
    expect(await getMachineHash()).toBe(answers.machineHash)
  })

  it('reads sync_state.json and writes it back byte for byte', async () => {
    const state = await loadSyncState(pinned.userData)
    expect(state?.my_device_id).toBe(answers.machineHash)
    const out = mkdtempSync(join(tmpdir(), 'rust-analytics-sync-state-'))
    try {
      await saveSyncState(out, state!)
      expect(readFileSync(join(out, 'local', 'typing-analytics', 'sync_state.json'), 'utf-8')).toBe(answers.syncState)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('reads the deleted ranges and serializes them byte for byte', async () => {
    const dirs = Object.keys(answers.deletedRanges)
    expect(dirs).toHaveLength(2)
    for (const dir of dirs) {
      const [, , uid, , hash] = dir.split('/')
      const entries = await readDeletedRanges(pinned.userData, uid, hash)
      expect(entries.length).toBeGreaterThan(0)
      expect(serializeDeletedRanges(entries)).toBe(answers.deletedRanges[dir])
    }
  })

  it('keeps the cache the crate left, with the same rows and answers', async () => {
    db = openCache()
    const fresh = await ensureCacheIsFresh(db, pinned.userData, answers.machineHash)
    expect(fresh.rebuilt).toBe(false)
    expectSameTables(db, answers.liveTables)
    await expectSameAnswers(answers.live)
  })

  it('rebuilds the same cache from the files at a restart', async () => {
    db?.close()
    rmSync(join(pinned.userData, 'local', 'typing-analytics', 'sync_state.json'))
    for (const name of ['typing-analytics.db', 'typing-analytics.db-wal', 'typing-analytics.db-shm']) {
      rmSync(join(pinned.userData, 'local', name), { force: true })
    }
    const synced = readTree(join(pinned.userData, 'sync'))
    vi.useFakeTimers({ toFake: ['Date'], now: answers.clock })
    try {
      db = openCache()
      expect((await ensureCacheIsFresh(db, pinned.userData, answers.machineHash)).rebuilt).toBe(true)
      await applyOwnDeletedRangesForAllKeyboards(pinned.userData, answers.machineHash, () => false)
      await runOnFlushChain(async () => {})
    } finally {
      vi.useRealTimers()
    }
    expectSameTables(db, answers.rebuiltTables)
    await expectSameAnswers(answers.rebuilt)
    // The applied ids were read as the crate wrote them, so no range was
    // applied again and no file changed.
    expect(readTree(join(pinned.userData, 'sync'))).toEqual(synced)
  })

  it('restores the pending units the crate reported', () => {
    restorePendingFromDisk()
    expect(pendingSnapshot().units).toEqual(answers.pendingUnits)
  })
})
