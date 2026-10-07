// SPDX-License-Identifier: GPL-2.0-or-later
//
// SYNC_UNIT_APPLIED is broadcast only after a merge wrote local files, so
// open renderer lists re-read exactly when there is something new on disk.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? mockUserDataPath : `/mock/${name}`),
  },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}))

const mockDownloadFile = vi.fn(async (_id: string): Promise<unknown> => ({}))
vi.mock('../google-drive', async () => {
  const actual = await vi.importActual<typeof import('../google-drive')>('../google-drive')
  return {
    ...actual,
    listFiles: vi.fn(async () => []),
    downloadFile: (id: string) => mockDownloadFile(id),
    uploadFile: vi.fn(async () => ({ id: 'up', modifiedTime: '2026-01-01T00:00:00.000Z' })),
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
import { MalformedSyncBundleError } from '../merge'
import { IpcChannels } from '../../../shared/ipc/channels'
import { MAX_RUN_LOGS_PER_KEYBOARD } from '../../../shared/types/typing-run-log'
import type { DriveFile } from '../google-drive'

const PW = 'pw'
const UID = 'kb1'
const OLD = '2026-01-01T00:00:00.000Z'
const NEW = '2026-02-01T00:00:00.000Z'

function appliedUnits(): unknown[] {
  return broadcasts.filter((b) => b.channel === IpcChannels.SYNC_UNIT_APPLIED).map((b) => b.payload)
}

function driveFile(name: string): DriveFile {
  return { id: name, name, modifiedTime: NEW } as DriveFile
}

function serveBundle(bundle: unknown): void {
  mockDownloadFile.mockResolvedValue({ ciphertext: JSON.stringify(bundle) })
}

interface Entry { id: string; label: string; filename: string; savedAt: string; updatedAt?: string; deletedAt?: string }

async function writeLocalIndex(unitDir: string, entries: Entry[], files: Record<string, string> = {}): Promise<void> {
  const dir = join(mockUserDataPath, 'sync', ...unitDir.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.json'), JSON.stringify({ type: 'tapDance', entries }), 'utf-8')
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(dir, name), content, 'utf-8')
  }
}

function indexBundle(entries: Entry[], files: Record<string, string> = {}): unknown {
  return { type: 'favorite', key: 'tapDance', index: { type: 'tapDance', entries }, files }
}

beforeEach(async () => {
  vi.clearAllMocks()
  broadcasts.length = 0
  watchedFile = null
  mockUserDataPath = await mkdtemp(join(tmpdir(), 'sync-unit-applied-'))
})

afterEach(async () => {
  await rm(mockUserDataPath, { recursive: true, force: true })
})

describe('settings unit', () => {
  const unit = `keyboards/${UID}/settings`
  const settingsPath = (): string => join(mockUserDataPath, 'sync', 'keyboards', UID, 'pipette_settings.json')

  async function writeLocalSettings(updatedAt: string): Promise<void> {
    await mkdir(join(mockUserDataPath, 'sync', 'keyboards', UID), { recursive: true })
    await writeFile(settingsPath(), JSON.stringify({ theme: 'light', _updatedAt: updatedAt }), 'utf-8')
  }

  function settingsBundle(updatedAt: string | null): unknown {
    const files: Record<string, string> = {}
    if (updatedAt) files['pipette_settings.json'] = JSON.stringify({ theme: 'dark', _updatedAt: updatedAt })
    return { type: 'settings', key: UID, index: { uid: UID, entries: [] }, files }
  }

  it('emits the unit after a remote win has been written', async () => {
    await writeLocalSettings(OLD)
    watchedFile = settingsPath()
    serveBundle(settingsBundle(NEW))

    await mergeWithRemote(driveFile(`keyboards_${UID}_settings.enc`), unit, PW, [])

    expect(appliedUnits()).toEqual([{ syncUnit: unit }])
    const sent = broadcasts.find((b) => b.channel === IpcChannels.SYNC_UNIT_APPLIED)
    expect(JSON.parse(sent?.fileAtSend ?? '{}')).toMatchObject({ theme: 'dark', _updatedAt: NEW })
  })

  it('does not emit when local wins', async () => {
    await writeLocalSettings(NEW)
    serveBundle(settingsBundle(OLD))

    await mergeWithRemote(driveFile(`keyboards_${UID}_settings.enc`), unit, PW, [])

    expect(appliedUnits()).toEqual([])
  })

  it('does not emit when the remote bundle has no settings file', async () => {
    await writeLocalSettings(OLD)
    serveBundle(settingsBundle(null))

    await mergeWithRemote(driveFile(`keyboards_${UID}_settings.enc`), unit, PW, [])

    expect(appliedUnits()).toEqual([])
  })
})

describe('index-based unit', () => {
  const unit = 'favorites/tapDance'
  const df = (): DriveFile => driveFile('favorites_tapDance.enc')
  const base: Entry = { id: 'a', label: 'A', filename: 'a.json', savedAt: OLD, updatedAt: OLD }

  it('emits for a remote tombstone win even though no file is copied', async () => {
    await writeLocalIndex(unit, [base], { 'a.json': '{}' })
    // Recent enough that tombstone GC keeps it.
    const now = new Date().toISOString()
    serveBundle(indexBundle([{ ...base, updatedAt: now, deletedAt: now }]))

    await mergeWithRemote(df(), unit, PW, [])

    expect(appliedUnits()).toEqual([{ syncUnit: unit }])
  })

  it('does not emit when the merged entries equal the local ones', async () => {
    await writeLocalIndex(unit, [base], { 'a.json': '{}' })
    serveBundle(indexBundle([base], { 'a.json': '{}' }))

    await mergeWithRemote(df(), unit, PW, [])

    expect(appliedUnits()).toEqual([])
  })

  it('emits after copying a remote entry file', async () => {
    await writeLocalIndex(unit, [base], { 'a.json': '{}' })
    const added: Entry = { id: 'b', label: 'B', filename: 'b.json', savedAt: NEW, updatedAt: NEW }
    watchedFile = join(mockUserDataPath, 'sync', 'favorites', 'tapDance', 'index.json')
    serveBundle(indexBundle([base, added], { 'a.json': '{}', 'b.json': '{"b":1}' }))

    await mergeWithRemote(df(), unit, PW, [])

    expect(appliedUnits()).toEqual([{ syncUnit: unit }])
    const sent = broadcasts.find((b) => b.channel === IpcChannels.SYNC_UNIT_APPLIED)
    expect(sent?.fileAtSend).toContain('"b.json"')
    expect(await readFile(join(mockUserDataPath, 'sync', 'favorites', 'tapDance', 'b.json'), 'utf-8')).toBe('{"b":1}')
  })

  it('emits when there was no local index yet', async () => {
    serveBundle(indexBundle([base], { 'a.json': '{}' }))

    await mergeWithRemote(df(), unit, PW, [])

    expect(appliedUnits()).toEqual([{ syncUnit: unit }])
  })

  it('does not emit for a malformed remote bundle', async () => {
    await writeLocalIndex(unit, [base])
    serveBundle({ type: 'favorite', key: 'tapDance', index: { entries: 'nope' }, files: {} })

    await expect(mergeWithRemote(df(), unit, PW, [])).rejects.toThrow(MalformedSyncBundleError)

    expect(appliedUnits()).toEqual([])
  })

  it('emits when run-log retention evicts entries', async () => {
    const runUnit = `keyboards/${UID}/runs`
    const runs = Array.from({ length: MAX_RUN_LOGS_PER_KEYBOARD + 1 }, (_, i) => {
      const t = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()
      return { id: `r${i}`, label: '', filename: `r${i}.json`, savedAt: t, updatedAt: t, startedAt: t }
    })
    // Local already holds every entry, so the only change is the eviction.
    await writeLocalIndex(runUnit, runs)
    serveBundle(indexBundle(runs))

    await mergeWithRemote(driveFile(`keyboards_${UID}_runs.enc`), runUnit, PW, [])

    expect(appliedUnits()).toEqual([{ syncUnit: runUnit }])
  })
})

describe('units that never emit', () => {
  it('does not emit for a remote device analytics day', async () => {
    const unit = `keyboards/${UID}/devices/other-hash/days/2026-01-01`
    serveBundle({ type: 'typing-analytics-day', key: unit, index: {}, files: { 'data.jsonl': '' } })

    await mergeWithRemote(driveFile(`keyboards_${UID}_devices_other-hash_days_2026-01-01.enc`), unit, PW, [])

    expect(appliedUnits()).toEqual([])
  })
})
