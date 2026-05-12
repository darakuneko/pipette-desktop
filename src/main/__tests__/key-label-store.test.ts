// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// --- Mock electron + sync-service before importing the store under test. ---

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))

vi.mock('../sync/sync-service', () => ({
  notifyChange: vi.fn(),
}))

import { dialog, BrowserWindow } from 'electron'
import { notifyChange } from '../sync/sync-service'
import {
  saveRecord,
  listMetas,
  listAllMetas,
  getRecord,
  renameRecord,
  deleteRecord,
  setHubPostId,
  hasActiveName,
  importFromDialog,
  exportToDialog,
  reorderActive,
  KEY_LABEL_SYNC_UNIT,
} from '../key-label-store'

describe('key-label-store', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'key-label-store-test-'))
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('saveRecord', () => {
    it('persists meta + payload and notifies sync', async () => {
      const result = await saveRecord({
        name: 'Brazilian',
        uploaderName: 'me',
        map: { KC_Q: 'Q' },
      })

      expect(result.success).toBe(true)
      expect(result.data?.name).toBe('Brazilian')
      expect(result.data?.uploaderName).toBe('me')
      expect(notifyChange).toHaveBeenCalledWith(KEY_LABEL_SYNC_UNIT)

      const filePath = join(mockUserDataPath, 'sync', 'key-labels', result.data!.filename)
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw) as { name: string; map: Record<string, string> }
      expect(parsed.name).toBe('Brazilian')
      expect(parsed.map.KC_Q).toBe('Q')
    })

    it('rejects empty name', async () => {
      const result = await saveRecord({ name: '   ', uploaderName: 'me', map: {} })
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_NAME')
    })

    it('rejects duplicate name (case-insensitive)', async () => {
      await saveRecord({ name: 'Italian', uploaderName: 'me', map: {} })
      const result = await saveRecord({ name: 'italian', uploaderName: 'someone', map: {} })
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('DUPLICATE_NAME')
    })

    it('keeps hubPostId when provided', async () => {
      const result = await saveRecord({
        name: 'Spanish',
        uploaderName: 'me',
        map: {},
        hubPostId: 'hub-uuid-1',
      })
      expect(result.data?.hubPostId).toBe('hub-uuid-1')
    })
  })

  describe('listMetas / getRecord', () => {
    it('returns active entries only and resolves payload', async () => {
      const a = await saveRecord({ name: 'A', uploaderName: 'me', map: { KC_A: 'A' } })
      await saveRecord({ name: 'B', uploaderName: 'me', map: {} })
      await deleteRecord(a.data!.id)

      // listMetas auto-creates the built-in QWERTY entry so it can
      // participate in the same drag/sync ordering as user labels.
      // Active rows = QWERTY + B; A is tombstoned.
      const metas = await listMetas()
      const names = metas.map((m) => m.name).sort()
      expect(names).toEqual(['B', 'QWERTY'])

      const b = metas.find((m) => m.name === 'B')!
      const record = await getRecord(b.id)
      expect(record.success).toBe(true)
      expect(record.data?.meta.id).toBe(b.id)
      expect(record.data?.data.map).toEqual({})
    })
  })

  describe('renameRecord', () => {
    it('updates index + payload', async () => {
      const created = await saveRecord({ name: 'Old', uploaderName: 'me', map: { KC_A: '1' } })
      const result = await renameRecord(created.data!.id, 'New')

      expect(result.success).toBe(true)
      expect(result.data?.name).toBe('New')

      const record = await getRecord(created.data!.id)
      expect(record.data?.data.name).toBe('New')
    })

    it('rejects rename to existing name', async () => {
      const a = await saveRecord({ name: 'A', uploaderName: 'me', map: {} })
      await saveRecord({ name: 'B', uploaderName: 'me', map: {} })
      const result = await renameRecord(a.data!.id, 'B')
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('DUPLICATE_NAME')
    })
  })

  describe('deleteRecord', () => {
    it('soft-deletes (tombstone) without removing the file', async () => {
      const created = await saveRecord({ name: 'X', uploaderName: 'me', map: {} })
      const result = await deleteRecord(created.data!.id)
      expect(result.success).toBe(true)

      // File still on disk so sync can carry the tombstone forward.
      const filePath = join(mockUserDataPath, 'sync', 'key-labels', created.data!.filename)
      const raw = await readFile(filePath, 'utf-8')
      expect(raw).toBeTruthy()

      // Active list excludes the deleted row but keeps the auto-created
      // QWERTY entry, which is undeletable by design.
      const metas = await listMetas()
      expect(metas.map((m) => m.name)).toEqual(['QWERTY'])
    })
  })

  describe('setHubPostId', () => {
    it('sets and clears hubPostId', async () => {
      const created = await saveRecord({ name: 'Y', uploaderName: 'me', map: {} })
      const id = created.data!.id

      const set = await setHubPostId(id, 'hub-id-2')
      expect(set.success).toBe(true)
      expect(set.data?.hubPostId).toBe('hub-id-2')

      const cleared = await setHubPostId(id, null)
      expect(cleared.success).toBe(true)
      expect(cleared.data?.hubPostId).toBeUndefined()
    })
  })

  describe('hasActiveName', () => {
    it('detects existing names case-insensitively and excludes the given id', async () => {
      const a = await saveRecord({ name: 'French', uploaderName: 'me', map: {} })

      expect(await hasActiveName('FRENCH')).toBe(true)
      expect(await hasActiveName('FRENCH', a.data!.id)).toBe(false)
      expect(await hasActiveName('Spanish')).toBe(false)
    })
  })

  describe('importFromDialog', () => {
    it('imports a valid .json and returns the saved meta', async () => {
      const dir = join(mockUserDataPath, 'tmp-import')
      await mkdir(dir, { recursive: true })
      const importPath = join(dir, 'sample.json')
      await writeFile(
        importPath,
        JSON.stringify({
          name: 'Hebrew',
          author: 'pipette',
          map: { KC_A: 'A' },
          composite_labels: null,
        }),
        'utf-8',
      )

      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [importPath],
      })

      const win = { id: 1 } as unknown as Electron.BrowserWindow
      vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(win)

      const result = await importFromDialog(win)
      expect(result.success).toBe(true)
      expect(result.data?.name).toBe('Hebrew')
    })

    it('rejects an invalid file shape', async () => {
      const dir = join(mockUserDataPath, 'tmp-import')
      await mkdir(dir, { recursive: true })
      const importPath = join(dir, 'bad.json')
      await writeFile(importPath, JSON.stringify({ name: 'x' }), 'utf-8')

      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: false,
        filePaths: [importPath],
      })

      const win = { id: 2 } as unknown as Electron.BrowserWindow
      const result = await importFromDialog(win)
      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_FILE')
    })

    it('returns IO_ERROR on cancel', async () => {
      vi.mocked(dialog.showOpenDialog).mockResolvedValue({
        canceled: true,
        filePaths: [],
      })

      const win = { id: 3 } as unknown as Electron.BrowserWindow
      const result = await importFromDialog(win)
      expect(result.success).toBe(false)
      expect(result.error).toBe('cancelled')
    })
  })

  describe('reorderActive', () => {
    it('reorders active entries by given ID array', async () => {
      const a = await saveRecord({ name: 'Alpha', uploaderName: 'me', map: {} })
      const b = await saveRecord({ name: 'Beta', uploaderName: 'me', map: {} })
      const c = await saveRecord({ name: 'Gamma', uploaderName: 'me', map: {} })

      await reorderActive([c.data!.id, a.data!.id, b.data!.id])

      const metas = await listMetas()
      const names = metas.map((m) => m.name)
      expect(names.indexOf('Gamma')).toBeLessThan(names.indexOf('Alpha'))
      expect(names.indexOf('Alpha')).toBeLessThan(names.indexOf('Beta'))
    })

    it('keeps tombstones in the tail after reordered active entries', async () => {
      const a = await saveRecord({ name: 'Keep', uploaderName: 'me', map: {} })
      const b = await saveRecord({ name: 'Remove', uploaderName: 'me', map: {} })
      await deleteRecord(b.data!.id)

      await reorderActive([a.data!.id])

      const all = await listAllMetas()
      const tombstoned = all.find((m) => m.id === b.data!.id)
      expect(tombstoned).toBeDefined()
      expect(tombstoned!.deletedAt).toBeTruthy()

      const activeIds = all.filter((m) => !m.deletedAt).map((m) => m.id)
      const tombIdx = all.findIndex((m) => m.id === b.data!.id)
      const lastActiveIdx = all.findIndex((m) => m.id === activeIds[activeIds.length - 1])
      expect(tombIdx).toBeGreaterThan(lastActiveIdx)
    })

    it('appends unlisted active IDs at the end', async () => {
      const a = await saveRecord({ name: 'Listed', uploaderName: 'me', map: {} })
      await saveRecord({ name: 'Unlisted', uploaderName: 'me', map: {} })

      await reorderActive([a.data!.id])

      const metas = await listMetas()
      const names = metas.map((m) => m.name)
      expect(names.indexOf('Listed')).toBeLessThan(names.indexOf('Unlisted'))
    })

    it('bumps updatedAt on all reordered metas', async () => {
      const a = await saveRecord({ name: 'TimestampA', uploaderName: 'me', map: {} })
      const b = await saveRecord({ name: 'TimestampB', uploaderName: 'me', map: {} })
      const origA = a.data!.updatedAt
      const origB = b.data!.updatedAt

      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 1000)
      await reorderActive([b.data!.id, a.data!.id])
      vi.mocked(Date.now).mockRestore()

      const metas = await listMetas()
      const metaA = metas.find((m) => m.id === a.data!.id)!
      const metaB = metas.find((m) => m.id === b.data!.id)!
      expect(metaA.updatedAt).not.toBe(origA)
      expect(metaB.updatedAt).not.toBe(origB)
    })

    it('calls notifyChange after reorder', async () => {
      await saveRecord({ name: 'Notify', uploaderName: 'me', map: {} })
      vi.mocked(notifyChange).mockClear()

      await reorderActive([])

      expect(notifyChange).toHaveBeenCalledWith(KEY_LABEL_SYNC_UNIT)
    })
  })

  describe('exportToDialog', () => {
    it('writes correct JSON to the chosen path', async () => {
      const created = await saveRecord({
        name: 'Export Test',
        uploaderName: 'me',
        map: { KC_A: 'A', KC_B: 'B' },
        compositeLabels: { KC_C: 'C' },
      })

      const exportPath = join(mockUserDataPath, 'exported.json')
      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: false,
        filePath: exportPath,
      })

      const win = { id: 10 } as unknown as Electron.BrowserWindow
      const result = await exportToDialog(win, created.data!.id)

      expect(result.success).toBe(true)
      expect(result.data?.filePath).toBe(exportPath)

      const raw = await readFile(exportPath, 'utf-8')
      const parsed = JSON.parse(raw) as { name: string; map: Record<string, string>; composite_labels: Record<string, string> | null }
      expect(parsed.name).toBe('Export Test')
      expect(parsed.map).toEqual({ KC_A: 'A', KC_B: 'B' })
      expect(parsed.composite_labels).toEqual({ KC_C: 'C' })
    })

    it('returns IO_ERROR when dialog is cancelled', async () => {
      const created = await saveRecord({ name: 'Cancel Export', uploaderName: 'me', map: {} })

      vi.mocked(dialog.showSaveDialog).mockResolvedValue({
        canceled: true,
        filePath: '',
      })

      const win = { id: 11 } as unknown as Electron.BrowserWindow
      const result = await exportToDialog(win, created.data!.id)

      expect(result.success).toBe(false)
      expect(result.error).toBe('cancelled')
    })
  })

  describe('listAllMetas', () => {
    it('returns all entries including tombstones', async () => {
      const a = await saveRecord({ name: 'Alive', uploaderName: 'me', map: {} })
      const b = await saveRecord({ name: 'Dead', uploaderName: 'me', map: {} })
      await deleteRecord(b.data!.id)

      const allMetas = await listAllMetas()
      const allIds = allMetas.map((m) => m.id)
      expect(allIds).toContain(a.data!.id)
      expect(allIds).toContain(b.data!.id)

      const tombstoned = allMetas.find((m) => m.id === b.data!.id)
      expect(tombstoned!.deletedAt).toBeTruthy()
    })

    it('includes entries that listMetas excludes', async () => {
      await saveRecord({ name: 'Visible', uploaderName: 'me', map: {} })
      const b = await saveRecord({ name: 'Hidden', uploaderName: 'me', map: {} })
      await deleteRecord(b.data!.id)

      const activeMetas = await listMetas()
      const allMetas = await listAllMetas()

      expect(activeMetas.find((m) => m.id === b.data!.id)).toBeUndefined()
      expect(allMetas.find((m) => m.id === b.data!.id)).toBeDefined()
      expect(allMetas.length).toBeGreaterThan(activeMetas.length)
    })
  })

  describe('setHubPostId with optional parameters', () => {
    it('sets uploaderName alongside hubPostId', async () => {
      const created = await saveRecord({ name: 'Hub Author', uploaderName: 'original', map: {} })
      const result = await setHubPostId(created.data!.id, 'hub-123', 'new-author')

      expect(result.success).toBe(true)
      expect(result.data?.hubPostId).toBe('hub-123')
      expect(result.data?.uploaderName).toBe('new-author')
    })

    it('sets hubUpdatedAt alongside hubPostId', async () => {
      const created = await saveRecord({ name: 'Hub Time', uploaderName: 'me', map: {} })
      const ts = '2026-01-15T10:00:00.000Z'
      const result = await setHubPostId(created.data!.id, 'hub-456', undefined, ts)

      expect(result.success).toBe(true)
      expect(result.data?.hubPostId).toBe('hub-456')
      expect(result.data?.hubUpdatedAt).toBe(ts)
    })

    it('leaves uploaderName unchanged when undefined is passed', async () => {
      const created = await saveRecord({ name: 'Keep Author', uploaderName: 'keep-me', map: {} })
      const result = await setHubPostId(created.data!.id, 'hub-789', undefined)

      expect(result.success).toBe(true)
      expect(result.data?.uploaderName).toBe('keep-me')
    })

    it('leaves hubUpdatedAt unchanged when undefined is passed', async () => {
      const created = await saveRecord({
        name: 'Keep Time',
        uploaderName: 'me',
        map: {},
        hubPostId: 'hub-existing',
        hubUpdatedAt: '2026-01-01T00:00:00.000Z',
      })
      const result = await setHubPostId(created.data!.id, 'hub-updated', undefined, undefined)

      expect(result.success).toBe(true)
      expect(result.data?.hubUpdatedAt).toBe('2026-01-01T00:00:00.000Z')
    })

    it('clears hubUpdatedAt when hubPostId is set to null', async () => {
      const created = await saveRecord({
        name: 'Clear Time',
        uploaderName: 'me',
        map: {},
        hubPostId: 'hub-clear',
        hubUpdatedAt: '2026-06-01T00:00:00.000Z',
      })
      const result = await setHubPostId(created.data!.id, null)

      expect(result.success).toBe(true)
      expect(result.data?.hubPostId).toBeUndefined()
      expect(result.data?.hubUpdatedAt).toBeUndefined()
    })
  })

  describe('QWERTY delete protection', () => {
    it('rejects deletion of the QWERTY entry', async () => {
      await listMetas()

      const result = await deleteRecord('qwerty')

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('INVALID_NAME')
      expect(result.error).toBe('QWERTY cannot be deleted')
    })

    it('QWERTY entry remains in the list after failed delete attempt', async () => {
      await listMetas()
      await deleteRecord('qwerty')

      const metas = await listMetas()
      const qwerty = metas.find((m) => m.id === 'qwerty')
      expect(qwerty).toBeDefined()
      expect(qwerty!.deletedAt).toBeUndefined()
    })
  })
})
