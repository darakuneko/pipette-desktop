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
  dialog: { showOpenDialog: vi.fn() },
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
  getRecord,
  renameRecord,
  deleteRecord,
  setHubPostId,
  hasActiveName,
  importFromDialog,
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
})
