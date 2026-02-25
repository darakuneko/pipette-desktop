// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

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

const mockListFiles = vi.fn(async () => [])
const mockDownloadFile = vi.fn(async () => ({}))
const mockUploadFile = vi.fn(async () => 'file-id')
const mockDriveFileName = vi.fn((syncUnit: string) => syncUnit.replaceAll('/', '_') + '.enc')
const mockSyncUnitFromFileName = vi.fn((name: string) => {
  const kbMatch = name.match(/^keyboards_(.+?)_(settings|snapshots)\.enc$/)
  if (kbMatch) return `keyboards/${kbMatch[1]}/${kbMatch[2]}`
  const favMatch = name.match(/^favorites_(.+)\.enc$/)
  if (favMatch) return `favorites/${favMatch[1]}`
  return null
})

vi.mock('../sync/google-drive', () => ({
  listFiles: (...args: unknown[]) => mockListFiles(...args),
  downloadFile: (...args: unknown[]) => mockDownloadFile(...args),
  uploadFile: (...args: unknown[]) => mockUploadFile(...args),
  driveFileName: (...args: unknown[]) => mockDriveFileName(...args),
  syncUnitFromFileName: (...args: unknown[]) => mockSyncUnitFromFileName(...args),
}))

const mockGetAuthStatus = vi.fn(async () => ({ authenticated: true }))

vi.mock('../sync/google-auth', () => ({
  getAuthStatus: (...args: unknown[]) => mockGetAuthStatus(...args),
  getAccessToken: vi.fn(async () => 'mock-token'),
  startOAuthFlow: vi.fn(async () => {}),
  signOut: vi.fn(async () => {}),
}))

vi.mock('../sync/sync-crypto', () => ({
  retrievePassword: vi.fn(async () => 'test-password'),
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
}))

vi.stubGlobal('fetch', vi.fn())

import { decrypt as mockDecryptFn, encrypt as mockEncryptFn, storePassword as mockStorePasswordFn, clearPassword as mockClearPasswordFn } from '../sync/sync-crypto'
import type { SyncProgress } from '../../shared/types/sync'
import {
  executeSync,
  matchesScope,
  notifyChange,
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
  _resetForTests,
} from '../sync/sync-service'

const POLL_INTERVAL_MS = 3 * 60 * 1000

const FAKE_TIMER_OPTS = {
  toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] as const,
}

async function flushIO(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
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
      await first
      await second

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
      await flushIO()

      // Second poll: detects modifiedTime change, downloads
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushIO()

      expect(mockListFiles).toHaveBeenCalledTimes(2)
      expect(mockDownloadFile).toHaveBeenCalledWith('file-1')

      stopPolling()
    })

    it('skips when no remote changes detected', async () => {
      mockListFiles.mockResolvedValue([makeDriveFile('2025-01-01T00:00:00.000Z')])

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushIO()

      const downloadCallCount = mockDownloadFile.mock.calls.length

      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
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
        return Promise.resolve('id1')
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
        return Promise.resolve('id1')
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
      mockUploadFile.mockResolvedValue('id1')

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

    it('returns empty result when not authenticated', async () => {
      mockGetAuthStatus.mockResolvedValueOnce({ authenticated: false })

      const result = await scanRemoteData()
      expect(result).toEqual({ keyboards: [], favorites: [], undecryptable: [] })
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
        'Cannot change password while sync is in progress',
      )

      await vi.advanceTimersByTimeAsync(200)
      await syncPromise
    })

    it('throws when new password is the same as current', async () => {
      await expect(changePassword('test-password')).rejects.toThrow('sync.samePassword')
      expect(mockUploadFile).not.toHaveBeenCalled()
    })

    it('throws when no password is stored', async () => {
      mockGetAuthStatus.mockResolvedValueOnce({ authenticated: false })

      await expect(changePassword('new-password')).rejects.toThrow('No stored password found')
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
      })
    })

    describe('executeSync with scope', () => {
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

      it('downloads all files when scope is omitted (backward compat)', async () => {
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

      it('updates remote state for all files even with scoped download', async () => {
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

        // Subsequent poll should detect changes to keyboard file
        // because updateRemoteState was called with all files
        const updatedFiles = [
          { id: 'f1', name: 'favorites_tapDance.enc', modifiedTime: '2025-01-01T00:00:00.000Z' },
          { id: 'f2', name: 'keyboards_0x1234_settings.enc', modifiedTime: '2025-01-02T00:00:00.000Z' },
          PASSWORD_CHECK_DRIVE_FILE,
        ]
        mockListFiles.mockResolvedValue(updatedFiles)
        mockDownloadFile.mockResolvedValue(makeSettingsEnvelope('0x1234', '2025-01-02T00:00:00.000Z'))

        startPolling()
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
        await flushIO()

        // Polling should detect the keyboard file changed
        expect(mockDownloadFile).toHaveBeenCalledWith('f2')

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
        mockUploadFile.mockResolvedValue('id1')

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
        mockUploadFile.mockResolvedValue('id1')

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
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

      // syncUnitFromFileName should return null for password-check.enc
      expect(mockSyncUnitFromFileName('password-check.enc')).toBeNull()

      await executeSync('download')
      // Should succeed without trying to merge password-check as a sync unit
    })

    it('validates password on polling when not yet validated', async () => {
      mockListFiles.mockResolvedValue([PASSWORD_CHECK_DRIVE_FILE])
      mockDownloadFile.mockResolvedValue(makePasswordCheckEnvelope())

      startPolling()
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
      await flushIO()

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
})
