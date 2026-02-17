// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'

// --- Mock electron ---

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
  ipcMain: {
    handle: vi.fn(),
  },
}))

vi.mock('../sync/sync-service', () => ({
  notifyChange: vi.fn(),
}))

vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

// --- Import after mocking ---

import { ipcMain } from 'electron'
import { setupFavoriteStore } from '../favorite-store'
import { IpcChannels } from '../../shared/ipc/channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

function getHandler(channel: string): IpcHandler {
  const calls = vi.mocked(ipcMain.handle).mock.calls
  const match = calls.find(([ch]) => ch === channel)
  if (!match) throw new Error(`No handler registered for ${channel}`)
  return match[1] as IpcHandler
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent

describe('favorite-store', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'favorite-store-test-'))
    setupFavoriteStore()
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('list', () => {
    it('returns empty entries when no favorites saved', async () => {
      const handler = getHandler(IpcChannels.FAVORITE_STORE_LIST)
      const result = await handler(fakeEvent, 'tapDance') as { success: boolean; entries: unknown[] }
      expect(result.success).toBe(true)
      expect(result.entries).toEqual([])
    })

    it('returns entries after saving', async () => {
      const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
      await saveHandler(fakeEvent, 'tapDance', '{"type":"tapDance","data":{}}', 'My TD')

      const listHandler = getHandler(IpcChannels.FAVORITE_STORE_LIST)
      const result = await listHandler(fakeEvent, 'tapDance') as { success: boolean; entries: Array<{ label: string; id: string }> }
      expect(result.success).toBe(true)
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].label).toBe('My TD')
      expect(result.entries[0].id).toBeTruthy()
    })
  })

  describe('save', () => {
    it('saves a .json file and creates index', async () => {
      const handler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
      const json = '{"type":"tapDance","data":{"onTap":4}}'
      const result = await handler(fakeEvent, 'tapDance', json, 'My Label') as {
        success: boolean
        entry: { id: string; label: string; filename: string; savedAt: string }
      }

      expect(result.success).toBe(true)
      expect(result.entry).toBeTruthy()
      expect(result.entry.label).toBe('My Label')
      expect(result.entry.filename).toMatch(/^tapDance_.*\.json$/)
      expect(result.entry.savedAt).toBeTruthy()

      const filePath = join(mockUserDataPath, 'sync', 'favorites', 'tapDance', result.entry.filename)
      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe(json)
    })

    it('saves multiple favorites in order (newest first)', async () => {
      const handler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
      await handler(fakeEvent, 'macro', '{"a":1}', 'First')
      await handler(fakeEvent, 'macro', '{"a":2}', 'Second')

      const listHandler = getHandler(IpcChannels.FAVORITE_STORE_LIST)
      const result = await listHandler(fakeEvent, 'macro') as { entries: Array<{ label: string }> }
      expect(result.entries).toHaveLength(2)
      expect(result.entries[0].label).toBe('Second')
      expect(result.entries[1].label).toBe('First')
    })
  })

  describe('load', () => {
    it('loads a previously saved favorite', async () => {
      const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
      const json = '{"type":"combo","data":{"key1":4}}'
      const saved = await saveHandler(fakeEvent, 'combo', json, 'test') as {
        entry: { id: string }
      }

      const loadHandler = getHandler(IpcChannels.FAVORITE_STORE_LOAD)
      const result = await loadHandler(fakeEvent, 'combo', saved.entry.id) as {
        success: boolean
        data: string
      }

      expect(result.success).toBe(true)
      expect(result.data).toBe(json)
    })

    it('returns error for non-existent entry', async () => {
      const handler = getHandler(IpcChannels.FAVORITE_STORE_LOAD)
      const result = await handler(fakeEvent, 'tapDance', 'nonexistent-id') as {
        success: boolean
        error: string
      }

      expect(result.success).toBe(false)
      expect(result.error).toBe('Entry not found')
    })
  })

  describe('rename', () => {
    it('renames an existing entry', async () => {
      const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'tapDance', '{}', 'Old Name') as {
        entry: { id: string }
      }

      const renameHandler = getHandler(IpcChannels.FAVORITE_STORE_RENAME)
      const result = await renameHandler(fakeEvent, 'tapDance', saved.entry.id, 'New Name') as {
        success: boolean
      }
      expect(result.success).toBe(true)

      const listHandler = getHandler(IpcChannels.FAVORITE_STORE_LIST)
      const list = await listHandler(fakeEvent, 'tapDance') as {
        entries: Array<{ label: string }>
      }
      expect(list.entries[0].label).toBe('New Name')
    })

    it('returns error for non-existent entry', async () => {
      const handler = getHandler(IpcChannels.FAVORITE_STORE_RENAME)
      const result = await handler(fakeEvent, 'tapDance', 'bad-id', 'New') as {
        success: boolean
        error: string
      }
      expect(result.success).toBe(false)
      expect(result.error).toBe('Entry not found')
    })
  })

  describe('delete', () => {
    it('soft-deletes an entry (tombstone) and hides from list', async () => {
      const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'tapDance', '{}', 'ToDelete') as {
        entry: { id: string; filename: string }
      }

      const deleteHandler = getHandler(IpcChannels.FAVORITE_STORE_DELETE)
      const result = await deleteHandler(fakeEvent, 'tapDance', saved.entry.id) as {
        success: boolean
      }
      expect(result.success).toBe(true)

      const listHandler = getHandler(IpcChannels.FAVORITE_STORE_LIST)
      const list = await listHandler(fakeEvent, 'tapDance') as { entries: unknown[] }
      expect(list.entries).toHaveLength(0)

      // File should still exist (soft delete keeps it for sync)
      const filePath = join(mockUserDataPath, 'sync', 'favorites', 'tapDance', saved.entry.filename)
      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe('{}')

      // Index should still contain the entry with deletedAt
      const indexPath = join(mockUserDataPath, 'sync', 'favorites', 'tapDance', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8'))
      expect(index.entries).toHaveLength(1)
      expect(index.entries[0].deletedAt).toBeTruthy()
      expect(index.entries[0].updatedAt).toBeTruthy()
    })

    it('returns error for non-existent entry', async () => {
      const handler = getHandler(IpcChannels.FAVORITE_STORE_DELETE)
      const result = await handler(fakeEvent, 'tapDance', 'bad-id') as {
        success: boolean
        error: string
      }
      expect(result.success).toBe(false)
      expect(result.error).toBe('Entry not found')
    })

    it('load rejects deleted entry', async () => {
      const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'tapDance', '{}', 'test') as {
        entry: { id: string }
      }

      const deleteHandler = getHandler(IpcChannels.FAVORITE_STORE_DELETE)
      await deleteHandler(fakeEvent, 'tapDance', saved.entry.id)

      const loadHandler = getHandler(IpcChannels.FAVORITE_STORE_LOAD)
      const result = await loadHandler(fakeEvent, 'tapDance', saved.entry.id) as {
        success: boolean
        error: string
      }
      expect(result.success).toBe(false)
      expect(result.error).toBe('Entry has been deleted')
    })
  })

  describe('updatedAt tracking', () => {
    it('sets updatedAt on save', async () => {
      const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
      const result = await saveHandler(fakeEvent, 'tapDance', '{}', 'test') as {
        entry: { savedAt: string; updatedAt?: string }
      }
      expect(result.entry.updatedAt).toBeTruthy()
      expect(result.entry.updatedAt).toBe(result.entry.savedAt)
    })

    it('updates updatedAt on rename', async () => {
      const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'tapDance', '{}', 'Old') as {
        entry: { id: string; updatedAt?: string }
      }
      const originalUpdatedAt = saved.entry.updatedAt

      // Wait a tick to get a different timestamp
      await new Promise((resolve) => setTimeout(resolve, 10))

      const renameHandler = getHandler(IpcChannels.FAVORITE_STORE_RENAME)
      await renameHandler(fakeEvent, 'tapDance', saved.entry.id, 'New')

      const indexPath = join(mockUserDataPath, 'sync', 'favorites', 'tapDance', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8'))
      expect(index.entries[0].updatedAt).toBeTruthy()
      expect(new Date(index.entries[0].updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalUpdatedAt!).getTime(),
      )
    })
  })

  describe('type isolation', () => {
    it('entries are scoped per type', async () => {
      const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
      await saveHandler(fakeEvent, 'tapDance', '{}', 'TD entry')
      await saveHandler(fakeEvent, 'combo', '{}', 'Combo entry')

      const listHandler = getHandler(IpcChannels.FAVORITE_STORE_LIST)

      const listTD = await listHandler(fakeEvent, 'tapDance') as { entries: Array<{ label: string }> }
      expect(listTD.entries).toHaveLength(1)
      expect(listTD.entries[0].label).toBe('TD entry')

      const listCombo = await listHandler(fakeEvent, 'combo') as { entries: Array<{ label: string }> }
      expect(listCombo.entries).toHaveLength(1)
      expect(listCombo.entries[0].label).toBe('Combo entry')
    })
  })

  describe('invalid type rejection', () => {
    it('rejects invalid type for list', async () => {
      const handler = getHandler(IpcChannels.FAVORITE_STORE_LIST)
      const result = await handler(fakeEvent, 'qmkSettings') as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid favorite type')
    })

    it('rejects path traversal in type', async () => {
      const handler = getHandler(IpcChannels.FAVORITE_STORE_LIST)
      const result = await handler(fakeEvent, '../..') as { success: boolean; error: string }
      expect(result.success).toBe(false)
    })

    it('rejects empty string type', async () => {
      const handler = getHandler(IpcChannels.FAVORITE_STORE_LIST)
      const result = await handler(fakeEvent, '') as { success: boolean; error: string }
      expect(result.success).toBe(false)
    })
  })

  describe('corrupt index recovery', () => {
    it('returns empty entries when index is corrupt', async () => {
      const dir = join(mockUserDataPath, 'sync', 'favorites', 'tapDance')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'index.json'), 'not json!!!', 'utf-8')

      const listHandler = getHandler(IpcChannels.FAVORITE_STORE_LIST)
      const result = await listHandler(fakeEvent, 'tapDance') as { success: boolean; entries: unknown[] }
      expect(result.success).toBe(true)
      expect(result.entries).toEqual([])
    })
  })
})
