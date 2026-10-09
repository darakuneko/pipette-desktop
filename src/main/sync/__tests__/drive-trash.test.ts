// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DriveFile } from '../google-drive'

vi.mock('electron', () => ({ app: { getPath: () => '/mock' } }))

const mockRenameFile = vi.fn(async (_id: string, _name: string): Promise<DriveFile | null> => null)

vi.mock('../google-drive', async () => {
  const actual = await vi.importActual<typeof import('../google-drive')>('../google-drive')
  return { ...actual, renameFile: (id: string, name: string) => mockRenameFile(id, name) }
})

import { syncUnitFromFileName, isDataFileName } from '../google-drive'
import {
  TRASH_QUARANTINE_MS,
  isTrashExpired,
  moveFilesToTrash,
  parseTrashFile,
  trashFileName,
} from '../drive-trash'
import { duplicatedNames, filesNamedWithTrash, namesWithTrash, trashCopiesOf } from '../drive-canonical'
import { syncRuntime } from '../sync-runtime-state'

const MODIFIED = '2026-10-01T00:00:00.000Z'
const MODIFIED_MS = Date.parse(MODIFIED)
const file = (id: string, name: string, modifiedTime = MODIFIED): DriveFile => ({ id, name, modifiedTime })

describe('drive-trash', () => {
  beforeEach(() => {
    mockRenameFile.mockClear()
    syncRuntime.createdFileIds.clear()
  })

  describe('trash names', () => {
    it('round-trips the original name, the rename time and the previous modifiedTime', () => {
      const live = file('Abc_-1', 'favorites_macro.enc')
      const name = trashFileName(live, 1234)

      expect(name).toBe(`favorites_macro.enc.trash.1234.${MODIFIED_MS}.Abc_-1`)
      expect(parseTrashFile({ id: live.id, name: name! })).toEqual({
        originalName: 'favorites_macro.enc',
        renamedAtMs: 1234,
        preModifiedMs: MODIFIED_MS,
      })
    })

    it('maps a trash name to no sync unit, and a live name to no trash file', () => {
      for (const name of [
        'favorites_macro.enc',
        'keyboards_0x1_settings.enc',
        'keyboards_0x1_devices_h1_days_2026-10-01.enc',
        'i18n_packs_p1.enc',
        'key-labels.enc',
      ]) {
        const trashName = trashFileName(file('id1', name), 1)!
        expect(syncUnitFromFileName(trashName)).toBeNull()
        expect(isDataFileName(trashName)).toBe(true)
        expect(parseTrashFile({ id: 'id1', name })).toBeNull()
        expect(parseTrashFile({ id: 'id1', name: trashName })?.originalName).toBe(name)
      }
    })

    it('is not a trash file when the id in the name is not the file\'s own', () => {
      const name = trashFileName(file('id1', 'favorites_macro.enc'), 1)!
      expect(parseTrashFile({ id: 'id2', name })).toBeNull()
    })

    it('is not a trash file when the original name is not a data file with a sync unit', () => {
      expect(parseTrashFile({ id: 'id1', name: 'password-check.enc.trash.1.2.id1' })).toBeNull()
      expect(parseTrashFile({ id: 'id1', name: 'unknown.enc.trash.1.2.id1' })).toBeNull()
      expect(parseTrashFile({ id: 'id1', name: 'favorites_macro.enc.trash.x.2.id1' })).toBeNull()
    })

    it('records 0 for an unparseable modifiedTime and refuses an id the name cannot carry', () => {
      expect(trashFileName(file('id1', 'favorites_macro.enc', 'broken'), 5)).toBe('favorites_macro.enc.trash.5.0.id1')
      expect(trashFileName(file('id.1', 'favorites_macro.enc'), 5)).toBeNull()
    })

    it('expires TRASH_QUARANTINE_MS after the rename', () => {
      const trash = { originalName: 'a.enc', renamedAtMs: 1000, preModifiedMs: 0 }
      expect(isTrashExpired(trash, 1000 + TRASH_QUARANTINE_MS - 1)).toBe(false)
      expect(isTrashExpired(trash, 1000 + TRASH_QUARANTINE_MS)).toBe(true)
    })
  })

  describe('moveFilesToTrash', () => {
    it('renames each file to its trash name and forgets ids this process created', async () => {
      syncRuntime.createdFileIds.set('favorites_macro.enc', 'b')
      syncRuntime.createdFileIds.set('favorites_other.enc', 'z')

      const result = await moveFilesToTrash([file('a', 'favorites_macro.enc'), file('b', 'favorites_macro.enc')], 77)

      expect(result).toEqual({ attempted: 2, failed: 0, firstError: undefined })
      expect(mockRenameFile.mock.calls.sort()).toEqual([
        ['a', `favorites_macro.enc.trash.77.${MODIFIED_MS}.a`],
        ['b', `favorites_macro.enc.trash.77.${MODIFIED_MS}.b`],
      ])
      expect([...syncRuntime.createdFileIds]).toEqual([['favorites_other.enc', 'z']])
    })

    it('reports a failed rename without stopping the others', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      mockRenameFile.mockImplementation(async (id) => {
        if (id === 'a') throw new Error('Drive rename failed: 500')
        return null
      })

      const result = await moveFilesToTrash([file('a', 'favorites_macro.enc'), file('b', 'favorites_macro.enc')], 1)

      expect(result).toEqual({ attempted: 2, failed: 1, firstError: 'Drive rename failed: 500' })
      expect(mockRenameFile).toHaveBeenCalledTimes(2)
      warn.mockRestore()
      mockRenameFile.mockImplementation(async () => null)
    })
  })

  describe('listing index', () => {
    const live1 = file('l1', 'favorites_macro.enc')
    const live2 = file('l2', 'favorites_macro.enc')
    const single = file('s1', 'favorites_tapDance.enc')
    const trashA = file('ta', 'favorites_macro.enc.trash.1.2.ta')
    const trashB = file('tb', 'favorites_tapDance.enc.trash.1.2.tb')
    const forged = file('tf', 'favorites_macro.enc.trash.1.2.zz')
    const listing = [live1, single, trashA, live2, trashB, forged]

    it('groups trash files by original name and lists names with duplicates', () => {
      expect(duplicatedNames(listing)).toEqual(['favorites_macro.enc'])
      expect(namesWithTrash(listing)).toEqual(['favorites_macro.enc', 'favorites_tapDance.enc'])
      expect(trashCopiesOf(listing, 'favorites_macro.enc').map((c) => c.file.id)).toEqual(['ta'])
      expect(trashCopiesOf(listing, 'favorites_none.enc')).toEqual([])
      expect(filesNamedWithTrash(listing, 'favorites_macro.enc').map((f) => f.id)).toEqual(['l1', 'l2', 'ta'])
    })
  })
})
