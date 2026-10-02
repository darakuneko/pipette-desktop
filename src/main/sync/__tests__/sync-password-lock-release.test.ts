// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DriveFile } from '../google-drive'

const mockListFiles = vi.fn(async (..._args: unknown[]): Promise<DriveFile[]> => [])
const mockDownloadRawFile = vi.fn(async (_fileId: string): Promise<string> => '')
const mockDeleteFile = vi.fn(async (_fileId: string): Promise<void> => {})
const mockHasChangeState = vi.fn(async () => false)

vi.mock('../google-drive', async () => ({
  ...(await vi.importActual<typeof import('../google-drive')>('../google-drive')),
  listFiles: (...args: unknown[]) => mockListFiles(...args),
  downloadRawFile: (...args: unknown[]) => mockDownloadRawFile(...(args as [string])),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...(args as [string])),
}))

vi.mock('../sync-password-change-state', () => ({
  hasChangeState: () => mockHasChangeState(),
}))

vi.mock('../sync-runtime-state', () => ({
  syncRuntime: { isSyncing: false, analyticsSyncingUids: new Set<string>() },
  emitProgress: vi.fn(),
}))

vi.mock('../../typing-analytics/machine-hash', () => ({
  getMachineHash: vi.fn(async () => 'hash-own'),
}))

import { PASSWORD_CHANGE_LOCK_FILE } from '../google-drive'
import { syncRuntime } from '../sync-runtime-state'
import { getPasswordChangeLockStatus, releasePasswordChangeLocks } from '../sync-password-lock-release'

function lockFile(id: string, createdTime: string): DriveFile {
  return { id, name: PASSWORD_CHANGE_LOCK_FILE, modifiedTime: createdTime, createdTime }
}

function lockText(machineHash: string, startedAt: string): string {
  return JSON.stringify({ type: 'password-change-lock', version: 1, lockId: `lock-${machineHash}`, machineHash, startedAt })
}

const EARLY = lockFile('early', '2026-10-02T09:00:00.000Z')
const LATE = lockFile('late', '2026-10-02T10:00:00.000Z')

describe('sync-password-lock-release', () => {
  beforeEach(() => {
    mockListFiles.mockReset()
    mockListFiles.mockResolvedValue([])
    mockDownloadRawFile.mockReset()
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)
    mockHasChangeState.mockReset()
    mockHasChangeState.mockResolvedValue(false)
    syncRuntime.isSyncing = false
    syncRuntime.analyticsSyncingUids.clear()
  })

  describe('getPasswordChangeLockStatus', () => {
    it('is null when Drive has no lock', async () => {
      expect(await getPasswordChangeLockStatus()).toBeNull()
    })

    it("reports the earliest lock's start time and that another machine holds it", async () => {
      mockListFiles.mockResolvedValue([LATE, EARLY])
      mockDownloadRawFile.mockImplementation(async (id) =>
        id === 'early' ? lockText('hash-other', '2026-10-02T09:00:00.000Z') : lockText('hash-own', '2026-10-02T10:00:00.000Z'),
      )
      expect(await getPasswordChangeLockStatus()).toEqual({ startedAt: '2026-10-02T09:00:00.000Z', ownMachine: false })
      expect(mockDownloadRawFile).toHaveBeenCalledWith('early')
    })

    it('reports a lock left by this machine', async () => {
      mockListFiles.mockResolvedValue([EARLY])
      mockDownloadRawFile.mockResolvedValue(lockText('hash-own', '2026-10-02T09:00:00.000Z'))
      expect(await getPasswordChangeLockStatus()).toEqual({ startedAt: '2026-10-02T09:00:00.000Z', ownMachine: true })
    })

    it('reports an unreadable lock without a start time', async () => {
      mockListFiles.mockResolvedValue([EARLY])
      mockDownloadRawFile.mockResolvedValue('not json')
      expect(await getPasswordChangeLockStatus()).toEqual({ startedAt: null, ownMachine: false })
    })

    it('never exposes the lock id', async () => {
      mockListFiles.mockResolvedValue([EARLY])
      mockDownloadRawFile.mockResolvedValue(lockText('hash-other', '2026-10-02T09:00:00.000Z'))
      expect(JSON.stringify(await getPasswordChangeLockStatus())).not.toContain('lock-')
    })

    it('ignores non-lock files that match the name filter loosely', async () => {
      mockListFiles.mockResolvedValue([{ id: 'x', name: `${PASSWORD_CHANGE_LOCK_FILE}.bak`, modifiedTime: 'm' }])
      expect(await getPasswordChangeLockStatus()).toBeNull()
    })
  })

  describe('releasePasswordChangeLocks', () => {
    it('deletes every lock on Drive', async () => {
      mockListFiles.mockResolvedValue([LATE, EARLY])
      await releasePasswordChangeLocks()
      expect(mockDeleteFile.mock.calls.map(([id]) => id).sort()).toEqual(['early', 'late'])
      expect(syncRuntime.isSyncing).toBe(false)
    })

    it('refuses while this machine has a password change of its own', async () => {
      mockHasChangeState.mockResolvedValue(true)
      mockListFiles.mockResolvedValue([EARLY])
      await expect(releasePasswordChangeLocks()).rejects.toThrow('sync.passwordChange.blockedLocal')
      expect(mockDeleteFile).not.toHaveBeenCalled()
    })

    it('refuses while a sync runs on this machine', async () => {
      syncRuntime.isSyncing = true
      mockListFiles.mockResolvedValue([EARLY])
      await expect(releasePasswordChangeLocks()).rejects.toThrow('sync.passwordChange.releaseBusy')
      expect(mockDeleteFile).not.toHaveBeenCalled()
      expect(syncRuntime.isSyncing).toBe(true)
    })

    it('refuses while an analytics sync runs on this machine', async () => {
      syncRuntime.analyticsSyncingUids.add('uid1')
      await expect(releasePasswordChangeLocks()).rejects.toThrow('sync.passwordChange.releaseBusy')
    })

    it('holds isSyncing while deleting and clears it after a failure', async () => {
      mockListFiles.mockResolvedValue([EARLY])
      let syncingDuringDelete = false
      mockDeleteFile.mockImplementation(async () => {
        syncingDuringDelete = syncRuntime.isSyncing
        throw new Error('Drive delete failed: 503')
      })
      await expect(releasePasswordChangeLocks()).rejects.toThrow('503')
      expect(syncingDuringDelete).toBe(true)
      expect(syncRuntime.isSyncing).toBe(false)
    })
  })
})
