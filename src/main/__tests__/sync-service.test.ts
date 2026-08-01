// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { access, mkdtemp, readFile, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import type { DriveFile } from '../sync/google-drive'

// --- Mock electron ---
let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
    on: vi.fn(),
    quit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => {
      const str = b.toString()
      if (str.startsWith('enc:')) return str.slice(4)
      throw new Error('decrypt failed')
    }),
  },
  shell: {
    openExternal: vi.fn(async () => {}),
  },
}))

const mockListFiles = vi.fn(async (..._args: unknown[]): Promise<DriveFile[]> => [])
const mockDownloadFile = vi.fn(async (_fileId: string): Promise<Record<string, unknown>> => ({}))
const mockUploadFile = vi.fn(
  async (_name: string, _envelope?: unknown, _existingFileId?: string): Promise<{ id: string; modifiedTime: string }> =>
    ({ id: 'file-id', modifiedTime: '2026-01-01T00:00:00.000Z' }),
)
const mockDeleteFile = vi.fn(async (_fileId: string): Promise<void> => {})

vi.mock('../sync/google-drive', async () => {
  // `driveFileName`/`syncUnitFromFileName` are imported via `importActual`
  // (not hand-rolled) so this mock can never drift out of sync with the
  // real filename ↔ sync-unit mapping again — a stale hand-rolled regex
  // here previously hid a fresh-machine discovery gap for several stores
  // (see Task-sync-unit-filename-gap.md) because the test mock silently
  // kept "supporting" a narrower set of filenames than production code.
  const actual = await vi.importActual<typeof import('../sync/google-drive')>('../sync/google-drive')
  return {
    listFiles: (...args: unknown[]) => mockListFiles(...args),
    downloadFile: (...args: unknown[]) => mockDownloadFile(...(args as Parameters<typeof mockDownloadFile>)),
    uploadFile: (...args: unknown[]) => mockUploadFile(...(args as Parameters<typeof mockUploadFile>)),
    deleteFile: (...args: unknown[]) => mockDeleteFile(...(args as Parameters<typeof mockDeleteFile>)),
    driveFileName: actual.driveFileName,
    syncUnitFromFileName: actual.syncUnitFromFileName,
  }
})

const mockGetAuthStatus = vi.fn(async (..._args: unknown[]) => ({ authenticated: true }))

vi.mock('../sync/google-auth', () => ({
  getAuthStatus: (...args: unknown[]) => mockGetAuthStatus(...args),
  getAccessToken: vi.fn(async () => 'mock-token'),
  startOAuthFlow: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
}))

vi.mock('../sync/sync-crypto', () => ({
  retrievePasswordResult: vi.fn(async () => ({ ok: true, password: 'test-password' })),
  storePassword: vi.fn(async () => {}),
  clearPassword: vi.fn(async () => {}),
  hasStoredPassword: vi.fn(async () => true),
  checkPasswordStrength: vi.fn(() => ({ score: 4, feedback: [] })),
  encrypt: vi.fn(async (plaintext: string, _password: string, syncUnit: string) => ({
    version: 1,
    syncUnit,
    updatedAt: new Date().toISOString(),
    salt: 'mock-salt',
    iv: 'mock-iv',
    ciphertext: plaintext,
  })),
  decrypt: vi.fn(async (envelope: { ciphertext: string }) => envelope.ciphertext),
}))

let mockAutoSync = false
vi.mock('../app-config', () => ({
  loadAppConfig: vi.fn(async () => ({ autoSync: mockAutoSync })),
  saveAppConfig: vi.fn(async () => {}),
  getAppConfigStore: vi.fn(() => ({ get: () => false })),
}))

vi.mock('../typing-analytics/sync', () => ({
  typingAnalyticsDeviceDaySyncUnit: (uid: string, machineHash: string, day: string) =>
    `keyboards/${uid}/devices/${machineHash}/days/${day}`,
  parseTypingAnalyticsDeviceDaySyncUnit: (syncUnit: string) => {
    const parts = syncUnit.split('/')
    if (parts.length !== 6) return null
    if (parts[0] !== 'keyboards' || parts[2] !== 'devices' || parts[4] !== 'days') return null
    if (parts[1].length === 0 || parts[3].length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(parts[5])) return null
    return { uid: parts[1], machineHash: parts[3], utcDay: parts[5] }
  },
}))

const mockApplyRowsToCache = vi.fn((..._args: unknown[]) => ({
  scopes: 0,
  charMinutes: 0,
  matrixMinutes: 0,
  minuteStats: 0,
  sessions: 0,
}))
vi.mock('../typing-analytics/jsonl/apply-to-cache', () => ({
  applyRowsToCache: (...args: unknown[]) => mockApplyRowsToCache(...args),
}))

// Loosely-typed test double for a JSONL row — the consumer of these rows
// (applyRowsToCache) is itself mocked above, so the fixtures here only need
// to match what sync-service.ts reads directly (id/kind/updated_at), not the
// full discriminated JsonlRow union's per-kind payload shape.
interface MockJsonlRow {
  id: string
  kind: string
  updated_at: number
  payload: Record<string, unknown>
}
const mockReadRows = vi.fn(async (..._args: unknown[]) => ({
  rows: [] as MockJsonlRow[],
  lastId: null as string | null,
  partialLineSkipped: false,
}))
vi.mock('../typing-analytics/jsonl/jsonl-reader', () => ({
  readRows: (...args: unknown[]) => mockReadRows(...args),
}))

const mockListLocalKeyboardUids = vi.fn(() => [] as string[])
const mockTombstoneRowsForUidHashInRange = vi.fn(
  (_uid: string, _machineHash: string, _startMs: number, _endMs: number, _updatedAt: number) => ({
    charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0,
  }),
)
vi.mock('../typing-analytics/db/typing-analytics-db', () => ({
  getTypingAnalyticsDB: vi.fn(() => ({
    listLocalKeyboardUids: mockListLocalKeyboardUids,
    tombstoneRowsForUidHashInRange: mockTombstoneRowsForUidHashInRange,
  })),
}))

vi.mock('../typing-analytics/machine-hash', () => ({
  getMachineHash: vi.fn(async () => 'test-machine-hash'),
}))

interface MockTypingSyncState {
  _rev: 3
  my_device_id: string
  uploaded: Record<string, string[]>
  reconciled_at: Record<string, number | null>
  last_synced_at: number
}
let mockSyncState: MockTypingSyncState | null = null
const mockLoadSyncState = vi.fn(async (_userData: string) => (mockSyncState ? { ...mockSyncState } : null))
const mockSaveSyncState = vi.fn(async (_userData: string, state: MockTypingSyncState) => {
  mockSyncState = state
})
vi.mock('../typing-analytics/sync-state', () => ({
  loadSyncState: (...args: unknown[]) => mockLoadSyncState(...args as [string]),
  saveSyncState: (...args: unknown[]) => mockSaveSyncState(...args as [string, MockTypingSyncState]),
  emptySyncState: (myDeviceId: string): MockTypingSyncState => ({
    _rev: 3,
    my_device_id: myDeviceId,
    uploaded: {},
    reconciled_at: {},
    last_synced_at: 0,
  }),
  isReconcilePending: (state: MockTypingSyncState, uid: string, hash: string): boolean => {
    const v = state.reconciled_at[`${uid}|${hash}`]
    return v === undefined || v === null
  },
}))

vi.stubGlobal('fetch', vi.fn())

const mockLog = vi.fn()
vi.mock('../logger', () => ({
  log: (...args: unknown[]) => mockLog(...args),
}))

// Pass-level pack GC is exercised by its own dedicated unit tests
// (src/main/sync/__tests__/pack-gc.test.ts) and by the
// "pack GC coordinator" describe block below (which restores the real
// implementation). Mocked to a no-op by default so every OTHER test in
// this file — many of which write an isolated pack body or index
// fixture without the full sibling state a real sweepOrphans expects —
// doesn't have its fixture files swept out from under it as a false
// "orphan" by a real filesystem side effect it never opted into.
const mockRunPackGcAfterPass = vi.fn().mockResolvedValue(undefined)
vi.mock('../sync/pack-gc', () => ({
  runPackGcAfterPass: (...args: unknown[]) => mockRunPackGcAfterPass(...args),
}))

import { decrypt as mockDecryptFn, encrypt as mockEncryptFn, storePassword as mockStorePasswordFn, clearPassword as mockClearPasswordFn, retrievePasswordResult as mockRetrievePasswordResultFn } from '../sync/sync-crypto'
import type { SyncProgress } from '../../shared/types/sync'
import {
  executeSync,
  isAnalyticsSyncUnit,
  matchesScope,
  notifyChange,
  shouldDownloadSyncUnit,
  setProgressCallback,
  startPolling,
  stopPolling,
  hasPendingChanges,
  cancelPendingChanges,
  isSyncInProgress,
  resetPasswordCheckCache,
  listUndecryptableFiles,
  scanRemoteData,
  changePassword,
  checkPasswordCheckExists,
  setPasswordAndValidate,
  setupBeforeQuitHandler,
  registerPreSyncQuitFinalizer,
  registerBeforeQuitFinalizer,
  deleteRemoteTypingDay,
  fetchRemoteTypingDay,
  _resetForTests,
} from '../sync/sync-service'
import { app } from 'electron'

const POLL_INTERVAL_MS = 3 * 60 * 1000

const FAKE_TIMER_OPTS: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
}

async function flushIO(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
}

/**
 * Drains event-loop turns until `predicate` is true, then lets a couple
 * more turns run so any bookkeeping chained after the awaited condition
 * (e.g. remote-state updates that follow a download) settles too.
 *
 * `flushIO`'s fixed 10-turn drain assumes every awaited step resolves on
 * the microtask/`setImmediate` queue. Polling paths that hit real fs I/O
 * (the tests use a real mkdtemp userData dir) resolve via the libuv
 * threadpool instead, so under load a fixed drain can come up short.
 * This does not throw on timeout — it just falls through so the
 * caller's own assertion produces the meaningful failure message.
 */
async function flushUntil(predicate: () => boolean, maxTurns = 500): Promise<void> {
  for (let i = 0; i < maxTurns && !predicate(); i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
}

function makeRemoteEnvelope(
  updatedAt: string,
  entries?: Array<{ id: string; label: string; filename: string; savedAt: string; updatedAt?: string }>,
): Record<string, unknown> {
  const entryList = entries ?? []
  const files: Record<string, string> = {}
  for (const e of entryList) {
    files[e.filename] = `{"data":"${e.id}"}`
  }
  files['index.json'] = JSON.stringify({ type: 'tapDance', entries: entryList })
  return {
    version: 1,
    syncUnit: 'favorites/tapDance',
    updatedAt,
    salt: 's',
    iv: 'i',
    ciphertext: JSON.stringify({
      type: 'favorite',
      key: 'tapDance',
      index: { type: 'tapDance', entries: entryList },
      files,
    }),
  }
}

function makeSettingsEnvelope(
  uid: string,
  updatedAt: string | undefined,
): Record<string, unknown> {
  const settings: Record<string, unknown> = { theme: 'dark' }
  if (updatedAt !== undefined) settings._updatedAt = updatedAt
  return {
    version: 1,
    syncUnit: `keyboards/${uid}/settings`,
    updatedAt: updatedAt ?? new Date().toISOString(),
    salt: 's',
    iv: 'i',
    ciphertext: JSON.stringify({
      type: 'settings',
      key: uid,
      index: { uid, entries: [] },
      files: { 'pipette_settings.json': JSON.stringify(settings) },
    }),
  }
}

function makeDriveFile(modifiedTime: string): { id: string; name: string; modifiedTime: string } {
  return { id: 'file-1', name: 'favorites_tapDance.enc', modifiedTime }
}

function makeSettingsDriveFile(uid: string, modifiedTime: string): { id: string; name: string; modifiedTime: string } {
  return { id: `settings-${uid}`, name: `keyboards_${uid}_settings.enc`, modifiedTime }
}

const PASSWORD_CHECK_DRIVE_FILE = {
  id: 'pc-1',
  name: 'password-check.enc',
  modifiedTime: '2025-01-01T00:00:00.000Z',
}

function makePasswordCheckEnvelope(): Record<string, unknown> {
  return {
    version: 1,
    syncUnit: 'password-check',
    updatedAt: '2025-01-01T00:00:00.000Z',
    salt: 's',
    iv: 'i',
    ciphertext: JSON.stringify({ type: 'password-check', version: 1 }),
  }
}

async function setupLocalFavorite(
  savedAt: string,
  dataFile?: { name: string; content: string },
  opts?: { id?: string; updatedAt?: string; favoriteType?: string },
): Promise<void> {
  const type = opts?.favoriteType ?? 'tapDance'
  const favDir = join(mockUserDataPath, 'sync', 'favorites', type)
  await mkdir(favDir, { recursive: true })
  const entry: Record<string, string> = {
    id: opts?.id ?? '1',
    label: 'entry',
    filename: dataFile?.name ?? 'data.json',
    savedAt,
  }
  if (opts?.updatedAt) entry.updatedAt = opts.updatedAt
  await writeFile(
    join(favDir, 'index.json'),
    JSON.stringify({ type, entries: [entry] }),
    'utf-8',
  )
  if (dataFile) {
    await writeFile(join(favDir, dataFile.name), dataFile.content, 'utf-8')
  }
}

describe('sync-service', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    vi.useFakeTimers(FAKE_TIMER_OPTS)
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'sync-service-test-'))
    mockAutoSync = false
    mockSyncState = null
    mockListLocalKeyboardUids.mockReturnValue([])
    mockTombstoneRowsForUidHashInRange.mockReturnValue({ charMinutes: 0, matrixMinutes: 0, minuteStats: 0, sessions: 0 })
    _resetForTests()
  })

  afterEach(async () => {
    _resetForTests()
    vi.useRealTimers()
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('notifyChange', () => {
    it('accumulates changes and debounces', () => {
      notifyChange('favorites/tapDance')
      notifyChange('favorites/macro')
    })
  })

  describe('cancelPendingChanges', () => {
    it('clears all pending changes when called without prefix', () => {
      notifyChange('favorites/tapDance')
      notifyChange('keyboards/uid1/settings')
      expect(hasPendingChanges()).toBe(true)

      cancelPendingChanges()
      expect(hasPendingChanges()).toBe(false)
    })

    it('clears only matching pending changes when called with prefix', () => {
      notifyChange('keyboards/uid1/settings')
      notifyChange('keyboards/uid1/snapshots')
      notifyChange('favorites/tapDance')

      cancelPendingChanges('keyboards/uid1/')
      expect(hasPendingChanges()).toBe(true) // favorites/tapDance remains
    })

    it('leaves unrelated pending changes intact', () => {
      notifyChange('keyboards/uid1/settings')
      notifyChange('keyboards/uid2/settings')

      cancelPendingChanges('keyboards/uid1/')
      expect(hasPendingChanges()).toBe(true) // uid2 remains
    })

    it('does not collide with similar uid prefixes', () => {
      notifyChange('keyboards/uid1/settings')
      notifyChange('keyboards/uid10/settings')

      cancelPendingChanges('keyboards/uid1/')
      expect(hasPendingChanges()).toBe(true) // uid10 remains
    })
  })

  describe('isSyncInProgress', () => {
    it('returns false when no sync is running', () => {
      expect(isSyncInProgress()).toBe(false)
    })

    it('returns true during executeSync', async () => {
      mockListFiles.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 100)),
      )

      const syncPromise = executeSync('download')
      expect(isSyncInProgress()).toBe(true)

      await vi.advanceTimersByTimeAsync(200)
      await syncPromise
      expect(isSyncInProgress()).toBe(false)
    })
  })

  describe('setProgressCallback', () => {
    it('accepts a callback function', () => {
      const cb = vi.fn()
      setProgressCallback(cb)
    })
  })

  describe('bundle creation', () => {
    it('reads favorite index and data files', async () => {
      const favDir = join(mockUserDataPath, 'sync', 'favorites', 'tapDance')
      await mkdir(favDir, { recursive: true })

      const index = {
        type: 'tapDance',
        entries: [
          {
            id: 'test-id',
            label: 'Test TD',
            filename: 'tapDance_2024-01-01.json',
            savedAt: '2024-01-01T00:00:00.000Z',
          },
        ],
      }

      await writeFile(join(favDir, 'index.json'), JSON.stringify(index), 'utf-8')
      await writeFile(
        join(favDir, 'tapDance_2024-01-01.json'),
        '{"onTap":4}',
        'utf-8',
      )

      notifyChange('favorites/tapDance')
    })
  })

  describe('sync lock', () => {
    it('prevents concurrent executeSync calls', async () => {
      mockListFiles.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 100)),
      )

      const first = executeSync('download')
      const second = executeSync('download')

      await vi.advanceTimersByTimeAsync(200)
      const firstResult = await first
      // M1/M2: the busy race must surface as a real, checkable status —
      // not a silent no-op indistinguishable from a completed sync.
      const secondResult = await second
      expect(firstResult).toEqual({ status: 'completed' })
      expect(secondResult).toEqual({ status: 'skipped', skipReason: 'busy' })

      expect(mockListFiles).toHaveBeenCalledTimes(1)
    })

    it('releases lock after executeSync completes', async () => {
      mockListFiles.mockResolvedValue([])

      await executeSync('download')
      await executeSync('download')

      expect(mockListFiles).toHaveBeenCalledTimes(2)
    })

    it('releases lock after executeSync errors', async () => {
      mockListFiles
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce([])

      await expect(executeSync('download')).rejects.toThrow('network error')
      await executeSync('download')

      expect(mockListFiles).toHaveBeenCalledTimes(2)
    })
  })

  describe('flush conflict checking', () => {
    it('merges when remote exists and uploads if local has unique entries', async () => {
      // Remote has entry 'r1', local has entry '1' — merge should combine both
      mockListFiles.mockResolvedValue([makeDriveFile('2025-06-01T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2025-06-01T00:00:00.000Z', [
        { id: 'r1', label: 'remote', filename: 'remote.json', savedAt: '2025-06-01T00:00:00.000Z' },
      ]))

      await setupLocalFavorite('2024-01-01T00:00:00.000Z', { name: 'data.json', content: '{"local":1}' })

      await executeSync('upload')

      expect(mockDownloadFile).toHaveBeenCalledWith('file-1')
      // Local has entry '1' not in remote, so remoteNeedsUpdate → upload
      expect(mockUploadFile).toHaveBeenCalled()
    })

    it('uploads when local is newer than remote', async () => {
      mockListFiles.mockResolvedValue([makeDriveFile('2020-01-01T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2020-01-01T00:00:00.000Z'))

      await setupLocalFavorite('2026-01-01T00:00:00.000Z', { name: 'new.json', content: '{"data":1}' })

      await executeSync('upload')

      expect(mockUploadFile).toHaveBeenCalled()
    })

    it('does not upload when remote and local have same entries', async () => {
      mockAutoSync = true
      const sharedEntry = {
        id: '1', label: 'entry', filename: 'data.json', savedAt: '2025-01-01T00:00:00.000Z',
      }
      mockListFiles.mockResolvedValue([makeDriveFile('2025-01-01T00:00:00.000Z'), PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2025-01-01T00:00:00.000Z', [sharedEntry]))

      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{"data":1}' })

      notifyChange('favorites/tapDance')
      await vi.advanceTimersByTimeAsync(10_000)
      await flushIO()

      expect(mockDownloadFile).toHaveBeenCalledWith('file-1')
      expect(mockUploadFile).not.toHaveBeenCalled()
    })
  })

  describe('flush sync lock', () => {
    it('re-schedules flush when sync is in progress', async () => {
      mockAutoSync = true

      mockListFiles.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 30_000)),
      )

      const syncPromise = executeSync('download')

      notifyChange('favorites/tapDance')
      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockListFiles).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(30_000)
      await syncPromise

      mockListFiles.mockResolvedValue([])
      await vi.advanceTimersByTimeAsync(10_000)
      await flushIO()

      expect(mockListFiles.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('polling', () => {
    it('only records state on first poll without downloading data files', async () => {
      mockListFiles.mockResolvedValue([
        PASSWORD_CHECK_DRIVE_FILE,
        makeDriveFile('2026-01-01T00:00:00.000Z'),
      ])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockDownloadFile.mock.calls.some((call) => call[0] === 'pc-1'))
      // Settle the rest of the tick so a hypothetical late data-file
      // download can't land after the count assertion below.
      await flushIO()

      // Password-check downloaded for validation, but data file NOT downloaded
      expect(mockDownloadFile).toHaveBeenCalledTimes(1)
      expect(mockDownloadFile).toHaveBeenCalledWith('pc-1')

      stopPolling()
    })

    it('detects remote changes on subsequent polls and downloads', async () => {
      mockListFiles
        .mockResolvedValueOnce([makeDriveFile('2026-01-01T00:00:00.000Z')])
        .mockResolvedValueOnce([makeDriveFile('2026-01-02T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2026-01-02T00:00:00.000Z'))

      startPolling()
      // First poll: records state, no data download
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockListFiles.mock.calls.length >= 1)
      await flushIO()

      // Second poll: detects modifiedTime change, downloads
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockDownloadFile.mock.calls.some((call) => call[0] === 'file-1'))
      // Settle the tick before the exact listFiles count assertion.
      await flushIO()

      expect(mockListFiles).toHaveBeenCalledTimes(2)
      expect(mockDownloadFile).toHaveBeenCalledWith('file-1')

      stopPolling()
    })

    // Task-sync-unit-filename-gap: themes/i18n only match scope 'all',
    // which the 3-minute poll always uses (see matchesScope) — so once
    // syncUnitFromFileName recognizes their filenames, polling picks up
    // changes for them exactly like any other scope-'all' unit.
    it('detects a changed themes/packs file on a subsequent poll and downloads it', async () => {
      const themePackFile = (modifiedTime: string): DriveFile =>
        ({ id: 'theme-pack-1', name: 'themes_packs_pack-a.enc', modifiedTime })
      mockListFiles
        .mockResolvedValueOnce([themePackFile('2026-01-01T00:00:00.000Z')])
        .mockResolvedValueOnce([themePackFile('2026-01-02T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue({
        version: 1,
        syncUnit: 'themes/packs/pack-a',
        updatedAt: '2026-01-02T00:00:00.000Z',
        salt: 's',
        iv: 'i',
        ciphertext: JSON.stringify({
          type: 'theme-pack',
          key: 'pack-a',
          index: { metas: [] },
          files: { 'pack-a.json': JSON.stringify({ name: 'Pack A', version: '1.0.0', colorScheme: 'dark', colors: {} }) },
        }),
      })

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockListFiles.mock.calls.length >= 1)
      await flushIO()

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockDownloadFile.mock.calls.some((call) => call[0] === 'theme-pack-1'))
      // The merge's file write is real disk I/O — wait for the poll's own
      // sync-lock release rather than a fixed tick count.
      await flushUntil(() => !isSyncInProgress())

      expect(mockDownloadFile).toHaveBeenCalledWith('theme-pack-1')
      await expect(
        readFile(join(mockUserDataPath, 'sync', 'themes', 'packs', 'pack-a.json'), 'utf-8'),
      ).resolves.toContain('Pack A')

      stopPolling()
    })

    // A key-labels-specific variant of this test previously lived here.
    // Dropped as redundant: key-labels rides the same generic index-based
    // poll-merge path already exercised above by favorites (this file's
    // own "detects remote changes on subsequent polls and downloads"),
    // and its filename recognition is pinned at the unit level in
    // google-drive.test.ts's round-trip coverage.

    it('skips when no remote changes detected', async () => {
      mockListFiles.mockResolvedValue([makeDriveFile('2025-01-01T00:00:00.000Z')])

      startPolling()
      // Wait for the poll to actually run (listFiles fires at its start)
      // before settling — a plain fixed drain could return before the
      // tick completed and false-pass the negative count check below.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockListFiles.mock.calls.length >= 1)
      await flushIO()

      const downloadCallCount = mockDownloadFile.mock.calls.length

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockListFiles.mock.calls.length >= 2)
      await flushIO()

      expect(mockDownloadFile.mock.calls.length).toBe(downloadCallCount)

      stopPolling()
    })

    it('skips poll when sync lock is held', async () => {
      mockListFiles.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 5 * 60 * 1000)),
      )

      const syncPromise = executeSync('download')

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

      expect(mockListFiles).toHaveBeenCalledTimes(1)

      stopPolling()
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
      await syncPromise
    })

    it('start/stop lifecycle works correctly', () => {
      startPolling()
      startPolling() // no-op
      stopPolling()
      stopPolling() // no-op, no error
    })

    it('stop prevents further polls', async () => {
      mockListFiles.mockResolvedValue([])

      startPolling()
      stopPolling()

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)

      expect(mockListFiles).not.toHaveBeenCalled()
    })
  })

  describe('pack GC coordinator wiring', () => {
    // pack-gc.ts's own internals (which store(s) it calls, error
    // isolation) are covered by src/main/sync/__tests__/pack-gc.test.ts.
    // This block only asserts sync-service.ts calls it exactly once per
    // PASS (never per-unit) from both the download path and the poll
    // path, with the attempted sync units for that pass.
    it('calls runPackGcAfterPass once after a download pass, with every attempted sync unit', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'pack1', name: 'i18n_packs_pack-a.enc', modifiedTime: '2026-01-01T00:00:00.000Z' },
        makeDriveFile('2026-01-01T00:00:00.000Z'),
      ])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2026-01-01T00:00:00.000Z'))

      await executeSync('download')

      expect(mockRunPackGcAfterPass).toHaveBeenCalledTimes(1)
      const attempted = mockRunPackGcAfterPass.mock.calls[0][0] as string[]
      expect(attempted).toContain('i18n/packs/pack-a')
    })

    it('calls runPackGcAfterPass once per poll pass that touches a pack unit', async () => {
      const themePackFile = (modifiedTime: string): DriveFile =>
        ({ id: 'theme-pack-1', name: 'themes_packs_pack-a.enc', modifiedTime })
      mockListFiles
        .mockResolvedValueOnce([themePackFile('2026-01-01T00:00:00.000Z')])
        .mockResolvedValueOnce([themePackFile('2026-01-02T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue({
        version: 1,
        syncUnit: 'themes/packs/pack-a',
        updatedAt: '2026-01-02T00:00:00.000Z',
        salt: 's',
        iv: 'i',
        ciphertext: JSON.stringify({
          type: 'theme-pack',
          key: 'pack-a',
          index: { metas: [] },
          files: { 'pack-a.json': JSON.stringify({ name: 'Pack A', version: '1.0.0', colorScheme: 'dark', colors: {} }) },
        }),
      })

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockListFiles.mock.calls.length >= 1)
      await flushIO()
      expect(mockRunPackGcAfterPass).not.toHaveBeenCalled() // first poll: seed-only, no merge

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockDownloadFile.mock.calls.some((call) => call[0] === 'theme-pack-1'))
      await flushUntil(() => !isSyncInProgress())

      expect(mockRunPackGcAfterPass).toHaveBeenCalledTimes(1)
      expect(mockRunPackGcAfterPass.mock.calls[0][0]).toContain('themes/packs/pack-a')

      stopPolling()
    })

    it('still calls runPackGcAfterPass once for a pass with no pack units — the attempted list is passed through as-is, and the function itself no-ops on a pack-free list (see pack-gc.test.ts)', async () => {
      mockListFiles.mockResolvedValue([makeDriveFile('2026-01-01T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2026-01-01T00:00:00.000Z'))

      await executeSync('download')

      expect(mockRunPackGcAfterPass).toHaveBeenCalledTimes(1)
      expect(mockRunPackGcAfterPass.mock.calls[0][0]).toEqual(['favorites/tapDance'])
    })

    // M3: a unit that failed to merge this pass must be threaded through
    // as the second argument so pack-gc.ts can skip that store's sweep
    // (see pack-gc.test.ts for the skipSweep-per-store behavior itself).
    it('passes the failed sync unit as the second argument on a download pass', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'pack1', name: 'i18n_packs_pack-a.enc', modifiedTime: '2026-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockRejectedValueOnce(new Error('decrypt failed'))

      await executeSync('download')

      expect(mockRunPackGcAfterPass).toHaveBeenCalledTimes(1)
      expect(mockRunPackGcAfterPass.mock.calls[0][0]).toContain('i18n/packs/pack-a')
      expect(mockRunPackGcAfterPass.mock.calls[0][1]).toEqual(['i18n/packs/pack-a'])
    })

    it('passes the failed sync unit as the second argument on a poll pass', async () => {
      const themePackFile = (modifiedTime: string): DriveFile =>
        ({ id: 'theme-pack-1', name: 'themes_packs_pack-a.enc', modifiedTime })
      mockListFiles
        .mockResolvedValueOnce([themePackFile('2026-01-01T00:00:00.000Z')])
        .mockResolvedValueOnce([themePackFile('2026-01-02T00:00:00.000Z')])
      mockDownloadFile.mockRejectedValue(new Error('decrypt failed'))

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockListFiles.mock.calls.length >= 1)
      await flushIO()

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockDownloadFile.mock.calls.some((call) => call[0] === 'theme-pack-1'))
      await flushUntil(() => !isSyncInProgress())

      expect(mockRunPackGcAfterPass).toHaveBeenCalledTimes(1)
      expect(mockRunPackGcAfterPass.mock.calls[0][1]).toEqual(['themes/packs/pack-a'])

      stopPolling()
    })
  })

  describe('merge-based sync', () => {
    it('merges local and remote entries during download sync', async () => {
      // Local has entry '1', remote has entry 'r1'
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{"local":true}' })

      mockListFiles.mockResolvedValue([makeDriveFile('2025-06-01T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2025-06-01T00:00:00.000Z', [
        { id: 'r1', label: 'remote-entry', filename: 'remote.json', savedAt: '2025-06-01T00:00:00.000Z' },
      ]))

      await executeSync('download')

      // Should have downloaded (merged) and uploaded (local had unique entry)
      expect(mockDownloadFile).toHaveBeenCalledWith('file-1')
      expect(mockUploadFile).toHaveBeenCalled()

      // Verify merged index on disk
      const indexPath = join(mockUserDataPath, 'sync', 'favorites', 'tapDance', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8'))
      expect(index.entries).toHaveLength(2)
      const ids = index.entries.map((e: { id: string }) => e.id).sort()
      expect(ids).toEqual(['1', 'r1'])
    })

    it('does not upload when merge shows no local-only changes', async () => {
      // Both local and remote have the same entry
      const sharedEntry = {
        id: 'shared', label: 'same', filename: 'shared.json', savedAt: '2025-01-01T00:00:00.000Z',
      }
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'shared.json', content: '{}' }, { id: 'shared' })

      mockListFiles.mockResolvedValue([makeDriveFile('2025-01-01T00:00:00.000Z'), PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2025-01-01T00:00:00.000Z', [sharedEntry]))

      await executeSync('download')

      expect(mockDownloadFile).toHaveBeenCalled()
      // Only password-check download, no sync unit uploads
      const syncUnitUploads = mockUploadFile.mock.calls.filter(
        (call) => call[0] !== 'password-check.enc',
      )
      expect(syncUnitUploads).toHaveLength(0)
    })

    it('never writes a remote entry whose filename attempts path traversal (P9)', async () => {
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{"local":true}' })

      mockListFiles.mockResolvedValue([makeDriveFile('2025-06-01T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2025-06-01T00:00:00.000Z', [
        { id: 'evil', label: 'evil', filename: '../../../evil.json', savedAt: '2025-06-01T00:00:00.000Z' },
      ]))

      await executeSync('download')

      // The merge itself must not have thrown, and the traversal target
      // must never be created outside the sync store's own directory.
      await expect(access(join(mockUserDataPath, 'evil.json'))).rejects.toThrow()
      await expect(access(join(mockUserDataPath, 'sync', 'evil.json'))).rejects.toThrow()
    })

    it('uses updatedAt for local timestamp comparison', async () => {
      // savedAt is old but updatedAt is newer
      await setupLocalFavorite(
        '2020-01-01T00:00:00.000Z',
        { name: 'data.json', content: '{}' },
        { updatedAt: '2026-06-01T00:00:00.000Z' },
      )

      mockListFiles.mockResolvedValue([makeDriveFile('2025-01-01T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))

      await executeSync('upload')

      // Local entry is newer (via updatedAt), so should upload
      expect(mockUploadFile).toHaveBeenCalled()
    })
  })

  describe('partial failure reporting', () => {
    it('emits status: partial with failedUnits when some downloads fail', async () => {
      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      // Two remote files: one succeeds, one fails during merge
      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f2', name: 'favorites_macro.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
        .mockRejectedValueOnce(new Error('decrypt failed'))

      await executeSync('download')

      const final = progressEvents[progressEvents.length - 1]
      expect(final.status).toBe('partial')
      expect(final.failedUnits).toEqual(['favorites/macro'])
    })

    it('emits status: success when all downloads succeed', async () => {
      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))

      await executeSync('download')

      const final = progressEvents[progressEvents.length - 1]
      expect(final.status).toBe('success')
      expect(final.failedUnits).toBeUndefined()
    })

    it('emits status: partial with failedUnits when some uploads fail', async () => {
      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      // Set up two local favorites so collectAllSyncUnits finds them
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{}' })
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'macro.json', content: '{}' }, { id: '2', favoriteType: 'macro' })

      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValueOnce(makePasswordCheckEnvelope())
      // tapDance upload succeeds, macro upload fails (argument-based to avoid order dependency)
      mockUploadFile.mockImplementation((name: string) => {
        if (name === 'favorites_macro.enc') return Promise.reject(new Error('upload failed'))
        return Promise.resolve({ id: 'id1', modifiedTime: '2026-01-01T00:00:00.000Z' })
      })

      await executeSync('upload')

      const final = progressEvents[progressEvents.length - 1]
      expect(final.status).toBe('partial')
      expect(final.failedUnits).toBeDefined()
      expect(final.failedUnits).toContain('favorites/macro')
    })

    it('re-adds failed units to pending after partial upload', async () => {
      // Set up two local favorites
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{}' })
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'macro.json', content: '{}' }, { id: '2', favoriteType: 'macro' })

      // Mark both as pending before sync
      notifyChange('favorites/tapDance')
      notifyChange('favorites/macro')
      expect(hasPendingChanges()).toBe(true)

      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValueOnce(makePasswordCheckEnvelope())
      // tapDance succeeds, macro fails (argument-based to avoid order dependency)
      mockUploadFile.mockImplementation((name: string) => {
        if (name === 'favorites_macro.enc') return Promise.reject(new Error('upload failed'))
        return Promise.resolve({ id: 'id1', modifiedTime: '2026-01-01T00:00:00.000Z' })
      })

      await executeSync('upload')

      // Failed unit should remain pending for auto-sync retry
      expect(hasPendingChanges()).toBe(true)
    })

    it('calls listFiles only twice during upload sync (no N+1)', async () => {
      // Set up multiple local favorites to simulate N sync units
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{}' })
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'macro.json', content: '{}' }, { id: '2', favoriteType: 'macro' })

      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValueOnce(makePasswordCheckEnvelope())
      mockUploadFile.mockResolvedValue({ id: 'id1', modifiedTime: '2026-01-01T00:00:00.000Z' })

      await executeSync('upload')

      // listFiles should be called exactly twice:
      // 1. Initial fetch in executeSync (password check + passed to executeUploadSync)
      // 2. Final refresh after the loop
      // NOT N+1 times (once per sync unit)
      expect(mockListFiles).toHaveBeenCalledTimes(2)
      // Verify uploads actually happened (2 sync units, password-check downloaded not uploaded)
      expect(mockUploadFile).toHaveBeenCalledTimes(2)
    })

    it('emits status: error and re-throws on catastrophic failure', async () => {
      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      mockListFiles.mockRejectedValue(new Error('network down'))

      await expect(executeSync('download')).rejects.toThrow('network down')

      const final = progressEvents[progressEvents.length - 1]
      expect(final.status).toBe('error')
      expect(final.failedUnits).toBeUndefined()
    })
  })

  // M1/M2: executeSync's own return value must distinguish a real
  // completion from a silent skip (busy race, missing credentials) or a
  // partial failure — callers (useDeviceLifecycle's packsPulledOnce
  // once-flag, usePackCloudPull's error state) branch on this instead of
  // assuming any non-throwing call succeeded.
  describe('executeSync return value contract (M1/M2)', () => {
    it('returns status: completed when every unit succeeds', async () => {
      mockListFiles.mockResolvedValue([])

      await expect(executeSync('download')).resolves.toEqual({ status: 'completed' })
    })

    it('returns status: skipped, skipReason: unauthenticated when not signed in', async () => {
      mockGetAuthStatus.mockResolvedValueOnce({ authenticated: false })

      await expect(executeSync('download')).resolves.toEqual({
        status: 'skipped',
        skipReason: 'unauthenticated',
      })
    })

    it('returns status: skipped, skipReason: noPasswordFile when no password is stored', async () => {
      vi.mocked(mockRetrievePasswordResultFn).mockResolvedValueOnce({ ok: false, reason: 'noPasswordFile' })

      await expect(executeSync('download')).resolves.toEqual({
        status: 'skipped',
        skipReason: 'noPasswordFile',
      })
    })

    it('returns status: partial with failedUnits when some downloads fail', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f2', name: 'favorites_macro.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
        .mockRejectedValueOnce(new Error('decrypt failed'))

      await expect(executeSync('download')).resolves.toEqual({
        status: 'partial',
        failedUnits: ['favorites/macro'],
      })
    })
  })

  describe('settings timestamp NaN handling', () => {
    const uid = 'test-kb'

    async function setupLocalSettings(updatedAt?: string): Promise<void> {
      const dir = join(mockUserDataPath, 'sync', 'keyboards', uid)
      await mkdir(dir, { recursive: true })
      const settings: Record<string, unknown> = { theme: 'light' }
      if (updatedAt !== undefined) settings._updatedAt = updatedAt
      await writeFile(join(dir, 'pipette_settings.json'), JSON.stringify(settings), 'utf-8')
    }

    async function readLocalSettings(): Promise<Record<string, unknown>> {
      const raw = await readFile(
        join(mockUserDataPath, 'sync', 'keyboards', uid, 'pipette_settings.json'),
        'utf-8',
      )
      return JSON.parse(raw) as Record<string, unknown>
    }

    it('treats invalid local _updatedAt as 0 and accepts valid remote', async () => {
      await setupLocalSettings('invalid-date-string')

      const remoteTime = '2025-06-01T00:00:00.000Z'
      mockListFiles.mockResolvedValue([makeSettingsDriveFile(uid, remoteTime)])
      mockDownloadFile.mockResolvedValue(makeSettingsEnvelope(uid, remoteTime))

      await executeSync('download')

      const settings = await readLocalSettings()
      expect(settings._updatedAt).toBe(remoteTime)
    })

    it('treats invalid remote _updatedAt as 0 and keeps valid local', async () => {
      const localTime = '2025-06-01T00:00:00.000Z'
      await setupLocalSettings(localTime)

      mockListFiles.mockResolvedValue([makeSettingsDriveFile(uid, '2025-06-01T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeSettingsEnvelope(uid, 'garbage'))

      await executeSync('download')

      const settings = await readLocalSettings()
      expect(settings._updatedAt).toBe(localTime)
      expect(settings.theme).toBe('light')
    })

    it('treats both invalid timestamps as 0 — remote does not overwrite local', async () => {
      await setupLocalSettings('not-a-date')

      mockListFiles.mockResolvedValue([makeSettingsDriveFile(uid, '2025-01-01T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeSettingsEnvelope(uid, 'also-not-a-date'))

      await executeSync('download')

      const settings = await readLocalSettings()
      expect(settings.theme).toBe('light')
    })
  })

  describe('listUndecryptableFiles', () => {
    const mockDecrypt = vi.mocked(mockDecryptFn)

    it('returns empty array when all files decrypt successfully', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f2', name: 'favorites_macro.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))

      const result = await listUndecryptableFiles()
      expect(result).toEqual([])
    })

    it('returns only files that fail decryption', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f2', name: 'favorites_macro.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f3', name: 'keyboards_uid1_settings.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
        .mockResolvedValueOnce(makeSettingsEnvelope('uid1', '2025-01-01T00:00:00.000Z'))

      mockDecrypt
        .mockResolvedValueOnce('ok')
        .mockRejectedValueOnce(new Error('Decryption failed'))
        .mockResolvedValueOnce('ok')

      const result = await listUndecryptableFiles()
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        fileId: 'f2',
        fileName: 'favorites_macro.enc',
        syncUnit: 'favorites/macro',
      })
    })

    it('returns empty array when not authenticated', async () => {
      mockGetAuthStatus.mockResolvedValueOnce({ authenticated: false })

      const result = await listUndecryptableFiles()
      expect(result).toEqual([])
    })

    it('includes syncUnit from fileName for keyboard files', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'keyboards_uid1_snapshots.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockResolvedValueOnce(makeSettingsEnvelope('uid1', '2025-01-01T00:00:00.000Z'))
      mockDecrypt.mockRejectedValueOnce(new Error('bad password'))

      const result = await listUndecryptableFiles()
      expect(result).toHaveLength(1)
      expect(result[0].syncUnit).toBe('keyboards/uid1/snapshots')
    })

    it('sets syncUnit to null for unrecognized file names', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'unknown-file.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockResolvedValueOnce({ ciphertext: 'data' })
      mockDecrypt.mockRejectedValueOnce(new Error('bad password'))

      const result = await listUndecryptableFiles()
      expect(result).toHaveLength(1)
      expect(result[0].syncUnit).toBeNull()
      expect(result[0].fileName).toBe('unknown-file.enc')
    })

    it('excludes password-check file from results', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'pc', name: 'password-check.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile
        .mockResolvedValueOnce({ ciphertext: 'check' })
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
      mockDecrypt
        .mockResolvedValueOnce(JSON.stringify({ type: 'password-check', version: 1 }))
        .mockRejectedValueOnce(new Error('bad password'))

      const result = await listUndecryptableFiles()
      expect(result).toHaveLength(1)
      expect(result[0].fileId).toBe('f1')
    })

    it('propagates PasswordMismatchError without scanning data files', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'pc', name: 'password-check.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockResolvedValueOnce({ ciphertext: 'check' })
      mockDecrypt.mockRejectedValueOnce(new Error('wrong password'))

      await expect(listUndecryptableFiles()).rejects.toThrow('sync.passwordMismatch')
      // Data file should never be downloaded
      expect(mockDownloadFile).toHaveBeenCalledTimes(1)
    })
  })

  describe('scanRemoteData', () => {
    const mockDecrypt = vi.mocked(mockDecryptFn)

    it('categorizes keyboards, favorites, and undecryptable files', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'keyboards_uid1_settings.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f2', name: 'keyboards_uid1_snapshots.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f3', name: 'keyboards_uid2_settings.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f4', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f5', name: 'favorites_macro.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makeSettingsEnvelope('uid1', '2025-01-01T00:00:00.000Z'))
        .mockResolvedValueOnce(makeSettingsEnvelope('uid1', '2025-01-01T00:00:00.000Z'))
        .mockResolvedValueOnce(makeSettingsEnvelope('uid2', '2025-01-01T00:00:00.000Z'))
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))

      // All decrypt OK except f5
      mockDecrypt
        .mockResolvedValueOnce('ok')
        .mockResolvedValueOnce('ok')
        .mockResolvedValueOnce('ok')
        .mockResolvedValueOnce('ok')
        .mockRejectedValueOnce(new Error('bad'))

      const result = await scanRemoteData()

      expect(result.keyboards.sort()).toEqual(['uid1', 'uid2'])
      expect(result.favorites.sort()).toEqual(['macro', 'tapDance'])
      expect(result.undecryptable).toHaveLength(1)
      expect(result.undecryptable[0].fileId).toBe('f5')
    })

    // C2: the index file can outlive every pack id it once listed (all
    // tombstoned and GC'd) — hasI18nData/hasThemesData must still report
    // `true` from the index file's own presence alone in that dead zone.
    it('reports hasI18nData/hasThemesData true from the index file alone, with zero pack ids', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'idx1', name: 'i18n_index.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'idx2', name: 'themes_index.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
      mockDecrypt
        .mockResolvedValueOnce('ok')
        .mockResolvedValueOnce('ok')

      const result = await scanRemoteData()

      expect(result.i18nPacks).toEqual([])
      expect(result.themePacks).toEqual([])
      expect(result.hasI18nData).toBe(true)
      expect(result.hasThemesData).toBe(true)
    })

    it('reports hasI18nData/hasThemesData false when neither the index nor any pack id is present', async () => {
      mockListFiles.mockResolvedValue([])

      const result = await scanRemoteData()

      expect(result.hasI18nData).toBe(false)
      expect(result.hasThemesData).toBe(false)
    })

    it('returns empty result when not authenticated', async () => {
      mockGetAuthStatus.mockResolvedValueOnce({ authenticated: false })

      const result = await scanRemoteData()
      expect(result).toEqual({
        keyboards: [],
        keyboardNames: {},
        favorites: [],
        i18nPacks: [],
        themePacks: [],
        keyLabels: false,
        typingTestTexts: false,
        hasI18nData: false,
        hasThemesData: false,
        undecryptable: [],
      })
    })

    it('deduplicates keyboard UIDs', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'keyboards_uid1_settings.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f2', name: 'keyboards_uid1_snapshots.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makeSettingsEnvelope('uid1', '2025-01-01T00:00:00.000Z'))
        .mockResolvedValueOnce(makeSettingsEnvelope('uid1', '2025-01-01T00:00:00.000Z'))

      const result = await scanRemoteData()
      expect(result.keyboards).toEqual(['uid1'])
    })

    it('excludes password-check file from categories', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'pc', name: 'password-check.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile
        .mockResolvedValueOnce({ ciphertext: 'check' })
        .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
      mockDecrypt
        .mockResolvedValueOnce(JSON.stringify({ type: 'password-check', version: 1 }))
        .mockResolvedValueOnce('ok')

      const result = await scanRemoteData()
      expect(result.favorites).toEqual(['tapDance'])
      expect(result.keyboards).toEqual([])
      expect(result.undecryptable).toEqual([])
    })

    // Task-sync-unit-filename-gap: scanRemoteData categorizes purely from
    // syncUnitFromFileName — these previously fell through as unrecognized
    // filenames (syncUnit === null) and were silently dropped from every
    // category, including keyboards (for a uid that only has this file)
    // and themePacks.
    it('surfaces a uid whose only remote file is analyze_filters as a cloud keyboard', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'keyboards_uid-only-filters_analyze_filters.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockResolvedValueOnce({ ciphertext: 'ok' })

      const result = await scanRemoteData()
      expect(result.keyboards).toEqual(['uid-only-filters'])
    })

    it('surfaces theme pack ids found on the remote', async () => {
      mockListFiles.mockResolvedValue([
        { id: 't1', name: 'themes_packs_pack-a.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockResolvedValueOnce({ ciphertext: 'ok' })

      const result = await scanRemoteData()
      expect(result.themePacks).toEqual(['pack-a'])
    })

    it('surfaces keyLabels=true when the global key-labels unit exists on the remote', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'k1', name: 'key-labels.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockResolvedValueOnce({ ciphertext: 'ok' })

      const result = await scanRemoteData()
      expect(result.keyLabels).toBe(true)
      expect(result.typingTestTexts).toBe(false)
    })

    it('surfaces typingTestTexts=true when the global typing-test-texts unit exists on the remote', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'tt1', name: 'typing-test-texts.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockResolvedValueOnce({ ciphertext: 'ok' })

      const result = await scanRemoteData()
      expect(result.typingTestTexts).toBe(true)
      expect(result.keyLabels).toBe(false)
    })
  })

  describe('changePassword', () => {
    const mockDecrypt = vi.mocked(mockDecryptFn)
    const mockEncrypt = vi.mocked(mockEncryptFn)
    const mockStorePassword = vi.mocked(mockStorePasswordFn)

    it('re-encrypts all files and uploads with new password', async () => {
      const dataFile = {
        id: 'f1',
        name: 'favorites_tapDance.enc',
        modifiedTime: '2025-01-01T00:00:00.000Z',
      }
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE, dataFile])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope()) // validatePasswordCheck
        .mockResolvedValueOnce({ version: 1, syncUnit: 'favorites/tapDance', ciphertext: '{"data":"test"}' })

      await changePassword('new-password')

      // Should upload the data file with the new password
      expect(mockEncrypt).toHaveBeenCalledWith('{"data":"test"}', 'new-password', 'favorites/tapDance')
      expect(mockUploadFile).toHaveBeenCalledWith(
        'favorites_tapDance.enc',
        expect.objectContaining({ syncUnit: 'favorites/tapDance' }),
        'f1',
      )
      // Should upload password-check with new password
      expect(mockUploadFile).toHaveBeenCalledWith(
        'password-check.enc',
        expect.objectContaining({ syncUnit: 'password-check' }),
        'pc-1',
      )
      expect(mockStorePassword).toHaveBeenCalledWith('new-password')
    })

    it('aborts when a file cannot be decrypted (uploadFile not called)', async () => {
      const dataFile = {
        id: 'f1',
        name: 'favorites_tapDance.enc',
        modifiedTime: '2025-01-01T00:00:00.000Z',
      }
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE, dataFile])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope()) // validatePasswordCheck
        .mockResolvedValueOnce({ version: 1, syncUnit: 'favorites/tapDance', ciphertext: 'bad' })
      mockDecrypt
        .mockResolvedValueOnce('ok') // validatePasswordCheck succeeds
        .mockRejectedValueOnce(new Error('Decryption failed')) // data file fails

      await expect(changePassword('new-password')).rejects.toThrow('sync.changePasswordUndecryptable')
      expect(mockUploadFile).not.toHaveBeenCalled()
    })

    it('throws when sync is in progress', async () => {
      mockListFiles.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 100)),
      )
      const syncPromise = executeSync('download')

      await expect(changePassword('new-password')).rejects.toThrow(
        'sync.changePasswordInProgress',
      )

      await vi.advanceTimersByTimeAsync(200)
      await syncPromise
    })

    it('throws when new password is the same as current', async () => {
      await expect(changePassword('test-password')).rejects.toThrow('sync.samePassword')
      expect(mockUploadFile).not.toHaveBeenCalled()
    })

    it('throws SyncCredentialError(unauthenticated) when not signed in', async () => {
      mockGetAuthStatus.mockResolvedValueOnce({ authenticated: false })

      await expect(changePassword('new-password')).rejects.toThrow('sync.changePasswordError.unauthenticated')
    })

    it('succeeds with no remote data files (password-check only)', async () => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValueOnce(makePasswordCheckEnvelope())

      await changePassword('new-password')

      // Only password-check should be uploaded (re-created in Phase 3)
      expect(mockUploadFile).toHaveBeenCalledTimes(1)
      expect(mockUploadFile).toHaveBeenCalledWith(
        'password-check.enc',
        expect.objectContaining({ syncUnit: 'password-check' }),
        'pc-1',
      )
      expect(mockStorePassword).toHaveBeenCalledWith('new-password')
    })

    it('validates old password against password-check before proceeding', async () => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValueOnce(makePasswordCheckEnvelope())
      mockDecrypt.mockRejectedValueOnce(new Error('wrong password'))

      await expect(changePassword('new-password')).rejects.toThrow('sync.passwordMismatch')
      // Should not upload anything since validation failed
      expect(mockUploadFile).not.toHaveBeenCalled()
      expect(mockStorePassword).not.toHaveBeenCalled()
    })

    it('skips password-check file during re-encryption and recreates it', async () => {
      const dataFile = {
        id: 'f1',
        name: 'favorites_tapDance.enc',
        modifiedTime: '2025-01-01T00:00:00.000Z',
      }
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE, dataFile])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope()) // validatePasswordCheck
        .mockResolvedValueOnce({ version: 1, syncUnit: 'favorites/tapDance', ciphertext: '{"data":"test"}' })

      await changePassword('new-password')

      // downloadFile called twice: once for validation, once for data file
      expect(mockDownloadFile).toHaveBeenCalledTimes(2)
      expect(mockDownloadFile).toHaveBeenCalledWith('pc-1')
      expect(mockDownloadFile).toHaveBeenCalledWith('f1')
    })

    it('uploads with existing file ID (overwrite)', async () => {
      const dataFile = {
        id: 'existing-id-123',
        name: 'favorites_tapDance.enc',
        modifiedTime: '2025-01-01T00:00:00.000Z',
      }
      // No PASSWORD_CHECK_DRIVE_FILE — validatePasswordCheck will create one
      mockListFiles.mockResolvedValue([dataFile])
      mockDownloadFile.mockResolvedValue({
        version: 1,
        syncUnit: 'favorites/tapDance',
        ciphertext: '{"data":"test"}',
      })

      await changePassword('new-password')

      expect(mockUploadFile).toHaveBeenCalledWith(
        'favorites_tapDance.enc',
        expect.anything(),
        'existing-id-123',
      )
    })

    it('preserves syncUnit from envelope for re-encryption', async () => {
      const dataFile = {
        id: 'f1',
        name: 'keyboards_uid1_settings.enc',
        modifiedTime: '2025-01-01T00:00:00.000Z',
      }
      mockListFiles.mockResolvedValue([dataFile])
      mockDownloadFile.mockResolvedValue({
        version: 1,
        syncUnit: 'keyboards/uid1/settings',
        ciphertext: '{"settings":"data"}',
      })

      await changePassword('new-password')

      expect(mockEncrypt).toHaveBeenCalledWith(
        '{"settings":"data"}',
        'new-password',
        'keyboards/uid1/settings',
      )
    })

    it('releases sync lock on error', async () => {
      mockListFiles.mockRejectedValue(new Error('network error'))

      await expect(changePassword('new-password')).rejects.toThrow('network error')
      expect(isSyncInProgress()).toBe(false)
    })

    it('propagates download errors without classifying as undecryptable', async () => {
      const dataFile = {
        id: 'f1',
        name: 'favorites_tapDance.enc',
        modifiedTime: '2025-01-01T00:00:00.000Z',
      }
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE, dataFile])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope()) // validatePasswordCheck
        .mockRejectedValueOnce(new Error('Network timeout')) // data file download fails

      await expect(changePassword('new-password')).rejects.toThrow('Network timeout')
      expect(mockUploadFile).not.toHaveBeenCalled()
    })
  })

  describe('selective sync (SyncScope)', () => {
    describe('matchesScope', () => {
      it('matches all syncUnits with scope "all"', () => {
        expect(matchesScope('favorites/tapDance', 'all')).toBe(true)
        expect(matchesScope('favorites/macro', 'all')).toBe(true)
        expect(matchesScope('keyboards/0x1234/settings', 'all')).toBe(true)
        expect(matchesScope('keyboards/0x1234/snapshots', 'all')).toBe(true)
      })

      it('matches only favorites/* with scope "favorites"', () => {
        expect(matchesScope('favorites/tapDance', 'favorites')).toBe(true)
        expect(matchesScope('favorites/macro', 'favorites')).toBe(true)
        expect(matchesScope('favorites/combo', 'favorites')).toBe(true)
        expect(matchesScope('keyboards/0x1234/settings', 'favorites')).toBe(false)
        expect(matchesScope('keyboards/0x1234/snapshots', 'favorites')).toBe(false)
      })

      it('matches only keyboards/{uid}/* with scope { keyboard: uid }', () => {
        expect(matchesScope('keyboards/0x1234/settings', { keyboard: '0x1234' })).toBe(true)
        expect(matchesScope('keyboards/0x1234/snapshots', { keyboard: '0x1234' })).toBe(true)
        expect(matchesScope('keyboards/0x5678/settings', { keyboard: '0x1234' })).toBe(false)
        expect(matchesScope('favorites/tapDance', { keyboard: '0x1234' })).toBe(false)
      })

      it('does not match a different uid', () => {
        expect(matchesScope('keyboards/0xABCD/settings', { keyboard: '0x1234' })).toBe(false)
        expect(matchesScope('keyboards/0xABCD/snapshots', { keyboard: '0x1234' })).toBe(false)
      })

      it('safely handles null syncUnit', () => {
        expect(matchesScope(null, 'all')).toBe(true)
        expect(matchesScope(null, 'favorites')).toBe(false)
        expect(matchesScope(null, { keyboard: '0x1234' })).toBe(false)
        expect(matchesScope(null, 'packs')).toBe(false)
      })

      // C.1 / codex ordering trap: 'packs' must be checked BEFORE the
      // unconditional key-labels/typing-test-texts `true`s below it in
      // matchesScope — otherwise a 'packs'-scoped download would also
      // pull those unrelated global units in, since their own checks
      // don't care what scope was asked for.
      describe('scope "packs"', () => {
        it('admits i18n and theme sync units', () => {
          expect(matchesScope('i18n/index', 'packs')).toBe(true)
          expect(matchesScope('i18n/packs/pack-a', 'packs')).toBe(true)
          expect(matchesScope('themes/index', 'packs')).toBe(true)
          expect(matchesScope('themes/packs/pack-a', 'packs')).toBe(true)
        })

        it('rejects key-labels and typing-test-texts despite their normal every-scope pass', () => {
          expect(matchesScope('key-labels', 'packs')).toBe(false)
          expect(matchesScope('typing-test-texts', 'packs')).toBe(false)
        })

        it('rejects keyboard-meta, favorites, and keyboard-scoped units', () => {
          expect(matchesScope('meta/keyboard-names', 'packs')).toBe(false)
          expect(matchesScope('favorites/tapDance', 'packs')).toBe(false)
          expect(matchesScope('keyboards/0x1234/settings', 'packs')).toBe(false)
        })
      })
    })

    describe('isAnalyticsSyncUnit', () => {
      it('identifies per-day typing-analytics units', () => {
        expect(isAnalyticsSyncUnit('keyboards/0x1234/devices/hashabc/days/2026-04-19')).toBe(true)
      })

      it('rejects non-analytics keyboard sub-units', () => {
        expect(isAnalyticsSyncUnit('keyboards/0x1234/settings')).toBe(false)
        expect(isAnalyticsSyncUnit('keyboards/0x1234/snapshots')).toBe(false)
        expect(isAnalyticsSyncUnit('keyboards/0x1234')).toBe(false)
        // Legacy flat device form (no `/days/...`) is no longer recognised.
        expect(isAnalyticsSyncUnit('keyboards/uid-a/devices/machineHash-xyz')).toBe(false)
      })

      it('rejects unrelated units', () => {
        expect(isAnalyticsSyncUnit('favorites/macro')).toBe(false)
        expect(isAnalyticsSyncUnit('meta/keyboard-names')).toBe(false)
        expect(isAnalyticsSyncUnit('')).toBe(false)
      })
    })

    // isRunLogSyncUnit itself is just re-exported here (see sync-bundle's
    // own isRunLogSyncUnit tests in sync-bundle.run-log.test.ts) — only
    // its use in shouldDownloadSyncUnit's scope logic is worth covering
    // in this file.
    describe('shouldDownloadSyncUnit', () => {
      const local = new Set(['uid-a'])
      const analyticsUnit = 'keyboards/uid-a/devices/hash/days/2026-04-19'
      const runLogUnit = 'keyboards/uid-a/runs'
      const settingsUnit = 'keyboards/uid-a/settings'
      const favoritesUnit = 'favorites/macro'

      it("keeps analytics when scope is 'all' (manual sync path)", () => {
        expect(shouldDownloadSyncUnit(analyticsUnit, 'all', local)).toBe(true)
      })

      it('keeps analytics when scope is an explicit keyboard scope (manual keyboard sync)', () => {
        expect(shouldDownloadSyncUnit(analyticsUnit, { keyboard: 'uid-a' }, local)).toBe(true)
      })

      it('drops analytics when scope is the connect-time favorites+keyboard shape', () => {
        const scope = { favorites: true as const, keyboard: 'uid-a' }
        expect(shouldDownloadSyncUnit(analyticsUnit, scope, local)).toBe(false)
        expect(shouldDownloadSyncUnit(settingsUnit, scope, local)).toBe(true)
        expect(shouldDownloadSyncUnit(favoritesUnit, scope, local)).toBe(true)
      })

      it("keeps run logs when scope is 'all' or an explicit keyboard scope, but drops them at connect time", () => {
        expect(shouldDownloadSyncUnit(runLogUnit, 'all', local)).toBe(true)
        expect(shouldDownloadSyncUnit(runLogUnit, { keyboard: 'uid-a' }, local)).toBe(true)
        const connectScope = { favorites: true as const, keyboard: 'uid-a' }
        expect(shouldDownloadSyncUnit(runLogUnit, connectScope, local)).toBe(false)
      })

      // Task-sync-unit-filename-gap: these three stores are discovery-included
      // ("それ以外" column in settings-persistence.md's trigger matrix — no
      // dedicated exclusion predicate like analytics/run-logs) — the fix here
      // is purely that syncUnitFromFileName now recognizes their filenames at
      // all; shouldDownloadSyncUnit's own logic needs no changes for them.
      it('keeps key-labels, typing-test-texts, and analyze_filters under the connect-time scope shape', () => {
        const connectScope = { favorites: true as const, keyboard: 'uid-a' }
        expect(shouldDownloadSyncUnit('key-labels', connectScope, local)).toBe(true)
        expect(shouldDownloadSyncUnit('typing-test-texts', connectScope, local)).toBe(true)
        expect(shouldDownloadSyncUnit('keyboards/uid-a/analyze_filters', connectScope, local)).toBe(true)
        // Sanity: analytics/run-logs remain excluded under the same scope shape.
        expect(shouldDownloadSyncUnit(analyticsUnit, connectScope, local)).toBe(false)
        expect(shouldDownloadSyncUnit(runLogUnit, connectScope, local)).toBe(false)
      })
    })

    describe('executeSync with scope', () => {
      // Task-sync-unit-filename-gap: fresh-machine discovery — a remote-only
      // unit for these stores previously could never be found because
      // syncUnitFromFileName didn't recognize their filenames at all.
      it.each([
        {
          label: 'key-labels',
          fileId: 'kl1',
          fileName: 'key-labels.enc',
          syncUnit: 'key-labels',
          bundleType: 'key-label',
          key: 'key-labels',
          dirSegments: ['key-labels'],
          scope: 'favorites' as const,
        },
        {
          label: 'typing-test-texts',
          fileId: 'tt1',
          fileName: 'typing-test-texts.enc',
          syncUnit: 'typing-test-texts',
          bundleType: 'typing-test-text',
          key: 'typing-test-texts',
          dirSegments: ['typing-test-texts'],
          scope: 'favorites' as const,
        },
        {
          label: 'analyze_filters',
          fileId: 'af1',
          fileName: 'keyboards_0x9999_analyze_filters.enc',
          syncUnit: 'keyboards/0x9999/analyze_filters',
          bundleType: 'analyze-filter',
          key: '0x9999',
          dirSegments: ['keyboards', '0x9999', 'analyze_filters'],
          scope: { keyboard: '0x9999' } as const,
        },
      ])('fresh-machine discovery: downloads a remote-only $label unit', async ({ fileId, fileName, syncUnit, bundleType, key, dirSegments, scope }) => {
        mockListFiles.mockResolvedValue([
          { id: fileId, name: fileName, modifiedTime: '2025-01-01T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        mockDownloadFile
          .mockResolvedValueOnce(makePasswordCheckEnvelope())
          .mockResolvedValueOnce({
            version: 1,
            syncUnit,
            updatedAt: '2025-01-01T00:00:00.000Z',
            salt: 's',
            iv: 'i',
            ciphertext: JSON.stringify({
              type: bundleType,
              key,
              index: { entries: [] },
              files: {},
            }),
          })

        await executeSync('download', scope)

        const downloadedIds = mockDownloadFile.mock.calls.map((call) => call[0])
        expect(downloadedIds).toContain(fileId)
        await expect(
          access(join(mockUserDataPath, 'sync', ...dirSegments, 'index.json')),
        ).resolves.toBeUndefined()
      })

      it('downloads only favorites files when scope is "favorites"', async () => {
        mockListFiles.mockResolvedValue([
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f2', name: 'favorites_macro.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f3', name: 'keyboards_0x1234_settings.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        mockDownloadFile
          .mockResolvedValueOnce(makePasswordCheckEnvelope())
          .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
          .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))

        await executeSync('download', 'favorites')

        // Should download password-check + 2 favorites, NOT the keyboard file
        const downloadedIds = mockDownloadFile.mock.calls.map((call) => call[0])
        expect(downloadedIds).toContain('pc-1') // password check
        expect(downloadedIds).toContain('f1')   // favorites/tapDance
        expect(downloadedIds).toContain('f2')   // favorites/macro
        expect(downloadedIds).not.toContain('f3') // keyboards/0x1234/settings excluded
      })

      it('downloads only target keyboard files when scope is { keyboard: uid }', async () => {
        mockListFiles.mockResolvedValue([
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f2', name: 'keyboards_0x1234_settings.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f3', name: 'keyboards_0x1234_snapshots.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f4', name: 'keyboards_0x5678_settings.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        mockDownloadFile
          .mockResolvedValueOnce(makePasswordCheckEnvelope())
          .mockResolvedValueOnce(makeSettingsEnvelope('0x1234', '2025-01-01T00:00:00.000Z'))
          .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))

        await executeSync('download', { keyboard: '0x1234' })

        const downloadedIds = mockDownloadFile.mock.calls.map((call) => call[0])
        expect(downloadedIds).toContain('pc-1') // password check
        expect(downloadedIds).toContain('f2')   // keyboards/0x1234/settings
        expect(downloadedIds).toContain('f3')   // keyboards/0x1234/snapshots
        expect(downloadedIds).not.toContain('f1') // favorites excluded
        expect(downloadedIds).not.toContain('f4') // other keyboard excluded
      })

      it('downloads all files when scope is omitted and the keyboard is already local', async () => {
        // Lazy: scope='all' only pulls remote keyboards that already exist locally
        await mkdir(join(mockUserDataPath, 'sync', 'keyboards', '0x1234'), { recursive: true })

        mockListFiles.mockResolvedValue([
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f2', name: 'keyboards_0x1234_settings.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        mockDownloadFile
          .mockResolvedValueOnce(makePasswordCheckEnvelope())
          .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
          .mockResolvedValueOnce(makeSettingsEnvelope('0x1234', '2025-01-01T00:00:00.000Z'))

        await executeSync('download')

        const downloadedIds = mockDownloadFile.mock.calls.map((call) => call[0])
        expect(downloadedIds).toContain('f1')
        expect(downloadedIds).toContain('f2')
      })

      it('does not materialize remote-only keyboards locally when scope is omitted (lazy download)', async () => {
        mockListFiles.mockResolvedValue([
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f2', name: 'keyboards_0xRemoteOnly_snapshots.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        // Default response covers password-check + favorites + any backfill probe
        mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

        await executeSync('download')

        // mergeWithRemote should not have run for the remote-only keyboard
        await expect(
          access(join(mockUserDataPath, 'sync', 'keyboards', '0xRemoteOnly')),
        ).rejects.toBeDefined()
      })

      it('updates remote state for all files even with scoped download', async () => {
        // Local copy of 0x1234 exists, so polling should still pick up changes for it
        await mkdir(join(mockUserDataPath, 'sync', 'keyboards', '0x1234'), { recursive: true })

        const allFiles = [
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f2', name: 'keyboards_0x1234_settings.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ]
        mockListFiles.mockResolvedValue(allFiles)
        mockDownloadFile
          .mockResolvedValueOnce(makePasswordCheckEnvelope())
          .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))

        await executeSync('download', 'favorites')

        // First poll with the UNCHANGED file list: the scoped sync must
        // have recorded f2's remote state, so nothing should download.
        // Without this step, a missing f2 state entry (the bug this test
        // guards against) would be indistinguishable from a detected
        // change on the next poll — both trigger a download.
        mockDownloadFile.mockClear()
        startPolling()
        const listCallsAfterSync = mockListFiles.mock.calls.length
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushUntil(() => mockListFiles.mock.calls.length > listCallsAfterSync)
        await flushIO()
        expect(mockDownloadFile).not.toHaveBeenCalledWith('f2')

        // Second poll after the keyboard file's modifiedTime changes:
        // now the download must happen for the locally-tracked keyboard.
        const updatedFiles = [
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f2', name: 'keyboards_0x1234_settings.enc', modifiedTime: '2025-01-02T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ]
        mockListFiles.mockResolvedValue(updatedFiles)
        mockDownloadFile.mockResolvedValue(makeSettingsEnvelope('0x1234', '2025-01-02T00:00:00.000Z'))

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushUntil(() => mockDownloadFile.mock.calls.some((call) => call[0] === 'f2'))

        expect(mockDownloadFile).toHaveBeenCalledWith('f2')

        stopPolling()
      })

      it('polling skips remote-only keyboards (lazy)', async () => {
        // No local directory for 0xRemoteOnly — polling should not download it
        const initialFiles = [
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f2', name: 'keyboards_0xRemoteOnly_snapshots.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ]
        mockListFiles.mockResolvedValue(initialFiles)
        mockDownloadFile
          .mockResolvedValueOnce(makePasswordCheckEnvelope())
          .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))

        await executeSync('download')

        const updatedFiles = [
          ...initialFiles.slice(0, 1),
          { id: 'f2', name: 'keyboards_0xRemoteOnly_snapshots.enc', modifiedTime: '2025-01-02T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ]
        mockListFiles.mockResolvedValue(updatedFiles)

        mockDownloadFile.mockClear()
        startPolling()
        // Wait for the poll to actually run before the negative assertion,
        // otherwise an under-drained tick could false-pass it.
        const listCallsBeforePoll = mockListFiles.mock.calls.length
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushUntil(() => mockListFiles.mock.calls.length > listCallsBeforePoll)
        await flushIO()

        expect(mockDownloadFile).not.toHaveBeenCalledWith('f2')
        stopPolling()
      })

      it('skips password re-validation with non-all scope when cached', async () => {
        // First: validate password with scope 'all'
        mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
        mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

        await executeSync('download')

        // Password is now cached
        mockDownloadFile.mockClear()
        mockListFiles.mockResolvedValue([
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))

        await executeSync('download', 'favorites')

        // Should NOT download password-check again (cached)
        const downloadedIds = mockDownloadFile.mock.calls.map((call) => call[0])
        expect(downloadedIds).not.toContain('pc-1')
      })

      it('forces password re-validation with scope "all"', async () => {
        // First: validate password
        mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
        mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

        await executeSync('download')

        // Second call with 'all' should re-validate
        mockDownloadFile.mockClear()
        mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
        mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

        await executeSync('download', 'all')

        const downloadedIds = mockDownloadFile.mock.calls.map((call) => call[0])
        expect(downloadedIds).toContain('pc-1')
      })

      it('filters upload sync units with scoped upload', async () => {
        // Set up both favorites and keyboard data
        await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{}' })
        const kbDir = join(mockUserDataPath, 'sync', 'keyboards', '0x1234')
        await mkdir(kbDir, { recursive: true })
        await writeFile(join(kbDir, 'pipette_settings.json'), JSON.stringify({ theme: 'dark' }), 'utf-8')

        // First validate password
        mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
        mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())
        await executeSync('download')

        // Now do scoped upload for favorites only
        mockUploadFile.mockClear()
        mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
        mockDownloadFile.mockResolvedValueOnce(makePasswordCheckEnvelope())
        mockUploadFile.mockResolvedValue({ id: 'id1', modifiedTime: '2026-01-01T00:00:00.000Z' })

        await executeSync('upload', 'favorites')

        // Should only upload favorites, not keyboard settings
        const uploadedNames = mockUploadFile.mock.calls.map((call) => call[0])
        const keyboardUploads = uploadedNames.filter((n: string) => n.startsWith('keyboards_'))
        expect(keyboardUploads).toHaveLength(0)
      })

      it('clears only matching pending changes after scoped upload', async () => {
        await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{}' })

        notifyChange('favorites/tapDance')
        notifyChange('keyboards/0x1234/settings')

        mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
        mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())
        mockUploadFile.mockResolvedValue({ id: 'id1', modifiedTime: '2026-01-01T00:00:00.000Z' })

        await executeSync('upload', 'favorites')

        // keyboards/0x1234/settings should still be pending
        expect(hasPendingChanges()).toBe(true)
      })
    })
  })

  describe('password check validation', () => {
    const mockDecrypt = vi.mocked(mockDecryptFn)
    const mockEncrypt = vi.mocked(mockEncryptFn)

    it('creates password-check file when remote has none', async () => {
      mockListFiles.mockResolvedValue([])

      await executeSync('download')

      expect(mockEncrypt).toHaveBeenCalledWith(
        JSON.stringify({ type: 'password-check', version: 1 }),
        'test-password',
        'password-check',
      )
      expect(mockUploadFile).toHaveBeenCalledWith(
        'password-check.enc',
        expect.objectContaining({ syncUnit: 'password-check' }),
      )
    })

    it('validates existing password-check file with correct password', async () => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

      await executeSync('download')

      expect(mockDownloadFile).toHaveBeenCalledWith('pc-1')
      expect(mockDecrypt).toHaveBeenCalled()
    })

    it('throws error when password-check decryption fails', async () => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())
      mockDecrypt.mockRejectedValueOnce(new Error('Decryption failed'))

      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      await expect(executeSync('download')).rejects.toThrow('sync.passwordMismatch')

      const errorEvent = progressEvents.find((p) => p.message === 'sync.passwordMismatch')
      expect(errorEvent).toBeDefined()
      expect(errorEvent?.status).toBe('error')
    })

    it('lets network errors propagate without masking as password mismatch', async () => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockRejectedValue(new Error('Network timeout'))

      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      await expect(executeSync('download')).rejects.toThrow('Network timeout')

      const errorEvent = progressEvents.find((p) => p.status === 'error')
      expect(errorEvent?.message).toBe('Network timeout')
    })

    it('caches validation result for flushPendingChanges', async () => {
      mockAutoSync = true
      // First: manual sync creates and validates
      mockListFiles.mockResolvedValue([])
      await executeSync('download')

      // Now trigger auto-sync — should skip password check (cached)
      mockListFiles.mockResolvedValue([])
      notifyChange('favorites/tapDance')
      await vi.advanceTimersByTimeAsync(10_000)
      await flushIO()

      // No additional password-check upload (cached)
      const passwordCheckUploads = mockUploadFile.mock.calls.filter(
        (call) => call[0] === 'password-check.enc',
      )
      expect(passwordCheckUploads).toHaveLength(1) // Only from the manual sync
    })

    it('re-validates after cache reset', async () => {
      // First: manual sync creates and validates
      mockListFiles.mockResolvedValue([])
      await executeSync('download')

      resetPasswordCheckCache()

      // Second manual sync should re-validate
      mockListFiles.mockResolvedValue([])
      await executeSync('download')

      const passwordCheckUploads = mockUploadFile.mock.calls.filter(
        (call) => call[0] === 'password-check.enc',
      )
      // executeSync always validates (ignores cache), so 2 uploads
      expect(passwordCheckUploads).toHaveLength(2)
    })

    it('does not treat password-check as a regular sync unit during download', async () => {
      // syncUnitFromFileName's own null-mapping for password-check.enc is
      // covered at the unit level by google-drive.test.ts — this test only
      // needs the integration behavior: a download sync must succeed
      // without trying to merge password-check as a data sync unit.
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

      await executeSync('download')
      // Should succeed without trying to merge password-check as a sync unit
    })

    it('validates password on polling when not yet validated', async () => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockDownloadFile.mock.calls.some((call) => call[0] === 'pc-1'))

      // Should have downloaded password-check for validation
      expect(mockDownloadFile).toHaveBeenCalledWith('pc-1')

      stopPolling()
    })
  })

  describe('checkPasswordCheckExists', () => {
    it('returns true when password-check file exists remotely', async () => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])

      const result = await checkPasswordCheckExists()
      expect(result).toBe(true)
    })

    it('returns false when no password-check file exists remotely', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])

      const result = await checkPasswordCheckExists()
      expect(result).toBe(false)
    })

    it('returns false when remote has no files', async () => {
      mockListFiles.mockResolvedValue([])

      const result = await checkPasswordCheckExists()
      expect(result).toBe(false)
    })

    it('propagates network errors', async () => {
      mockListFiles.mockRejectedValue(new Error('network error'))

      await expect(checkPasswordCheckExists()).rejects.toThrow('network error')
    })
  })

  describe('setPasswordAndValidate', () => {
    const mockDecrypt = vi.mocked(mockDecryptFn)
    const mockEncrypt = vi.mocked(mockEncryptFn)
    const mockStorePassword = vi.mocked(mockStorePasswordFn)

    it('stores password and validates against remote password-check', async () => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

      await setPasswordAndValidate('my-password')

      expect(mockStorePassword).toHaveBeenCalledWith('my-password')
      expect(mockDownloadFile).toHaveBeenCalledWith('pc-1')
      expect(mockDecrypt).toHaveBeenCalled()
    })

    it('creates password-check file when none exists remotely', async () => {
      mockListFiles.mockResolvedValue([])

      await setPasswordAndValidate('my-password')

      expect(mockStorePassword).toHaveBeenCalledWith('my-password')
      expect(mockEncrypt).toHaveBeenCalledWith(
        JSON.stringify({ type: 'password-check', version: 1 }),
        'my-password',
        'password-check',
      )
      expect(mockUploadFile).toHaveBeenCalledWith(
        'password-check.enc',
        expect.objectContaining({ syncUnit: 'password-check' }),
      )
    })

    it('throws PasswordMismatchError when password is wrong', async () => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())
      mockDecrypt.mockRejectedValueOnce(new Error('Decryption failed'))

      await expect(setPasswordAndValidate('wrong-password')).rejects.toThrow('sync.passwordMismatch')
    })

    it('clears stored password on validation failure', async () => {
      const mockClearPassword = vi.mocked(mockClearPasswordFn)
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())
      mockDecrypt.mockRejectedValueOnce(new Error('Decryption failed'))

      await expect(setPasswordAndValidate('wrong-password')).rejects.toThrow()
      expect(mockClearPassword).toHaveBeenCalled()
    })
  })

  describe('setupBeforeQuitHandler phased ordering', () => {
    function captureBeforeQuitHandler(): (e: { preventDefault: () => void }) => void {
      setupBeforeQuitHandler()
      const mockOn = vi.mocked(app.on)
      // `app.on` is overloaded per Electron event name, so TS narrows the mock's
      // inferred call-tuple type to whichever overload it picked first. Cast to
      // string for the comparison since at runtime this is always a plain event name.
      const match = mockOn.mock.calls.find(([event]) => (event as string) === 'before-quit')
      if (!match) throw new Error('before-quit handler not registered')
      return match[1] as (e: { preventDefault: () => void }) => void
    }

    it('runs pre-sync finalizers before the sync flush, then extra finalizers', async () => {
      const order: string[] = []
      const preSyncFinalizer = {
        hasWork: () => true,
        run: vi.fn(async () => {
          order.push('pre-sync')
          // Pre-sync finalizer enqueues a sync unit that the flush must pick up.
          notifyChange('keyboards/0xAABB/settings')
        }),
      }
      const extraFinalizer = {
        hasWork: () => true,
        run: vi.fn(async () => {
          order.push('extra')
        }),
      }
      registerPreSyncQuitFinalizer(preSyncFinalizer)
      registerBeforeQuitFinalizer(extraFinalizer)

      // Seed pendingChanges so the sync-flush phase becomes observable.
      notifyChange('favorites/tapDance')

      const handler = captureBeforeQuitHandler()
      const preventDefault = vi.fn()
      handler({ preventDefault })
      await flushIO()

      expect(preventDefault).toHaveBeenCalled()
      expect(preSyncFinalizer.run).toHaveBeenCalledTimes(1)
      expect(extraFinalizer.run).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['pre-sync', 'extra'])
      expect(app.quit).toHaveBeenCalled()
    })

    it('skips the handler entirely when nothing has work', () => {
      const handler = captureBeforeQuitHandler()
      const preventDefault = vi.fn()
      handler({ preventDefault })
      expect(preventDefault).not.toHaveBeenCalled()
    })

    it('runs only pre-sync finalizers when there is no extra work and sync is empty', async () => {
      const preSyncFinalizer = {
        hasWork: () => true,
        run: vi.fn(async () => {}),
      }
      registerPreSyncQuitFinalizer(preSyncFinalizer)

      const handler = captureBeforeQuitHandler()
      handler({ preventDefault: vi.fn() })
      await flushIO()

      expect(preSyncFinalizer.run).toHaveBeenCalledTimes(1)
      expect(app.quit).toHaveBeenCalled()
    })
  })

  // v7 sync scenario coverage. These tests exercise the per-day
  // upload / reconcile / delete code paths with a stateful sync-state
  // mock and a real filesystem tmpDir for local JSONL files, while
  // Google Drive calls stay mocked.
  describe('v7 typing-analytics sync scenarios', () => {
    const OWN_HASH = 'test-machine-hash'
    const REMOTE_HASH = 'remote-hash-xyz'
    const UID = '0xDEAD'
    const cloudFileName = (hash: string, day: string): string =>
      `keyboards_${UID}_devices_${hash}_days_${day}.enc`
    const pointerKey = (hash: string): string => `${UID}|${hash}`
    const ownDayPath = (day: string, hash = OWN_HASH): string =>
      join(mockUserDataPath, 'sync', 'keyboards', UID, 'devices', hash, `${day}.jsonl`)

    async function writeDayFile(day: string, hash = OWN_HASH, content = '{"id":"x"}\n'): Promise<void> {
      const path = ownDayPath(day, hash)
      await mkdir(join(mockUserDataPath, 'sync', 'keyboards', UID, 'devices', hash), { recursive: true })
      await writeFile(path, content, 'utf-8')
    }

    function cloudDriveFile(hash: string, day: string): { id: string; name: string; modifiedTime: string } {
      return { id: `drive-${hash}-${day}`, name: cloudFileName(hash, day), modifiedTime: '2026-04-19T00:00:00.000Z' }
    }

    async function fileExists(path: string): Promise<boolean> {
      try {
        await access(path)
        return true
      } catch { return false }
    }

    // --- Reconcile rule 2: uploaded has, local missing → cloud delete ---
    it('reconcile rule 2: drops cloud file when uploaded lists a day but local file is gone', async () => {
      mockSyncState = {
        _rev: 3,
        my_device_id: OWN_HASH,
        uploaded: { [pointerKey(OWN_HASH)]: ['2026-04-17', '2026-04-18'] },
        reconciled_at: { [pointerKey(OWN_HASH)]: 1_000 },
        last_synced_at: 1_000,
      }
      // Only day 18 exists locally; day 17 was Local-deleted.
      await writeDayFile('2026-04-18')
      mockListFiles.mockResolvedValue([
        cloudDriveFile(OWN_HASH, '2026-04-17'),
        cloudDriveFile(OWN_HASH, '2026-04-18'),
        PASSWORD_CHECK_DRIVE_FILE,
      ])

      await executeSync('upload')

      expect(mockDeleteFile).toHaveBeenCalledWith('drive-test-machine-hash-2026-04-17')
      expect(mockSyncState?.uploaded[pointerKey(OWN_HASH)]).toEqual(['2026-04-18'])
    })

    // --- Reconcile rule 3: uploaded has, cloud missing → local unlink ---
    it('reconcile rule 3: unlinks local file when uploaded has the day but cloud does not', async () => {
      mockSyncState = {
        _rev: 3,
        my_device_id: OWN_HASH,
        uploaded: { [pointerKey(OWN_HASH)]: ['2026-04-17', '2026-04-18'] },
        reconciled_at: { [pointerKey(OWN_HASH)]: 1_000 },
        last_synced_at: 1_000,
      }
      await writeDayFile('2026-04-17')
      await writeDayFile('2026-04-18')
      // Cloud lost day 17 (Sync-deleted from another device).
      mockListFiles.mockResolvedValue([
        cloudDriveFile(OWN_HASH, '2026-04-18'),
        PASSWORD_CHECK_DRIVE_FILE,
      ])

      await executeSync('upload')

      expect(await fileExists(ownDayPath('2026-04-17'))).toBe(false)
      expect(await fileExists(ownDayPath('2026-04-18'))).toBe(true)
      expect(mockSyncState?.uploaded[pointerKey(OWN_HASH)]).toEqual(['2026-04-18'])
    })

    // --- Reconcile orphan cleanup: first run ---
    it('reconcile orphan: deletes cloud-only days when reconciled_at is pending', async () => {
      mockSyncState = {
        _rev: 3,
        my_device_id: OWN_HASH,
        uploaded: { [pointerKey(OWN_HASH)]: [] },
        reconciled_at: { [pointerKey(OWN_HASH)]: null },
        last_synced_at: 0,
      }
      await writeDayFile('2026-04-18')
      mockListFiles.mockResolvedValue([
        cloudDriveFile(OWN_HASH, '2026-04-16'), // orphan: not local, not uploaded
        cloudDriveFile(OWN_HASH, '2026-04-18'),
        PASSWORD_CHECK_DRIVE_FILE,
      ])

      await executeSync('upload')

      expect(mockDeleteFile).toHaveBeenCalledWith('drive-test-machine-hash-2026-04-16')
      expect(typeof mockSyncState?.reconciled_at[pointerKey(OWN_HASH)]).toBe('number')
    })

    // --- Reconcile skip: reconciled_at set ---
    it('reconcile skip: leaves cloud orphans alone once reconciled_at is a timestamp', async () => {
      mockSyncState = {
        _rev: 3,
        my_device_id: OWN_HASH,
        uploaded: { [pointerKey(OWN_HASH)]: [] },
        reconciled_at: { [pointerKey(OWN_HASH)]: 5_000 },
        last_synced_at: 5_000,
      }
      mockListFiles.mockResolvedValue([
        cloudDriveFile(OWN_HASH, '2026-04-16'),
        PASSWORD_CHECK_DRIVE_FILE,
      ])

      await executeSync('upload')

      expect(mockDeleteFile).not.toHaveBeenCalled()
    })

    // --- Rule 1 new-day upload + uploaded bookkeeping ---
    it('rule 1: uploading a new own-hash day records it into sync_state.uploaded', async () => {
      mockSyncState = {
        _rev: 3,
        my_device_id: OWN_HASH,
        uploaded: {},
        reconciled_at: { [pointerKey(OWN_HASH)]: 5_000 }, // reconcile already done
        last_synced_at: 5_000,
      }
      await writeDayFile('2026-04-18')
      mockListLocalKeyboardUids.mockReturnValue([UID])
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])

      await executeSync('upload')

      expect(mockUploadFile).toHaveBeenCalledWith(
        cloudFileName(OWN_HASH, '2026-04-18'),
        expect.anything(),
        undefined,
      )
      expect(mockSyncState?.uploaded[pointerKey(OWN_HASH)]).toEqual(['2026-04-18'])
    })

    // --- deleteRemoteTypingDay E2E ---
    it('deleteRemoteTypingDay: removes cloud + local + cache tombstone in one call', async () => {
      const day = '2026-04-18'
      const localPath = ownDayPath(day, REMOTE_HASH)
      await writeDayFile(day, REMOTE_HASH, '{"id":"remote"}\n')
      mockListFiles.mockResolvedValue([
        cloudDriveFile(REMOTE_HASH, day),
        PASSWORD_CHECK_DRIVE_FILE,
      ])

      const ok = await deleteRemoteTypingDay(UID, REMOTE_HASH, day)

      expect(ok).toBe(true)
      expect(mockDeleteFile).toHaveBeenCalledWith(`drive-${REMOTE_HASH}-${day}`)
      expect(await fileExists(localPath)).toBe(false)
      const tombstoneCall = mockTombstoneRowsForUidHashInRange.mock.calls.at(-1)
      expect(tombstoneCall?.[0]).toBe(UID)
      expect(tombstoneCall?.[1]).toBe(REMOTE_HASH)
    })

    it('deleteRemoteTypingDay: tombstones cache even when the cloud file is already gone', async () => {
      const day = '2026-04-18'
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])

      const ok = await deleteRemoteTypingDay(UID, REMOTE_HASH, day)

      expect(ok).toBe(false)
      expect(mockDeleteFile).not.toHaveBeenCalled()
      expect(mockTombstoneRowsForUidHashInRange).toHaveBeenCalled()
    })

    // --- mergeDeviceDayBundle full replay idempotency (via download flow) ---
    it('download: same remote day merged twice replays rows each call (LWW idempotency)', async () => {
      const day = '2026-04-18'
      const payload = JSON.stringify({ id: 'x', kind: 'scope', updated_at: 1, payload: {} }) + '\n'
      mockReadRows.mockResolvedValue({ rows: [{ id: 'x', kind: 'scope', updated_at: 1, payload: {} }], lastId: 'x', partialLineSkipped: false })
      mockDownloadFile.mockResolvedValue({
        version: 1,
        syncUnit: `keyboards/${UID}/devices/${REMOTE_HASH}/days/${day}`,
        updatedAt: '2026-04-18T00:00:00.000Z',
        salt: 's',
        iv: 'i',
        ciphertext: JSON.stringify({
          type: 'typing-analytics-device',
          key: `${UID}|${REMOTE_HASH}|${day}`,
          index: { uid: UID, entries: [] },
          files: { 'data.jsonl': payload },
        }),
      })
      mockListFiles.mockResolvedValue([
        cloudDriveFile(REMOTE_HASH, day),
        PASSWORD_CHECK_DRIVE_FILE,
      ])
      // Local uid seeded so the lazy scope filter keeps the unit.
      await mkdir(join(mockUserDataPath, 'sync', 'keyboards', UID), { recursive: true })

      await executeSync('download')
      const firstCalls = mockApplyRowsToCache.mock.calls.length
      await executeSync('download')
      const secondCalls = mockApplyRowsToCache.mock.calls.length

      expect(secondCalls).toBeGreaterThan(firstCalls)
    })

    // --- Reconcile: remote hashes are not touched ---
    it('reconcile hash-scope: remote device days stay intact (own-hash only)', async () => {
      mockSyncState = {
        _rev: 3,
        my_device_id: OWN_HASH,
        uploaded: { [pointerKey(OWN_HASH)]: [] },
        reconciled_at: { [pointerKey(OWN_HASH)]: null },
        last_synced_at: 0,
      }
      mockListFiles.mockResolvedValue([
        cloudDriveFile(REMOTE_HASH, '2026-04-18'),
        PASSWORD_CHECK_DRIVE_FILE,
      ])

      await executeSync('upload')

      expect(mockDeleteFile).not.toHaveBeenCalled()
    })

    // --- Same-day re-upload dedup: current day keeps `uploaded` at 1 ---
    it('same-day re-upload: uploaded array stays a single entry across repeated flushes', async () => {
      mockSyncState = {
        _rev: 3,
        my_device_id: OWN_HASH,
        uploaded: {},
        reconciled_at: { [pointerKey(OWN_HASH)]: 5_000 },
        last_synced_at: 5_000,
      }
      await writeDayFile('2026-04-18')
      mockListLocalKeyboardUids.mockReturnValue([UID])

      // First upload: cloud empty, `uploaded` grows by one.
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      await executeSync('upload')
      expect(mockSyncState?.uploaded[pointerKey(OWN_HASH)]).toEqual(['2026-04-18'])

      // Second upload: cloud now has the file; the implementation passes
      // the existing drive id to uploadFile (update-in-place), and
      // `uploaded` stays deduped to a single day.
      mockListFiles.mockResolvedValue([
        cloudDriveFile(OWN_HASH, '2026-04-18'),
        PASSWORD_CHECK_DRIVE_FILE,
      ])
      await executeSync('upload')
      expect(mockSyncState?.uploaded[pointerKey(OWN_HASH)]).toEqual(['2026-04-18'])
    })

    // --- fetchRemoteTypingDay branches ---
    describe('fetchRemoteTypingDay branches', () => {
      it('returns false when the user is not authenticated', async () => {
        vi.mocked(mockRetrievePasswordResultFn).mockResolvedValueOnce({ ok: false, reason: 'unauthenticated' })
        const ok = await fetchRemoteTypingDay(UID, REMOTE_HASH, '2026-04-18')
        expect(ok).toBe(false)
        expect(mockListFiles).not.toHaveBeenCalled()
      })

      it('returns false when the requested cloud file is missing', async () => {
        mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
        const ok = await fetchRemoteTypingDay(UID, REMOTE_HASH, '2026-04-18')
        expect(ok).toBe(false)
        expect(mockDownloadFile).not.toHaveBeenCalled()
      })

      it('own-hash is treated as a no-op (mergeDeviceDayBundle early-returns)', async () => {
        const day = '2026-04-18'
        mockListFiles.mockResolvedValue([
          cloudDriveFile(OWN_HASH, day),
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        mockDownloadFile.mockResolvedValue({
          version: 1,
          syncUnit: `keyboards/${UID}/devices/${OWN_HASH}/days/${day}`,
          updatedAt: '2026-04-18T00:00:00.000Z',
          salt: 's',
          iv: 'i',
          ciphertext: JSON.stringify({
            type: 'typing-analytics-device',
            key: `${UID}|${OWN_HASH}|${day}`,
            index: { uid: UID, entries: [] },
            files: { 'data.jsonl': '' },
          }),
        })

        const ok = await fetchRemoteTypingDay(UID, OWN_HASH, day)
        expect(ok).toBe(true)
        // Download + decrypt ran (we don't short-circuit before decrypt),
        // but no cache apply because mergeDeviceDayBundle exits when
        // machineHash === ownHash.
        expect(mockApplyRowsToCache).not.toHaveBeenCalled()
      })

      it('remote day download: file written locally and rows replayed', async () => {
        const day = '2026-04-18'
        const payload = JSON.stringify({ id: 'y', kind: 'scope', updated_at: 1, payload: {} }) + '\n'
        mockReadRows.mockResolvedValue({
          rows: [{ id: 'y', kind: 'scope', updated_at: 1, payload: {} }],
          lastId: 'y',
          partialLineSkipped: false,
        })
        mockListFiles.mockResolvedValue([
          cloudDriveFile(REMOTE_HASH, day),
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        mockDownloadFile.mockResolvedValue({
          version: 1,
          syncUnit: `keyboards/${UID}/devices/${REMOTE_HASH}/days/${day}`,
          updatedAt: '2026-04-18T00:00:00.000Z',
          salt: 's',
          iv: 'i',
          ciphertext: JSON.stringify({
            type: 'typing-analytics-device',
            key: `${UID}|${REMOTE_HASH}|${day}`,
            index: { uid: UID, entries: [] },
            files: { 'data.jsonl': payload },
          }),
        })

        const ok = await fetchRemoteTypingDay(UID, REMOTE_HASH, day)
        expect(ok).toBe(true)
        expect(await fileExists(ownDayPath(day, REMOTE_HASH))).toBe(true)
        expect(mockApplyRowsToCache).toHaveBeenCalled()
      })
    })

    // --- v1 state → executeSync triggers orphan reconcile on first run ---
    it('v1-shaped state: first executeSync upload treats reconciled_at missing as pending', async () => {
      // Simulate a v1-migrated state: the migration leaves `reconciled_at`
      // as an empty object, so `isReconcilePending` returns true for any
      // key. The first upload pass must perform orphan cleanup and then
      // stamp `reconciled_at`.
      mockSyncState = {
        _rev: 3,
        my_device_id: OWN_HASH,
        uploaded: {},
        reconciled_at: {}, // empty map — no key has been reconciled yet
        last_synced_at: 0,
      }
      mockListFiles.mockResolvedValue([
        cloudDriveFile(OWN_HASH, '2026-04-16'), // cloud orphan
        PASSWORD_CHECK_DRIVE_FILE,
      ])

      await executeSync('upload')

      expect(mockDeleteFile).toHaveBeenCalledWith('drive-test-machine-hash-2026-04-16')
      expect(typeof mockSyncState?.reconciled_at[pointerKey(OWN_HASH)]).toBe('number')
    })

    // --- 0:00 UTC crossing delete: one local date spans two UTC days ---
    it('local-date delete spanning 0:00 UTC unlinks both UTC day files', async () => {
      // A non-UTC wall-clock timezone interprets "2026-04-18" as a 24h
      // window that includes the last hours of UTC 2026-04-17 and early
      // hours of 2026-04-18. The delete must unlink both.
      await writeDayFile('2026-04-17')
      await writeDayFile('2026-04-18')
      mockSyncState = {
        _rev: 3,
        my_device_id: OWN_HASH,
        uploaded: { [pointerKey(OWN_HASH)]: ['2026-04-17', '2026-04-18'] },
        reconciled_at: { [pointerKey(OWN_HASH)]: 5_000 },
        last_synced_at: 5_000,
      }
      mockListFiles.mockResolvedValue([
        cloudDriveFile(OWN_HASH, '2026-04-17'),
        cloudDriveFile(OWN_HASH, '2026-04-18'),
        PASSWORD_CHECK_DRIVE_FILE,
      ])
      // Simulate "both days already gone locally" (the TZ-straddling
      // delete path in typing-analytics-service maps one local date to
      // two UTC days and unlinks each). Here we verify reconcile rule 2
      // fires for both in the same pass.
      const { unlink } = await import('node:fs/promises')
      await unlink(ownDayPath('2026-04-17'))
      await unlink(ownDayPath('2026-04-18'))

      await executeSync('upload')

      const deletedIds = mockDeleteFile.mock.calls.map((c) => c[0]).sort()
      expect(deletedIds).toEqual([
        'drive-test-machine-hash-2026-04-17',
        'drive-test-machine-hash-2026-04-18',
      ])
      expect(mockSyncState?.uploaded[pointerKey(OWN_HASH)]).toEqual([])
    })
  })

  // Task-sync-unit-filename-gap / bundle-variant merge crash regression.
  // i18n-index / i18n-pack / theme-index / theme-pack bundles carry
  // `{ metas: [...] }` or a raw pack body, never `{ entries }` — so before
  // dedicated branches existed, mergeSyncUnit's generic index-based branch
  // called `gcTombstones((remoteBundle.index as { entries }).entries)` on
  // `undefined`, throwing a TypeError. This first test pins the pre-fix
  // failure mode (caught per-unit → 'partial' status); every test after it
  // asserts the fixed LWW behavior.
  describe('bundle-variant merge (i18n/theme index + pack)', () => {
    /** Builds a mock decrypted SyncEnvelope for any bundle shape (index
     *  or pack-body). Replaces the four near-identical `make*Envelope`
     *  factories this describe block used to carry, one per
     *  i18n/theme × index/pack combination. */
    function makeBundleEnvelope(
      syncUnit: string,
      updatedAt: string,
      bundle: { type: string; key: string; index?: unknown; files?: Record<string, string> },
    ): Record<string, unknown> {
      return {
        version: 1,
        syncUnit,
        updatedAt,
        salt: 's',
        iv: 'i',
        ciphertext: JSON.stringify({
          type: bundle.type,
          key: bundle.key,
          index: bundle.index ?? { metas: [] },
          files: bundle.files ?? {},
        }),
      }
    }

    it('regression baseline: merging a remote i18n-index bundle no longer crashes the sync unit', async () => {
      // Pre-fix, this scenario threw inside gcTombstones(undefined) and
      // surfaced as a 'partial' sync with 'i18n/index' in failedUnits.
      // Post-fix it must merge cleanly (remote is the only side, so
      // remote wins trivially) and report 'success'.
      mockListFiles.mockResolvedValue([
        { id: 'idx1', name: 'i18n_index.enc', modifiedTime: '2026-01-01T00:00:00.000Z' },
        PASSWORD_CHECK_DRIVE_FILE,
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope())
        .mockResolvedValueOnce(makeBundleEnvelope('i18n/index', '2026-01-01T00:00:00.000Z', {
          type: 'i18n-index',
          key: 'i18n-index',
          index: { metas: [{ id: 'p1', name: 'Test Pack', version: '1.0.0', enabled: true, savedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] },
        }))

      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      await executeSync('download')

      const final = progressEvents[progressEvents.length - 1]
      expect(final.status).toBe('success')
      expect(final.failedUnits).toBeUndefined()

      const written = JSON.parse(
        await readFile(join(mockUserDataPath, 'sync', 'i18n', 'index.json'), 'utf-8'),
      ) as { metas: Array<{ id: string }> }
      expect(written.metas.map((m) => m.id)).toEqual(['p1'])
    })

    it.each([
      {
        label: 'i18n',
        syncUnit: 'i18n/index',
        fileName: 'i18n_index.enc',
        fileId: 'idx1',
        bundleType: 'i18n-index',
        dir: 'i18n',
        meta: { id: 'new', name: 'New Pack', version: '2.0.0', enabled: true, savedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
      },
      {
        label: 'theme',
        syncUnit: 'themes/index',
        fileName: 'themes_index.enc',
        fileId: 'tidx1',
        bundleType: 'theme-index',
        dir: 'themes',
        meta: { id: 't1', name: 'Ocean', version: '1.0.0', savedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' },
      },
    ])('$label-index: remote-only id merges alongside the pre-existing local id (union, not wholesale replace)', async ({ syncUnit, fileName, fileId, bundleType, dir, meta }) => {
      // M1 fix: index merge used to be file-level LWW — "newer roster
      // wins wholesale" — which meant a remote index arriving with a
      // different id than local's simply erased the local-only entry
      // forever (its body file became an orphan, unreachable because
      // collectAllSyncUnits only walks ids present in the index). This
      // is now entry-level LWW: both ids survive as a union, and since
      // local has an id remote doesn't have yet, the merged index is
      // marked for re-upload so remote converges too.
      await mkdir(join(mockUserDataPath, 'sync', dir), { recursive: true })
      await writeFile(
        join(mockUserDataPath, 'sync', dir, 'index.json'),
        JSON.stringify({ metas: [{ ...meta, id: 'old', savedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }] }),
        'utf-8',
      )

      mockListFiles.mockResolvedValue([
        { id: fileId, name: fileName, modifiedTime: '2026-06-01T00:00:00.000Z' },
        PASSWORD_CHECK_DRIVE_FILE,
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope())
        .mockResolvedValueOnce(makeBundleEnvelope(syncUnit, '2026-06-01T00:00:00.000Z', {
          type: bundleType,
          key: bundleType,
          index: { metas: [meta] },
        }))

      await executeSync('download')

      // Local had an entry ('old') remote doesn't have — the unit must
      // be re-uploaded so remote picks it up too (both sides converge).
      expect(mockUploadFile.mock.calls.some((c) => c[0] === fileName)).toBe(true)
      const written = JSON.parse(
        await readFile(join(mockUserDataPath, 'sync', dir, 'index.json'), 'utf-8'),
      ) as { metas: Array<{ id: string }> }
      expect(written.metas.map((m) => m.id).sort()).toEqual(['old', meta.id].sort())
    })

    it('two machines each install a different pack while offline: next sync converges to the union, neither pack is lost', async () => {
      // The headline M1 scenario: machine A installs pack 'pack-a'
      // (already on remote); machine B (this process) independently
      // installed 'pack-b' locally before ever syncing. A naive
      // file-level LWW would have machine B's later local timestamp win
      // wholesale, permanently erasing 'pack-a' from both the local
      // index AND — once B uploads — from remote too, orphaning its
      // pack body forever. Entry-level LWW must instead keep both.
      await mkdir(join(mockUserDataPath, 'sync', 'i18n'), { recursive: true })
      await writeFile(
        join(mockUserDataPath, 'sync', 'i18n', 'index.json'),
        JSON.stringify({ metas: [{ id: 'pack-b', name: 'Pack B', version: '1.0.0', enabled: true, savedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' }] }),
        'utf-8',
      )

      mockListFiles.mockResolvedValue([
        { id: 'idx1', name: 'i18n_index.enc', modifiedTime: '2020-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockResolvedValueOnce(makeBundleEnvelope('i18n/index', '2020-01-01T00:00:00.000Z', {
        type: 'i18n-index',
        key: 'i18n-index',
        index: { metas: [{ id: 'pack-a', name: 'Pack A', version: '1.0.0', enabled: true, savedAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z' }] },
      }))
      mockUploadFile.mockResolvedValue({ id: 'idx-file-id', modifiedTime: '2026-01-01T00:00:00.000Z' })

      await executeSync('download')

      // Both packs survive the merge — this is the union, not a
      // one-side-wins replacement.
      expect(mockUploadFile.mock.calls.some((c) => c[0] === 'i18n_index.enc')).toBe(true)
      const written = JSON.parse(
        await readFile(join(mockUserDataPath, 'sync', 'i18n', 'index.json'), 'utf-8'),
      ) as { metas: Array<{ id: string }> }
      expect(written.metas.map((m) => m.id)).toEqual(['pack-b', 'pack-a'])
    })

    it('the built-in English meta merges harmlessly across machines despite each machine stamping its own first-seen timestamp', async () => {
      // ensureBuiltinEnglishEntry creates 'builtin-english' locally with
      // whatever timestamp this machine first saw it at — two machines
      // therefore carry different savedAt/updatedAt for the exact same
      // logical entry. Confirms per-id LWW picking either side is
      // harmless: the entry that "wins" still has the same
      // name/version/enabled content every machine generates.
      await mkdir(join(mockUserDataPath, 'sync', 'i18n'), { recursive: true })
      await writeFile(
        join(mockUserDataPath, 'sync', 'i18n', 'index.json'),
        JSON.stringify({ metas: [{ id: 'builtin-english', filename: 'packs/builtin-english.json', name: 'English', version: '0.0.0', enabled: true, uploaderName: 'pipette', savedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] }),
        'utf-8',
      )

      mockListFiles.mockResolvedValue([
        { id: 'idx1', name: 'i18n_index.enc', modifiedTime: '2026-06-01T00:00:00.000Z' },
        PASSWORD_CHECK_DRIVE_FILE,
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope())
        .mockResolvedValueOnce(makeBundleEnvelope('i18n/index', '2026-06-01T00:00:00.000Z', {
          type: 'i18n-index',
          key: 'i18n-index',
          index: { metas: [{ id: 'builtin-english', filename: 'packs/builtin-english.json', name: 'English', version: '0.0.0', enabled: true, uploaderName: 'pipette', savedAt: '2026-06-01T00:00:00.000Z', updatedAt: '2026-06-01T00:00:00.000Z' }] },
        }))

      await executeSync('download')

      const written = JSON.parse(
        await readFile(join(mockUserDataPath, 'sync', 'i18n', 'index.json'), 'utf-8'),
      ) as { metas: Array<{ id: string; name: string; version: string; enabled: boolean }> }
      expect(written.metas).toHaveLength(1)
      expect(written.metas[0]).toMatchObject({ id: 'builtin-english', name: 'English', version: '0.0.0', enabled: true })
    })

    it.each([
      {
        label: 'i18n',
        syncUnit: 'i18n/packs/pack-a',
        fileName: 'i18n_packs_pack-a.enc',
        fileId: 'pack1',
        bundleType: 'i18n-pack',
        dir: 'i18n',
        packId: 'pack-a',
        body: { name: 'Pack A', version: '2.0.0' },
      },
      {
        label: 'theme',
        syncUnit: 'themes/packs/theme-a',
        fileName: 'themes_packs_theme-a.enc',
        fileId: 'tpack1',
        bundleType: 'theme-pack',
        dir: 'themes',
        packId: 'theme-a',
        body: { name: 'Theme A', version: '2.0.0', colorScheme: 'dark', colors: {} },
      },
    ])('$label-pack: remote newer than local mtime writes the pack body locally', async ({ syncUnit, fileName, fileId, bundleType, dir, packId, body }) => {
      mockListFiles.mockResolvedValue([
        { id: fileId, name: fileName, modifiedTime: '2026-06-01T00:00:00.000Z' },
        PASSWORD_CHECK_DRIVE_FILE,
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope())
        .mockResolvedValueOnce(makeBundleEnvelope(syncUnit, '2026-06-01T00:00:00.000Z', {
          type: bundleType,
          key: packId,
          files: { [`${packId}.json`]: JSON.stringify(body) },
        }))

      await executeSync('download')

      const written = JSON.parse(
        await readFile(join(mockUserDataPath, 'sync', dir, 'packs', `${packId}.json`), 'utf-8'),
      ) as { version: string }
      expect(written.version).toBe('2.0.0')
      // applySyncedPackBody writes via temp-file-then-rename — the `.tmp`
      // must never linger after a successful write.
      await expect(
        access(join(mockUserDataPath, 'sync', dir, 'packs', `${packId}.json.tmp`)),
      ).rejects.toThrow()
    })

    it('local i18n-pack file newer than remote drive modifiedTime: local kept, remote re-uploaded', async () => {
      await mkdir(join(mockUserDataPath, 'sync', 'i18n', 'packs'), { recursive: true })
      await writeFile(
        join(mockUserDataPath, 'sync', 'i18n', 'packs', 'pack-a.json'),
        JSON.stringify({ name: 'Pack A', version: '3.0.0' }),
        'utf-8',
      )
      // Local file mtime is "now" (just written) — the remote drive
      // file's modifiedTime is set far in the past, so local must win.
      // No mockDownloadFile queued for this pack: packBodyLocalWins
      // short-circuits mergeWithRemote BEFORE downloadFile is ever
      // called — if the production code regressed and called it
      // anyway, the mock would throw/return undefined and this test
      // would fail loudly instead of silently leaking a queued
      // implementation into the next test.
      mockListFiles.mockResolvedValue([
        { id: 'pack1', name: 'i18n_packs_pack-a.enc', modifiedTime: '2000-01-01T00:00:00.000Z' },
      ])
      mockUploadFile.mockResolvedValue({ id: 'pack-file-id', modifiedTime: '2026-01-01T00:00:00.000Z' })

      await executeSync('download')

      expect(mockDownloadFile.mock.calls.some((c) => c[0] === 'pack1')).toBe(false)
      expect(mockUploadFile.mock.calls.some((c) => c[0] === 'i18n_packs_pack-a.enc')).toBe(true)
      const written = JSON.parse(
        await readFile(join(mockUserDataPath, 'sync', 'i18n', 'packs', 'pack-a.json'), 'utf-8'),
      ) as { version: string }
      expect(written.version).toBe('3.0.0')
    })

    it('S3: a local-wins pack-body upload pins local mtime to the Drive response modifiedTime (closes a clock-skew re-upload loop)', async () => {
      // Without this pin, the local pack file keeps its own wall-clock
      // write time. If the local clock runs ahead of Drive's own clock
      // (or the two just don't line up exactly), that time permanently
      // looks "newer than the remote copy" — every subsequent sync pass
      // would re-upload this unchanged body, and every peer would
      // re-download it, forever. Pinning to the upload response's own
      // modifiedTime closes that gap the same way a remote-win already
      // does for the download direction (see the idempotence test
      // below).
      await mkdir(join(mockUserDataPath, 'sync', 'i18n', 'packs'), { recursive: true })
      const packPath = join(mockUserDataPath, 'sync', 'i18n', 'packs', 'pack-a.json')
      await writeFile(packPath, JSON.stringify({ name: 'Pack A', version: '3.0.0' }), 'utf-8')

      mockListFiles.mockResolvedValue([
        { id: 'pack1', name: 'i18n_packs_pack-a.enc', modifiedTime: '2000-01-01T00:00:00.000Z' },
      ])
      const driveAssignedModifiedTime = '2026-07-15T12:00:00.000Z'
      mockUploadFile.mockResolvedValue({ id: 'pack-file-id', modifiedTime: driveAssignedModifiedTime })

      await executeSync('download')

      expect(mockUploadFile.mock.calls.some((c) => c[0] === 'i18n_packs_pack-a.enc')).toBe(true)
      const statAfterUpload = await stat(packPath)
      expect(statAfterUpload.mtime.toISOString()).toBe(driveAssignedModifiedTime)
    })

    it('S3-race: a concurrent local save landing between the upload snapshot and the post-upload pin is not clobbered (CAS-guarded)', async () => {
      // uploadSyncUnit snapshots the local body's mtime BEFORE bundling —
      // bundling/encrypting/uploading all happen without holding the
      // store's write lock, so a fresh local save can land in that
      // window. A blind pin would stamp the NEW content with the OLD
      // upload's stale Drive time, making the next LWW comparison see a
      // tie and the new edit never get uploaded. Simulate that race
      // inside the uploadFile mock itself: by the time it "returns" from
      // Drive, a concurrent save has already landed locally.
      await mkdir(join(mockUserDataPath, 'sync', 'i18n', 'packs'), { recursive: true })
      const packPath = join(mockUserDataPath, 'sync', 'i18n', 'packs', 'pack-a.json')
      await writeFile(packPath, JSON.stringify({ name: 'Pack A', version: '3.0.0' }), 'utf-8')

      mockListFiles.mockResolvedValue([
        { id: 'pack1', name: 'i18n_packs_pack-a.enc', modifiedTime: '2000-01-01T00:00:00.000Z' },
      ])
      const staleDriveModifiedTime = '2026-07-15T12:00:00.000Z'
      const raceMtime = new Date('2030-01-01T00:00:00.000Z')
      mockUploadFile.mockImplementation(async (name: string) => {
        if (name === 'i18n_packs_pack-a.enc') {
          await writeFile(packPath, JSON.stringify({ name: 'Pack A', version: '4.0.0' }), 'utf-8')
          await utimes(packPath, raceMtime, raceMtime)
        }
        return { id: 'pack-file-id', modifiedTime: staleDriveModifiedTime }
      })

      await executeSync('download')

      // The raced edit's content and mtime must both survive untouched —
      // the pin must have been skipped rather than overwriting either.
      const written = JSON.parse(await readFile(packPath, 'utf-8')) as { version: string }
      expect(written.version).toBe('4.0.0')
      const finalStat = await stat(packPath)
      expect(finalStat.mtime.getTime()).toBe(raceMtime.getTime())
      expect(finalStat.mtime.toISOString()).not.toBe(staleDriveModifiedTime)
    })

    it('idempotence: a remote-won pack body is not re-uploaded on the very next sync (mtime pinned to remote modifiedTime)', async () => {
      const remoteModifiedTime = '2026-06-01T00:00:00.000Z'
      const remoteFile = { id: 'pack1', name: 'i18n_packs_pack-a.enc', modifiedTime: remoteModifiedTime }
      const packEnvelope = makeBundleEnvelope('i18n/packs/pack-a', remoteModifiedTime, {
        type: 'i18n-pack',
        key: 'pack-a',
        files: { 'pack-a.json': JSON.stringify({ name: 'Pack A', version: '2.0.0' }) },
      })

      mockListFiles.mockResolvedValue([remoteFile, PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope())
        .mockResolvedValueOnce(packEnvelope)
        .mockResolvedValueOnce(makePasswordCheckEnvelope())
        .mockResolvedValueOnce(packEnvelope)

      await executeSync('download')
      expect(mockUploadFile.mock.calls.some((c) => c[0] === 'i18n_packs_pack-a.enc')).toBe(false)

      // Second, independent sync pass against the exact same unchanged
      // remote revision. Without the mtime pin in applySyncedPackBody,
      // the file just written would carry a local mtime of "now" (>
      // remoteModifiedTime), so this recompute would see "local newer"
      // and immediately re-upload the identical content it just
      // downloaded — an endless full-body ping-pong between any two
      // devices that both hold this pack.
      await executeSync('download')
      expect(mockUploadFile.mock.calls.some((c) => c[0] === 'i18n_packs_pack-a.enc')).toBe(false)
    })

    it('rejects a hostile packId parsed from a crafted remote filename — nothing is written outside the packs dir', async () => {
      // A remote Drive file is attacker-reachable data (anyone who can
      // write to this appData folder) — a crafted filename can make
      // syncUnitFromFileName/parsePackBodySyncUnit produce a traversal
      // packId. applySyncedPackBody's isSafePackId guard must refuse it
      // before it's ever joined into a filesystem path.
      const hostileFile = { id: 'evil1', name: 'i18n_packs_../evil.enc', modifiedTime: '2026-06-01T00:00:00.000Z' }
      mockListFiles.mockResolvedValue([hostileFile, PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope())
        .mockResolvedValueOnce(makeBundleEnvelope('i18n/packs/../evil', '2026-06-01T00:00:00.000Z', {
          type: 'i18n-pack',
          key: '../evil',
          files: { '../evil.json': JSON.stringify({ name: 'Evil', version: '1.0.0' }) },
        }))

      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      await executeSync('download')

      const final = progressEvents[progressEvents.length - 1]
      expect(final.status).toBe('partial')
      expect(final.failedUnits).toContain('i18n/packs/../evil')

      await expect(access(join(mockUserDataPath, 'sync', 'i18n', 'evil.json'))).rejects.toThrow()
      await expect(access(join(mockUserDataPath, 'sync', 'evil.json'))).rejects.toThrow()
      await expect(access(join(mockUserDataPath, 'evil.json'))).rejects.toThrow()
    })

    it('malformed generic bundle (entries not an array) is skipped with a warn, not thrown', async () => {
      // A hypothetical corrupt favorites bundle whose index.entries isn't
      // an array must not crash the whole sync pass — it should be
      // contained per-unit (same shape as any other per-unit failure).
      mockListFiles.mockResolvedValue([
        { id: 'bad1', name: 'favorites_tapDance.enc', modifiedTime: '2026-01-01T00:00:00.000Z' },
      ])
      mockDownloadFile.mockResolvedValueOnce({
        version: 1,
        syncUnit: 'favorites/tapDance',
        updatedAt: '2026-01-01T00:00:00.000Z',
        salt: 's',
        iv: 'i',
        ciphertext: JSON.stringify({
          type: 'favorite',
          key: 'tapDance',
          index: { type: 'tapDance', entries: 'not-an-array' },
          files: {},
        }),
      })

      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      await executeSync('download')

      const final = progressEvents[progressEvents.length - 1]
      expect(final.status).toBe('partial')
      expect(final.failedUnits).toContain('favorites/tapDance')
    })

    it('malformed bundle: same remote revision is not retried on the next poll (contained via lastKnownRemoteState)', async () => {
      const badFile = { id: 'bad1', name: 'favorites_tapDance.enc', modifiedTime: '2026-01-01T00:00:00.000Z' }
      const badEnvelope = {
        version: 1,
        syncUnit: 'favorites/tapDance',
        updatedAt: '2026-01-01T00:00:00.000Z',
        salt: 's',
        iv: 'i',
        ciphertext: JSON.stringify({
          type: 'favorite',
          key: 'tapDance',
          index: { type: 'tapDance', entries: 'not-an-array' },
          files: {},
        }),
      }
      // First poll returns only the (syncUnit-less) password-check file,
      // so the baseline is non-empty but doesn't include badFile — the
      // very next poll then sees badFile as newly "changed" (present but
      // absent from the recorded state). An empty first-poll file list
      // would instead re-trigger pollForRemoteChanges's own "first poll
      // ever" branch (`lastKnownRemoteState.size === 0`) a second time.
      mockListFiles.mockResolvedValueOnce([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(badEnvelope)

      startPolling()
      // First poll: records baseline state only (no download attempts).
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockListFiles.mock.calls.length >= 1)
      await flushIO()

      // Second poll: badFile is now present and wasn't in the baseline,
      // so it's treated as "changed" — the merge fails with
      // MalformedSyncBundleError, but the poll's catch deliberately does
      // NOT forget badFile's modifiedTime from lastKnownRemoteState (it
      // was already recorded earlier in this same poll pass), so poll 3
      // below sees an unchanged modifiedTime and skips it without ever
      // retrying — no separate block-map data structure needed.
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE, badFile])
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockDownloadFile.mock.calls.some((c) => c[0] === 'bad1'))
      // The failing merge itself is real disk I/O (readIndexFile against a
      // real tmp dir), which resolves via the libuv threadpool rather than
      // the microtask queue `flushIO` drains — wait for the poll's own
      // sync-lock release, not just a fixed tick count, so poll 3 below
      // never races a still-in-flight poll 2.
      await flushUntil(() => !isSyncInProgress())
      const attemptsAfterSecondPoll = mockDownloadFile.mock.calls.filter((c) => c[0] === 'bad1').length
      expect(attemptsAfterSecondPoll).toBeGreaterThan(0)
      // Contained per-unit with a warn naming only the sync unit — never
      // bundle content (attacker-reachable remote data).
      expect(mockLog).toHaveBeenCalledWith('warn', expect.stringContaining('favorites/tapDance'))

      // Third poll, same revision still on Drive — must NOT retry again.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockListFiles.mock.calls.length >= 3)
      await flushUntil(() => !isSyncInProgress())
      const attemptsAfterThirdPoll = mockDownloadFile.mock.calls.filter((c) => c[0] === 'bad1').length
      expect(attemptsAfterThirdPoll).toBe(attemptsAfterSecondPoll)

      // A changed revision (new modifiedTime) clears the block and is retried.
      const changedFile = { ...badFile, modifiedTime: '2026-01-02T00:00:00.000Z' }
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE, changedFile])
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockDownloadFile.mock.calls.filter((c) => c[0] === 'bad1').length > attemptsAfterThirdPoll)
      const attemptsAfterFourthPoll = mockDownloadFile.mock.calls.filter((c) => c[0] === 'bad1').length
      expect(attemptsAfterFourthPoll).toBeGreaterThan(attemptsAfterThirdPoll)

      stopPolling()
    })

    it('S1: a hostile packId is contained on the poll path too — not retried every 3 minutes', async () => {
      // Task M2's hostile-packId test above only exercises the manual
      // sync path (executeSync). S1: applySyncedPackBody now THROWS
      // MalformedSyncBundleError for a rejected packId instead of
      // returning false as a bare Error would — this lets the poll's
      // `instanceof MalformedSyncBundleError` branch recognize the
      // rejection as permanent and skip retrying it, exactly like the
      // malformed-generic-bundle poll test above. Before this fix, a
      // bare Error looked identical to a transient I/O failure, which
      // the poll deliberately DOES keep retrying — so a hostile remote
      // filename would have triggered a fresh download+decrypt attempt
      // every 3 minutes forever.
      const evilFile = { id: 'evil1', name: 'i18n_packs_../evil.enc', modifiedTime: '2026-06-01T00:00:00.000Z' }
      const evilEnvelope = makeBundleEnvelope('i18n/packs/../evil', '2026-06-01T00:00:00.000Z', {
        type: 'i18n-pack',
        key: '../evil',
        files: { '../evil.json': JSON.stringify({ name: 'Evil', version: '1.0.0' }) },
      })
      mockListFiles.mockResolvedValueOnce([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(evilEnvelope)

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockListFiles.mock.calls.length >= 1)
      await flushIO()

      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE, evilFile])
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockDownloadFile.mock.calls.some((c) => c[0] === 'evil1'))
      await flushUntil(() => !isSyncInProgress())
      const attemptsAfterSecondPoll = mockDownloadFile.mock.calls.filter((c) => c[0] === 'evil1').length
      expect(attemptsAfterSecondPoll).toBeGreaterThan(0)

      // Same revision still on Drive on the next poll — must NOT retry.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushUntil(() => mockListFiles.mock.calls.length >= 3)
      await flushUntil(() => !isSyncInProgress())
      const attemptsAfterThirdPoll = mockDownloadFile.mock.calls.filter((c) => c[0] === 'evil1').length
      expect(attemptsAfterThirdPoll).toBe(attemptsAfterSecondPoll)

      await expect(access(join(mockUserDataPath, 'sync', 'i18n', 'evil.json'))).rejects.toThrow()
      await expect(access(join(mockUserDataPath, 'evil.json'))).rejects.toThrow()

      stopPolling()
    })

    it('M2: a hostile meta id is filtered out of the merged index — never persisted, never reaches collectAllSyncUnits', async () => {
      // A remote index meta whose id is shaped like a path-traversal
      // sequence would, if persisted, later flow through
      // collectAllSyncUnits into a sync-unit string with more than the
      // expected 3 `/`-separated segments — bundleSyncUnit's i18n pack
      // branch fails to match that shape and falls through to the
      // generic index-based tail, joining an attacker-chosen path into
      // a filesystem read that gets bundled for upload. The index merge
      // must drop the hostile id before it's ever written to disk,
      // while keeping the legitimate sibling entry.
      mockListFiles.mockResolvedValue([
        { id: 'idx1', name: 'i18n_index.enc', modifiedTime: '2026-01-01T00:00:00.000Z' },
        PASSWORD_CHECK_DRIVE_FILE,
      ])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope())
        .mockResolvedValueOnce(makeBundleEnvelope('i18n/index', '2026-01-01T00:00:00.000Z', {
          type: 'i18n-index',
          key: 'i18n-index',
          index: {
            metas: [
              { id: '../evil', name: 'Evil', version: '1.0.0', enabled: true, savedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
              { id: 'ok-pack', name: 'OK Pack', version: '1.0.0', enabled: true, savedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
            ],
          },
        }))

      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      await executeSync('download')

      const final = progressEvents[progressEvents.length - 1]
      expect(final.status).toBe('success')

      const written = JSON.parse(
        await readFile(join(mockUserDataPath, 'sync', 'i18n', 'index.json'), 'utf-8'),
      ) as { metas: Array<{ id: string }> }
      expect(written.metas.map((m) => m.id)).toEqual(['ok-pack'])
      expect(mockLog).toHaveBeenCalledWith('warn', expect.stringContaining('i18n/index'))
    })

    it('M2: a hostile favorites filename with a path-separator segment is rejected, not traversed', async () => {
      // syncUnitFromFileName's regex captures everything after
      // `favorites_` up to `.enc` — a crafted Drive filename (Drive
      // names are arbitrary strings, not real filesystem paths, so
      // they can contain '/') can make that capture contain a path
      // separator, producing a syncUnit like 'favorites/../../evil'.
      // Every `/`-split segment of `syncUnit` must be validated before
      // mergeSyncUnit's settings / generic branches join it into a
      // filesystem path — this is the pre-existing exposure M2 closes
      // centrally, independent of the i18n/theme pack-index fix above.
      const hostileFile = { id: 'evil1', name: 'favorites_../../evil.enc', modifiedTime: '2026-06-01T00:00:00.000Z' }
      mockListFiles.mockResolvedValue([hostileFile, PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile
        .mockResolvedValueOnce(makePasswordCheckEnvelope())
        .mockResolvedValueOnce({
          version: 1,
          syncUnit: 'favorites/../../evil',
          updatedAt: '2026-06-01T00:00:00.000Z',
          salt: 's',
          iv: 'i',
          ciphertext: JSON.stringify({
            type: 'favorite',
            key: 'evil',
            index: { type: 'evil', entries: [] },
            files: {},
          }),
        })

      const progressEvents: SyncProgress[] = []
      setProgressCallback((p) => progressEvents.push({ ...p }))

      await executeSync('download')

      const final = progressEvents[progressEvents.length - 1]
      expect(final.status).toBe('partial')
      expect(final.failedUnits).toContain('favorites/../../evil')

      await expect(access(join(mockUserDataPath, 'sync', 'evil.json'))).rejects.toThrow()
      await expect(access(join(mockUserDataPath, 'evil.json'))).rejects.toThrow()
    })
  })
})
