// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'

let mockUserDataPath = ''

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserDataPath
      return `/mock/${name}`
    },
  },
  ipcMain: { handle: vi.fn() },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  BrowserWindow: { fromWebContents: vi.fn() },
}))

vi.mock('../sync/sync-service', () => ({ notifyChange: vi.fn() }))

vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

import { ipcMain } from 'electron'
import { setupFavoriteStore } from '../favorite-store'
import { IpcChannels } from '../../shared/ipc/channels'
import type { HubPrivateLink } from '../../shared/types/hub-private'

type IpcHandler = (...args: unknown[]) => Promise<unknown>

function getHandler(channel: string): IpcHandler {
  const calls = vi.mocked(ipcMain.handle).mock.calls
  const match = calls.find(([ch]) => ch === channel)
  if (!match) throw new Error(`No handler registered for ${channel}`)
  return match[1] as IpcHandler
}

const fakeEvent = { sender: {} } as Electron.IpcMainInvokeEvent

const LINK: HubPrivateLink = {
  id: 'priv-1',
  url: '/private/post/priv-1?token=pt_v1_abc',
  expiresAt: '2026-09-14T16:00:00.000Z',
}

async function save(type: string, label: string): Promise<string> {
  const saveHandler = getHandler(IpcChannels.FAVORITE_STORE_SAVE)
  const saved = (await saveHandler(fakeEvent, type, '{}', label)) as { entry: { id: string } }
  return saved.entry.id
}

async function readEntry(type: string): Promise<{ hubPostId?: string; hubPrivate?: HubPrivateLink }> {
  const indexPath = join(mockUserDataPath, 'sync', 'favorites', type, 'index.json')
  const index = JSON.parse(await readFile(indexPath, 'utf-8'))
  return index.entries[0]
}

describe('favorite-store set-hub-private (toggle)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockUserDataPath = await mkdtemp(join(tmpdir(), 'fav-hub-private-test-'))
    setupFavoriteStore()
  })

  afterEach(async () => {
    await rm(mockUserDataPath, { recursive: true, force: true })
  })

  it('sets hubPrivate on an existing entry', async () => {
    const id = await save('macro', 'M')
    const handler = getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_PRIVATE)
    const result = (await handler(fakeEvent, 'macro', id, LINK)) as { success: boolean }
    expect(result.success).toBe(true)
    expect((await readEntry('macro')).hubPrivate).toEqual(LINK)
  })

  it('clears the public hubPostId when a private link is set (toggle)', async () => {
    const id = await save('combo', 'C')
    await getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)(fakeEvent, 'combo', id, 'pub-1')
    await getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_PRIVATE)(fakeEvent, 'combo', id, LINK)
    const entry = await readEntry('combo')
    expect(entry.hubPrivate).toEqual(LINK)
    expect(entry.hubPostId).toBeUndefined()
  })

  it('clears the private link when a public hubPostId is set (toggle)', async () => {
    const id = await save('tapDance', 'T')
    await getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_PRIVATE)(fakeEvent, 'tapDance', id, LINK)
    await getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_POST_ID)(fakeEvent, 'tapDance', id, 'pub-2')
    const entry = await readEntry('tapDance')
    expect(entry.hubPostId).toBe('pub-2')
    expect(entry.hubPrivate).toBeUndefined()
  })

  it('clears hubPrivate when null is passed', async () => {
    const id = await save('keyOverride', 'K')
    await getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_PRIVATE)(fakeEvent, 'keyOverride', id, LINK)
    await getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_PRIVATE)(fakeEvent, 'keyOverride', id, null)
    expect((await readEntry('keyOverride')).hubPrivate).toBeUndefined()
  })

  it('returns error when entry is not found', async () => {
    const handler = getHandler(IpcChannels.FAVORITE_STORE_SET_HUB_PRIVATE)
    const result = (await handler(fakeEvent, 'macro', 'missing', LINK)) as { success: boolean; error: string }
    expect(result.success).toBe(false)
    expect(result.error).toBe('Entry not found')
  })
})
