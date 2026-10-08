// SPDX-License-Identifier: GPL-2.0-or-later
//
// The v2 entry merge applied through `mergeWithRemote` for the index-based
// sync units: per-group clocks across devices, delete / revival, remote
// bodies saved under id-carrying names, orphan body cleanup, the snapshot
// body-hash tie, run-log retention and the upload decision.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? mockUserDataPath : `/mock/${name}`),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

const mockDownloadFile = vi.fn(async (_id: string): Promise<unknown> => ({}))
const mockUploadFile = vi.fn(async (..._args: unknown[]) => ({ id: 'up', modifiedTime: '2026-01-01T00:00:00.000Z' }))
vi.mock('../google-drive', async () => {
  const actual = await vi.importActual<typeof import('../google-drive')>('../google-drive')
  return {
    ...actual,
    listFiles: vi.fn(async () => []),
    downloadFile: (id: string) => mockDownloadFile(id),
    uploadFile: (...args: unknown[]) => mockUploadFile(...args),
  }
})

vi.mock('../sync-crypto', () => ({
  encrypt: vi.fn(async (plaintext: string, _pw: string, syncUnit: string) => ({ syncUnit, ciphertext: plaintext })),
  decrypt: vi.fn(async (envelope: { ciphertext: string }) => envelope.ciphertext),
}))

vi.mock('../../typing-analytics/machine-hash', () => ({
  getMachineHash: vi.fn(async () => 'own-hash'),
}))
vi.mock('../../typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: vi.fn(() => ({})),
}))
vi.mock('../../typing-analytics/jsonl/apply-to-cache', () => ({
  applyRowsToCache: vi.fn(),
}))
vi.mock('../../typing-analytics/jsonl/jsonl-reader', () => ({
  readRows: vi.fn(async () => ({ rows: [], lastId: null, partialLineSkipped: false })),
}))
vi.mock('../../typing-analytics/sync-state', () => ({
  loadSyncState: vi.fn(async () => null),
  saveSyncState: vi.fn(async () => undefined),
  emptySyncState: (id: string) => ({ _rev: 3, my_device_id: id, uploaded: {}, reconciled_at: {}, last_synced_at: 0 }),
}))
vi.mock('../../logger', () => ({ log: vi.fn() }))
vi.mock('../../app-config', () => ({
  loadAppConfig: vi.fn(() => ({ autoSync: false })),
  saveAppConfig: vi.fn(async () => undefined),
  getAppConfigStore: vi.fn(() => ({ get: () => false })),
}))

// Each broadcast records what the target file held at that moment, which
// proves the notification is sent after the write rather than before it.
const broadcasts: Array<{ channel: string; payload: unknown; fileAtSend: string | null }> = []
let watchedFile: string | null = null
vi.mock('../../utils/broadcast', () => ({
  broadcastToAllWindows: vi.fn((channel: string, payload: unknown) => {
    let fileAtSend: string | null = null
    if (watchedFile) {
      try { fileAtSend = readFileSync(watchedFile, 'utf-8') } catch { fileAtSend = null }
    }
    broadcasts.push({ channel, payload, fileAtSend })
  }),
}))

import { mergeWithRemote } from '../sync-merge-dispatch'
import { bundleSyncUnit } from '../sync-bundle'
import { withWriteLock } from '../../per-uid-write-lock'
import { isSyncFormatUpdateRequired } from '../sync-format'
import { SYNC_FORMAT_VERSION } from '../../../shared/constants/sync-format'
import { MAX_RUN_LOGS_PER_KEYBOARD } from '../../../shared/types/typing-run-log'
import type { DriveFile } from '../google-drive'
import type { SyncBundle } from '../../../shared/types/sync'

const PW = 'pw'
const UID = 'kb1'
// Recent enough that no tombstone below reaches the 30-day GC.
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString()
const T0 = daysAgo(4)
const T1 = daysAgo(3)
const T2 = daysAgo(2)
const T3 = daysAgo(1)

type Entry = Record<string, unknown> & { id: string; filename: string }

function dirOf(unit: string): string {
  return join(mockUserDataPath, 'sync', ...unit.split('/'))
}

async function writeLocal(unit: string, index: Record<string, unknown>, entries: Entry[], files: Record<string, string> = {}): Promise<void> {
  const dir = dirOf(unit)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.json'), JSON.stringify({ ...index, entries }), 'utf-8')
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content, 'utf-8')
}

async function readLocal(unit: string): Promise<Entry[]> {
  return (JSON.parse(await readFile(join(dirOf(unit), 'index.json'), 'utf-8')) as { entries: Entry[] }).entries
}

async function merge(unit: string, bundle: Record<string, unknown>): Promise<void> {
  mockDownloadFile.mockResolvedValue({ ciphertext: JSON.stringify(bundle) })
  await mergeWithRemote({ id: 'f', name: 'f.enc', modifiedTime: T3 } as DriveFile, unit, PW, [])
}

function uploaded(): SyncBundle | undefined {
  const call = mockUploadFile.mock.calls[0] as unknown[] | undefined
  if (!call) return undefined
  return JSON.parse((call[1] as { ciphertext: string }).ciphertext) as SyncBundle
}

const fullClocks = (c: Partial<Record<'created' | 'body' | 'name' | 'hub', string>>): Record<string, string> =>
  ({ created: T0, body: T0, name: T0, hub: T0, ...c })

beforeEach(async () => {
  vi.clearAllMocks()
  watchedFile = null
  broadcasts.length = 0
  mockUserDataPath = await mkdtemp(join(tmpdir(), 'sync-merge-v2-'))
})

afterEach(async () => {
  await rm(mockUserDataPath, { recursive: true, force: true })
})

describe('snapshots', () => {
  const unit = `keyboards/${UID}/snapshots`
  const seed = { uid: UID }
  const snap = (c: Record<string, string>, extra: Record<string, unknown> = {}): Entry => ({
    id: 's1', label: 'Local name', filename: 'KB_ts_s1.pipette', savedAt: T0, vilVersion: 1, clocks: c, updatedAt: T0, ...extra,
  })

  it('a rename here and a body save elsewhere both survive', async () => {
    await writeLocal(unit, seed, [snap(fullClocks({ name: T2 }), { updatedAt: T2 })], { 'KB_ts_s1.pipette': 'OLD BODY' })
    const remote = snap(fullClocks({ body: T1 }), { label: 'Old name', vilVersion: 2, updatedAt: T1 })
    await merge(unit, { index: { uid: UID, entries: [remote] }, files: { 'KB_ts_s1.pipette': 'NEW BODY' } })

    const [e] = await readLocal(unit)
    expect(e).toMatchObject({ label: 'Local name', vilVersion: 2, clocks: { name: T2, body: T1 } })
    expect(await readFile(join(dirOf(unit), 'KB_ts_s1.pipette'), 'utf-8')).toBe('NEW BODY')
    // Drive still has the old name.
    expect(uploaded()?.index).toMatchObject({ entries: [{ label: 'Local name', vilVersion: 2 }] })
  })

  it('breaks an exact body tie by the hash of the body bytes, the same way on both devices', async () => {
    const e = snap(fullClocks({}))
    await writeLocal(unit, seed, [e], { 'KB_ts_s1.pipette': 'AAAA' })
    await merge(unit, { index: { uid: UID, entries: [e] }, files: { 'KB_ts_s1.pipette': 'BBBB' } })
    const afterFirst = await readFile(join(dirOf(unit), 'KB_ts_s1.pipette'), 'utf-8')
    const firstUploaded = uploaded() !== undefined

    // The other device: the bodies swapped.
    await rm(dirOf(unit), { recursive: true, force: true })
    mockUploadFile.mockClear()
    await writeLocal(unit, seed, [e], { 'KB_ts_s1.pipette': 'BBBB' })
    await merge(unit, { index: { uid: UID, entries: [e] }, files: { 'KB_ts_s1.pipette': 'AAAA' } })
    const afterSecond = await readFile(join(dirOf(unit), 'KB_ts_s1.pipette'), 'utf-8')

    expect(afterFirst).toBe(afterSecond)
    // Exactly one side keeps its own body and has to send it.
    expect(firstUploaded).not.toBe(uploaded() !== undefined)
  })
})

describe('favorites', () => {
  const unit = 'favorites/macro'
  const seed = { type: 'macro' }
  const fav = (c: Record<string, string>, extra: Record<string, unknown> = {}): Entry => ({
    id: 'f1', label: 'L', filename: 'macro_ts_f1.json', savedAt: T0, clocks: c, updatedAt: T0, ...extra,
  })

  it('a delete wins over a rename made before it and after it; only a re-create revives', async () => {
    await writeLocal(unit, seed, [fav(fullClocks({}), { deletedAt: T2, updatedAt: T2 })], { 'macro_ts_f1.json': 'BODY' })
    await merge(unit, { index: { type: 'macro', entries: [fav(fullClocks({ name: T3 }), { label: 'Renamed', updatedAt: T3 })] }, files: { 'macro_ts_f1.json': 'BODY' } })
    let [e] = await readLocal(unit)
    expect(e.deletedAt).toBe(T2)

    await merge(unit, { index: { type: 'macro', entries: [fav(fullClocks({ created: T3, body: T3 }), { updatedAt: T3 })] }, files: { 'macro_ts_f1.json': 'RECREATED' } })
    ;[e] = await readLocal(unit)
    expect(e.deletedAt).toBeUndefined()
    expect(await readFile(join(dirOf(unit), 'macro_ts_f1.json'), 'utf-8')).toBe('RECREATED')
  })

  it('saves a legacy remote body under its id-carrying name and migrates local legacy names first', async () => {
    await writeLocal(unit, seed, [{ id: 'l1', label: 'Local', filename: 'local.json', savedAt: T0 }], { 'local.json': 'LOCAL' })
    await merge(unit, { index: { type: 'macro', entries: [{ id: 'r1', label: 'Remote', filename: 'remote.json', savedAt: T1 }] }, files: { 'remote.json': 'REMOTE' } })

    const entries = await readLocal(unit)
    expect(entries.map((e) => [e.id, e.filename]).sort()).toEqual([['l1', 'local_l1.json'], ['r1', 'remote_r1.json']])
    expect((await readdir(dirOf(unit))).sort()).toEqual(['index.json', 'local_l1.json', 'remote_r1.json'])
    expect(await readFile(join(dirOf(unit), 'remote_r1.json'), 'utf-8')).toBe('REMOTE')
  })

  it('ignores a remote entry whose body is missing from the bundle', async () => {
    await writeLocal(unit, seed, [], {})
    await merge(unit, { index: { type: 'macro', entries: [fav(fullClocks({}))] }, files: {} })
    expect(await readLocal(unit)).toEqual([])
  })

  it('keeps the local body when the remote side has none, and sends it', async () => {
    await writeLocal(unit, seed, [fav(fullClocks({}))], { 'macro_ts_f1.json': 'BODY' })
    await merge(unit, { index: { type: 'macro', entries: [fav(fullClocks({ body: T2 }))] }, files: {} })
    expect(await readFile(join(dirOf(unit), 'macro_ts_f1.json'), 'utf-8')).toBe('BODY')
    expect(uploaded()?.files['macro_ts_f1.json']).toBe('BODY')
  })

  it('removes only unreferenced body files', async () => {
    await writeLocal(unit, seed, [fav(fullClocks({}))], {
      'macro_ts_f1.json': 'BODY', 'old_orphan.json': 'X', 'notes.txt': 'N', 'plain.json': 'P', 'index.json.123.ab.tmp': 'T',
    })
    await merge(unit, { index: { type: 'macro', entries: [fav(fullClocks({}))] }, files: { 'macro_ts_f1.json': 'BODY' } })
    expect((await readdir(dirOf(unit))).sort()).toEqual(['index.json', 'index.json.123.ab.tmp', 'macro_ts_f1.json', 'notes.txt', 'plain.json'])
  })

  it('does not upload once both sides hold the same v2 entries', async () => {
    const e = fav(fullClocks({}))
    await writeLocal(unit, seed, [e], { 'macro_ts_f1.json': 'BODY' })
    await merge(unit, { index: { type: 'macro', entries: [e] }, files: { 'macro_ts_f1.json': 'BODY' } })
    expect(mockUploadFile).not.toHaveBeenCalled()
  })
})

describe('key labels', () => {
  const unit = 'key-labels'

  it('keeps the local order and merges groups', async () => {
    const a: Entry = { id: 'a', name: 'A', filename: 'a_1.json', savedAt: T0, clocks: { created: T0, body: T0, name: T0, hub: T0 }, updatedAt: T0 }
    const b: Entry = { ...a, id: 'b', name: 'B', filename: 'b_1.json' }
    await writeLocal(unit, {}, [b, a], { 'a_1.json': '{}', 'b_1.json': '{}' })
    await merge(unit, { index: { entries: [a, { ...b, hubPostId: 'p', clocks: { created: T0, body: T0, name: T0, hub: T1 }, updatedAt: T1 }] }, files: { 'a_1.json': '{}', 'b_1.json': '{}' } })
    const entries = await readLocal(unit)
    expect(entries.map((e) => e.id)).toEqual(['b', 'a'])
    expect(entries[0].hubPostId).toBe('p')
  })
})

describe('run logs', () => {
  const unit = `keyboards/${UID}/runs`

  it('applies retention and unlinks the evicted file', async () => {
    const remote: Entry[] = []
    const files: Record<string, string> = {}
    for (let i = 0; i <= MAX_RUN_LOGS_PER_KEYBOARD; i++) {
      const id = `run-${String(i).padStart(3, '0')}`
      const filename = `ts_${id}.json`
      remote.push({ id, startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), filename, savedAt: T0, clocks: { created: T0, body: T0 }, updatedAt: T0 })
      files[filename] = '{}'
    }
    await writeLocal(unit, { uid: UID }, [], {})
    await merge(unit, { index: { uid: UID, entries: remote }, files })
    const entries = await readLocal(unit)
    expect(entries.filter((e) => !e.deletedAt)).toHaveLength(MAX_RUN_LOGS_PER_KEYBOARD)
    expect(entries.find((e) => e.id === 'run-000')?.deletedAt).toBeDefined()
    expect(await readdir(dirOf(unit))).not.toContain('ts_run-000.json')
    // The fresh tombstone goes to Drive.
    expect(mockUploadFile).toHaveBeenCalled()
  })
})

describe('unreadable local index', () => {
  it('fails the unit and leaves the local index and body files alone', async () => {
    const unit = 'favorites/macro'
    await mkdir(dirOf(unit), { recursive: true })
    await writeFile(join(dirOf(unit), 'index.json'), '{"type":"macro","entr', 'utf-8')
    await writeFile(join(dirOf(unit), 'macro_ts_f1.json'), 'UNSENT', 'utf-8')
    await expect(merge(unit, { index: { type: 'macro', entries: [] }, files: {} })).rejects.toThrow()
    expect(await readFile(join(dirOf(unit), 'index.json'), 'utf-8')).toBe('{"type":"macro","entr')
    expect(await readFile(join(dirOf(unit), 'macro_ts_f1.json'), 'utf-8')).toBe('UNSENT')
  })
})

describe('missing local index', () => {
  it('writes the remote index but leaves body files already in the directory', async () => {
    const unit = 'favorites/macro'
    await mkdir(dirOf(unit), { recursive: true })
    await writeFile(join(dirOf(unit), 'macro_ts_x1.json'), 'UNSENT', 'utf-8')
    const e: Entry = { id: 'f1', label: 'L', filename: 'macro_ts_f1.json', savedAt: T0, clocks: fullClocks({}), updatedAt: T0 }
    await merge(unit, { index: { type: 'macro', entries: [e] }, files: { 'macro_ts_f1.json': 'BODY' } })
    expect((await readLocal(unit)).map((x) => x.id)).toEqual(['f1'])
    expect(await readFile(join(dirOf(unit), 'macro_ts_x1.json'), 'utf-8')).toBe('UNSENT')

    // The next merge, with an index present, sweeps as usual.
    await merge(unit, { index: { type: 'macro', entries: [e] }, files: { 'macro_ts_f1.json': 'BODY' } })
    expect(await readdir(dirOf(unit))).not.toContain('macro_ts_x1.json')
  })
})

describe('index without an entries array', () => {
  it('is treated as unreadable: the merge fails and removes no body file', async () => {
    const unit = 'favorites/macro'
    await mkdir(dirOf(unit), { recursive: true })
    await writeFile(join(dirOf(unit), 'index.json'), '{"type":"macro"}', 'utf-8')
    await writeFile(join(dirOf(unit), 'macro_ts_f1.json'), 'UNSENT', 'utf-8')
    await expect(merge(unit, { index: { type: 'macro', entries: [] }, files: {} })).rejects.toThrow()
    expect(await readFile(join(dirOf(unit), 'index.json'), 'utf-8')).toBe('{"type":"macro"}')
    expect(await readFile(join(dirOf(unit), 'macro_ts_f1.json'), 'utf-8')).toBe('UNSENT')
  })
})

describe('bundles', () => {
  it('are read under the store lock', async () => {
    const unit = 'favorites/macro'
    await writeLocal(unit, { type: 'macro' }, [{ id: 'a', label: 'A', filename: 'm_a.json', savedAt: T0 }], { 'm_a.json': 'OLD' })
    let release!: () => void
    const held = withWriteLock(unit, () => new Promise<void>((r) => { release = r }))
    const bundling = bundleSyncUnit(unit)
    await new Promise((r) => setTimeout(r, 20))
    // A save holding the lock replaces the body before the bundle reads it.
    await writeFile(join(dirOf(unit), 'm_a.json'), 'NEW', 'utf-8')
    release()
    await held
    expect((await bundling)?.files['m_a.json']).toBe('NEW')
  })

  it('leave out alive entries whose body file is missing, but keep tombstones', async () => {
    const unit = 'favorites/macro'
    await writeLocal(unit, { type: 'macro' }, [
      { id: 'a', label: 'A', filename: 'm_a.json', savedAt: T0 },
      { id: 'b', label: 'B', filename: 'm_b.json', savedAt: T0 },
      { id: 'c', label: 'C', filename: 'm_c.json', savedAt: T0, deletedAt: T1 },
    ], { 'm_a.json': 'A' })
    const bundle = await bundleSyncUnit(unit)
    expect((bundle?.index as unknown as { entries: Entry[] }).entries.map((e) => e.id)).toEqual(['a', 'c'])
    expect(Object.keys(bundle?.files ?? {}).sort()).toEqual(['index.json', 'm_a.json'])
  })
})

describe('sync format', () => {
  it('is version 2: a v2 marker is current, a v3 marker asks for an update', () => {
    expect(SYNC_FORMAT_VERSION).toBe(2)
    const marker = (n: number): DriveFile => ({ id: `m${n}`, name: `sync-format-v${n}.json`, modifiedTime: T0 } as DriveFile)
    expect(isSyncFormatUpdateRequired([marker(1), marker(2)])).toBe(false)
    expect(isSyncFormatUpdateRequired([marker(3)])).toBe(true)
  })
})
