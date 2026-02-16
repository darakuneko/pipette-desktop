// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock electron
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

// Mock google-auth
vi.mock('../sync/google-auth', () => ({
  getIdToken: vi.fn(),
}))

// Mock hub-client
vi.mock('../hub/hub-client', () => ({
  authenticateWithHub: vi.fn(),
  uploadPostToHub: vi.fn(),
  updatePostOnHub: vi.fn(),
  deletePostFromHub: vi.fn(),
}))

import { ipcMain } from 'electron'
import { getIdToken } from '../sync/google-auth'
import { authenticateWithHub, uploadPostToHub, updatePostOnHub, deletePostFromHub } from '../hub/hub-client'
import { setupHubIpc } from '../hub/hub-ipc'

describe('hub-ipc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ipcMain as any)._handlers.clear()
    setupHubIpc()
  })

  function getHandler(): (...args: unknown[]) => Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (ipcMain as any)._handlers.get('hub:upload-post')
    expect(handler).toBeDefined()
    return handler
  }

  const VALID_PARAMS = {
    title: 'My Keymap',
    keyboardName: 'TestBoard',
    vilJson: '{"keymap":{}}',
    pippetteJson: '{"uid":"0x1"}',
    keymapC: 'const uint16_t keymaps[]',
    pdfBase64: 'cGRmLWRhdGE=',
    thumbnailBase64: Buffer.from('fake-jpeg').toString('base64'),
  }

  it('registers HUB_UPLOAD_POST handler', () => {
    expect(ipcMain.handle).toHaveBeenCalledWith('hub:upload-post', expect.any(Function))
  })

  it('returns error when not authenticated', async () => {
    vi.mocked(getIdToken).mockResolvedValueOnce(null)

    const handler = getHandler()
    const result = await handler({ sender: {} }, VALID_PARAMS)

    expect(result).toEqual({
      success: false,
      error: 'Not authenticated with Google. Please sign in again.',
    })
  })

  it('returns error when Hub auth fails', async () => {
    vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
    vi.mocked(authenticateWithHub).mockRejectedValueOnce(new Error('Hub auth failed: 401 Unauthorized'))

    const handler = getHandler()
    const result = await handler({ sender: {} }, VALID_PARAMS)

    expect(result).toEqual({
      success: false,
      error: 'Hub auth failed: 401 Unauthorized',
    })
  })

  it('uploads successfully with all files', async () => {
    vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
    vi.mocked(authenticateWithHub).mockResolvedValueOnce({
      token: 'hub-jwt',
      user: { id: 'u1', email: 'test@example.com', display_name: null },
    })
    vi.mocked(uploadPostToHub).mockResolvedValueOnce({
      id: 'post-42',
      title: 'My Keymap',
    })

    const handler = getHandler()
    const result = await handler({}, VALID_PARAMS)

    expect(result).toEqual({ success: true, postId: 'post-42' })
    expect(authenticateWithHub).toHaveBeenCalledWith('id-token')
    expect(uploadPostToHub).toHaveBeenCalledWith(
      'hub-jwt',
      'My Keymap',
      'TestBoard',
      expect.objectContaining({
        vil: expect.objectContaining({ name: 'TestBoard.vil' }),
        pippette: expect.objectContaining({ name: 'TestBoard.pippette' }),
        c: expect.objectContaining({ name: 'TestBoard.c' }),
        pdf: expect.objectContaining({ name: 'TestBoard.pdf' }),
        thumbnail: expect.objectContaining({ name: 'TestBoard.jpg' }),
      }),
    )
  })

  it('returns error when upload fails', async () => {
    vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
    vi.mocked(authenticateWithHub).mockResolvedValueOnce({
      token: 'hub-jwt',
      user: { id: 'u1', email: 'test@example.com', display_name: null },
    })
    vi.mocked(uploadPostToHub).mockRejectedValueOnce(new Error('Hub upload failed: 500'))

    const handler = getHandler()
    const result = await handler({ sender: {} }, VALID_PARAMS)

    expect(result).toEqual({
      success: false,
      error: 'Hub upload failed: 500',
    })
  })

  describe('HUB_UPDATE_POST', () => {
    function getUpdateHandler(): (...args: unknown[]) => Promise<unknown> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (ipcMain as any)._handlers.get('hub:update-post')
      expect(handler).toBeDefined()
      return handler
    }

    it('registers HUB_UPDATE_POST handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('hub:update-post', expect.any(Function))
    })

    it('returns error when not authenticated', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce(null)

      const handler = getUpdateHandler()
      const result = await handler({ sender: {} }, { ...VALID_PARAMS, postId: 'post-1' })

      expect(result).toEqual({
        success: false,
        error: 'Not authenticated with Google. Please sign in again.',
      })
    })

    it('updates successfully', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(updatePostOnHub).mockResolvedValueOnce({
        id: 'post-1',
        title: 'Updated',
      })

      const handler = getUpdateHandler()
      const result = await handler({}, { ...VALID_PARAMS, postId: 'post-1' })

      expect(result).toEqual({ success: true, postId: 'post-1' })
      expect(updatePostOnHub).toHaveBeenCalledWith(
        'hub-jwt',
        'post-1',
        'My Keymap',
        'TestBoard',
        expect.any(Object),
      )
    })

    it('rejects invalid postId', async () => {
      const handler = getUpdateHandler()
      for (const bad of ['', '../escape', 'has/slash', 'a b c']) {
        const result = await handler(
          { sender: {} },
          { ...VALID_PARAMS, postId: bad },
        )
        expect(result).toEqual({ success: false, error: 'Invalid post ID' })
      }
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('returns error on update failure', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(updatePostOnHub).mockRejectedValueOnce(new Error('Hub update failed: 403'))

      const handler = getUpdateHandler()
      const result = await handler({ sender: {} }, { ...VALID_PARAMS, postId: 'post-1' })

      expect(result).toEqual({
        success: false,
        error: 'Hub update failed: 403',
      })
    })
  })

  describe('HUB_DELETE_POST', () => {
    function getDeleteHandler(): (...args: unknown[]) => Promise<unknown> {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const handler = (ipcMain as any)._handlers.get('hub:delete-post')
      expect(handler).toBeDefined()
      return handler
    }

    it('registers HUB_DELETE_POST handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('hub:delete-post', expect.any(Function))
    })

    it('rejects invalid postId', async () => {
      const handler = getDeleteHandler()
      for (const bad of ['', '../escape', 'has spaces']) {
        const result = await handler({}, bad)
        expect(result).toEqual({ success: false, error: 'Invalid post ID' })
      }
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('returns error when not authenticated', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce(null)

      const handler = getDeleteHandler()
      const result = await handler({}, 'post-1')

      expect(result).toEqual({
        success: false,
        error: 'Not authenticated with Google. Please sign in again.',
      })
    })

    it('returns error when auth fails', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockRejectedValueOnce(new Error('Hub auth failed: 401'))

      const handler = getDeleteHandler()
      const result = await handler({}, 'post-1')

      expect(result).toEqual({
        success: false,
        error: 'Hub auth failed: 401',
      })
    })

    it('deletes successfully', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(deletePostFromHub).mockResolvedValueOnce(undefined)

      const handler = getDeleteHandler()
      const result = await handler({}, 'post-42')

      expect(result).toEqual({ success: true })
      expect(deletePostFromHub).toHaveBeenCalledWith('hub-jwt', 'post-42')
    })

    it('returns error on API failure', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(deletePostFromHub).mockRejectedValueOnce(new Error('Hub delete failed: 500'))

      const handler = getDeleteHandler()
      const result = await handler({}, 'post-1')

      expect(result).toEqual({
        success: false,
        error: 'Hub delete failed: 500',
      })
    })
  })
})
