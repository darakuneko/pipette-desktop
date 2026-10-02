// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DriveFile } from '../google-drive'

const mockListFiles = vi.fn(async (..._args: unknown[]): Promise<DriveFile[]> => [])
const mockCreateRawFile = vi.fn(async (_name: string, _content: string): Promise<{ id: string }> => ({ id: 'own' }))
const mockDownloadRawFile = vi.fn(async (_fileId: string): Promise<string> => '')
const mockDeleteFile = vi.fn(async (_fileId: string): Promise<void> => {})

vi.mock('../google-drive', async () => ({
  ...(await vi.importActual<typeof import('../google-drive')>('../google-drive')),
  listFiles: (...args: unknown[]) => mockListFiles(...args),
  createRawFile: (...args: unknown[]) => mockCreateRawFile(...(args as [string, string])),
  downloadRawFile: (...args: unknown[]) => mockDownloadRawFile(...(args as [string])),
  deleteFile: (...args: unknown[]) => mockDeleteFile(...(args as [string])),
}))

import { PASSWORD_CHANGE_LOCK_FILE } from '../google-drive'
import {
  parsePasswordChangeLock,
  acquirePasswordChangeLock,
  findOwnPasswordChangeLock,
  isPasswordChangeLockHeld,
  lockTiming,
  releasePasswordChangeLock,
  readPasswordChangeLockInfo,
} from '../sync-password-lock'

const OWN = { lockId: 'lock-own', machineHash: 'hash-own', startedAt: '2026-10-02T10:00:00.000Z' }

function lockFile(id: string, createdTime?: string): DriveFile {
  return { id, name: PASSWORD_CHANGE_LOCK_FILE, modifiedTime: createdTime ?? 'm', createdTime }
}

function lockText(lockId: string, machineHash = 'hash-other', startedAt = '2026-10-02T09:00:00.000Z'): string {
  return JSON.stringify({ type: 'password-change-lock', version: 1, lockId, machineHash, startedAt })
}

const DATA_FILE: DriveFile = { id: 'd1', name: 'favorites_macro.enc', modifiedTime: 'm' }

describe('sync-password-lock', () => {
  // Settle waits are recorded instead of slept so tests run instantly.
  let sleeps: number[]
  beforeEach(() => {
    sleeps = []
    vi.spyOn(lockTiming, 'sleep').mockImplementation(async (ms: number) => {
      sleeps.push(ms)
    })
    mockListFiles.mockReset()
    mockCreateRawFile.mockReset()
    mockCreateRawFile.mockResolvedValue({ id: 'own' })
    mockDownloadRawFile.mockReset()
    mockDeleteFile.mockReset()
    mockDeleteFile.mockResolvedValue(undefined)
  })

  describe('parsePasswordChangeLock', () => {
    const valid = {
      type: 'password-change-lock',
      version: 1,
      lockId: 'a',
      machineHash: 'h',
      startedAt: '2026-10-02T09:00:00.000Z',
    }
    const { machineHash: _omitted, ...withoutMachineHash } = valid

    it('accepts a well-formed lock', () => {
      expect(parsePasswordChangeLock(JSON.stringify(valid))).toEqual(valid)
    })

    it.each([
      ['not json', 'nope'],
      ['null', 'null'],
      ['an array', '[]'],
      ['wrong type', JSON.stringify({ ...valid, type: 'other' })],
      ['wrong version', JSON.stringify({ ...valid, version: 2 })],
      ['empty lockId', JSON.stringify({ ...valid, lockId: '' })],
      ['missing machineHash', JSON.stringify(withoutMachineHash)],
      ['unparseable startedAt', JSON.stringify({ ...valid, startedAt: 'yesterday' })],
      ['numeric startedAt', JSON.stringify({ ...valid, startedAt: 1 })],
    ])('rejects %s', (_label, text) => {
      expect(parsePasswordChangeLock(text)).toBeNull()
    })
  })

  describe('acquirePasswordChangeLock', () => {
    const T_OWN = '2026-10-02T10:00:01.000Z'
    const T_EARLIER = '2026-10-02T10:00:00.500Z'
    const T_LATER = '2026-10-02T10:00:02.000Z'
    const noop = { onCreated: async () => {} }

    /** Listings returned in order; the last one repeats. */
    function stubListings(...listings: DriveFile[][]): void {
      let i = 0
      mockListFiles.mockImplementation(async () => listings[Math.min(i++, listings.length - 1)])
    }

    it('creates the lock, settles and wins when it is the only lock', async () => {
      stubListings([DATA_FILE], [DATA_FILE, lockFile('own', T_OWN)])

      const result = await acquirePasswordChangeLock(OWN, noop)

      expect(result).toEqual({ ok: true, fileId: 'own' })
      expect(mockCreateRawFile).toHaveBeenCalledWith(
        PASSWORD_CHANGE_LOCK_FILE,
        JSON.stringify({ type: 'password-change-lock', version: 1, ...OWN }),
      )
      // initial list, re-list, settle re-list
      expect(mockListFiles).toHaveBeenCalledTimes(3)
      expect(sleeps).toEqual([2000])
      expect(mockDeleteFile).not.toHaveBeenCalled()
    })

    it('hands the new file id to onCreated before re-listing', async () => {
      const order: string[] = []
      let calls = 0
      mockListFiles.mockImplementation(async () => {
        order.push(calls === 0 ? 'list' : 'relist')
        return calls++ === 0 ? [] : [lockFile('own', T_OWN)]
      })
      const onCreated = vi.fn(async (fileId: string) => {
        order.push(`created:${fileId}`)
      })

      await acquirePasswordChangeLock(OWN, { onCreated })

      expect(order.slice(0, 3)).toEqual(['list', 'created:own', 'relist'])
    })

    it('returns locked without creating when a lock already exists', async () => {
      stubListings([
        DATA_FILE,
        lockFile('later', '2026-10-02T09:30:00.000Z'),
        lockFile('earliest', '2026-10-02T09:00:00.000Z'),
      ])
      mockDownloadRawFile.mockResolvedValueOnce(lockText('other', 'hash-x', '2026-10-02T08:59:00.000Z'))

      const result = await acquirePasswordChangeLock(OWN, noop)

      expect(result).toEqual({
        ok: false,
        reason: 'locked',
        holder: { machineHash: 'hash-x', startedAt: '2026-10-02T08:59:00.000Z' },
      })
      expect(mockDownloadRawFile).toHaveBeenCalledWith('earliest')
      expect(mockCreateRawFile).not.toHaveBeenCalled()
    })

    it('returns locked with a null holder when the existing lock is unreadable', async () => {
      stubListings([lockFile('other', '2026-10-02T09:00:00.000Z')])
      mockDownloadRawFile.mockResolvedValueOnce('garbage')

      const result = await acquirePasswordChangeLock(OWN, noop)

      expect(result).toEqual({ ok: false, reason: 'locked', holder: null })
      expect(mockCreateRawFile).not.toHaveBeenCalled()
    })

    it('loses to an earlier lock and deletes only its own file', async () => {
      stubListings([], [lockFile('own', T_OWN), lockFile('other', T_EARLIER)])

      const result = await acquirePasswordChangeLock(OWN, noop)

      expect(result).toEqual({ ok: false, reason: 'lost' })
      expect(mockDeleteFile).toHaveBeenCalledOnce()
      expect(mockDeleteFile).toHaveBeenCalledWith('own')
    })

    it('returns lost even when deleting its own lock fails', async () => {
      stubListings([], [lockFile('own', T_OWN), lockFile('other', T_EARLIER)])
      mockDeleteFile.mockRejectedValueOnce(new Error('delete failed'))

      await expect(acquirePasswordChangeLock(OWN, noop)).resolves.toEqual({ ok: false, reason: 'lost' })
    })

    it('wins over a later lock and leaves it alone', async () => {
      stubListings([], [lockFile('other', T_LATER), lockFile('own', T_OWN)])

      await expect(acquirePasswordChangeLock(OWN, noop)).resolves.toEqual({ ok: true, fileId: 'own' })
      expect(mockDeleteFile).not.toHaveBeenCalled()
    })

    it('loses when the settle re-list reveals an earlier peer lock', async () => {
      stubListings([], [lockFile('own', T_OWN)], [lockFile('own', T_OWN), lockFile('other', T_EARLIER)])

      await expect(acquirePasswordChangeLock(OWN, noop)).resolves.toEqual({ ok: false, reason: 'lost' })
      expect(mockDeleteFile).toHaveBeenCalledWith('own')
      expect(mockDeleteFile).not.toHaveBeenCalledWith('other')
    })

    it('breaks a createdTime tie by the smallest file id', async () => {
      mockCreateRawFile.mockResolvedValue({ id: 'b-own' })
      stubListings([], [lockFile('b-own', T_OWN), lockFile('a-other', T_OWN)])

      await expect(acquirePasswordChangeLock(OWN, noop)).resolves.toEqual({ ok: false, reason: 'lost' })
      expect(mockDeleteFile).toHaveBeenCalledWith('b-own')
    })

    it('wins a createdTime tie when its id is the smallest', async () => {
      mockCreateRawFile.mockResolvedValue({ id: 'a-own' })
      stubListings([], [lockFile('b-other', T_OWN), lockFile('a-own', T_OWN)])

      await expect(acquirePasswordChangeLock(OWN, noop)).resolves.toEqual({ ok: true, fileId: 'a-own' })
    })

    it('sorts a lock without createdTime after every timed lock', async () => {
      stubListings([], [lockFile('a-untimed'), lockFile('own', T_OWN)])

      await expect(acquirePasswordChangeLock(OWN, noop)).resolves.toEqual({ ok: true, fileId: 'own' })
    })

    it('re-lists with backoff until its own lock becomes visible', async () => {
      stubListings([], [], [lockFile('own', T_OWN)])

      await expect(acquirePasswordChangeLock(OWN, noop)).resolves.toEqual({ ok: true, fileId: 'own' })
      expect(sleeps).toEqual([1000, 2000])
    })

    it('loses when its own lock never appears in the re-list', async () => {
      stubListings([], [lockFile('other', T_LATER)])

      await expect(acquirePasswordChangeLock(OWN, noop)).resolves.toEqual({ ok: false, reason: 'lost' })
      expect(sleeps).toEqual([1000, 2000, 4000])
      expect(mockDeleteFile).toHaveBeenCalledOnce()
      expect(mockDeleteFile).toHaveBeenCalledWith('own')
    })

    it('deletes its own lock and rethrows when the re-list fails', async () => {
      mockListFiles
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('Drive list failed: 500 boom'))

      await expect(acquirePasswordChangeLock(OWN, noop)).rejects.toThrow('Drive list failed: 500 boom')
      expect(mockDeleteFile).toHaveBeenCalledOnce()
      expect(mockDeleteFile).toHaveBeenCalledWith('own')
    })

    it('rethrows the re-list error even when deleting its own lock also fails', async () => {
      mockListFiles
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error('relist failed'))
      mockDeleteFile.mockRejectedValueOnce(new Error('delete failed'))

      await expect(acquirePasswordChangeLock(OWN, noop)).rejects.toThrow('relist failed')
    })

    it('deletes its own lock and rethrows when onCreated fails', async () => {
      stubListings([])
      const onCreated = vi.fn(async () => {
        throw new Error('state write failed')
      })

      await expect(acquirePasswordChangeLock(OWN, { onCreated })).rejects.toThrow('state write failed')
      expect(mockDeleteFile).toHaveBeenCalledWith('own')
      expect(mockListFiles).toHaveBeenCalledOnce()
    })

    it('finds and deletes its own lock by lockId when the create response is lost', async () => {
      stubListings([], [lockFile('created-anyway', T_OWN)])
      mockCreateRawFile.mockRejectedValueOnce(new Error('Drive upload failed: 503 boom'))
      mockDownloadRawFile.mockResolvedValueOnce(lockText('lock-own', 'hash-own'))
      const onCreated = vi.fn(async () => {})

      await expect(acquirePasswordChangeLock(OWN, { onCreated })).rejects.toThrow('Drive upload failed: 503 boom')
      expect(mockDeleteFile).toHaveBeenCalledOnce()
      expect(mockDeleteFile).toHaveBeenCalledWith('created-anyway')
      expect(onCreated).not.toHaveBeenCalled()
    })

    it('rethrows the create error when the lost-response cleanup also fails', async () => {
      mockListFiles.mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('offline'))
      mockCreateRawFile.mockRejectedValueOnce(new TypeError('fetch failed'))

      await expect(acquirePasswordChangeLock(OWN, noop)).rejects.toThrow('fetch failed')
      expect(mockDeleteFile).not.toHaveBeenCalled()
    })

    it('propagates a failed first listing without creating a lock', async () => {
      mockListFiles.mockRejectedValueOnce(new Error('offline'))

      await expect(acquirePasswordChangeLock(OWN, noop)).rejects.toThrow('offline')
      expect(mockCreateRawFile).not.toHaveBeenCalled()
    })
  })

  describe('findOwnPasswordChangeLock', () => {
    it('returns the file id whose content carries the lockId', async () => {
      mockListFiles.mockResolvedValueOnce([
        DATA_FILE,
        lockFile('other', '2026-10-02T09:00:00.000Z'),
        lockFile('broken', '2026-10-02T09:10:00.000Z'),
        lockFile('mine', '2026-10-02T10:00:00.000Z'),
      ])
      mockDownloadRawFile.mockImplementation(async (fileId: string) => {
        if (fileId === 'other') return lockText('lock-other')
        if (fileId === 'broken') return '{'
        return lockText('lock-own', 'hash-own')
      })

      await expect(findOwnPasswordChangeLock('lock-own')).resolves.toBe('mine')
      expect(mockDownloadRawFile).not.toHaveBeenCalledWith('d1')
    })

    it('returns null when no lock carries the lockId', async () => {
      mockListFiles.mockResolvedValueOnce([lockFile('other', '2026-10-02T09:00:00.000Z')])
      mockDownloadRawFile.mockResolvedValueOnce(lockText('lock-other'))

      await expect(findOwnPasswordChangeLock('lock-own')).resolves.toBeNull()
    })

    it('propagates a download failure instead of reporting no lock', async () => {
      mockListFiles.mockResolvedValueOnce([lockFile('mine', '2026-10-02T09:00:00.000Z')])
      mockDownloadRawFile.mockRejectedValueOnce(new Error('Drive download failed: 500 boom'))

      await expect(findOwnPasswordChangeLock('lock-own')).rejects.toThrow('Drive download failed: 500 boom')
    })
  })

  describe('isPasswordChangeLockHeld', () => {
    it('is true while its lock is listed and is the earliest', async () => {
      mockListFiles.mockResolvedValueOnce([DATA_FILE, lockFile('mine', '2026-10-02T10:00:00.000Z')])
      await expect(isPasswordChangeLockHeld('mine')).resolves.toBe(true)

      mockListFiles.mockResolvedValueOnce([
        lockFile('later', '2026-10-02T10:00:05.000Z'),
        lockFile('mine', '2026-10-02T10:00:00.000Z'),
      ])
      await expect(isPasswordChangeLockHeld('mine')).resolves.toBe(true)
    })

    it('is false once its lock is gone', async () => {
      mockListFiles.mockResolvedValueOnce([DATA_FILE, lockFile('other', '2026-10-02T10:00:00.000Z')])
      await expect(isPasswordChangeLockHeld('mine')).resolves.toBe(false)
    })

    it('is false when an earlier lock exists', async () => {
      mockListFiles.mockResolvedValueOnce([
        lockFile('mine', '2026-10-02T10:00:00.000Z'),
        lockFile('earlier', '2026-10-02T09:59:59.000Z'),
      ])
      await expect(isPasswordChangeLockHeld('mine')).resolves.toBe(false)
    })

    it('ignores a non-lock file that happens to have the id', async () => {
      mockListFiles.mockResolvedValueOnce([{ ...DATA_FILE, id: 'mine' }])
      await expect(isPasswordChangeLockHeld('mine')).resolves.toBe(false)
    })
  })

  describe('releasePasswordChangeLock', () => {
    it('deletes the lock by file id', async () => {
      await releasePasswordChangeLock('mine')
      expect(mockDeleteFile).toHaveBeenCalledWith('mine')
    })
  })

  describe('readPasswordChangeLockInfo', () => {
    it('returns the holder machine and start time', async () => {
      mockDownloadRawFile.mockResolvedValueOnce(lockText('lock-other', 'hash-x', '2026-10-02T08:00:00.000Z'))

      await expect(readPasswordChangeLockInfo(lockFile('other', 't'))).resolves.toEqual({
        machineHash: 'hash-x',
        startedAt: '2026-10-02T08:00:00.000Z',
      })
    })

    it('returns null for invalid content or a failed download', async () => {
      mockDownloadRawFile.mockResolvedValueOnce(JSON.stringify({ type: 'password-change-lock', version: 1 }))
      await expect(readPasswordChangeLockInfo(lockFile('other', 't'))).resolves.toBeNull()

      mockDownloadRawFile.mockRejectedValueOnce(new Error('offline'))
      await expect(readPasswordChangeLockInfo(lockFile('other', 't'))).resolves.toBeNull()
    })
  })
})
