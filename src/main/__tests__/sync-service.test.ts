// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { access, appendFile, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { driveFileName, type DriveFile } from '../sync/google-drive'

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
const mockCreateRawFile = vi.fn(async (..._args: unknown[]): Promise<{ id: string }> => ({ id: 'format-marker' }))

vi.mock('../sync/google-drive', async () => {
  // `driveFileName`/`syncUnitFromFileName` are imported via `importActual`
  // (not hand-rolled) so this mock can never drift out of sync with the
  // real filename ↔ sync-unit mapping — a stale hand-rolled regex
  // here hides a fresh-machine discovery gap for several stores because
  // the test mock silently keeps "supporting" a narrower set of filenames
  // than production code.
  const actual = await vi.importActual<typeof import('../sync/google-drive')>('../sync/google-drive')
  return {
    listFiles: (...args: unknown[]) => mockListFiles(...args),
    downloadFile: (...args: unknown[]) => mockDownloadFile(...(args as Parameters<typeof mockDownloadFile>)),
    uploadFile: (...args: unknown[]) => mockUploadFile(...(args as Parameters<typeof mockUploadFile>)),
    deleteFile: (...args: unknown[]) => mockDeleteFile(...(args as Parameters<typeof mockDeleteFile>)),
    driveFileName: actual.driveFileName,
    syncUnitFromFileName: actual.syncUnitFromFileName,
    driveFilenamePrefix: actual.driveFilenamePrefix,
    isDataFileName: actual.isDataFileName,
    isPasswordChangeLockFile: actual.isPasswordChangeLockFile,
    PASSWORD_CHECK_UNIT: actual.PASSWORD_CHECK_UNIT,
    PASSWORD_CHANGE_LOCK_FILE: actual.PASSWORD_CHANGE_LOCK_FILE,
    SYNC_FORMAT_FILE_PREFIX: actual.SYNC_FORMAT_FILE_PREFIX,
    syncFormatFileName: actual.syncFormatFileName,
    parseSyncFormatFileName: actual.parseSyncFormatFileName,
    createRawFile: (...args: unknown[]) => mockCreateRawFile(...args),
  }
})

const mockGetAuthStatus = vi.fn(async (..._args: unknown[]) => ({ authenticated: true }))

vi.mock('../sync/google-auth', () => ({
  getAuthStatus: (...args: unknown[]) => mockGetAuthStatus(...args),
  getAccessToken: vi.fn(async () => 'mock-token'),
  startOAuthFlow: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
  getAccountSub: vi.fn(async () => null),
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
  loadAppConfig: vi.fn(() => ({ autoSync: mockAutoSync })),
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

// Pass-through wrappers so a test can stall a merge right after its read of
// the local index / settings file (inside the merge's read-modify-write).
vi.mock('../sync/sync-bundle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sync/sync-bundle')>()
  return {
    ...actual,
    readIndexFile: vi.fn(actual.readIndexFile),
    readSettingsFile: vi.fn(actual.readSettingsFile),
  }
})

vi.mock('../utils/write-file-atomic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/write-file-atomic')>()
  return { ...actual, writeFileAtomic: vi.fn(actual.writeFileAtomic) }
})

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
  startPollingIfAutoSync,
  startPollingAtLaunch,
  hasPendingChanges,
  cancelPendingChanges,
  isSyncInProgress,
  resetPasswordCheckCache,
  listUndecryptableFiles,
  scanRemoteData,
  listRemoteFileNames,
  checkPasswordCheckExists,
  setPasswordAndValidate,
  setupBeforeQuitHandler,
  registerPreSyncQuitFinalizer,
  registerBeforeQuitFinalizer,
  deleteRemoteTypingDay,
  fetchRemoteTypingDay,
  executeAnalyticsSync,
  waitForPollPassForTests,
  withResetLock,
  _resetForTests,
  type ResetKeyboards,
} from '../sync/sync-service'
import { syncOrUpload, mergeWithRemote } from '../sync/sync-merge-dispatch'
import { readIndexFile, readSettingsFile } from '../sync/sync-bundle'
import { writeFileAtomic } from '../utils/write-file-atomic'
import { withWriteLock } from '../per-uid-write-lock'
import { saveRecord as saveKeyLabel } from '../key-label-store'
import { app } from 'electron'
import { syncRuntime, claimSyncLock, DEBOUNCE_MS } from '../sync/sync-runtime-state'
import { flushPendingChanges, scheduleFlushIfPending, QUIT_SYNC_DEADLINE_MS } from '../sync/sync-flush'
import { PENDING_WRITE_DELAY_MS, restorePendingFromDisk } from '../sync/sync-pending-store'
import { getAccountSub } from '../sync/google-auth'

const POLL_INTERVAL_MS = 3 * 60 * 1000

const FAKE_TIMER_OPTS: Parameters<typeof vi.useFakeTimers>[0] = {
  toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'],
}

// Fake timers replace `Date` (see FAKE_TIMER_OPTS), so wait deadlines use
// `performance.now`, which they leave alone. `setImmediate` is not faked
// either, so yielding with it lets real fs I/O callbacks run between checks.
const realNow = performance.now.bind(performance)
const realSetImmediate = setImmediate
const realSetTimeout = setTimeout
// Kept below vitest's default 5 s test timeout so flushUntil's own
// "timed out waiting for …" error fires before vitest aborts the test.
const WAIT_TIMEOUT_MS = 3_000

/**
 * Yields to the real event loop until `predicate` is true, then lets a
 * couple more turns run so any bookkeeping chained after the awaited
 * condition (e.g. remote-state updates that follow a download) settles too.
 *
 * Polling paths hit real fs I/O (the tests use a real mkdtemp userData
 * dir), which resolves via the libuv threadpool and is not advanced by
 * fake timers, so how many turns a pass needs depends on the machine.
 * The bound is wall-clock time instead, and running out of it throws so a
 * slow pass fails here rather than as a misleading assertion later.
 */
async function flushUntil(
  predicate: () => boolean,
  description = 'condition',
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = realNow() + timeoutMs
  while (!predicate()) {
    if (realNow() > deadline) {
      throw new Error(`flushUntil: timed out after ${timeoutMs}ms waiting for ${description}`)
    }
    await new Promise<void>((resolve) => realSetImmediate(resolve))
  }
  await new Promise<void>((resolve) => realSetImmediate(resolve))
  await new Promise<void>((resolve) => realSetImmediate(resolve))
}

/**
 * Waits until no sync of any kind (poll pass, executeSync, debounced
 * flush) holds the sync lock. Tests that only need the poll pass the
 * interval started await `waitForPollPassForTests` instead.
 */
async function waitForSyncIdle(): Promise<void> {
  await flushUntil(() => !isSyncInProgress(), 'the sync lock to be released')
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

function routeDownloads(byId: Record<string, () => unknown>): void {
  mockDownloadFile.mockImplementation(async (id: string) =>
    (byId[id]?.() ?? makePasswordCheckEnvelope()) as Record<string, unknown>)
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
    // A poll pass started by the test may still be doing real fs I/O;
    // let it finish before the shared state and the tmp dir go away, or
    // it can touch the next test's mocks.
    // The reset, timer restore and tmp-dir removal run even when that
    // wait times out, so a stuck pass does not leak into the next test.
    stopPolling()
    try {
      await waitForSyncIdle()
    } finally {
      _resetForTests()
      vi.useRealTimers()
      await rm(mockUserDataPath, { recursive: true, force: true })
    }
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

      cancelPendingChanges(['keyboards/uid1/'])
      expect(hasPendingChanges()).toBe(true) // favorites/tapDance remains
    })

    it('leaves unrelated pending changes intact', () => {
      notifyChange('keyboards/uid1/settings')
      notifyChange('keyboards/uid2/settings')

      cancelPendingChanges(['keyboards/uid1/'])
      expect(hasPendingChanges()).toBe(true) // uid2 remains
    })

    it('does not collide with similar uid prefixes', () => {
      notifyChange('keyboards/uid1/settings')
      notifyChange('keyboards/uid10/settings')

      cancelPendingChanges(['keyboards/uid1/'])
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

      // The password-change guard reads its local state file (real fs I/O)
      // before listing, so the delayed listing starts a few turns later.
      await flushUntil(() => mockListFiles.mock.calls.length > 0, 'the listing')
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

      await flushUntil(() => mockListFiles.mock.calls.length > 0, 'the listing')
      await vi.advanceTimersByTimeAsync(200)
      const firstResult = await first
      // The busy race must surface as a real, checkable status —
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
      await waitForSyncIdle()

      expect(mockDownloadFile).toHaveBeenCalledWith('file-1')
      expect(mockUploadFile).not.toHaveBeenCalled()
    })
  })

  describe('flush sync lock', () => {
    it('waits for the running sync to end, then flushes without another timer', async () => {
      mockAutoSync = true
      mockListFiles.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 30_000)),
      )
      mockListFiles.mockResolvedValue([])

      const syncPromise = executeSync('download')
      await flushUntil(() => mockListFiles.mock.calls.length > 0, 'the listing')

      notifyChange('favorites/tapDance')
      // The debounced flush fires while the manual sync holds the lock.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockListFiles).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(20_000)
      await syncPromise

      // The waiting flush starts as soon as the lock is free.
      await flushUntil(() => mockListFiles.mock.calls.length >= 2, 'the waiting flush to list')
      await waitForSyncIdle()
      expect(mockListFiles).toHaveBeenCalledTimes(2)
      expect(hasPendingChanges()).toBe(false)
    })
  })

  describe('flush lifecycle', () => {
    const FAV_FILE = 'favorites_tapDance.enc'
    const OK_UPLOAD = { id: 'file-id', modifiedTime: '2026-01-01T00:00:00.000Z' }
    const gateReleases: Array<() => void> = []

    const favUploads = (): number => mockUploadFile.mock.calls.filter((call) => call[0] === FAV_FILE).length
    const quitCalled = (): boolean => vi.mocked(app.quit).mock.calls.length > 0

    /** A promise that settles on `release`; afterEach releases it too. */
    function makeGate(): { promise: Promise<void>; release: () => void } {
      let release!: () => void
      const promise = new Promise<void>((resolve) => {
        release = resolve
      })
      gateReleases.push(release)
      return { promise, release }
    }

    /** Holds every upload of `fileName` until `release` is called. */
    function gateUploadsOf(fileName: string): { release: () => void } {
      const gate = makeGate()
      mockUploadFile.mockImplementation(async (name: string) => {
        if (name === fileName) await gate.promise
        return OK_UPLOAD
      })
      return { release: gate.release }
    }

    async function turns(count = 5): Promise<void> {
      for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve) => realSetImmediate(resolve))
      }
    }

    beforeEach(async () => {
      mockAutoSync = true
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())
      mockUploadFile.mockResolvedValue(OK_UPLOAD)
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{"data":1}' })
    })

    afterEach(() => {
      for (const release of gateReleases.splice(0)) release()
      mockUploadFile.mockImplementation(async () => OK_UPLOAD)
      mockListFiles.mockImplementation(async () => [])
      mockDownloadFile.mockImplementation(async () => ({}))
    })

    describe('pending units changed during a pass', () => {
      it('keeps a unit changed during its upload pending, and uploads it again after the debounce', async () => {
        const gate = gateUploadsOf(FAV_FILE)
        notifyChange('favorites/tapDance')
        const flush = flushPendingChanges()
        await flushUntil(() => favUploads() === 1, 'the upload to start')

        notifyChange('favorites/tapDance')
        notifyChange('favorites/macro')
        gate.release()
        await flush

        expect(syncRuntime.pendingChanges.has('favorites/tapDance')).toBe(true)
        expect(syncRuntime.pendingChanges.has('favorites/macro')).toBe(true)
        expect(vi.getTimerCount()).toBe(1)

        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
        await flushUntil(() => !hasPendingChanges(), 'the retry flush')
        await waitForSyncIdle()
        expect(favUploads()).toBe(2)
      })

      it('removes a unit uploaded without a later change', async () => {
        notifyChange('favorites/tapDance')
        await flushPendingChanges()

        expect(favUploads()).toBe(1)
        expect(hasPendingChanges()).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
      })

      it('scoped upload keeps a unit changed during its upload pending', async () => {
        const gate = gateUploadsOf(FAV_FILE)
        notifyChange('favorites/tapDance')
        const sync = executeSync('upload', 'favorites')
        await flushUntil(() => favUploads() === 1, 'the upload to start')

        notifyChange('favorites/tapDance')
        gate.release()
        await sync

        expect(syncRuntime.pendingChanges.has('favorites/tapDance')).toBe(true)
      })

      it('manual upload keeps a failed unit pending with one retry timer, and settles the uploaded ones', async () => {
        await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'macro.json', content: '{"data":2}' }, { favoriteType: 'macro' })
        mockUploadFile.mockImplementation(async (name: string) => {
          if (name === FAV_FILE) throw new Error('offline')
          return OK_UPLOAD
        })
        notifyChange('favorites/macro')

        const result = await executeSync('upload')

        expect(result.status).toBe('partial')
        expect(mockUploadFile.mock.calls.some((call) => call[0] === 'favorites_macro.enc')).toBe(true)
        expect([...syncRuntime.pendingChanges]).toEqual(['favorites/tapDance'])
        expect(vi.getTimerCount()).toBe(1)

        mockUploadFile.mockImplementation(async () => OK_UPLOAD)
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushUntil(() => !hasPendingChanges(), 'the retry flush')
        await waitForSyncIdle()
        expect(favUploads()).toBe(2)
      })

      it('scoped upload removes a pending unit it uploaded', async () => {
        notifyChange('favorites/tapDance')
        await executeSync('upload', 'favorites')

        expect(favUploads()).toBe(1)
        expect(hasPendingChanges()).toBe(false)
      })
    })

    describe('flush while another pass holds the lock', () => {
      it('a second flush waits for the first and does not upload twice', async () => {
        const gate = gateUploadsOf(FAV_FILE)
        notifyChange('favorites/tapDance')
        const first = flushPendingChanges()
        await flushUntil(() => favUploads() === 1, 'the upload to start')

        notifyChange('favorites/tapDance')
        const second = flushPendingChanges()
        await turns()
        expect(favUploads()).toBe(1)

        gate.release()
        await first
        await second

        expect(favUploads()).toBe(2)
        expect(hasPendingChanges()).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
      })

      it('two flushes waiting on the same pass do not both take the lock', async () => {
        await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'macro.json', content: '{"data":2}' }, { favoriteType: 'macro' })
        const holderGate = makeGate()
        const waiterGate = makeGate()
        let tapDanceUploads = 0
        mockUploadFile.mockImplementation(async (name: string) => {
          if (name === FAV_FILE && ++tapDanceUploads === 1) await holderGate.promise
          if (name === 'favorites_macro.enc') await waiterGate.promise
          return OK_UPLOAD
        })
        notifyChange('favorites/tapDance')
        const holder = flushPendingChanges()
        await flushUntil(() => favUploads() === 1, 'the holder upload to start')
        const listsBeforeWaiters = mockListFiles.mock.calls.length

        notifyChange('favorites/tapDance')
        notifyChange('favorites/macro')
        const first = flushPendingChanges()
        const second = flushPendingChanges()
        holderGate.release()
        await holder
        await flushUntil(
          () => mockUploadFile.mock.calls.some((call) => call[0] === 'favorites_macro.enc'),
          'the waiter upload to start',
        )
        await second

        // Only one waiter took the lock; the other did not list while it runs.
        expect(isSyncInProgress()).toBe(true)
        expect(mockListFiles.mock.calls.length).toBe(listsBeforeWaiters + 1)

        waiterGate.release()
        await first
        await waitForSyncIdle()
        expect(favUploads()).toBe(2)
        expect(mockUploadFile.mock.calls.filter((call) => call[0] === 'favorites_macro.enc')).toHaveLength(1)
        expect(hasPendingChanges()).toBe(false)
      })
    })

    describe('before-quit', () => {
      it('waits for a running flush upload before quitting', async () => {
        const gate = gateUploadsOf(FAV_FILE)
        notifyChange('favorites/tapDance')
        const flush = flushPendingChanges()
        await flushUntil(() => favUploads() === 1, 'the upload to start')

        const preventDefault = vi.fn()
        captureBeforeQuitHandler()({ preventDefault })
        expect(preventDefault).toHaveBeenCalled()
        await turns()
        expect(app.quit).not.toHaveBeenCalled()

        gate.release()
        await flush
        await flushUntil(quitCalled, 'the quit phases to call app.quit')
        expect(hasPendingChanges()).toBe(false)
        // The deadline timer is cleared once the phases finish.
        expect(vi.getTimerCount()).toBe(0)
      })

      it('waits for a running poll, then flushes the pending unit before quitting', async () => {
        const listGate = makeGate()
        mockListFiles.mockImplementationOnce(async () => {
          await listGate.promise
          return [PASSWORD_CHECK_DRIVE_FILE]
        })
        startPolling()
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushUntil(() => mockListFiles.mock.calls.length === 1, 'the poll to list')

        notifyChange('favorites/tapDance')
        captureBeforeQuitHandler()({ preventDefault: vi.fn() })
        await turns()
        expect(app.quit).not.toHaveBeenCalled()

        listGate.release()
        await flushUntil(quitCalled, 'the quit phases to call app.quit')
        expect(favUploads()).toBe(1)
        const uploadOrder = mockUploadFile.mock.invocationCallOrder.at(-1) ?? Infinity
        expect(uploadOrder).toBeLessThan(vi.mocked(app.quit).mock.invocationCallOrder[0])
      })

      it('quits after the deadline when the upload never settles', async () => {
        const gate = gateUploadsOf(FAV_FILE)
        notifyChange('favorites/tapDance')
        const flush = flushPendingChanges()
        await flushUntil(() => favUploads() === 1, 'the upload to start')

        captureBeforeQuitHandler()({ preventDefault: vi.fn() })
        await turns()
        expect(app.quit).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(QUIT_SYNC_DEADLINE_MS)
        await flushUntil(quitCalled, 'the deadline to call app.quit')
        expect(mockLog).toHaveBeenCalledWith('warn', 'before-quit: sync did not finish within the deadline')

        gate.release()
        await flush
        await waitForSyncIdle()
      })
    })

    describe('retry after failed units', () => {
      it('arms exactly one timer and retries after the polling interval', async () => {
        mockUploadFile.mockImplementation(async (name: string) => {
          if (name === FAV_FILE) throw new Error('offline')
          return OK_UPLOAD
        })
        notifyChange('favorites/tapDance')
        await flushPendingChanges()
        expect(hasPendingChanges()).toBe(true)
        expect(vi.getTimerCount()).toBe(1)

        await flushPendingChanges()
        expect(vi.getTimerCount()).toBe(1)
        expect(favUploads()).toBe(2)

        mockUploadFile.mockImplementation(async () => OK_UPLOAD)
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
        expect(favUploads()).toBe(2)

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - DEBOUNCE_MS)
        await flushUntil(() => !hasPendingChanges(), 'the retry flush')
        await waitForSyncIdle()
        expect(favUploads()).toBe(3)
      })
    })

    describe('flush timer', () => {
      it('a partial manual upload keeps an armed debounce timer that fires sooner', async () => {
        await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'macro.json', content: '{"data":2}' }, { favoriteType: 'macro' })
        mockUploadFile.mockImplementation(async (name: string) => {
          if (name === FAV_FILE) throw new Error('offline')
          return OK_UPLOAD
        })
        notifyChange('favorites/macro')

        expect((await executeSync('upload')).status).toBe('partial')
        expect(vi.getTimerCount()).toBe(1)

        mockUploadFile.mockImplementation(async () => OK_UPLOAD)
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
        await flushUntil(() => !hasPendingChanges(), 'the debounced flush')
        await waitForSyncIdle()
        expect(favUploads()).toBe(2)
      })

      it('a sooner schedule shortens an armed polling-interval retry', async () => {
        mockUploadFile.mockImplementation(async (name: string) => {
          if (name === FAV_FILE) throw new Error('offline')
          return OK_UPLOAD
        })
        notifyChange('favorites/tapDance')
        await flushPendingChanges()
        expect(vi.getTimerCount()).toBe(1)

        mockUploadFile.mockImplementation(async () => OK_UPLOAD)
        scheduleFlushIfPending(DEBOUNCE_MS)
        expect(vi.getTimerCount()).toBe(1)

        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
        await flushUntil(() => !hasPendingChanges(), 'the shortened retry')
        await waitForSyncIdle()
        expect(favUploads()).toBe(2)
      })
    })

    describe('auto sync off', () => {
      it('keeps pending without a timer, and flushes once scheduled after auto sync turns on', async () => {
        mockAutoSync = false
        notifyChange('favorites/tapDance')
        await flushPendingChanges()
        expect(hasPendingChanges()).toBe(true)
        expect(vi.getTimerCount()).toBe(0)

        mockAutoSync = true
        scheduleFlushIfPending()
        expect(vi.getTimerCount()).toBe(1)
        await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
        await flushUntil(() => !hasPendingChanges(), 'the scheduled flush')
        await waitForSyncIdle()
        expect(favUploads()).toBe(1)
      })

      it('scheduleFlushIfPending arms no timer when nothing is pending', () => {
        scheduleFlushIfPending()
        expect(vi.getTimerCount()).toBe(0)
      })
    })

    describe('credentials not ready', () => {
      const mockRetrievePasswordResult = vi.mocked(mockRetrievePasswordResultFn)

      it.each(['keystoreUnavailable', 'decryptFailed'] as const)(
        '%s keeps pending and retries after the polling interval',
        async (reason) => {
          mockRetrievePasswordResult.mockResolvedValueOnce({ ok: false, reason })
          notifyChange('favorites/tapDance')
          await flushPendingChanges()
          expect(hasPendingChanges()).toBe(true)
          expect(favUploads()).toBe(0)
          expect(vi.getTimerCount()).toBe(1)

          await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
          await flushUntil(() => !hasPendingChanges(), 'the retry flush')
          await waitForSyncIdle()
          expect(favUploads()).toBe(1)
        },
      )

      it('noPasswordFile keeps pending without a timer', async () => {
        mockRetrievePasswordResult.mockResolvedValueOnce({ ok: false, reason: 'noPasswordFile' })
        notifyChange('favorites/tapDance')
        await flushPendingChanges()
        expect(hasPendingChanges()).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
      })

      it('signed out keeps pending without a timer', async () => {
        mockGetAuthStatus.mockResolvedValueOnce({ authenticated: false })
        notifyChange('favorites/tapDance')
        await flushPendingChanges()
        expect(hasPendingChanges()).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
      })

      it('does not arm a retry while quitting', async () => {
        mockRetrievePasswordResult.mockResolvedValueOnce({ ok: false, reason: 'keystoreUnavailable' })
        notifyChange('favorites/tapDance')
        syncRuntime.isQuitting = true
        await flushPendingChanges()
        expect(hasPendingChanges()).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
      })
    })

    describe('pre-step failures', () => {
      const failures: Array<[string, () => void]> = [
        ['the listing throws', () => { mockListFiles.mockRejectedValueOnce(new Error('offline')) }],
        ['the format marker cannot be created', () => { mockCreateRawFile.mockRejectedValueOnce(new Error('offline')) }],
        ['the password check cannot be read', () => { mockDownloadFile.mockRejectedValueOnce(new Error('offline')) }],
      ]

      it.each(failures)('%s: keeps pending and retries after the polling interval', async (_name, fail) => {
        fail()
        notifyChange('favorites/tapDance')
        await expect(flushPendingChanges()).resolves.toBeUndefined()
        expect(hasPendingChanges()).toBe(true)
        expect(favUploads()).toBe(0)
        expect(vi.getTimerCount()).toBe(1)

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushUntil(() => !hasPendingChanges(), 'the retry flush')
        await waitForSyncIdle()
        expect(favUploads()).toBe(1)
      })

      it('a password mismatch keeps pending without a timer', async () => {
        vi.mocked(mockDecryptFn).mockRejectedValueOnce(new Error('Decryption failed'))
        const progressEvents: SyncProgress[] = []
        setProgressCallback((p) => progressEvents.push({ ...p }))
        notifyChange('favorites/tapDance')

        await flushPendingChanges()

        expect(progressEvents.some((p) => p.status === 'error' && p.message === 'sync.passwordMismatch')).toBe(true)
        expect(hasPendingChanges()).toBe(true)
        expect(favUploads()).toBe(0)
        expect(vi.getTimerCount()).toBe(0)
      })

      it.each(failures)('%s while quitting: keeps pending without a timer', async (_name, fail) => {
        fail()
        notifyChange('favorites/tapDance')
        syncRuntime.isQuitting = true
        await expect(flushPendingChanges()).resolves.toBeUndefined()
        expect(hasPendingChanges()).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
      })
    })

    describe('pending changes kept on disk', () => {
      const pendingFile = (): string => join(mockUserDataPath, 'local', 'sync-pending.json')
      const unitsOnDisk = async (): Promise<string[]> =>
        (JSON.parse(await readFile(pendingFile(), 'utf-8')) as { units: string[] }).units

      beforeEach(() => {
        restorePendingFromDisk()
      })

      it('uploads a change left by the last run and writes it out of the file once sent', async () => {
        notifyChange('favorites/tapDance')
        await vi.advanceTimersByTimeAsync(PENDING_WRITE_DELAY_MS)
        expect(await unitsOnDisk()).toEqual(['favorites/tapDance'])

        // A restart: memory is gone, the file stays.
        _resetForTests()
        restorePendingFromDisk()
        expect(hasPendingChanges()).toBe(true)

        await flushPendingChanges()
        expect(favUploads()).toBe(1)
        expect(hasPendingChanges()).toBe(false)
        await vi.advanceTimersByTimeAsync(PENDING_WRITE_DELAY_MS)
        expect(await unitsOnDisk()).toEqual([])
      })

      it('holds units changed under another account instead of uploading them', async () => {
        syncRuntime.pendingOwner = 'account-a'
        notifyChange('favorites/tapDance')
        vi.mocked(getAccountSub).mockResolvedValueOnce('account-b')

        await flushPendingChanges()

        expect(favUploads()).toBe(0)
        expect(hasPendingChanges()).toBe(false)
        expect([...(syncRuntime.heldPending.get('account-a') ?? [])]).toEqual(['favorites/tapDance'])
        expect(JSON.parse(await readFile(pendingFile(), 'utf-8'))).toEqual({
          version: 1,
          owner: 'account-b',
          units: [],
          held: { 'account-a': ['favorites/tapDance'] },
        })
      })

      it('uploads the units held for the signed-in account with its next change', async () => {
        syncRuntime.pendingOwner = 'account-b'
        syncRuntime.heldPending.set('account-a', new Set(['favorites/tapDance']))
        notifyChange('favorites/macro')
        vi.mocked(getAccountSub).mockResolvedValueOnce('account-a')

        await flushPendingChanges()

        expect(favUploads()).toBe(1)
        expect(syncRuntime.heldPending.get('account-b')).toEqual(new Set(['favorites/macro']))
        expect(syncRuntime.pendingChanges.has('favorites/tapDance')).toBe(false)
      })

      it('before-quit with nothing left to do writes the last settle at once', async () => {
        notifyChange('favorites/tapDance')
        await vi.advanceTimersByTimeAsync(PENDING_WRITE_DELAY_MS)
        await flushPendingChanges()
        expect(await unitsOnDisk()).toEqual(['favorites/tapDance'])

        const preventDefault = vi.fn()
        captureBeforeQuitHandler()({ preventDefault })

        expect(preventDefault).not.toHaveBeenCalled()
        expect(await unitsOnDisk()).toEqual([])
      })

      it('writes what is still pending before quitting after the deadline', async () => {
        const gate = gateUploadsOf(FAV_FILE)
        notifyChange('favorites/tapDance')
        const flush = flushPendingChanges()
        await flushUntil(() => favUploads() === 1, 'the upload to start')
        // The scheduled write has run; only the quit can bring the file back.
        await vi.advanceTimersByTimeAsync(PENDING_WRITE_DELAY_MS)
        await rm(pendingFile(), { force: true })

        captureBeforeQuitHandler()({ preventDefault: vi.fn() })
        await vi.advanceTimersByTimeAsync(QUIT_SYNC_DEADLINE_MS)
        await flushUntil(quitCalled, 'the deadline to call app.quit')

        expect(await unitsOnDisk()).toEqual(['favorites/tapDance'])

        gate.release()
        await flush
        await waitForSyncIdle()
      })

      it('keeps a change kept by a flush with auto sync off for the next launch', async () => {
        mockAutoSync = false
        notifyChange('favorites/tapDance')
        await flushPendingChanges()

        captureBeforeQuitHandler()({ preventDefault: vi.fn() })
        await flushUntil(quitCalled, 'the quit phases to call app.quit')

        expect(await unitsOnDisk()).toEqual(['favorites/tapDance'])
      })
    })

    describe('sync lock ownership', () => {
      it('a stale release does not clear a newer pass', () => {
        const releaseOld = claimSyncLock()
        syncRuntime.isSyncing = false
        syncRuntime.inFlightPass = null
        const releaseNew = claimSyncLock()
        const newPass = syncRuntime.inFlightPass

        releaseOld()
        expect(syncRuntime.inFlightPass).toBe(newPass)
        expect(syncRuntime.isSyncing).toBe(true)

        releaseNew()
        expect(syncRuntime.inFlightPass).toBeNull()
        expect(syncRuntime.isSyncing).toBe(false)
      })

      it('_resetForTests clears the in-flight pass and the pending generations', () => {
        notifyChange('favorites/tapDance')
        syncRuntime.inFlightPass = Promise.resolve()

        _resetForTests()

        expect(syncRuntime.inFlightPass).toBeNull()
        expect(syncRuntime.pendingGeneration.size).toBe(0)
      })
    })
  })

  describe('reset holding the sync lock', () => {
    const gateReleases: Array<() => void> = []

    /** Starts a reset whose body waits for `release`; afterEach releases it too. */
    function holdReset(keyboards: ResetKeyboards = null): { done: Promise<void>; release: () => void } {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      gateReleases.push(release)
      return { done: withResetLock(keyboards, () => gate, 'busy'), release }
    }

    async function turns(count = 5): Promise<void> {
      for (let i = 0; i < count; i++) {
        await new Promise<void>((resolve) => realSetImmediate(resolve))
      }
    }

    beforeEach(() => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())
    })

    afterEach(() => {
      for (const release of gateReleases.splice(0)) release()
      mockListFiles.mockImplementation(async () => [])
      mockDownloadFile.mockImplementation(async () => ({}))
    })

    it('holds the lock as a waitable holder and records its keyboards until the reset ends', async () => {
      const reset = holdReset(['uid-a'])
      expect(isSyncInProgress()).toBe(true)
      expect(syncRuntime.inFlightPassWaitable).toBe(true)
      expect(syncRuntime.resetKeyboards).toEqual(new Set(['uid-a']))

      reset.release()
      await reset.done

      expect(isSyncInProgress()).toBe(false)
      expect(syncRuntime.inFlightPass).toBeNull()
      expect(syncRuntime.inFlightPassWaitable).toBe(false)
      expect(syncRuntime.resetKeyboards).toBeNull()
    })

    it('records no keyboards for a reset without keyboard data', () => {
      holdReset(null)
      expect(syncRuntime.resetKeyboards).toBeNull()
      expect(isSyncInProgress()).toBe(true)
    })

    it('releases the lock when the reset throws', async () => {
      await expect(withResetLock('all', async () => {
        throw new Error('rm failed')
      })).rejects.toThrow('rm failed')

      expect(isSyncInProgress()).toBe(false)
      expect(syncRuntime.resetKeyboards).toBeNull()
    })

    it('refuses with the default message while another pass holds the lock', async () => {
      const release = claimSyncLock()
      const body = vi.fn(async () => {})

      await expect(withResetLock(null, body)).rejects.toThrow('Cannot reset while sync is in progress')

      expect(body).not.toHaveBeenCalled()
      release()
    })

    it('refuses a reset of a keyboard with an analytics sync running', async () => {
      syncRuntime.analyticsSyncingUids.add('uid-a')
      const body = vi.fn(async () => {})

      await expect(withResetLock(['uid-a'], body)).rejects.toThrow()
      await expect(withResetLock('all', body)).rejects.toThrow()
      expect(body).not.toHaveBeenCalled()
      expect(isSyncInProgress()).toBe(false)

      await withResetLock(['uid-b'], body)
      await withResetLock(null, body)
      expect(body).toHaveBeenCalledTimes(2)
    })

    it('refuses a reset of a keyboard with a remote day fetch running', async () => {
      const listGate = new Promise<DriveFile[]>((resolve) => {
        gateReleases.push(() => resolve([PASSWORD_CHECK_DRIVE_FILE]))
      })
      mockListFiles.mockImplementationOnce(() => listGate)
      const fetch = fetchRemoteTypingDay('uid-a', 'remote-hash', '2026-04-18')
      await flushUntil(() => mockListFiles.mock.calls.length === 1, 'the fetch to list')
      expect(syncRuntime.remoteTypingDayFetches.get('uid-a')).toBe(1)
      const body = vi.fn(async () => {})

      await expect(withResetLock(['uid-a'], body)).rejects.toThrow()
      await expect(withResetLock('all', body)).rejects.toThrow()
      await withResetLock(['uid-b'], body)
      await withResetLock(null, body)
      expect(body).toHaveBeenCalledTimes(2)

      for (const release of gateReleases.splice(0)) release()
      expect(await fetch).toBe(false)
      expect(syncRuntime.remoteTypingDayFetches.size).toBe(0)
    })

    it('a remote day fetch that throws is no longer counted', async () => {
      mockListFiles.mockRejectedValueOnce(new Error('network error'))

      await expect(fetchRemoteTypingDay('uid-a', 'remote-hash', '2026-04-18')).rejects.toThrow('network error')

      expect(syncRuntime.remoteTypingDayFetches.size).toBe(0)
    })

    it('an analytics sync and a remote day fetch of a keyboard being reset do not start', async () => {
      holdReset(['uid-a'])

      expect(await executeAnalyticsSync('uid-a')).toBe(false)
      expect(await fetchRemoteTypingDay('uid-a', 'remote-hash', '2026-04-18')).toBe(false)

      expect(mockListFiles).not.toHaveBeenCalled()
      expect(syncRuntime.analyticsSyncingUids.size).toBe(0)
      expect(syncRuntime.remoteTypingDayFetches.size).toBe(0)
    })

    it('an analytics sync and a remote day fetch of another keyboard still run', async () => {
      holdReset(['uid-a'])

      await executeAnalyticsSync('uid-b')
      expect(mockListFiles).toHaveBeenCalled()
      mockListFiles.mockClear()
      await fetchRemoteTypingDay('uid-b', 'remote-hash', '2026-04-18')
      expect(mockListFiles).toHaveBeenCalledTimes(1)
    })

    it('a reset of every keyboard stops an analytics sync of any keyboard', async () => {
      holdReset('all')

      expect(await executeAnalyticsSync('uid-b')).toBe(false)
      expect(mockListFiles).not.toHaveBeenCalled()
    })

    it('a poll pass skips during a reset', async () => {
      holdReset()

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()

      expect(mockListFiles).not.toHaveBeenCalled()
      stopPolling()
    })

    it('a flush waits for the reset, then runs', async () => {
      mockAutoSync = true
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{"data":1}' })
      const reset = holdReset()
      notifyChange('favorites/tapDance')

      const flush = flushPendingChanges()
      await turns()
      expect(mockListFiles).not.toHaveBeenCalled()

      reset.release()
      await reset.done
      await flush

      expect(mockListFiles).toHaveBeenCalled()
      expect(hasPendingChanges()).toBe(false)
    })

    it('executeSync waits for the reset instead of returning busy', async () => {
      const reset = holdReset()

      const sync = executeSync('download')
      await turns()
      expect(mockListFiles).not.toHaveBeenCalled()

      reset.release()
      await reset.done

      expect(await sync).toEqual({ status: 'completed' })
      expect(mockListFiles).toHaveBeenCalled()
    })

    it('before-quit waits for a running reset', async () => {
      const reset = holdReset()

      captureBeforeQuitHandler()({ preventDefault: vi.fn() })
      await turns()
      expect(app.quit).not.toHaveBeenCalled()

      reset.release()
      await reset.done
      await flushUntil(() => vi.mocked(app.quit).mock.calls.length > 0, 'the quit phases to call app.quit')
    })
  })

  describe('polling', () => {
    it('downloads locally relevant units on the first poll and skips lazy and analytics units', async () => {
      await mkdir(join(mockUserDataPath, 'sync', 'keyboards', '0x1234'), { recursive: true })
      mockListFiles.mockResolvedValue([
        PASSWORD_CHECK_DRIVE_FILE,
        makeDriveFile('2026-01-01T00:00:00.000Z'),
        makeSettingsDriveFile('0x1234', '2026-01-01T00:00:00.000Z'),
        makeSettingsDriveFile('0xRemoteOnly', '2026-01-01T00:00:00.000Z'),
        { id: 'day-1', name: driveFileName('keyboards/0x1234/devices/hash/days/2026-01-01'), modifiedTime: '2026-01-01T00:00:00.000Z' },
      ])
      routeDownloads({
        'file-1': () => makeRemoteEnvelope('2026-01-01T00:00:00.000Z'),
        'settings-0x1234': () => makeSettingsEnvelope('0x1234', '2026-01-01T00:00:00.000Z'),
      })

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)

      const downloaded = mockDownloadFile.mock.calls.map((call) => call[0])
      expect(downloaded).toContain('file-1')
      expect(downloaded).toContain('settings-0x1234')
      expect(downloaded).not.toContain('settings-0xRemoteOnly')
      expect(downloaded).not.toContain('day-1')

      stopPolling()
    })

    it('detects remote changes on subsequent polls and downloads', async () => {
      mockListFiles
        .mockResolvedValueOnce([makeDriveFile('2026-01-01T00:00:00.000Z')])
        .mockResolvedValueOnce([makeDriveFile('2026-01-02T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2026-01-02T00:00:00.000Z'))

      startPolling()
      // First poll: merges the listed file once
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)

      // Second poll: detects modifiedTime change, downloads again
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()

      expect(mockListFiles).toHaveBeenCalledTimes(2)
      expect(mockDownloadFile).toHaveBeenCalledWith('file-1')

      stopPolling()
    })

    // themes/i18n only match scope 'all', which the 3-minute poll always
    // uses (see matchesScope) — so once syncUnitFromFileName recognizes
    // their filenames, polling picks up changes for them exactly like
    // any other scope-'all' unit.
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
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)

      // The merge's file write is real disk I/O, so wait for the pass itself
      // rather than a fixed tick count.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()

      expect(mockListFiles).toHaveBeenCalledTimes(2)
      expect(mockDownloadFile).toHaveBeenCalledWith('theme-pack-1')
      await expect(
        readFile(join(mockUserDataPath, 'sync', 'themes', 'packs', 'pack-a.json'), 'utf-8'),
      ).resolves.toContain('Pack A')

      stopPolling()
    })

    // Key-labels rides the same generic index-based poll-merge path
    // already exercised above by favorites (this file's own "detects
    // remote changes on subsequent polls and downloads"), and its
    // filename recognition is pinned at the unit level in
    // google-drive.test.ts's round-trip coverage.

    it('skips when no remote changes detected', async () => {
      // The first poll merges the listed file and validates the password-check.
      mockListFiles.mockResolvedValue([makeDriveFile('2025-01-01T00:00:00.000Z'), PASSWORD_CHECK_DRIVE_FILE])
      routeDownloads({ 'file-1': () => makeRemoteEnvelope('2025-01-01T00:00:00.000Z') })

      startPolling()
      // The listFiles counts prove each poll actually ran, so the negative
      // download check below can't false-pass on a skipped pass.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)

      const downloadCallCount = mockDownloadFile.mock.calls.length

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(2)

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
      // The skipped pass settles at once even though the lock stays held.
      await waitForPollPassForTests()

      expect(mockListFiles).toHaveBeenCalledTimes(1)
      expect(isSyncInProgress()).toBe(true)

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

  describe('polling with a delayed first pass', () => {
    const FIRST_PASS_DELAY_MS = 15_000

    it('runs one pass after the delay and then keeps the interval', async () => {
      mockListFiles.mockResolvedValue([])

      startPolling({ firstPassDelayMs: FIRST_PASS_DELAY_MS })
      await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS - 1)
      expect(mockListFiles).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - FIRST_PASS_DELAY_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(2)
    })

    it('stopPolling during the delay cancels the first pass', async () => {
      mockListFiles.mockResolvedValue([])

      startPolling({ firstPassDelayMs: FIRST_PASS_DELAY_MS })
      stopPolling()
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      expect(mockListFiles).not.toHaveBeenCalled()
    })

    it('_resetForTests during the delay cancels the first pass', async () => {
      mockListFiles.mockResolvedValue([])

      startPolling({ firstPassDelayMs: FIRST_PASS_DELAY_MS })
      _resetForTests()
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      expect(mockListFiles).not.toHaveBeenCalled()
    })

    it('a second start arms no second first pass or interval', async () => {
      mockListFiles.mockResolvedValue([])

      startPolling({ firstPassDelayMs: FIRST_PASS_DELAY_MS })
      startPolling({ firstPassDelayMs: FIRST_PASS_DELAY_MS })
      startPolling()
      expect(vi.getTimerCount()).toBe(2)

      await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)
    })

    it('a start without a delay arms no first pass even when one is asked for later', async () => {
      mockListFiles.mockResolvedValue([])

      startPolling()
      startPolling({ firstPassDelayMs: FIRST_PASS_DELAY_MS })
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS)
      expect(mockListFiles).not.toHaveBeenCalled()
    })

    it('waits for a running download and then runs its pass', async () => {
      let releaseList: (files: DriveFile[]) => void = () => {}
      const listGate = new Promise<DriveFile[]>((resolve) => { releaseList = resolve })
      mockListFiles.mockImplementationOnce(() => listGate)
      mockListFiles.mockResolvedValue([])

      const download = executeSync('download')
      try {
        await flushUntil(() => mockListFiles.mock.calls.length === 1, 'the download to reach listFiles')

        startPolling({ firstPassDelayMs: FIRST_PASS_DELAY_MS })
        await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS)
        expect(mockListFiles).toHaveBeenCalledTimes(1)
      } finally {
        releaseList([])
      }
      await download

      await flushUntil(() => mockListFiles.mock.calls.length === 2, 'the first poll pass to list Drive')
      await waitForSyncIdle()
    })

    it('a download started during the first pass waits for it instead of skipping', async () => {
      let releaseList: (files: DriveFile[]) => void = () => {}
      const listGate = new Promise<DriveFile[]>((resolve) => { releaseList = resolve })
      mockListFiles.mockImplementationOnce(() => listGate)
      mockListFiles.mockResolvedValue([])

      startPolling({ firstPassDelayMs: FIRST_PASS_DELAY_MS })
      await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS)
      const pass = waitForPollPassForTests()
      let download: Promise<Awaited<ReturnType<typeof executeSync>>>
      try {
        await flushUntil(() => mockListFiles.mock.calls.length === 1, 'the first pass to reach listFiles')
        download = executeSync('download')
      } finally {
        releaseList([])
      }
      await pass

      const result = await download
      expect(result.skipReason).toBeUndefined()
      expect(mockListFiles).toHaveBeenCalledTimes(2)
    })

    it('returns silently when credentials are not ready', async () => {
      mockGetAuthStatus.mockResolvedValueOnce({ authenticated: false })
      const progress: SyncProgress[] = []
      setProgressCallback((p) => progress.push(p))

      startPolling({ firstPassDelayMs: FIRST_PASS_DELAY_MS })
      await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS)
      await waitForPollPassForTests()

      expect(mockGetAuthStatus).toHaveBeenCalledTimes(1)
      expect(mockListFiles).not.toHaveBeenCalled()
      expect(progress).toEqual([])
    })

    it('startPollingAtLaunch arms the interval and a delayed first pass when auto sync is on', async () => {
      mockAutoSync = true
      mockListFiles.mockResolvedValue([])

      startPollingAtLaunch()
      expect(vi.getTimerCount()).toBe(2)

      await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)
    })

    it('startPollingAtLaunch does nothing when auto sync is off', () => {
      startPollingAtLaunch()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('startPollingIfAutoSync arms only the interval when auto sync is on', async () => {
      mockAutoSync = true
      mockListFiles.mockResolvedValue([])

      startPollingIfAutoSync()
      expect(vi.getTimerCount()).toBe(1)

      await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS)
      expect(mockListFiles).not.toHaveBeenCalled()
    })

    it('startPollingIfAutoSync does nothing when auto sync is off', () => {
      startPollingIfAutoSync()
      expect(vi.getTimerCount()).toBe(0)
    })

    it('stopPolling while the first pass waits for the lock cancels it', async () => {
      mockListFiles.mockResolvedValue([])
      const release = claimSyncLock()
      try {
        startPolling({ firstPassDelayMs: FIRST_PASS_DELAY_MS })
        await vi.advanceTimersByTimeAsync(FIRST_PASS_DELAY_MS)
        stopPolling()
      } finally {
        release()
      }

      await flushUntil(() => true)
      await vi.advanceTimersByTimeAsync(0)
      expect(mockListFiles).not.toHaveBeenCalled()
      expect(isSyncInProgress()).toBe(false)
    })
  })

  describe('waitForPollPassForTests', () => {
    // Resolves 'pending' unless `promise` has already settled after a few
    // real event-loop turns.
    async function settlesSoon(promise: Promise<void>): Promise<'settled' | 'pending'> {
      const pending = new Promise<'pending'>((resolve) => {
        realSetImmediate(() => realSetImmediate(() => realSetImmediate(() => resolve('pending'))))
      })
      return Promise.race([promise.then(() => 'settled' as const), pending])
    }

    it('resolves immediately before any tick', async () => {
      await expect(settlesSoon(waitForPollPassForTests())).resolves.toBe('settled')

      startPolling()
      await expect(settlesSoon(waitForPollPassForTests())).resolves.toBe('settled')
      expect(mockListFiles).not.toHaveBeenCalled()
      stopPolling()
    })

    it('keeps tracking a pass that spans a later tick and resolves only after its GC step', async () => {
      mockListFiles.mockResolvedValue([makeDriveFile('2026-01-01T00:00:00.000Z')])

      startPolling()
      // First poll only seeds the remote state.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)

      // The gate exists before the pass reaches GC, so releasing it in
      // `finally` unblocks the pass whenever an assertion fails.
      let releaseGc: () => void = () => {}
      const gcGate = new Promise<void>((resolve) => { releaseGc = resolve })
      mockRunPackGcAfterPass.mockImplementationOnce(() => gcGate)

      // Second poll: nothing changed, so the pass goes straight to the GC
      // step and waits there.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      const tracked = waitForPollPassForTests()
      try {
        await flushUntil(() => mockRunPackGcAfterPass.mock.calls.length === 1, 'the GC step to start')

        // Third tick while the second pass is still running: no new pass,
        // and the tracked promise is not replaced.
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        expect(mockListFiles).toHaveBeenCalledTimes(2)
        expect(waitForPollPassForTests()).toBe(tracked)
        await expect(settlesSoon(tracked)).resolves.toBe('pending')
      } finally {
        releaseGc()
        await tracked
      }
      expect(isSyncInProgress()).toBe(false)
      await expect(settlesSoon(waitForPollPassForTests())).resolves.toBe('settled')

      stopPolling()
    })

    it('resolves when the pass fails internally', async () => {
      mockListFiles.mockRejectedValueOnce(new Error('network down'))

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await expect(waitForPollPassForTests()).resolves.toBeUndefined()

      expect(mockListFiles).toHaveBeenCalledTimes(1)
      expect(mockRunPackGcAfterPass).not.toHaveBeenCalled()
      expect(isSyncInProgress()).toBe(false)

      stopPolling()
    })

    it('resolves when the pass exits early on missing credentials', async () => {
      mockGetAuthStatus.mockResolvedValueOnce({ authenticated: false })

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await expect(waitForPollPassForTests()).resolves.toBeUndefined()

      expect(mockGetAuthStatus).toHaveBeenCalledTimes(1)
      expect(mockListFiles).not.toHaveBeenCalled()
      expect(isSyncInProgress()).toBe(false)

      stopPolling()
    })

    it('resolves immediately after stopPolling once the last pass settled', async () => {
      mockListFiles.mockResolvedValue([])

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      stopPolling()

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await expect(settlesSoon(waitForPollPassForTests())).resolves.toBe('settled')
      expect(mockListFiles).toHaveBeenCalledTimes(1)
    })

    it('resolves immediately after _resetForTests even while a pass is running', async () => {
      let releaseList: (files: DriveFile[]) => void = () => {}
      const listGate = new Promise<DriveFile[]>((resolve) => { releaseList = resolve })
      mockListFiles.mockImplementationOnce(() => listGate)

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      const running = waitForPollPassForTests()
      try {
        await flushUntil(() => mockListFiles.mock.calls.length === 1, 'the pass to reach listFiles')

        _resetForTests()
        await expect(settlesSoon(waitForPollPassForTests())).resolves.toBe('settled')
      } finally {
        // Let the dropped pass finish so it can't touch the next test.
        releaseList([])
        await running
      }
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
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)
      expect(mockRunPackGcAfterPass).toHaveBeenCalledTimes(1) // first poll: merges the pack
      mockRunPackGcAfterPass.mockClear()

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockDownloadFile).toHaveBeenCalledWith('theme-pack-1')

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

    // A unit that failed to merge this pass must be threaded through
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
        .mockResolvedValueOnce([themePackFile('2026-01-01T00:00:00.000Z'), PASSWORD_CHECK_DRIVE_FILE])
        .mockResolvedValueOnce([themePackFile('2026-01-02T00:00:00.000Z'), PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockImplementation(async (id) => {
        if (id === PASSWORD_CHECK_DRIVE_FILE.id) return { ciphertext: 'ok' }
        throw new Error('decrypt failed')
      })

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)
      // First poll already failed the pack; the next poll retries it.
      expect(mockRunPackGcAfterPass).toHaveBeenCalledTimes(1)
      expect(mockRunPackGcAfterPass.mock.calls[0][1]).toEqual(['themes/packs/pack-a'])
      mockRunPackGcAfterPass.mockClear()

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockDownloadFile).toHaveBeenCalledWith('theme-pack-1')

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

    it('calls listFiles once during upload sync (no N+1)', async () => {
      // Set up multiple local favorites to simulate N sync units
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{}' })
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'macro.json', content: '{}' }, { id: '2', favoriteType: 'macro' })

      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValueOnce(makePasswordCheckEnvelope())
      mockUploadFile.mockResolvedValue({ id: 'id1', modifiedTime: '2026-01-01T00:00:00.000Z' })

      await executeSync('upload')

      // One fetch in executeSync (password check + passed to executeUploadSync),
      // not once per sync unit.
      expect(mockListFiles).toHaveBeenCalledTimes(1)
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

  // executeSync's own return value must distinguish a real completion
  // from a silent skip (busy race, missing credentials) or a partial
  // failure — callers (useDeviceLifecycle's packsPulledOnce once-flag,
  // usePackCloudPull's error state) branch on this instead of assuming
  // any non-throwing call succeeded.
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

    // The index file can outlive every pack id it once listed (all
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

    // scanRemoteData categorizes purely from syncUnitFromFileName —
    // unrecognized filenames (syncUnit === null) are silently dropped
    // from every category, including keyboards (for a uid that only has
    // this file) and themePacks.
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
    it('is refused while the password-change lock is listed, downloading nothing', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'lock', name: 'password-change-lock.json', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f1', name: 'favorites_macro.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])

      await expect(scanRemoteData()).rejects.toThrow('sync.passwordChange.blockedByOtherDevice')

      expect(mockDownloadFile).not.toHaveBeenCalled()
    })
  })

  describe('listRemoteFileNames', () => {
    it('leaves the password-check file out of the name set', async () => {
      mockListFiles.mockResolvedValue([
        PASSWORD_CHECK_DRIVE_FILE,
        { id: 'f1', name: 'favorites_macro.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])

      const names = await listRemoteFileNames()

      expect(names).toEqual(new Set(['favorites_macro.enc']))
    })

    it('returns null while the password-change lock is listed', async () => {
      mockListFiles.mockResolvedValue([
        { id: 'lock', name: 'password-change-lock.json', modifiedTime: '2025-01-01T00:00:00.000Z' },
        { id: 'f1', name: 'favorites_macro.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
      ])

      expect(await listRemoteFileNames()).toBeNull()
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

      // Ordering trap: 'packs' must be checked BEFORE the unconditional
      // key-labels/typing-test-texts `true`s below it in matchesScope —
      // otherwise a 'packs'-scoped download would also pull those unrelated
      // global units in, since their own checks don't care what scope was
      // asked for.
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
        // Legacy flat device form (no `/days/...`) is not recognised.
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

      // These three stores are discovery-included (no dedicated
      // exclusion predicate like analytics/run-logs) —
      // shouldDownloadSyncUnit's own logic needs no changes for them.
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
      // One poll pass; the listing count proves it ran.
      async function pollOnce(): Promise<void> {
        startPolling()
        const before = mockListFiles.mock.calls.length
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await waitForPollPassForTests()
        expect(mockListFiles).toHaveBeenCalledTimes(before + 1)
        stopPolling()
      }

      // Fresh-machine discovery.
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

      it('downloads the settings file for a keyboard whose local directory exists without any settings file', async () => {
        const kbDir = join(mockUserDataPath, 'sync', 'keyboards', '0x1234')
        await mkdir(kbDir, { recursive: true })

        mockListFiles.mockResolvedValue([
          makeSettingsDriveFile('0x1234', '2025-01-01T00:00:00.000Z'),
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        routeDownloads({
          'settings-0x1234': () => makeSettingsEnvelope('0x1234', '2025-01-01T00:00:00.000Z'),
        })

        await executeSync('download')

        expect(mockDownloadFile).toHaveBeenCalledWith('settings-0x1234')
        await expect(access(join(kbDir, 'pipette_settings.json'))).resolves.toBeUndefined()
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

      it('scoped download records only the units it merged, so polling still picks up the rest', async () => {
        await mkdir(join(mockUserDataPath, 'sync', 'keyboards', '0x1234'), { recursive: true })

        const allFiles = [
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f2', name: 'keyboards_0x1234_snapshots.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ]
        mockListFiles.mockResolvedValue(allFiles)
        mockDownloadFile
          .mockResolvedValueOnce(makePasswordCheckEnvelope())
          .mockResolvedValueOnce(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))

        await executeSync('download', 'favorites')

        // Same listing on the next poll: f2 was out of scope, so it was never
        // merged and must be downloaded now; f1 was merged and must not be.
        mockDownloadFile.mockClear()
        mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())
        await pollOnce()
        expect(mockDownloadFile).toHaveBeenCalledWith('f2')
        expect(mockDownloadFile).not.toHaveBeenCalledWith('f1')
      })

      it('a failed unit in a scoped download is retried by the next poll', async () => {
        mockListFiles.mockResolvedValue([
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        mockDownloadFile
          .mockResolvedValueOnce(makePasswordCheckEnvelope())
          .mockRejectedValueOnce(new Error('download failed'))

        const result = await executeSync('download', 'favorites')
        expect(result.status).toBe('partial')

        mockDownloadFile.mockClear()
        mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2025-01-01T00:00:00.000Z'))
        await pollOnce()
        expect(mockDownloadFile).toHaveBeenCalledWith('f1')
      })

      it('flush records only the units it uploaded, so polling still picks up other files', async () => {
        mockAutoSync = true
        await mkdir(join(mockUserDataPath, 'sync', 'keyboards', '0x1234'), { recursive: true })
        await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{"data":1}' })

        mockListFiles.mockResolvedValue([
          makeDriveFile('2025-01-01T00:00:00.000Z'),
          makeSettingsDriveFile('0x1234', '2025-01-01T00:00:00.000Z'),
          PASSWORD_CHECK_DRIVE_FILE,
        ])
        routeDownloads({
          'file-1': () => makeRemoteEnvelope('2025-01-01T00:00:00.000Z'),
          'settings-0x1234': () => makeSettingsEnvelope('0x1234', '2025-01-01T00:00:00.000Z'),
        })

        // The upload result is the revision the flush records for file-1.
        mockUploadFile.mockResolvedValue({ id: 'file-1', modifiedTime: '2025-01-01T00:00:00.000Z' })

        notifyChange('favorites/tapDance')
        await vi.advanceTimersByTimeAsync(10_000)
        await waitForSyncIdle()

        mockDownloadFile.mockClear()
        await pollOnce()
        expect(mockDownloadFile).toHaveBeenCalledWith('settings-0x1234')
        expect(mockDownloadFile).not.toHaveBeenCalledWith('file-1')
      })

      describe('revision recorded by an upload', () => {
        const UPLOADED_AT = '2026-02-01T00:00:00.000Z'

        // Only the listing taken before the upload shows the old revision;
        // every listing after it (including any the upload pass itself might
        // take) shows `revisionAfterUpload`.
        async function uploadFavoriteOverOlderRemote(revisionAfterUpload: string): Promise<void> {
          await setupLocalFavorite('2026-01-01T00:00:00.000Z', { name: 'new.json', content: '{"data":1}' })
          mockListFiles
            .mockResolvedValueOnce([makeDriveFile('2020-01-01T00:00:00.000Z'), PASSWORD_CHECK_DRIVE_FILE])
            .mockResolvedValue([makeDriveFile(revisionAfterUpload), PASSWORD_CHECK_DRIVE_FILE])
          routeDownloads({ 'file-1': () => makeRemoteEnvelope('2020-01-01T00:00:00.000Z') })
          mockUploadFile.mockResolvedValueOnce({ id: 'file-1', modifiedTime: UPLOADED_AT })

          await executeSync('upload')
          expect(mockUploadFile).toHaveBeenCalled()
          mockDownloadFile.mockClear()
        }

        it('an upload is not re-downloaded by the next poll', async () => {
          await uploadFavoriteOverOlderRemote(UPLOADED_AT)

          await pollOnce()
          expect(mockDownloadFile).not.toHaveBeenCalledWith('file-1')
        })

        it('a revision newer than the upload result is downloaded by the next poll', async () => {
          // Another machine wrote right after this upload, before any later
          // listing: only the upload result's own revision may count as known.
          await uploadFavoriteOverOlderRemote('2026-03-01T00:00:00.000Z')

          await pollOnce()
          expect(mockDownloadFile).toHaveBeenCalledWith('file-1')
        })
      })

      it('a scoped executeSync waits for an in-flight poll instead of skipping as busy', async () => {
        await mkdir(join(mockUserDataPath, 'sync', 'keyboards', '0x1234'), { recursive: true })

        let releasePollListing: (files: DriveFile[]) => void = () => {}
        const pollListing = new Promise<DriveFile[]>((resolve) => { releasePollListing = resolve })
        const syncListing = [PASSWORD_CHECK_DRIVE_FILE, makeSettingsDriveFile('0x1234', '2025-01-01T00:00:00.000Z')]
        mockListFiles.mockResolvedValue(syncListing)
        mockListFiles.mockImplementationOnce(() => pollListing)
        routeDownloads({ 'settings-0x1234': () => makeSettingsEnvelope('0x1234', '2025-01-01T00:00:00.000Z') })

        startPolling()
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushUntil(() => mockListFiles.mock.calls.length === 1, 'the poll to list files')
        expect(isSyncInProgress()).toBe(true)

        const resultPromise = executeSync('download', { keyboard: '0x1234' })
        // The poll's own listing has no keyboard unit, so only the waiting
        // executeSync can download it.
        releasePollListing([PASSWORD_CHECK_DRIVE_FILE])
        const result = await resultPromise

        expect(result).toEqual({ status: 'completed' })
        expect(mockDownloadFile).toHaveBeenCalledWith('settings-0x1234')

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
        // The listFiles count proves the poll actually ran, so the negative
        // assertion can't false-pass on a skipped pass.
        const listCallsBeforePoll = mockListFiles.mock.calls.length
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await waitForPollPassForTests()
        expect(mockListFiles).toHaveBeenCalledTimes(listCallsBeforePoll + 1)

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
        undefined,
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
      // First: manual sync creates the password-check
      mockListFiles.mockResolvedValue([])
      await executeSync('download')

      // Once listed, the first auto-sync validates it; later ones skip the
      // check while its modifiedTime stays the same.
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue({ ciphertext: 'ok' })
      const passwordCheckDownloads = (): number =>
        mockDownloadFile.mock.calls.filter((call) => call[0] === PASSWORD_CHECK_DRIVE_FILE.id).length
      const listCallsBeforeFlush = mockListFiles.mock.calls.length
      notifyChange('favorites/tapDance')
      await vi.advanceTimersByTimeAsync(10_000)
      await waitForSyncIdle()

      // The auto-sync flush ran (it lists remote files)
      expect(mockListFiles.mock.calls.length).toBeGreaterThan(listCallsBeforeFlush)
      expect(passwordCheckDownloads()).toBe(1)

      notifyChange('favorites/tapDance')
      await vi.advanceTimersByTimeAsync(10_000)
      await waitForSyncIdle()

      expect(passwordCheckDownloads()).toBe(1)
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
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)

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
        undefined,
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

  describe('while a sign-in or sign-out switches tokens', () => {
    it('an analytics sync and a remote day fetch do not start', async () => {
      syncRuntime.accountSwitching = true

      expect(await executeAnalyticsSync('uid1')).toBe(false)
      expect(await fetchRemoteTypingDay('uid1', 'hash1', '2026-10-01')).toBe(false)
      expect(syncRuntime.analyticsSyncingUids.size).toBe(0)
      expect(syncRuntime.remoteTypingDayFetches.size).toBe(0)
      expect(mockListFiles).not.toHaveBeenCalled()
    })
  })

  describe('setupBeforeQuitHandler phased ordering', () => {
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
      await flushUntil(() => vi.mocked(app.quit).mock.calls.length > 0, 'the quit phases to call app.quit')

      expect(preventDefault).toHaveBeenCalled()
      expect(preSyncFinalizer.run).toHaveBeenCalledTimes(1)
      expect(extraFinalizer.run).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['pre-sync', 'extra'])
      expect(app.quit).toHaveBeenCalled()
    })

    it('waits for a running password switch to stop before quitting', async () => {
      let finish!: () => void
      syncRuntime.passwordChangeRun = new Promise<void>((resolve) => {
        finish = resolve
      })
      const handler = captureBeforeQuitHandler()
      const preventDefault = vi.fn()
      handler({ preventDefault })

      expect(preventDefault).toHaveBeenCalled()
      // The switch reads this at its next chunk boundary and stops.
      expect(syncRuntime.isQuitting).toBe(true)
      await new Promise((resolve) => setImmediate(resolve))
      expect(app.quit).not.toHaveBeenCalled()

      finish()
      await flushUntil(() => vi.mocked(app.quit).mock.calls.length > 0, 'the quit phases to call app.quit')
      expect(app.quit).toHaveBeenCalled()
    })

    it('still quits when the password switch rejects', async () => {
      syncRuntime.passwordChangeRun = Promise.reject(new Error('switch failed'))
      const handler = captureBeforeQuitHandler()
      handler({ preventDefault: vi.fn() })
      await flushUntil(() => vi.mocked(app.quit).mock.calls.length > 0, 'the quit phases to call app.quit')
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
      await flushUntil(() => vi.mocked(app.quit).mock.calls.length > 0, 'the quit phases to call app.quit')

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

    function seedOwnDayOnDrive(day: string, uploaded: string[] = [day]): void {
      mockSyncState = {
        _rev: 3,
        my_device_id: OWN_HASH,
        uploaded: { [pointerKey(OWN_HASH)]: uploaded },
        reconciled_at: { [pointerKey(OWN_HASH)]: 5_000 },
        last_synced_at: 5_000,
      }
      mockListFiles.mockResolvedValue([cloudDriveFile(OWN_HASH, day), PASSWORD_CHECK_DRIVE_FILE])
    }

    function expectOwnDayUploaded(day: string): void {
      expect(mockUploadFile).toHaveBeenCalledWith(
        cloudFileName(OWN_HASH, day),
        expect.anything(),
        `drive-${OWN_HASH}-${day}`,
      )
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
      mockUploadFile.mockClear()
      await executeSync('upload')
      expect(mockUploadFile).toHaveBeenCalledTimes(1)
      expectOwnDayUploaded('2026-04-18')
      expect(mockDownloadFile).not.toHaveBeenCalledWith(`drive-${OWN_HASH}-2026-04-18`)
      expect(mockSyncState?.uploaded[pointerKey(OWN_HASH)]).toEqual(['2026-04-18'])
    })

    it('own day on Drive: a debounced flush re-uploads it in place', async () => {
      const day = '2026-04-18'
      const unit = `keyboards/${UID}/devices/${OWN_HASH}/days/${day}`
      mockAutoSync = true
      seedOwnDayOnDrive(day)
      await writeDayFile(day)
      mockListLocalKeyboardUids.mockReturnValue([UID])

      notifyChange(unit)
      await vi.advanceTimersByTimeAsync(10_000)
      await waitForSyncIdle()

      expectOwnDayUploaded(day)
    })

    it('own day on Drive: executeAnalyticsSync uploads it exactly once', async () => {
      const day = '2026-04-18'
      seedOwnDayOnDrive(day)
      await writeDayFile(day)
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

      expect(await executeAnalyticsSync(UID)).toBe(true)

      const calls = mockUploadFile.mock.calls.filter((c) => c[0] === cloudFileName(OWN_HASH, day))
      expect(calls).toHaveLength(1)
      expect(calls[0][2]).toBe(`drive-${OWN_HASH}-${day}`)
      expect(mockDownloadFile).not.toHaveBeenCalledWith(`drive-${OWN_HASH}-${day}`)
    })

    it('own day on Drive with no local file: download sync neither uploads nor downloads it', async () => {
      const day = '2026-04-18'
      seedOwnDayOnDrive(day, [])
      await mkdir(join(mockUserDataPath, 'sync', 'keyboards', UID), { recursive: true })

      const result = await executeSync('download', { keyboard: UID })

      expect(result.status).toBe('completed')
      expect(mockUploadFile).not.toHaveBeenCalled()
      expect(mockDownloadFile).not.toHaveBeenCalledWith(`drive-${OWN_HASH}-${day}`)
    })

    it('own day with a hostile uid segment is rejected before any path is joined', async () => {
      const day = '2026-04-18'
      // `..` is a single segment, so the day-unit parser accepts it as a uid.
      const unit = `keyboards/../devices/${OWN_HASH}/days/${day}`
      const remoteFiles = [{ id: 'hostile', name: `keyboards_.._devices_${OWN_HASH}_days_${day}.enc`, modifiedTime: '2026-01-01T00:00:00.000Z' }]

      await expect(syncOrUpload(unit, 'test-password', remoteFiles)).rejects.toThrow('malformed sync bundle index')
      expect(mockUploadFile).not.toHaveBeenCalled()
      expect(mockDownloadFile).not.toHaveBeenCalled()
    })

    it('concurrent uploads of the same unit run one after the other', async () => {
      const day = '2026-04-18'
      const unit = `keyboards/${UID}/devices/${OWN_HASH}/days/${day}`
      const lineA = '{"id":"line-a"}\n'
      const lineB = '{"id":"line-b"}\n'
      await writeDayFile(day, OWN_HASH, lineA)
      const remoteFiles = [cloudDriveFile(OWN_HASH, day)]
      const mockEncrypt = vi.mocked(mockEncryptFn)
      mockEncrypt.mockClear()
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      mockUploadFile.mockImplementationOnce(async () => {
        await gate
        return { id: 'file-id', modifiedTime: '2026-01-01T00:00:00.000Z' }
      })

      const first = syncOrUpload(unit, 'test-password', remoteFiles)
      await flushUntil(() => mockUploadFile.mock.calls.length === 1, 'the first upload to start')
      const second = syncOrUpload(unit, 'test-password', remoteFiles)
      // Without serialization the second upload would bundle during these ticks, before line B exists.
      for (let i = 0; i < 50; i++) await new Promise<void>((resolve) => realSetImmediate(resolve))
      await appendFile(ownDayPath(day), lineB, 'utf-8')
      release()
      await Promise.all([first, second])

      expect(mockUploadFile).toHaveBeenCalledTimes(2)
      expect(mockEncrypt).toHaveBeenCalledTimes(2)
      const dayContent = (call: number): string =>
        (JSON.parse(mockEncrypt.mock.calls[call][0] as string) as { files: Record<string, string> }).files['data.jsonl']
      expect(dayContent(0)).not.toContain('line-b')
      expect(dayContent(1)).toContain('line-b')
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

  // Bundle-variant merge crash regression.
  // i18n-index / i18n-pack / theme-index / theme-pack bundles carry
  // `{ metas: [...] }` or a raw pack body, never `{ entries }` — so before
  // dedicated branches existed, mergeSyncUnit's generic index-based branch
  // called `gcTombstones((remoteBundle.index as { entries }).entries)` on
  // `undefined`, throwing a TypeError. This first test pins the pre-fix
  // failure mode (caught per-unit → 'partial' status); every test after it
  // asserts the fixed LWW behavior.
  describe('bundle-variant merge (i18n/theme index + pack)', () => {
    /** Builds a mock decrypted SyncEnvelope for any bundle shape (index
     *  or pack-body). */
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
      // Index merge is entry-level LWW: both ids survive as a union, and
      // since local has an id remote doesn't have yet, the merged index
      // is marked for re-upload so remote converges too.
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
      // Machine A installs pack 'pack-a' (already on remote); machine B
      // (this process) independently installed 'pack-b' locally before
      // ever syncing. A naive file-level LWW would have machine B's
      // later local timestamp win wholesale, permanently erasing
      // 'pack-a' from both the local index AND — once B uploads — from
      // remote too, orphaning its pack body forever. Entry-level LWW
      // must instead keep both.
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
      // applySyncedPackBody writes via temp-file-then-rename — no `.tmp`
      // sibling may linger after a successful write.
      const packFiles = await readdir(join(mockUserDataPath, 'sync', dir, 'packs'))
      expect(packFiles.filter((f) => f.endsWith('.tmp'))).toEqual([])
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
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)

      // Second poll: badFile is now present and wasn't in the baseline,
      // so it's treated as "changed" — the merge fails with
      // MalformedSyncBundleError, but the poll's catch deliberately does
      // NOT forget badFile's modifiedTime from lastKnownRemoteState (it
      // was already recorded earlier in this same poll pass), so poll 3
      // below sees an unchanged modifiedTime and skips it without ever
      // retrying — no separate block-map data structure needed.
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE, badFile])
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      // The failing merge itself is real disk I/O (readIndexFile against a
      // real tmp dir) — wait for the whole pass so poll 3 below never races
      // a still-in-flight poll 2.
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(2)
      const attemptsAfterSecondPoll = mockDownloadFile.mock.calls.filter((c) => c[0] === 'bad1').length
      expect(attemptsAfterSecondPoll).toBeGreaterThan(0)
      // Contained per-unit with a warn naming only the sync unit — never
      // bundle content (attacker-reachable remote data).
      expect(mockLog).toHaveBeenCalledWith('warn', expect.stringContaining('favorites/tapDance'))

      // Third poll, same revision still on Drive — must NOT retry again.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(3)
      const attemptsAfterThirdPoll = mockDownloadFile.mock.calls.filter((c) => c[0] === 'bad1').length
      expect(attemptsAfterThirdPoll).toBe(attemptsAfterSecondPoll)

      // A changed revision (new modifiedTime) clears the block and is retried.
      const changedFile = { ...badFile, modifiedTime: '2026-01-02T00:00:00.000Z' }
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE, changedFile])
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(4)
      const attemptsAfterFourthPoll = mockDownloadFile.mock.calls.filter((c) => c[0] === 'bad1').length
      expect(attemptsAfterFourthPoll).toBeGreaterThan(attemptsAfterThirdPoll)

      stopPolling()
    })

    it('S1: a hostile packId is contained on the poll path too — not retried every 3 minutes', async () => {
      // The hostile-packId test above only exercises the manual
      // sync path (executeSync). applySyncedPackBody THROWS
      // MalformedSyncBundleError for a rejected packId instead of
      // returning false as a bare Error would — this lets the poll's
      // `instanceof MalformedSyncBundleError` branch recognize the
      // rejection as permanent and skip retrying it, exactly like the
      // malformed-generic-bundle poll test above. A bare Error looks
      // identical to a transient I/O failure, which the poll
      // deliberately DOES keep retrying — so a hostile remote filename
      // would trigger a fresh download+decrypt attempt every 3 minutes
      // forever.
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
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(1)

      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE, evilFile])
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(2)
      const attemptsAfterSecondPoll = mockDownloadFile.mock.calls.filter((c) => c[0] === 'evil1').length
      expect(attemptsAfterSecondPoll).toBeGreaterThan(0)

      // Same revision still on Drive on the next poll — must NOT retry.
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await waitForPollPassForTests()
      expect(mockListFiles).toHaveBeenCalledTimes(3)
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
      // filesystem path — this is the exposure, independent of the
      // i18n/theme pack-index fix above.
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
  describe('merge under the stores\' write lock', () => {
    const UID = '0x1234'
    const PW = 'test-password'

    interface TestEntry { id: string; label: string; name: string; filename: string; savedAt: string; updatedAt?: string }

    function entry(id: string, savedAt = '2026-01-01T00:00:00.000Z'): TestEntry {
      return { id, label: id, name: id, filename: `${id}.json`, savedAt, updatedAt: savedAt }
    }

    function indexEnvelope(syncUnit: string, entries: TestEntry[], extra: Record<string, unknown> = {}): Record<string, unknown> {
      const files: Record<string, string> = {}
      for (const e of entries) files[e.filename] = `{"data":"${e.id}"}`
      const index = { ...extra, entries }
      files['index.json'] = JSON.stringify(index)
      return {
        version: 1,
        syncUnit,
        updatedAt: '2026-01-01T00:00:00.000Z',
        salt: 's',
        iv: 'i',
        ciphertext: JSON.stringify({ type: 'index', key: syncUnit, index, files }),
      }
    }

    async function seedIndex(dir: string, entries: TestEntry[], extra: Record<string, unknown> = {}): Promise<void> {
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'index.json'), JSON.stringify({ ...extra, entries }), 'utf-8')
      for (const e of entries) await writeFile(join(dir, e.filename), `{"data":"${e.id}"}`, 'utf-8')
    }

    async function readIndex(dir: string): Promise<{ entries: TestEntry[] }> {
      return JSON.parse(await readFile(join(dir, 'index.json'), 'utf-8')) as { entries: TestEntry[] }
    }

    async function readIds(dir: string): Promise<string[]> {
      return (await readIndex(dir)).entries.map((e) => e.id)
    }

    // Stalls the next call of `fn` right after the real read, until released.
    function stallAfterRead<A extends unknown[], R>(
      mocked: (...args: A) => Promise<R>,
      real: (...args: A) => Promise<R>,
    ): { reached: () => boolean; release: () => void } {
      let reached = false
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      vi.mocked(mocked).mockImplementation(async (...args: A) => {
        const result = await real(...args)
        reached = true
        await gate
        return result
      })
      return { reached: () => reached, release }
    }

    let realReadIndexFile: typeof readIndexFile
    let realReadSettingsFile: typeof readSettingsFile

    beforeEach(async () => {
      const actual = await vi.importActual<typeof import('../sync/sync-bundle')>('../sync/sync-bundle')
      realReadIndexFile = actual.readIndexFile
      realReadSettingsFile = actual.readSettingsFile
      vi.mocked(readIndexFile).mockImplementation(realReadIndexFile)
      vi.mocked(readSettingsFile).mockImplementation(realReadSettingsFile)
    })

    afterEach(() => {
      vi.mocked(readIndexFile).mockImplementation(realReadIndexFile)
      vi.mocked(readSettingsFile).mockImplementation(realReadSettingsFile)
    })

    // Issues a concurrent writer while the merge is stalled holding its lock,
    // then gives the writer a bounded real-time window to enter its locked
    // section. With the lock it stays queued (enteredEarly === false). Without
    // it, the writer is awaited to completion before the gate opens, so the
    // merge's stale write provably lands last and the assertions fail.
    async function raceWriterAgainstStalledMerge(
      stall: { release: () => void },
      merge: Promise<unknown>,
      startWriter: (markEntered: () => void) => Promise<unknown>,
    ): Promise<boolean> {
      let markEntered!: () => void
      const entered = new Promise<void>((resolve) => { markEntered = resolve })
      const writer = startWriter(markEntered)
      const enteredEarly = await Promise.race([
        entered.then(() => true),
        new Promise<boolean>((resolve) => { realSetTimeout(resolve, 100, false) }),
      ])
      if (enteredEarly) await writer
      stall.release()
      await Promise.all([merge, writer])
      return enteredEarly
    }

    async function runIndexRace(opts: {
      syncUnit: string
      driveFile: DriveFile
      remote: TestEntry[]
      extra?: Record<string, unknown>
      writer: (markEntered: () => void) => Promise<unknown>
    }): Promise<boolean> {
      mockDownloadFile.mockImplementation(async () =>
        indexEnvelope(opts.syncUnit, opts.remote, opts.extra))
      const stall = stallAfterRead(readIndexFile, realReadIndexFile)
      const merge = mergeWithRemote(opts.driveFile, opts.syncUnit, PW, [opts.driveFile])
      await flushUntil(stall.reached, 'the merge to read the local index')
      return raceWriterAgainstStalledMerge(stall, merge, opts.writer)
    }

    it('snapshots: a store save during a merge is not overwritten', async () => {
      const dir = join(mockUserDataPath, 'sync', 'keyboards', UID, 'snapshots')
      await seedIndex(dir, [entry('local-1')], { uid: UID })
      const driveFile = { id: 'snap-1', name: driveFileName(`keyboards/${UID}/snapshots`), modifiedTime: '2026-02-01T00:00:00.000Z' }

      const enteredEarly = await runIndexRace({
        syncUnit: `keyboards/${UID}/snapshots`,
        driveFile,
        remote: [entry('remote-1')],
        extra: { uid: UID },
        writer: (markEntered) => withWriteLock(UID, async () => {
          markEntered()
          const raw = await readIndex(dir)
          raw.entries.push(entry('local-new'))
          await writeFile(join(dir, 'index.json'), JSON.stringify(raw), 'utf-8')
        }),
      })

      expect(enteredEarly).toBe(false)
      const ids = await readIds(dir)
      expect(ids).toContain('remote-1')
      expect(ids).toContain('local-1')
      expect(ids).toContain('local-new')
    })

    it('favorites: a store save during a merge is not overwritten', async () => {
      const dir = join(mockUserDataPath, 'sync', 'favorites', 'tapDance')
      await seedIndex(dir, [entry('local-1')], { type: 'tapDance' })
      const driveFile = makeDriveFile('2026-02-01T00:00:00.000Z')

      const enteredEarly = await runIndexRace({
        syncUnit: 'favorites/tapDance',
        driveFile,
        remote: [entry('remote-1')],
        extra: { type: 'tapDance' },
        writer: (markEntered) => withWriteLock('favorites/tapDance', async () => {
          markEntered()
          const raw = await readIndex(dir)
          raw.entries.push(entry('local-new'))
          await writeFile(join(dir, 'index.json'), JSON.stringify(raw), 'utf-8')
        }),
      })

      expect(enteredEarly).toBe(false)
      const ids = await readIds(dir)
      expect(ids).toEqual(expect.arrayContaining(['remote-1', 'local-1', 'local-new']))
    })

    it('key-labels: the store\'s own save serializes with a merge', async () => {
      const dir = join(mockUserDataPath, 'sync', 'key-labels')
      await seedIndex(dir, [entry('local-1')])
      const driveFile = { id: 'kl-1', name: driveFileName('key-labels'), modifiedTime: '2026-02-01T00:00:00.000Z' }

      const enteredEarly = await runIndexRace({
        syncUnit: 'key-labels',
        driveFile,
        remote: [entry('remote-1')],
        writer: (markEntered) => saveKeyLabel({ name: 'LocalNew', map: {} }).finally(markEntered),
      })

      expect(enteredEarly).toBe(false)
      const index = await readIndex(dir)
      const names = index.entries.map((e) => e.name)
      expect(names).toEqual(expect.arrayContaining(['remote-1', 'local-1', 'LocalNew']))
    })

    it('settings: a store write during a merge is not overwritten', async () => {
      const dir = join(mockUserDataPath, 'sync', 'keyboards', UID)
      await mkdir(dir, { recursive: true })
      const filePath = join(dir, 'pipette_settings.json')
      await writeFile(filePath, JSON.stringify({ theme: 'light', _updatedAt: '2025-01-01T00:00:00.000Z' }), 'utf-8')
      mockDownloadFile.mockImplementation(async () => makeSettingsEnvelope(UID, '2026-01-01T00:00:00.000Z'))
      const driveFile = makeSettingsDriveFile(UID, '2026-02-01T00:00:00.000Z')

      const stall = stallAfterRead(readSettingsFile, realReadSettingsFile)
      const merge = mergeWithRemote(driveFile, `keyboards/${UID}/settings`, PW, [driveFile])
      await flushUntil(stall.reached, 'the merge to read the local settings')
      const enteredEarly = await raceWriterAgainstStalledMerge(stall, merge, (markEntered) =>
        withWriteLock(UID, async () => {
          markEntered()
          await writeFile(filePath, JSON.stringify({ theme: 'light', marker: true, _updatedAt: '2026-06-01T00:00:00.000Z' }), 'utf-8')
        }))

      expect(enteredEarly).toBe(false)
      const final = JSON.parse(await readFile(filePath, 'utf-8')) as { marker?: boolean }
      expect(final.marker).toBe(true)
    })

    it('does not deadlock when the unit lock is held externally', async () => {
      const dir = join(mockUserDataPath, 'sync', 'keyboards', UID, 'snapshots')
      await seedIndex(dir, [entry('local-1')], { uid: UID })
      mockDownloadFile.mockImplementation(async () =>
        indexEnvelope(`keyboards/${UID}/snapshots`, [entry('remote-1')], { uid: UID }))
      const driveFile = { id: 'snap-1', name: driveFileName(`keyboards/${UID}/snapshots`), modifiedTime: '2026-02-01T00:00:00.000Z' }

      let release!: () => void
      const hold = withWriteLock(UID, () => new Promise<void>((resolve) => { release = resolve }))
      const merge = mergeWithRemote(driveFile, `keyboards/${UID}/snapshots`, PW, [driveFile])
      await flushUntil(() => true)
      release()
      await Promise.all([hold, merge])

      // local-only entry => merge asked for an upload, which ran after the lock was released
      expect(mockUploadFile).toHaveBeenCalled()
      expect(await readIds(dir)).toEqual(expect.arrayContaining(['remote-1', 'local-1']))
    })

    it('writes the settings file and the merged index atomically', async () => {
      const dir = join(mockUserDataPath, 'sync', 'keyboards', UID)
      await mkdir(dir, { recursive: true })
      mockDownloadFile.mockImplementation(async () => makeSettingsEnvelope(UID, '2026-01-01T00:00:00.000Z'))
      const settingsFile = makeSettingsDriveFile(UID, '2026-02-01T00:00:00.000Z')
      await mergeWithRemote(settingsFile, `keyboards/${UID}/settings`, PW, [settingsFile])

      const snapDir = join(dir, 'snapshots')
      mockDownloadFile.mockImplementation(async () =>
        indexEnvelope(`keyboards/${UID}/snapshots`, [entry('remote-1')], { uid: UID }))
      const snapFile = { id: 'snap-1', name: driveFileName(`keyboards/${UID}/snapshots`), modifiedTime: '2026-02-01T00:00:00.000Z' }
      await mergeWithRemote(snapFile, `keyboards/${UID}/snapshots`, PW, [snapFile])

      const written = vi.mocked(writeFileAtomic).mock.calls.map((c) => String(c[0]))
      expect(written).toContain(join(dir, 'pipette_settings.json'))
      expect(written).toContain(join(snapDir, 'index.json'))
      expect(written).toContain(join(snapDir, 'remote-1.json'))
    })
  })
})
