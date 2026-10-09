// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DriveFile } from '../google-drive'

vi.mock('electron', () => ({ app: { getPath: () => '/mock' } }))
vi.mock('../../logger', () => ({ log: vi.fn() }))
vi.mock('../../app-config', () => ({ loadAppConfig: () => ({}), getAppConfigStore: () => ({ get: () => undefined }) }))

/** In-memory Drive: id → file. Renames and deletes change it the way Drive
 *  would, so a test can run several passes on fresh listings. */
const drive = vi.hoisted(() => ({
  files: new Map<string, { id: string; name: string; modifiedTime: string }>(),
  beforeRename: null as null | ((id: string) => void),
  renames: [] as Array<[string, string]>,
  deletes: [] as string[],
  lists: 0,
}))

vi.mock('../google-drive', async () => {
  const actual = await vi.importActual<typeof import('../google-drive')>('../google-drive')
  return {
    ...actual,
    listFiles: async (options?: { nameContains?: string }) => {
      drive.lists++
      return [...drive.files.values()]
        .filter((f) => !options?.nameContains || f.name.includes(options.nameContains))
        .map((f) => ({ ...f }))
    },
    renameFile: async (id: string, name: string) => {
      drive.beforeRename?.(id)
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

import { tidyDuplicateCopies, TRASH_NAMES_PER_PASS, type TrashTidyContext } from '../sync-trash'
import { TRASH_QUARANTINE_MS, trashFileName } from '../drive-trash'
import { syncRuntime } from '../sync-runtime-state'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 9, 9)
const OWN = 'hash-own'

function add(id: string, name: string, modifiedTime = '2026-10-01T00:00:00.000Z'): void {
  drive.files.set(id, { id, name, modifiedTime })
}

/** Adds a trash file of `name` renamed at `renamedAtMs`. */
function addTrash(id: string, name: string, renamedAtMs: number, modifiedTime = '2026-10-01T00:00:00.000Z'): void {
  add(id, trashFileName({ id, name, modifiedTime }, renamedAtMs)!, modifiedTime)
}

function listing(): DriveFile[] {
  return [...drive.files.values()].map((f) => ({ ...f }))
}

function names(): Record<string, string> {
  return Object.fromEntries([...drive.files.values()].map((f) => [f.id, f.name]))
}

function ctx(overrides: Partial<TrashTidyContext> = {}): TrashTidyContext {
  return { localKeyboardUids: new Set(['uid1']), ownHash: OWN, nowMs: NOW, ...overrides }
}

describe('sync-trash', () => {
  beforeEach(() => {
    drive.files.clear()
    drive.renames = []
    drive.deletes = []
    drive.beforeRename = null
    drive.lists = 0
    syncRuntime.isQuitting = false
    syncRuntime.createdFileIds.clear()
    syncRuntime.analyticsSyncingUids.clear()
  })

  describe('duplicate copies', () => {
    it('renames every copy except the chosen one, without touching the content', async () => {
      add('old', 'favorites_macro.enc', '2026-10-01T00:00:00.000Z')
      add('new', 'favorites_macro.enc', '2026-10-03T00:00:00.000Z')
      add('mid', 'favorites_macro.enc', '2026-10-02T00:00:00.000Z')
      syncRuntime.createdFileIds.set('favorites_macro.enc', 'mid')

      await tidyDuplicateCopies(listing(), ctx())

      expect(names()).toEqual({
        old: `favorites_macro.enc.trash.${NOW}.${Date.parse('2026-10-01T00:00:00.000Z')}.old`,
        new: 'favorites_macro.enc',
        mid: `favorites_macro.enc.trash.${NOW}.${Date.parse('2026-10-02T00:00:00.000Z')}.mid`,
      })
      expect(syncRuntime.createdFileIds.has('favorites_macro.enc')).toBe(false)
    })

    it('leaves a single copy alone', async () => {
      add('a', 'favorites_macro.enc')

      await tidyDuplicateCopies(listing(), ctx())

      expect(drive.renames).toEqual([])
    })
  })

  describe('expired trash', () => {
    it('deletes trash renamed 30 days ago or more while the name has a copy', async () => {
      add('live', 'favorites_macro.enc')
      addTrash('old', 'favorites_macro.enc', NOW - TRASH_QUARANTINE_MS)
      addTrash('young', 'favorites_macro.enc', NOW - TRASH_QUARANTINE_MS + 1)

      await tidyDuplicateCopies(listing(), ctx())

      expect(drive.deletes).toEqual(['old'])
      expect(drive.files.has('young')).toBe(true)
      expect(drive.renames).toEqual([])
    })

    it('never deletes the last copy: expired trash with no copy is renamed back', async () => {
      addTrash('old', 'favorites_macro.enc', NOW - 40 * DAY)

      await tidyDuplicateCopies(listing(), ctx())

      expect(drive.deletes).toEqual([])
      expect(names()).toEqual({ old: 'favorites_macro.enc' })
    })
  })

  describe('names with no copy', () => {
    it('renames the trash with the newest content back to the name', async () => {
      addTrash('older', 'favorites_macro.enc', NOW - DAY, '2026-10-01T00:00:00.000Z')
      addTrash('newer', 'favorites_macro.enc', NOW - 2 * DAY, '2026-10-02T00:00:00.000Z')

      await tidyDuplicateCopies(listing(), ctx())

      expect(drive.renames).toEqual([['newer', 'favorites_macro.enc']])
      expect(drive.files.get('older')?.name).toMatch(/\.trash\./)
    })

    it('does not rename this machine\'s own typing day back', async () => {
      const day = `keyboards_uid1_devices_${OWN}_days_2026-10-01.enc`
      addTrash('t', day, NOW - DAY)

      await tidyDuplicateCopies(listing(), ctx())

      expect(drive.renames).toEqual([])
    })

    it('two machines that each renamed the other\'s copy away converge on one copy', async () => {
      // Machine A keeps `a`, machine B keeps `b`, from listings taken a
      // moment apart: both copies end up as trash.
      addTrash('a', 'favorites_macro.enc', NOW, '2026-10-02T00:00:00.000Z')
      addTrash('b', 'favorites_macro.enc', NOW, '2026-10-01T00:00:00.000Z')

      await tidyDuplicateCopies(listing(), ctx())
      await tidyDuplicateCopies(listing(), ctx())

      expect(names()).toEqual({ a: 'favorites_macro.enc', b: expect.stringMatching(/\.trash\./) })
    })
  })

  describe('concurrency and resume', () => {
    it('an expired-trash delete meeting another machine renaming the live copy away keeps the trash', async () => {
      add('live', 'favorites_macro.enc', '2026-10-02T00:00:00.000Z')
      addTrash('expired', 'favorites_macro.enc', NOW - 31 * DAY)
      const first = listing()
      // Another machine renames the only copy away right after our listing.
      drive.files.get('live')!.name = trashFileName(drive.files.get('live')!, NOW)!

      await tidyDuplicateCopies(first, ctx())
      expect(drive.deletes).toEqual([])

      await tidyDuplicateCopies(listing(), ctx())
      expect(names().live).toBe('favorites_macro.enc')
      expect(drive.files.has('expired')).toBe(true)
    })

    it('does not delete a trash file another machine renamed back after our listing', async () => {
      add('live', 'favorites_macro.enc')
      addTrash('expired', 'favorites_macro.enc', NOW - 31 * DAY)
      const first = listing()
      // Another machine moves `live` away and renames `expired` back.
      drive.files.get('live')!.name = trashFileName(drive.files.get('live')!, NOW)!
      drive.files.get('expired')!.name = 'favorites_macro.enc'

      await tidyDuplicateCopies(first, ctx())

      expect(drive.deletes).toEqual([])
      expect(names().expired).toBe('favorites_macro.enc')
    })

    it('lists Drive by name only when there is expired trash to delete', async () => {
      add('live', 'favorites_macro.enc')
      addTrash('young', 'favorites_macro.enc', NOW - DAY)

      await tidyDuplicateCopies(listing(), ctx())

      expect(drive.lists).toBe(0)
    })

    it('a pass interrupted after some renames finishes on the next pass without renaming twice', async () => {
      add('keep', 'favorites_macro.enc', '2026-10-03T00:00:00.000Z')
      add('d1', 'favorites_macro.enc', '2026-10-01T00:00:00.000Z')
      add('d2', 'favorites_macro.enc', '2026-10-02T00:00:00.000Z')
      drive.beforeRename = (id) => {
        if (id === 'd2') throw new Error('Drive rename failed: 503')
      }
      await tidyDuplicateCopies(listing(), ctx())
      expect(drive.files.get('d1')?.name).toMatch(/\.trash\./)
      expect(drive.files.get('d2')?.name).toBe('favorites_macro.enc')

      drive.beforeRename = null
      drive.renames = []
      await tidyDuplicateCopies(listing(), ctx())
      await tidyDuplicateCopies(listing(), ctx())

      expect(drive.renames.map(([id]) => id)).toEqual(['d2'])
      expect(drive.files.get('keep')?.name).toBe('favorites_macro.enc')
    })

    it('a rename of a file already gone counts as done', async () => {
      add('keep', 'favorites_macro.enc', '2026-10-03T00:00:00.000Z')
      add('gone', 'favorites_macro.enc', '2026-10-01T00:00:00.000Z')
      const first = listing()
      drive.files.delete('gone')

      await expect(tidyDuplicateCopies(first, ctx())).resolves.toBeUndefined()
      expect(names()).toEqual({ keep: 'favorites_macro.enc' })
    })
  })

  describe('scope', () => {
    it('leaves keyboards without local data, other machines\' days and non-data names alone', async () => {
      add('k1', 'keyboards_uid2_settings.enc')
      add('k2', 'keyboards_uid2_settings.enc')
      add('o1', 'keyboards_uid1_devices_hash-other_days_2026-10-01.enc')
      add('o2', 'keyboards_uid1_devices_hash-other_days_2026-10-01.enc')
      addTrash('ot', 'keyboards_uid1_devices_hash-other_deleted-ranges.enc', NOW - DAY)
      add('p1', 'password-check.enc')
      add('p2', 'password-check.enc')
      add('u1', 'unknown.enc')
      add('u2', 'unknown.enc')
      add('x1', 'favorites_..enc')
      add('x2', 'favorites_..enc')

      await tidyDuplicateCopies(listing(), ctx())

      // Only the other machine's deleted ranges are tidied: any machine
      // writes to them.
      expect(drive.renames).toEqual([['ot', 'keyboards_uid1_devices_hash-other_deleted-ranges.enc']])
    })

    it('tidies this machine\'s own days, except while an analytics sync of the keyboard runs', async () => {
      const day = `keyboards_uid1_devices_${OWN}_days_2026-10-01.enc`
      add('d1', day, '2026-10-01T00:00:00.000Z')
      add('d2', day, '2026-10-02T00:00:00.000Z')
      syncRuntime.analyticsSyncingUids.add('uid1')

      await tidyDuplicateCopies(listing(), ctx())
      expect(drive.renames).toEqual([])

      syncRuntime.analyticsSyncingUids.clear()
      await tidyDuplicateCopies(listing(), ctx())
      expect(drive.renames.map(([id]) => id)).toEqual(['d1'])
    })

    it(`tidies at most ${TRASH_NAMES_PER_PASS} names per pass and stops when quitting`, async () => {
      for (let i = 0; i < TRASH_NAMES_PER_PASS + 2; i++) {
        add(`a${i}`, `favorites_t${i}.enc`, '2026-10-01T00:00:00.000Z')
        add(`b${i}`, `favorites_t${i}.enc`, '2026-10-02T00:00:00.000Z')
      }

      await tidyDuplicateCopies(listing(), ctx())
      expect(drive.renames).toHaveLength(TRASH_NAMES_PER_PASS)

      syncRuntime.isQuitting = true
      await tidyDuplicateCopies(listing(), ctx())
      expect(drive.renames).toHaveLength(TRASH_NAMES_PER_PASS)
    })
  })
})
