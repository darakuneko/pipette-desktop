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

import type { SyncProgress } from '../../shared/types/sync'
import {
  executeSync,
  notifyChange,
  setProgressCallback,
  startPolling,
  stopPolling,
  hasPendingChanges,
  cancelPendingChanges,
  isSyncInProgress,
  _resetForTests,
} from '../sync/sync-service'

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
      mockListFiles.mockResolvedValue([makeDriveFile('2025-01-01T00:00:00.000Z')])
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
    it('detects remote changes and downloads', async () => {
      mockListFiles.mockResolvedValue([makeDriveFile('2026-01-01T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2026-01-01T00:00:00.000Z'))

      startPolling()
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000)
      await flushIO()

      expect(mockListFiles).toHaveBeenCalled()
      expect(mockDownloadFile).toHaveBeenCalledWith('file-1')

      stopPolling()
    })

    it('skips when no remote changes detected', async () => {
      mockListFiles.mockResolvedValue([makeDriveFile('2025-01-01T00:00:00.000Z')])

      startPolling()
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000)
      await flushIO()

      const downloadCallCount = mockDownloadFile.mock.calls.length

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000)
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
      await vi.advanceTimersByTimeAsync(3 * 60 * 1000)

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

      await vi.advanceTimersByTimeAsync(3 * 60 * 1000)

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

      mockListFiles.mockResolvedValue([makeDriveFile('2025-01-01T00:00:00.000Z')])
      mockDownloadFile.mockResolvedValue(makeRemoteEnvelope('2025-01-01T00:00:00.000Z', [sharedEntry]))

      await executeSync('download')

      expect(mockDownloadFile).toHaveBeenCalled()
      expect(mockUploadFile).not.toHaveBeenCalled()
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

      mockListFiles.mockResolvedValue([])
      // tapDance upload succeeds, macro upload fails
      mockUploadFile
        .mockResolvedValueOnce('id1')
        .mockRejectedValueOnce(new Error('upload failed'))

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

      mockListFiles.mockResolvedValue([])
      // tapDance succeeds, macro fails
      mockUploadFile
        .mockResolvedValueOnce('id1')
        .mockRejectedValueOnce(new Error('upload failed'))

      await executeSync('upload')

      // Failed unit should remain pending for auto-sync retry
      expect(hasPendingChanges()).toBe(true)
    })

    it('calls listFiles only twice during upload sync (no N+1)', async () => {
      // Set up multiple local favorites to simulate N sync units
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'data.json', content: '{}' })
      await setupLocalFavorite('2025-01-01T00:00:00.000Z', { name: 'macro.json', content: '{}' }, { id: '2', favoriteType: 'macro' })

      mockListFiles.mockResolvedValue([])
      mockUploadFile.mockResolvedValue('id1')

      await executeSync('upload')

      // listFiles should be called exactly twice:
      // 1. Initial fetch before the loop
      // 2. Final refresh after the loop
      // NOT N+1 times (once per sync unit)
      expect(mockListFiles).toHaveBeenCalledTimes(2)
      // Verify uploads actually happened (guards against false-positive)
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
})
