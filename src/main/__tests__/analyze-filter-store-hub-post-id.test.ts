// SPDX-License-Identifier: GPL-2.0-or-later
// Smoke tests for the analyze-filter-store hubPostId handler. Mirrors
// favorite-store-hub-post-id.test.ts so the two stores stay in sync on
// the Hub upload contract.

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
import { setupAnalyzeFilterStore, setAnalyzeFilterHubPostId, readAnalyzeFilterEntry } from '../analyze-filter-store'
import { IpcChannels } from '../../shared/ipc/channels'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

function getHandler(channel: string): IpcHandler {
  const calls = vi.mocked(ipcMain.handle).mock.calls
  const match = calls.find(([ch]) => ch === channel)
  if (!match) throw new Error(`No handler registered for ${channel}`)
  return match[1] as IpcHandler
}

const fakeEvent = { sender: {} } as Electron.IpcMainInvokeEvent
const UID = 'kb-uid-1'

async function saveEntry(label = 'My filter'): Promise<{ id: string }> {
  const saveHandler = getHandler(IpcChannels.ANALYZE_FILTER_STORE_SAVE)
  const saved = await saveHandler(fakeEvent, UID, '{"version":1}', label) as {
    entry: { id: string }
  }
  return saved.entry
}

async function readIndex(): Promise<{ entries: Array<{ id: string; hubPostId?: string }> }> {
  const indexPath = join(mockUserDataPath, 'sync', 'keyboards', UID, 'analyze_filters', 'index.json')
  const raw = await readFile(indexPath, 'utf-8')
  return JSON.parse(raw) as { entries: Array<{ id: string; hubPostId?: string }> }
}

describe('analyze-filter-store set-hub-post-id', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'analyze-hub-post-id-test-'))
    setupAnalyzeFilterStore()
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('sets hubPostId on an existing entry', async () => {
    const entry = await saveEntry()

    const handler = getHandler(IpcChannels.ANALYZE_FILTER_STORE_SET_HUB_POST_ID)
    const result = await handler(fakeEvent, UID, entry.id, 'post-123') as {
      success: boolean
    }
    expect(result.success).toBe(true)

    const index = await readIndex()
    expect(index.entries[0].hubPostId).toBe('post-123')
    expect(notifyChange).toHaveBeenLastCalledWith(`keyboards/${UID}/analyze_filters`)
  })

  it('clears hubPostId when given null', async () => {
    const entry = await saveEntry()
    await setAnalyzeFilterHubPostId(UID, entry.id, 'post-abc')

    const handler = getHandler(IpcChannels.ANALYZE_FILTER_STORE_SET_HUB_POST_ID)
    const result = await handler(fakeEvent, UID, entry.id, null) as { success: boolean }
    expect(result.success).toBe(true)

    const index = await readIndex()
    expect(index.entries[0].hubPostId).toBeUndefined()
  })

  it('treats whitespace-only hubPostId as clear', async () => {
    const entry = await saveEntry()
    await setAnalyzeFilterHubPostId(UID, entry.id, 'post-xyz')

    const handler = getHandler(IpcChannels.ANALYZE_FILTER_STORE_SET_HUB_POST_ID)
    await handler(fakeEvent, UID, entry.id, '   ')

    const index = await readIndex()
    expect(index.entries[0].hubPostId).toBeUndefined()
  })

  it('returns error for missing entry', async () => {
    const handler = getHandler(IpcChannels.ANALYZE_FILTER_STORE_SET_HUB_POST_ID)
    const result = await handler(fakeEvent, UID, 'no-such-id', 'post-1') as {
      success: boolean
      error?: string
    }
    expect(result.success).toBe(false)
    expect(result.error).toBe('Entry not found')
  })

  it('main-side helpers can read and stamp hubPostId without going through IPC', async () => {
    const entry = await saveEntry('seed')

    const stamped = await setAnalyzeFilterHubPostId(UID, entry.id, 'post-direct')
    expect(stamped.success).toBe(true)

    const read = await readAnalyzeFilterEntry(UID, entry.id)
    expect(read).not.toBeNull()
    expect(read!.entry.hubPostId).toBe('post-direct')
    expect(JSON.parse(read!.data)).toEqual({ version: 1 })
  })

  it('readAnalyzeFilterEntry returns null for missing or tombstoned entries', async () => {
    expect(await readAnalyzeFilterEntry(UID, 'missing')).toBeNull()

    const entry = await saveEntry('to-delete')
    const deleteHandler = getHandler(IpcChannels.ANALYZE_FILTER_STORE_DELETE)
    await deleteHandler(fakeEvent, UID, entry.id)
    expect(await readAnalyzeFilterEntry(UID, entry.id)).toBeNull()
  })
})
