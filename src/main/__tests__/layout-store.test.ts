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
import { setupSnapshotStore } from '../snapshot-store'
import { IpcChannels } from '../../shared/ipc/channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

function getHandler(channel: string): IpcHandler {
  const calls = vi.mocked(ipcMain.handle).mock.calls
  const match = calls.find(([ch]) => ch === channel)
  if (!match) throw new Error(`No handler registered for ${channel}`)
  return match[1] as IpcHandler
}

const fakeEvent = {} as Electron.IpcMainInvokeEvent

describe('snapshot-store', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'snapshot-store-test-'))
    setupSnapshotStore()
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  describe('list', () => {
    it('returns empty entries when no snapshots saved', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_LIST)
      const result = await handler(fakeEvent, 'test-uid') as { success: boolean; entries: unknown[] }
      expect(result.success).toBe(true)
      expect(result.entries).toEqual([])
    })

    it('returns entries after saving', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      await saveHandler(fakeEvent, 'uid-1', '{"data":1}', 'MyKeyboard', 'First Save')

      const listHandler = getHandler(IpcChannels.SNAPSHOT_STORE_LIST)
      const result = await listHandler(fakeEvent, 'uid-1') as { success: boolean; entries: Array<{ label: string; id: string }> }
      expect(result.success).toBe(true)
      expect(result.entries).toHaveLength(1)
      expect(result.entries[0].label).toBe('First Save')
      expect(result.entries[0].id).toBeTruthy()
    })
  })

  describe('save', () => {
    it('saves a .pipette file and creates index', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const json = '{"uid":"uid-1","keymap":{}}'
      const result = await handler(fakeEvent, 'uid-1', json, 'TestKB', 'My Label') as {
        success: boolean
        entry: { id: string; label: string; filename: string; savedAt: string }
      }

      expect(result.success).toBe(true)
      expect(result.entry).toBeTruthy()
      expect(result.entry.label).toBe('My Label')
      expect(result.entry.filename).toMatch(/^TestKB_.*\.pipette$/)
      expect(result.entry.savedAt).toBeTruthy()

      // Verify file was written
      const filePath = join(mockUserDataPath, 'sync', 'keyboards', 'uid-1', 'snapshots', result.entry.filename)
      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe(json)
    })

    it('saves multiple snapshots in order', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      await handler(fakeEvent, 'uid-1', '{"a":1}', 'KB', 'First')
      await handler(fakeEvent, 'uid-1', '{"a":2}', 'KB', 'Second')

      const listHandler = getHandler(IpcChannels.SNAPSHOT_STORE_LIST)
      const result = await listHandler(fakeEvent, 'uid-1') as { entries: Array<{ label: string }> }
      expect(result.entries).toHaveLength(2)
      // Newest first
      expect(result.entries[0].label).toBe('Second')
      expect(result.entries[1].label).toBe('First')
    })

    it('sanitizes special characters in device name', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const result = await handler(fakeEvent, 'uid-1', '{}', 'My/Key*board', 'test') as {
        entry: { filename: string }
      }
      expect(result.entry.filename).not.toMatch(/[/\\:*?"<>|]/)
    })
  })

  describe('load', () => {
    it('loads a previously saved snapshot', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const json = '{"uid":"uid-1","data":"hello"}'
      const saved = await saveHandler(fakeEvent, 'uid-1', json, 'KB', 'test') as {
        entry: { id: string }
      }

      const loadHandler = getHandler(IpcChannels.SNAPSHOT_STORE_LOAD)
      const result = await loadHandler(fakeEvent, 'uid-1', saved.entry.id) as {
        success: boolean
        data: string
      }

      expect(result.success).toBe(true)
      expect(result.data).toBe(json)
    })

    it('returns error for non-existent entry', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_LOAD)
      const result = await handler(fakeEvent, 'uid-1', 'nonexistent-id') as {
        success: boolean
        error: string
      }

      expect(result.success).toBe(false)
      expect(result.error).toBe('Entry not found')
    })
  })

  describe('rename', () => {
    it('renames an existing entry', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'uid-1', '{}', 'KB', 'Old Name') as {
        entry: { id: string }
      }

      const renameHandler = getHandler(IpcChannels.SNAPSHOT_STORE_RENAME)
      const result = await renameHandler(fakeEvent, 'uid-1', saved.entry.id, 'New Name') as {
        success: boolean
      }
      expect(result.success).toBe(true)

      const listHandler = getHandler(IpcChannels.SNAPSHOT_STORE_LIST)
      const list = await listHandler(fakeEvent, 'uid-1') as {
        entries: Array<{ label: string }>
      }
      expect(list.entries[0].label).toBe('New Name')
    })

    it('returns error for non-existent entry', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_RENAME)
      const result = await handler(fakeEvent, 'uid-1', 'bad-id', 'New') as {
        success: boolean
        error: string
      }
      expect(result.success).toBe(false)
      expect(result.error).toBe('Entry not found')
    })
  })

  describe('delete', () => {
    it('soft-deletes an entry (tombstone) and hides from list', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'uid-1', '{}', 'KB', 'ToDelete') as {
        entry: { id: string; filename: string }
      }

      const deleteHandler = getHandler(IpcChannels.SNAPSHOT_STORE_DELETE)
      const result = await deleteHandler(fakeEvent, 'uid-1', saved.entry.id) as {
        success: boolean
      }
      expect(result.success).toBe(true)

      const listHandler = getHandler(IpcChannels.SNAPSHOT_STORE_LIST)
      const list = await listHandler(fakeEvent, 'uid-1') as { entries: unknown[] }
      expect(list.entries).toHaveLength(0)

      // File should still exist (soft delete keeps it for sync)
      const filePath = join(mockUserDataPath, 'sync', 'keyboards', 'uid-1', 'snapshots', saved.entry.filename)
      const content = await readFile(filePath, 'utf-8')
      expect(content).toBe('{}')

      // Index should still contain the entry with deletedAt
      const indexPath = join(mockUserDataPath, 'sync', 'keyboards', 'uid-1', 'snapshots', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8'))
      expect(index.entries).toHaveLength(1)
      expect(index.entries[0].deletedAt).toBeTruthy()
      expect(index.entries[0].updatedAt).toBeTruthy()
    })

    it('returns error for non-existent entry', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_DELETE)
      const result = await handler(fakeEvent, 'uid-1', 'bad-id') as {
        success: boolean
        error: string
      }
      expect(result.success).toBe(false)
      expect(result.error).toBe('Entry not found')
    })

    it('load rejects deleted entry', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'uid-1', '{}', 'KB', 'test') as {
        entry: { id: string }
      }

      const deleteHandler = getHandler(IpcChannels.SNAPSHOT_STORE_DELETE)
      await deleteHandler(fakeEvent, 'uid-1', saved.entry.id)

      const loadHandler = getHandler(IpcChannels.SNAPSHOT_STORE_LOAD)
      const result = await loadHandler(fakeEvent, 'uid-1', saved.entry.id) as {
        success: boolean
        error: string
      }
      expect(result.success).toBe(false)
      expect(result.error).toBe('Entry has been deleted')
    })
  })

  describe('updatedAt tracking', () => {
    it('sets updatedAt on save', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const result = await saveHandler(fakeEvent, 'uid-1', '{}', 'KB', 'test') as {
        entry: { savedAt: string; updatedAt?: string }
      }
      expect(result.entry.updatedAt).toBeTruthy()
      expect(result.entry.updatedAt).toBe(result.entry.savedAt)
    })

    it('updates updatedAt on rename', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'uid-1', '{}', 'KB', 'Old') as {
        entry: { id: string; updatedAt?: string }
      }
      const originalUpdatedAt = saved.entry.updatedAt

      await new Promise((resolve) => setTimeout(resolve, 10))

      const renameHandler = getHandler(IpcChannels.SNAPSHOT_STORE_RENAME)
      await renameHandler(fakeEvent, 'uid-1', saved.entry.id, 'New')

      const indexPath = join(mockUserDataPath, 'sync', 'keyboards', 'uid-1', 'snapshots', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8'))
      expect(index.entries[0].updatedAt).toBeTruthy()
      expect(new Date(index.entries[0].updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalUpdatedAt!).getTime(),
      )
    })
  })

  describe('uid isolation', () => {
    it('entries are scoped per uid', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      await saveHandler(fakeEvent, 'uid-A', '{}', 'KB', 'A-entry')
      await saveHandler(fakeEvent, 'uid-B', '{}', 'KB', 'B-entry')

      const listHandler = getHandler(IpcChannels.SNAPSHOT_STORE_LIST)

      const listA = await listHandler(fakeEvent, 'uid-A') as { entries: Array<{ label: string }> }
      expect(listA.entries).toHaveLength(1)
      expect(listA.entries[0].label).toBe('A-entry')

      const listB = await listHandler(fakeEvent, 'uid-B') as { entries: Array<{ label: string }> }
      expect(listB.entries).toHaveLength(1)
      expect(listB.entries[0].label).toBe('B-entry')
    })
  })

  describe('path traversal prevention', () => {
    it('rejects uid with path traversal characters', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_LIST)
      const result = await handler(fakeEvent, '../..') as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid uid')
    })

    it('rejects uid with slashes', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const result = await handler(fakeEvent, 'foo/bar', '{}', 'KB', 'test') as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid uid')
    })

    it('rejects uid that is empty string', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_LIST)
      const result = await handler(fakeEvent, '') as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid uid')
    })

    it('rejects uid that is dot', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_LIST)
      const result = await handler(fakeEvent, '.') as { success: boolean; error: string }
      expect(result.success).toBe(false)
      expect(result.error).toContain('Invalid uid')
    })
  })

  describe('set-hub-post-id', () => {
    it('sets hubPostId on an entry', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'uid-1', '{}', 'KB', 'test') as {
        entry: { id: string }
      }

      const setHubPostIdHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SET_HUB_POST_ID)
      const result = await setHubPostIdHandler(fakeEvent, 'uid-1', saved.entry.id, 'post-42') as {
        success: boolean
      }
      expect(result.success).toBe(true)

      const indexPath = join(mockUserDataPath, 'sync', 'keyboards', 'uid-1', 'snapshots', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8'))
      expect(index.entries[0].hubPostId).toBe('post-42')
    })

    it('clears hubPostId when set to null', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'uid-1', '{}', 'KB', 'test') as {
        entry: { id: string }
      }

      const setHubPostIdHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SET_HUB_POST_ID)
      await setHubPostIdHandler(fakeEvent, 'uid-1', saved.entry.id, 'post-42')
      const result = await setHubPostIdHandler(fakeEvent, 'uid-1', saved.entry.id, null) as {
        success: boolean
      }
      expect(result.success).toBe(true)

      const indexPath = join(mockUserDataPath, 'sync', 'keyboards', 'uid-1', 'snapshots', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8'))
      expect(index.entries[0].hubPostId).toBeUndefined()
    })

    it('normalizes empty/whitespace hubPostId to null (deletes field)', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'uid-1', '{}', 'KB', 'test') as {
        entry: { id: string }
      }

      const setHubPostIdHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SET_HUB_POST_ID)
      await setHubPostIdHandler(fakeEvent, 'uid-1', saved.entry.id, 'post-42')

      for (const blank of ['', '  ', '\t']) {
        await setHubPostIdHandler(fakeEvent, 'uid-1', saved.entry.id, blank)
        const indexPath = join(mockUserDataPath, 'sync', 'keyboards', 'uid-1', 'snapshots', 'index.json')
        const index = JSON.parse(await readFile(indexPath, 'utf-8'))
        expect(index.entries[0].hubPostId).toBeUndefined()
      }
    })

    it('returns error for non-existent entry', async () => {
      const handler = getHandler(IpcChannels.SNAPSHOT_STORE_SET_HUB_POST_ID)
      const result = await handler(fakeEvent, 'uid-1', 'bad-id', 'post-1') as {
        success: boolean
        error: string
      }
      expect(result.success).toBe(false)
      expect(result.error).toBe('Entry not found')
    })

    it('updates updatedAt timestamp', async () => {
      const saveHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SAVE)
      const saved = await saveHandler(fakeEvent, 'uid-1', '{}', 'KB', 'test') as {
        entry: { id: string; updatedAt?: string }
      }
      const originalUpdatedAt = saved.entry.updatedAt

      await new Promise((resolve) => setTimeout(resolve, 10))

      const setHubPostIdHandler = getHandler(IpcChannels.SNAPSHOT_STORE_SET_HUB_POST_ID)
      await setHubPostIdHandler(fakeEvent, 'uid-1', saved.entry.id, 'post-99')

      const indexPath = join(mockUserDataPath, 'sync', 'keyboards', 'uid-1', 'snapshots', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8'))
      expect(new Date(index.entries[0].updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(originalUpdatedAt!).getTime(),
      )
    })
  })

  describe('corrupt index recovery', () => {
    it('returns empty entries when index is corrupt', async () => {
      const dir = join(mockUserDataPath, 'sync', 'keyboards', 'uid-corrupt', 'snapshots')
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'index.json'), 'not json!!!', 'utf-8')

      const listHandler = getHandler(IpcChannels.SNAPSHOT_STORE_LIST)
      const result = await listHandler(fakeEvent, 'uid-corrupt') as { success: boolean; entries: unknown[] }
      expect(result.success).toBe(true)
      expect(result.entries).toEqual([])
    })
  })
})
