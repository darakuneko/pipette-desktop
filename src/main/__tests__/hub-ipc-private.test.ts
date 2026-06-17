// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler)
      }),
      _handlers: handlers,
    },
  }
})

vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

vi.mock('../sync/sync-service', () => ({ notifyChange: vi.fn() }))

vi.mock('../key-label-store', () => ({
  KEY_LABEL_SYNC_UNIT: 'key-labels',
  getRecord: vi.fn().mockResolvedValue({ success: false, errorCode: 'NOT_FOUND' }),
  saveRecord: vi.fn(),
  setHubPostId: vi.fn(),
}))

vi.mock('../sync/google-auth', () => ({ getIdToken: vi.fn() }))

vi.mock('../hub/hub-client', async () => {
  const actual = await vi.importActual<typeof import('../hub/hub-client')>('../hub/hub-client')
  return {
    ...actual,
    authenticateWithHub: vi.fn(),
    uploadPostToHub: vi.fn(),
    uploadPrivatePostToHub: vi.fn(),
    uploadPrivateFeaturePostToHub: vi.fn(),
    uploadPrivateAnalyticsPostToHub: vi.fn(),
    deletePrivatePostFromHub: vi.fn(),
    getHubOrigin: vi.fn(() => 'https://pipette-hub-worker.keymaps.workers.dev'),
  }
})

vi.mock('../hub/hub-analytics', () => ({
  buildAnalyticsExport: vi.fn(),
  validateAnalyticsExport: vi.fn(),
  estimateAnalyticsExportSizeBytes: vi.fn(() => 0),
}))
vi.mock('../analyze-filter-store', () => ({
  readAnalyzeFilterEntry: vi.fn(),
  setAnalyzeFilterHubPostId: vi.fn(),
}))
vi.mock('../typing-analytics/keymap-snapshots', () => ({ getKeymapSnapshotForRange: vi.fn() }))
vi.mock('../typing-analytics/machine-hash', () => ({ getMachineHash: vi.fn() }))

import { ipcMain } from 'electron'
import { getIdToken } from '../sync/google-auth'
import { Hub404Error, Hub403Error, authenticateWithHub, uploadPrivatePostToHub, deletePrivatePostFromHub } from '../hub/hub-client'
import { setupHubIpc, clearHubTokenCache } from '../hub/hub-ipc'
import { IpcChannels } from '../../shared/ipc/channels'

describe('hub-ipc private uploads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearHubTokenCache()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ipcMain as any)._handlers.clear()
    setupHubIpc()
  })

  function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (ipcMain as any)._handlers.get(channel)
    expect(handler).toBeDefined()
    return handler
  }

  function mockAuth(): void {
    vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
    vi.mocked(authenticateWithHub).mockResolvedValueOnce({
      token: 'hub-jwt',
      user: { id: 'u1', email: 't@e.c', display_name: null },
    })
  }

  const VALID_PARAMS = {
    title: 'My Keymap',
    keyboardName: 'TestBoard',
    vilJson: '{}',
    pipetteJson: '{}',
    keymapC: 'x',
    pdfBase64: 'cGRm',
    thumbnailBase64: Buffer.from('j').toString('base64'),
    expiresInDays: 7,
  }

  it('maps the private upload response to { success, id, url, expiresAt }', async () => {
    mockAuth()
    vi.mocked(uploadPrivatePostToHub).mockResolvedValueOnce({
      id: 'p1', token: 'pt_v1_x', url: '/private/post/p1?token=pt_v1_x', expires_at: '2026-09-14T16:00:00.000Z',
    })
    const handler = getHandler(IpcChannels.HUB_UPLOAD_PRIVATE_POST)
    const result = await handler({}, VALID_PARAMS)
    expect(result).toEqual({ success: true, id: 'p1', url: '/private/post/p1?token=pt_v1_x', expiresAt: '2026-09-14T16:00:00.000Z' })
    expect(uploadPrivatePostToHub).toHaveBeenCalledWith('hub-jwt', 'My Keymap', 'TestBoard', expect.anything(), 7)
  })

  it('delete handler treats a 404 (already gone) as success', async () => {
    mockAuth()
    vi.mocked(deletePrivatePostFromHub).mockRejectedValueOnce(new Hub404Error('x', 'gone'))
    const handler = getHandler(IpcChannels.HUB_DELETE_PRIVATE_POST)
    const result = await handler({}, 'files', 'p1')
    expect(result).toEqual({ success: true })
  })

  it('delete handler surfaces a 403 (not owner) as an error', async () => {
    mockAuth()
    vi.mocked(deletePrivatePostFromHub).mockRejectedValueOnce(new Hub403Error('x', 'forbidden'))
    const handler = getHandler(IpcChannels.HUB_DELETE_PRIVATE_POST)
    const result = await handler({}, 'files', 'p1') as { success: boolean }
    expect(result.success).toBe(false)
  })
})
