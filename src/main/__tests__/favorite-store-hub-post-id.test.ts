// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
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
  dialog: {
    showSaveDialog: vi.fn(),
    showOpenDialog: vi.fn(),
  },
  BrowserWindow: {
    fromWebContents: vi.fn(),
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
import { notifyChange } from '../sync/sync-service'
import { setupFavoriteStore } from '../favorite-store'
import { IpcChannels } from '../../shared/ipc/channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

function getHandler(channel: string): IpcHandler {
  const calls = vi.mocked(ipcMain.handle).mock.calls
  const match = calls.find(([ch]) => ch === channel)
  if (!match) throw new Error(`No handler registered for ${channel}`)
  return match[1] as IpcHandler
}

const fakeEvent = { sender: {} } as Electron.IpcMainInvokeEvent

describe('favorite-store set-hub-post-id', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'fav-hub-post-id-test-'))
    setupFavoriteStore()
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('sets hubPostId on an existing entry', async () => {
    const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
    const saved = await saveHandler(fakeEvent, 'tapDance', '{}', 'My TD') as {
      entry: { id: string }
    }

    const handler = getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)
    const result = await handler(fakeEvent, 'tapDance', saved.entry.id, 'post-123') as {
      success: boolean
    }
    expect(result.success).toBe(true)

    const indexPath = join(mockUserDataPath, 'sync', 'favorites', 'tapDance', 'index.json')
    const index = JSON.parse(await readFile(indexPath, 'utf-8'))
    expect(index.entries[0].hubPostId).toBe('post-123')
  })

  it('removes hubPostId when null is passed', async () => {
    const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
    const saved = await saveHandler(fakeEvent, 'macro', '{}', 'My Macro') as {
      entry: { id: string }
    }

    const handler = getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)
    await handler(fakeEvent, 'macro', saved.entry.id, 'post-456')
    const result = await handler(fakeEvent, 'macro', saved.entry.id, null) as {
      success: boolean
    }
    expect(result.success).toBe(true)

    const indexPath = join(mockUserDataPath, 'sync', 'favorites', 'macro', 'index.json')
    const index = JSON.parse(await readFile(indexPath, 'utf-8'))
    expect(index.entries[0].hubPostId).toBeUndefined()
  })

  it('returns error when entry is not found', async () => {
    const handler = getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)
    const result = await handler(fakeEvent, 'tapDance', 'nonexistent-id', 'post-1') as {
      success: boolean
      error: string
    }
    expect(result.success).toBe(false)
    expect(result.error).toBe('Entry not found')
  })

  it('returns error when type is invalid', async () => {
    const handler = getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)
    const result = await handler(fakeEvent, 'qmkSettings', 'some-id', 'post-1') as {
      success: boolean
      error: string
    }
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid favorite type')
  })

  it('trims whitespace from hubPostId', async () => {
    const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
    const saved = await saveHandler(fakeEvent, 'combo', '{}', 'My Combo') as {
      entry: { id: string }
    }

    const handler = getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)
    const result = await handler(fakeEvent, 'combo', saved.entry.id, '  post-789  ') as {
      success: boolean
    }
    expect(result.success).toBe(true)

    const indexPath = join(mockUserDataPath, 'sync', 'favorites', 'combo', 'index.json')
    const index = JSON.parse(await readFile(indexPath, 'utf-8'))
    expect(index.entries[0].hubPostId).toBe('post-789')
  })

  it('normalizes empty/whitespace hubPostId to null (deletes field)', async () => {
    const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
    const saved = await saveHandler(fakeEvent, 'tapDance', '{}', 'My TD') as {
      entry: { id: string }
    }

    const handler = getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)
    await handler(fakeEvent, 'tapDance', saved.entry.id, 'post-42')

    for (const blank of ['', '  ', '\t']) {
      await handler(fakeEvent, 'tapDance', saved.entry.id, blank)
      const indexPath = join(mockUserDataPath, 'sync', 'favorites', 'tapDance', 'index.json')
      const index = JSON.parse(await readFile(indexPath, 'utf-8'))
      expect(index.entries[0].hubPostId).toBeUndefined()
    }
  })

  it('updates updatedAt timestamp', async () => {
    const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
    const saved = await saveHandler(fakeEvent, 'keyOverride', '{}', 'My KO') as {
      entry: { id: string; updatedAt?: string }
    }
    const originalUpdatedAt = saved.entry.updatedAt

    await new Promise((resolve) => setTimeout(resolve, 10))

    const handler = getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)
    await handler(fakeEvent, 'keyOverride', saved.entry.id, 'post-99')

    const indexPath = join(mockUserDataPath, 'sync', 'favorites', 'keyOverride', 'index.json')
    const index = JSON.parse(await readFile(indexPath, 'utf-8'))
    expect(new Date(index.entries[0].updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(originalUpdatedAt!).getTime(),
    )
  })

  it('calls notifyChange with correct path', async () => {
    const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
    const saved = await saveHandler(fakeEvent, 'altRepeatKey', '{}', 'My ARK') as {
      entry: { id: string }
    }

    vi.mocked(notifyChange).mockClear()

    const handler = getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)
    await handler(fakeEvent, 'altRepeatKey', saved.entry.id, 'post-55')

    expect(vi.mocked(notifyChange)).toHaveBeenCalledWith('favorites/altRepeatKey')
  })
})
