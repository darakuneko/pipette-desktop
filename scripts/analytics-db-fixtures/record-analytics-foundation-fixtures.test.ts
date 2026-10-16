// SPDX-License-Identifier: GPL-2.0-or-later
// Fixture generator for src-tauri/crates/pipette-typing-analytics: what the
// real TypeScript code reads and writes on a userData directory built in a
// temp directory.
//
// - installation_id.json — `getInstallationId` (installation-id.ts) with
//   `randomUUID` pinned, for each starting `local/installation-id`: the id
//   or a failure, and the file left behind.
// - sync_state.json — `loadSyncState` (sync-state.ts) of each file text,
//   and what `saveSyncState` writes for the state it read.
// - cache_freshness.json — `ensureCacheIsFresh` (cache-rebuild.ts) on the
//   real better-sqlite3 database with the clock pinned: whether it rebuilt
//   and the `sync_state.json` it left.
//
// Run: pnpm run generate:analytics-db-fixtures

import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { writeJsonFixture } from '../fixture-files'
import { REPO_ROOT } from '../fixture-vitest-config'

const pinned = vi.hoisted(() => ({ userData: '', uuids: [] as string[] }))

vi.mock('electron', () => ({
  app: { getPath: () => pinned.userData },
}))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  const randomUUID = (): string => {
    const id = pinned.uuids.shift()
    if (!id) throw new Error('no pinned UUID left')
    return id
  }
  return { ...actual, default: { ...actual, randomUUID }, randomUUID }
})

import { getInstallationId, resetInstallationIdCacheForTests } from '../../src/main/typing-analytics/installation-id'
import { loadSyncState, saveSyncState, syncStatePath } from '../../src/main/typing-analytics/sync-state'
import { ensureCacheIsFresh } from '../../src/main/typing-analytics/cache-rebuild'
import { TypingAnalyticsDB } from '../../src/main/typing-analytics/db/typing-analytics-db'

const FIXTURES_DIR = resolve(REPO_ROOT, 'src-tauri/crates/pipette-typing-analytics/tests/fixtures')
const NEW_ID = '0f1e2d3c-4b5a-4697-8877-665544332211'
const OLD_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const NOW = Date.UTC(2026, 9, 16, 12, 34, 56, 789)

/** What a path holds: its bytes as hex, a directory, or nothing. */
type Entry = { hex: string } | { dir: true } | null

function readEntry(path: string): Entry {
  if (!existsSync(path)) return null
  if (lstatSync(path).isDirectory()) return { dir: true }
  return { hex: readFileSync(path).toString('hex') }
}

function writeEntry(path: string, entry: Entry): void {
  if (entry === null) return
  mkdirSync(dirname(path), { recursive: true })
  if ('dir' in entry) mkdirSync(path, { recursive: true })
  else writeFileSync(path, Buffer.from(entry.hex, 'hex'))
}

const text = (s: string): Entry => ({ hex: Buffer.from(s, 'utf8').toString('hex') })
const bytes = (...parts: Array<string | number[]>): Entry => ({
  hex: Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : Buffer.from(p)))).toString('hex'),
})

function freshUserData(): string {
  pinned.userData = mkdtempSync(join(tmpdir(), 'pipette-ta-foundation-'))
  return pinned.userData
}

afterEach(() => {
  if (pinned.userData) rmSync(pinned.userData, { recursive: true, force: true })
  pinned.userData = ''
})

const INSTALLATION_ID_CASES: Array<{ name: string; local?: Entry; file: Entry }> = [
  { name: 'missing', file: null },
  { name: 'an id', file: text(`${OLD_ID}\n`) },
  { name: 'an id without a newline', file: text(OLD_ID) },
  { name: 'an id in JavaScript whitespace', file: text(`﻿ ${OLD_ID}　\t\r\n`) },
  { name: 'an uppercase id', file: text(`${OLD_ID.toUpperCase()}\n`) },
  { name: 'two ids', file: text(`${OLD_ID}\n${OLD_ID}\n`) },
  { name: 'an id without hyphens', file: text(`${OLD_ID.replaceAll('-', '')}\n`) },
  { name: 'empty', file: text('') },
  { name: 'invalid UTF-8', file: bytes(OLD_ID.slice(0, 35), [0xff], '\n') },
  { name: 'a directory', file: { dir: true } },
  { name: 'local is a file', local: text('not a directory'), file: null },
]

const SYNC_STATE_CASES: Array<{ name: string; file: Entry }> = [
  { name: 'missing', file: null },
  { name: 'revision 3', file: text(JSON.stringify({ _rev: 3, my_device_id: 'dev', uploaded: { 'u|h': ['2026-01-01', '2026-01-02'] }, reconciled_at: { 'u|h': 1767225600000 }, last_synced_at: 1767225600123 })) },
  { name: 'fields out of order and unknown fields', file: text('{"extra":{"a":1},"last_synced_at":5,"reconciled_at":{},"uploaded":{},"my_device_id":"dev","_rev":3,"read_pointers":{}}') },
  { name: 'array index keys first', file: text('{"_rev":3,"my_device_id":"d","uploaded":{"b|x":[],"10":["2026-01-01"],"2":[],"__proto__":[]},"reconciled_at":{"z":null,"1":-0,"a":1e21,"0":1.5e-7},"last_synced_at":0.30000000000000004}') },
  { name: 'duplicate keys', file: text('{"_rev":3,"my_device_id":"first","uploaded":{"k":[]},"reconciled_at":{},"last_synced_at":1,"my_device_id":"last","uploaded":{"k":["2026-01-03"],"j":[]}}') },
  { name: 'escapes and a lone surrogate', file: text('{"_rev":3,"my_device_id":"\\ud800\\u0001é\\n","uploaded":{"\\u2028":[]},"reconciled_at":{},"last_synced_at":-1e-7}') },
  { name: 'invalid UTF-8 in the device id', file: bytes('{"_rev":3,"my_device_id":"d', [0xc3, 0x28], '","uploaded":{},"reconciled_at":{},"last_synced_at":0}') },
  { name: 'arrays where objects go', file: text('{"_rev":3,"my_device_id":"d","uploaded":[["2026-01-01"],[]],"reconciled_at":[1,null],"last_synced_at":0}') },
  { name: 'revision 3 as 3.0', file: text('{"_rev":3.0,"my_device_id":"d","uploaded":{},"reconciled_at":{},"last_synced_at":1e21}') },
  { name: 'revision 2', file: text(JSON.stringify({ _rev: 2, my_device_id: 'dev', read_pointers: { x: 3 }, uploaded: { 'u|h': ['2024-02-29'] }, reconciled_at: { 'u|h': null }, last_synced_at: 9 })) },
  { name: 'revision 2 with a bad day', file: text(JSON.stringify({ _rev: 2, my_device_id: 'dev', uploaded: { 'u|h': ['2026-02-29'] }, reconciled_at: {}, last_synced_at: 9 })) },
  { name: 'revision 1', file: text(JSON.stringify({ _rev: 1, my_device_id: 'dev', read_pointers: {}, uploaded: 'ignored', last_synced_at: 2 })) },
  { name: 'revision 4', file: text(JSON.stringify({ _rev: 4, my_device_id: 'dev', uploaded: {}, reconciled_at: {}, last_synced_at: 2 })) },
  { name: 'revision as text', file: text(JSON.stringify({ _rev: '3', my_device_id: 'dev', uploaded: {}, reconciled_at: {}, last_synced_at: 2 })) },
  { name: 'no revision', file: text(JSON.stringify({ my_device_id: 'dev', uploaded: {}, reconciled_at: {}, last_synced_at: 2 })) },
  { name: 'a two-digit year', file: text(JSON.stringify({ _rev: 3, my_device_id: 'dev', uploaded: { k: ['0050-01-01'] }, reconciled_at: {}, last_synced_at: 2 })) },
  { name: 'full-width digits', file: text(JSON.stringify({ _rev: 3, my_device_id: 'dev', uploaded: { k: ['２０２６-01-01'] }, reconciled_at: {}, last_synced_at: 2 })) },
  { name: 'a day that is not text', file: text(JSON.stringify({ _rev: 3, my_device_id: 'dev', uploaded: { k: [20260101] }, reconciled_at: {}, last_synced_at: 2 })) },
  { name: 'a list that is not an array', file: text(JSON.stringify({ _rev: 3, my_device_id: 'dev', uploaded: { k: '2026-01-01' }, reconciled_at: {}, last_synced_at: 2 })) },
  { name: 'a reconcile time as text', file: text(JSON.stringify({ _rev: 3, my_device_id: 'dev', uploaded: {}, reconciled_at: { k: '1' }, last_synced_at: 2 })) },
  { name: 'an infinite reconcile time', file: text('{"_rev":3,"my_device_id":"dev","uploaded":{},"reconciled_at":{"k":1e400},"last_synced_at":2}') },
  { name: 'an infinite sync time', file: text('{"_rev":3,"my_device_id":"dev","uploaded":{},"reconciled_at":{},"last_synced_at":-1e400}') },
  { name: 'a sync time as text', file: text(JSON.stringify({ _rev: 3, my_device_id: 'dev', uploaded: {}, reconciled_at: {}, last_synced_at: '2' })) },
  { name: 'no device id', file: text(JSON.stringify({ _rev: 3, uploaded: {}, reconciled_at: {}, last_synced_at: 2 })) },
  { name: 'null uploads', file: text(JSON.stringify({ _rev: 3, my_device_id: 'dev', uploaded: null, reconciled_at: {}, last_synced_at: 2 })) },
  { name: 'an array', file: text('[]') },
  { name: 'null', file: text('null') },
  { name: 'a byte order mark', file: text('﻿{"_rev":3,"my_device_id":"d","uploaded":{},"reconciled_at":{},"last_synced_at":0}') },
  { name: 'not JSON', file: text('{"_rev":3,') },
  { name: 'empty', file: text('') },
  { name: 'a directory', file: { dir: true } },
]

const OWN = 'own-device'
const STATE_OF = (device: string): Entry =>
  text(JSON.stringify({ _rev: 3, my_device_id: device, uploaded: { [`u|${device}`]: ['2026-01-01'] }, reconciled_at: { [`u|${device}`]: 5 }, last_synced_at: 7 }, null, 2))

const FRESHNESS_CASES: Array<{ name: string; file: Entry; force: boolean; deleteDb?: boolean }> = [
  { name: 'no state', file: null, force: false },
  { name: 'this device', file: STATE_OF(OWN), force: false },
  { name: 'this device without the database', file: STATE_OF(OWN), force: false, deleteDb: true },
  { name: 'another device', file: STATE_OF('other-device'), force: false },
  { name: 'forced', file: STATE_OF(OWN), force: true },
  { name: 'not a state', file: text('{"_rev":9}'), force: false },
  { name: 'revision 2 of this device', file: text(JSON.stringify({ _rev: 2, my_device_id: OWN, uploaded: {}, reconciled_at: {}, last_synced_at: 3 })), force: false },
]

describe('typing-analytics foundation fixtures', () => {
  it('records the installation ids', async () => {
    const records = []
    for (const c of INSTALLATION_ID_CASES) {
      const userData = freshUserData()
      const local = join(userData, 'local')
      const path = join(local, 'installation-id')
      writeEntry(local, c.local ?? null)
      writeEntry(path, c.file)
      pinned.uuids = [NEW_ID]
      resetInstallationIdCacheForTests()
      let id: string | null = null
      try {
        id = await getInstallationId()
      } catch {
        id = null
      }
      records.push({ ...c, local: c.local ?? null, id, after: { local: readEntry(local), file: readEntry(path) } })
      rmSync(userData, { recursive: true, force: true })
    }
    expect(records.filter((r) => r.id === NEW_ID).length).toBeGreaterThan(3)
    writeJsonFixture(join(FIXTURES_DIR, 'installation_id.json'), { newId: NEW_ID, cases: records })
  })

  it('records the sync states', async () => {
    const records = []
    for (const c of SYNC_STATE_CASES) {
      const userData = freshUserData()
      const path = syncStatePath(userData)
      writeEntry(path, c.file)
      const state = await loadSyncState(userData)
      let written: Entry = null
      if (state) {
        rmSync(path, { recursive: true, force: true })
        await saveSyncState(userData, state)
        written = readEntry(path)
      }
      records.push({ ...c, loaded: state !== null, written })
      rmSync(userData, { recursive: true, force: true })
    }
    expect(records.filter((r) => r.loaded).length).toBeGreaterThan(5)
    writeJsonFixture(join(FIXTURES_DIR, 'sync_state.json'), { cases: records })
  })

  it('records the cache freshness checks', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
    try {
      const records = []
      for (const c of FRESHNESS_CASES) {
        const userData = freshUserData()
        const dbPath = join(userData, 'local', 'typing-analytics.db')
        writeEntry(syncStatePath(userData), c.file)
        let db = new TypingAnalyticsDB(dbPath)
        if (c.deleteDb) {
          db.close()
          rmSync(dbPath, { force: true })
          db = new TypingAnalyticsDB(dbPath)
        }
        const { rebuilt } = await ensureCacheIsFresh(db, userData, OWN, { force: c.force })
        db.close()
        records.push({ ...c, deleteDb: c.deleteDb ?? false, rebuilt, after: readEntry(syncStatePath(userData)) })
        rmSync(userData, { recursive: true, force: true })
      }
      writeJsonFixture(join(FIXTURES_DIR, 'cache_freshness.json'), { device: OWN, nowMs: NOW, cases: records })
    } finally {
      vi.useRealTimers()
    }
  })
})
