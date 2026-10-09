// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/mock' } }))
vi.mock('../../logger', () => ({ log: vi.fn() }))
vi.mock('../../app-config', () => ({ loadAppConfig: () => ({}), getAppConfigStore: () => ({ get: () => undefined }) }))
vi.mock('../../typing-analytics/machine-hash', () => ({ getMachineHash: async () => 'hash-own' }))

const mockRequireSyncCredentials = vi.fn(async (): Promise<{ ok: true; password: string } | { ok: false; reason: string }> => ({ ok: true, password: 'pw' }))
vi.mock('../sync-password', () => ({
  requireSyncCredentials: () => mockRequireSyncCredentials(),
  SyncCredentialError: class SyncCredentialError extends Error {
    constructor(reason: string, namespace: string) {
      super(`sync.${namespace}.${reason}`)
    }
  },
}))

const drive = vi.hoisted(() => ({
  files: new Map<string, { id: string; name: string; modifiedTime: string }>(),
  lists: 0,
  /** Called before a listing is served. */
  beforeList: null as null | (() => void),
  /** Called before a rename is applied; throw to fail it. */
  beforeRename: null as null | ((id: string, name: string) => void),
  renames: [] as Array<[string, string]>,
  deletes: [] as string[],
}))

vi.mock('../google-drive', async () => {
  const actual = await vi.importActual<typeof import('../google-drive')>('../google-drive')
  return {
    ...actual,
    listFiles: async () => {
      drive.lists++
      drive.beforeList?.()
      return [...drive.files.values()].map((f) => ({ ...f }))
    },
    renameFile: async (id: string, name: string) => {
      drive.beforeRename?.(id, name)
      drive.renames.push([id, name])
      const file = drive.files.get(id)
      if (!file) return null
      file.name = name
      return { ...file }
    },
    deleteFilesById: async (ids: readonly string[]) => {
      for (const id of ids) {
        drive.deletes.push(id)
        drive.files.delete(id)
      }
      return { attempted: ids.length, failed: 0 }
    },
  }
})

const mockAssertSyncAllowed = vi.fn(async (..._args: unknown[]): Promise<void> => {})
const mockAssertNoLocalPasswordChange = vi.fn(async (): Promise<void> => {})
vi.mock('../sync-password-guard', () => ({
  assertSyncAllowed: (...args: unknown[]) => mockAssertSyncAllowed(...args),
  assertNoLocalPasswordChange: () => mockAssertNoLocalPasswordChange(),
}))
vi.mock('../sync-format', () => ({ syncFormatGeneration: () => 0 }))

import {
  deleteTrashFiles,
  listTrashFiles,
  restoreTrashFile,
  trashFileKeyboards,
  TRASH_NOT_FOUND_MESSAGE,
  TRASH_NOT_RESTORABLE_MESSAGE,
} from '../sync-trash-manual'
import { TRASH_QUARANTINE_MS, trashFileName } from '../drive-trash'
import { syncRuntime } from '../sync-runtime-state'

const NAME = 'favorites_macro.enc'
const T1 = '2026-10-01T00:00:00.000Z'
const T2 = '2026-10-02T00:00:00.000Z'
const OWN_DAY = 'keyboards_uid1_devices_hash-own_days_2026-10-01.enc'
const SETTINGS = 'keyboards_uid1_settings.enc'

function add(id: string, name: string, modifiedTime = T1): void {
  drive.files.set(id, { id, name, modifiedTime })
}

function addTrash(id: string, name: string, renamedAtMs: number, modifiedTime = T1): void {
  add(id, trashFileName({ id, name, modifiedTime }, renamedAtMs)!, modifiedTime)
}

function names(): Record<string, string> {
  return Object.fromEntries([...drive.files.values()].map((f) => [f.id, f.name]))
}

describe('sync-trash-manual', () => {
  beforeEach(() => {
    drive.files.clear()
    drive.lists = 0
    drive.beforeList = null
    drive.beforeRename = null
    drive.renames = []
    drive.deletes = []
    mockAssertSyncAllowed.mockReset().mockResolvedValue(undefined)
    mockAssertNoLocalPasswordChange.mockReset().mockResolvedValue(undefined)
    mockRequireSyncCredentials.mockReset().mockResolvedValue({ ok: true, password: 'pw' })
    syncRuntime.resetKeyboards = null
  })

  describe('listTrashFiles', () => {
    it('lists trash files from one listing, the most recently moved first', async () => {
      add('live', NAME)
      addTrash('older', NAME, 1000, T1)
      addTrash('newer', 'keyboards_uid1_settings.enc', 2000, T2)
      add('junk', `${NAME}.trash.1.2.someone-else`)

      await expect(listTrashFiles()).resolves.toEqual([
        { fileId: 'newer', originalName: 'keyboards_uid1_settings.enc', syncUnit: 'keyboards/uid1/settings', updatedAt: Date.parse(T2), expiresAt: 2000 + TRASH_QUARANTINE_MS, restorable: true },
        { fileId: 'older', originalName: NAME, syncUnit: 'favorites/macro', updatedAt: Date.parse(T1), expiresAt: 1000 + TRASH_QUARANTINE_MS, restorable: true },
      ])
      expect(drive.lists).toBe(1)
      expect(mockAssertSyncAllowed).toHaveBeenCalledWith(expect.any(Array), 0)
    })

    it('marks this machine\'s own typing days as not restorable', async () => {
      addTrash('own', OWN_DAY, 1000)
      addTrash('other', 'keyboards_uid1_devices_hash-other_days_2026-10-01.enc', 1000)

      const files = await listTrashFiles()

      expect(Object.fromEntries(files.map((f) => [f.fileId, f.restorable]))).toEqual({ own: false, other: true })
    })

    it('is refused with a readiness key without credentials, before listing Drive', async () => {
      mockRequireSyncCredentials.mockResolvedValue({ ok: false, reason: 'unauthenticated' })

      await expect(listTrashFiles()).rejects.toThrow('sync.readiness.unauthenticated')
      await expect(restoreTrashFile('x')).rejects.toThrow('sync.readiness.unauthenticated')
      await expect(deleteTrashFiles(['x'])).rejects.toThrow('sync.readiness.unauthenticated')
      await expect(trashFileKeyboards(['x'])).rejects.toThrow('sync.readiness.unauthenticated')
      expect(drive.lists).toBe(0)
    })

    it('is refused by the sync guards', async () => {
      mockAssertNoLocalPasswordChange.mockRejectedValueOnce(new Error('sync.passwordChange.blockedLocal'))
      await expect(listTrashFiles()).rejects.toThrow('sync.passwordChange.blockedLocal')
      expect(drive.lists).toBe(0)

      mockAssertSyncAllowed.mockRejectedValueOnce(new Error('sync.updateRequired'))
      await expect(listTrashFiles()).rejects.toThrow('sync.updateRequired')
    })
  })

  describe('restoreTrashFile', () => {
    it('swaps: moves every current copy to trash, then renames the chosen trash back', async () => {
      add('live1', NAME, T2)
      add('live2', NAME, T1)
      addTrash('pick', NAME, 1000)

      await restoreTrashFile('pick')

      expect(names().pick).toBe(NAME)
      expect(names().live1).toMatch(new RegExp(`^${NAME}\\.trash\\.\\d+\\.${Date.parse(T2)}\\.live1$`))
      expect(names().live2).toMatch(/\.trash\./)
      expect(drive.renames.at(-1)).toEqual(['pick', NAME])
    })

    it('restores a name that has no current copy', async () => {
      addTrash('pick', NAME, 1000)

      await restoreTrashFile('pick')

      expect(names()).toEqual({ pick: NAME })
    })

    it('is refused when the file is no longer a trash file', async () => {
      // The poll renamed it back after the screen listed it.
      add('pick', NAME)

      await expect(restoreTrashFile('pick')).rejects.toThrow(TRASH_NOT_FOUND_MESSAGE)
      await expect(restoreTrashFile('gone')).rejects.toThrow(TRASH_NOT_FOUND_MESSAGE)
      expect(drive.renames).toEqual([])
    })

    it('stops before renaming back when a current copy cannot be moved', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      add('live', NAME)
      addTrash('pick', NAME, 1000)
      drive.beforeRename = (id) => {
        if (id === 'live') throw new Error('Drive rename failed: 500')
      }

      await expect(restoreTrashFile('pick')).rejects.toThrow('Failed to move 1 of 1 files to trash')
      expect(names().live).toBe(NAME)
      expect(drive.renames.filter(([id]) => id === 'pick')).toEqual([])
      expect(names().pick).toMatch(/\.trash\./)
      warn.mockRestore()
    })

    it('refuses this machine\'s own typing day', async () => {
      syncRuntime.resetKeyboards = new Set(['uid1'])
      addTrash('own', OWN_DAY, 1000)

      await expect(restoreTrashFile('own')).rejects.toThrow(TRASH_NOT_RESTORABLE_MESSAGE)
      expect(drive.renames).toEqual([])
    })

    it('refuses a keyboard file the held reset lock does not cover', async () => {
      add('live', SETTINGS)
      addTrash('pick', SETTINGS, 1000)

      await expect(restoreTrashFile('pick')).rejects.toThrow('sync.trashBusy')
      expect(drive.renames).toEqual([])

      syncRuntime.resetKeyboards = new Set(['uid1'])
      await restoreTrashFile('pick')
      expect(names().pick).toBe(SETTINGS)
    })

    it('renames the moved copies back when the final rename fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      add('live', NAME)
      addTrash('pick', NAME, 1000)
      drive.beforeRename = (id, name) => {
        if (id === 'pick' && name === NAME) throw new Error('Drive rename failed: 500')
      }

      await expect(restoreTrashFile('pick')).rejects.toThrow('Drive rename failed: 500')

      expect(names().live).toBe(NAME)
      expect(names().pick).toMatch(/\.trash\./)
      warn.mockRestore()
    })

    it('renames the moved copies back when the file vanished before the final rename', async () => {
      add('live', NAME)
      addTrash('pick', NAME, 1000)
      drive.beforeRename = (id, name) => {
        if (id === 'pick' && name === NAME) drive.files.delete('pick')
      }

      await expect(restoreTrashFile('pick')).rejects.toThrow(TRASH_NOT_FOUND_MESSAGE)
      expect(names()).toEqual({ live: NAME })
    })

    it('is refused by the sync guards before anything is renamed', async () => {
      addTrash('pick', NAME, 1000)
      mockAssertSyncAllowed.mockRejectedValueOnce(new Error('sync.blockedByOtherDevice'))

      await expect(restoreTrashFile('pick')).rejects.toThrow('sync.blockedByOtherDevice')
      expect(drive.renames).toEqual([])
    })
  })

  describe('deleteTrashFiles', () => {
    it('deletes only ids that are still trash files, and skips the rest', async () => {
      add('live', NAME)
      addTrash('t1', NAME, 1000)
      // Listed as trash on the screen, then renamed back by the poll.
      add('restored', NAME)

      await expect(deleteTrashFiles(['t1', 'restored', 'gone'])).resolves.toEqual({
        deleted: ['t1'],
        skipped: ['restored', 'gone'],
      })
      expect(drive.deletes).toEqual(['t1'])
      expect(names()).toEqual({ live: NAME, restored: NAME })
    })

    it('skips keyboard files the held reset lock does not cover', async () => {
      addTrash('kb', SETTINGS, 1000)
      addTrash('fav', NAME, 1000)

      await expect(deleteTrashFiles(['kb', 'fav'])).resolves.toEqual({ deleted: ['fav'], skipped: ['kb'] })
    })

    it('lists Drive again inside the call, so a rename after the screen loaded is seen', async () => {
      addTrash('t1', NAME, 1000)
      drive.beforeList = () => {
        drive.files.get('t1')!.name = NAME
      }

      await expect(deleteTrashFiles(['t1'])).resolves.toEqual({ deleted: [], skipped: ['t1'] })
      expect(drive.deletes).toEqual([])
    })

    it('is refused by the sync guards before anything is deleted', async () => {
      addTrash('t1', NAME, 1000)
      mockAssertSyncAllowed.mockRejectedValueOnce(new Error('sync.updateRequired'))

      await expect(deleteTrashFiles(['t1'])).rejects.toThrow('sync.updateRequired')
      expect(drive.deletes).toEqual([])
    })
  })

  describe('trashFileKeyboards', () => {
    it('returns the keyboards of the given trash files, and nothing for global units or other ids', async () => {
      addTrash('kb1', SETTINGS, 1000)
      addTrash('kb2', 'keyboards_uid2_snapshots.enc', 1000)
      addTrash('fav', NAME, 1000)
      add('live', 'keyboards_uid3_settings.enc')

      expect((await trashFileKeyboards(['kb1', 'kb2', 'fav', 'live'])).sort()).toEqual(['uid1', 'uid2'])
      expect(await trashFileKeyboards(['fav'])).toEqual([])
    })
  })
})
