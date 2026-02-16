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
  patchPostOnHub: vi.fn(),
  deletePostFromHub: vi.fn(),
  fetchMyPosts: vi.fn(),
  fetchAuthMe: vi.fn(),
  patchAuthMe: vi.fn(),
  getHubOrigin: vi.fn(() => 'https://pipette-hub-worker.keymaps.workers.dev'),
}))

import { ipcMain } from 'electron'
import { getIdToken } from '../sync/google-auth'
import { authenticateWithHub, uploadPostToHub, updatePostOnHub, patchPostOnHub, deletePostFromHub, fetchMyPosts, fetchAuthMe, patchAuthMe, getHubOrigin } from '../hub/hub-client'
import { setupHubIpc } from '../hub/hub-ipc'

describe('hub-ipc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(ipcMain as any)._handlers.clear()
    setupHubIpc()
  })

  function getHandlerFor(channel: string): (...args: unknown[]) => Promise<unknown> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (ipcMain as any)._handlers.get(channel)
    expect(handler).toBeDefined()
    return handler
  }

  function mockHubAuth(): void {
    vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
    vi.mocked(authenticateWithHub).mockResolvedValueOnce({
      token: 'hub-jwt',
      user: { id: 'u1', email: 'test@example.com', display_name: null },
    })
  }

  function getHandler(): (...args: unknown[]) => Promise<unknown> {
    return getHandlerFor('hub:upload-post')
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
    mockHubAuth()
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
    mockHubAuth()
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
      return getHandlerFor('hub:update-post')
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
      mockHubAuth()
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
      mockHubAuth()
      vi.mocked(updatePostOnHub).mockRejectedValueOnce(new Error('Hub update failed: 403'))

      const handler = getUpdateHandler()
      const result = await handler({ sender: {} }, { ...VALID_PARAMS, postId: 'post-1' })

      expect(result).toEqual({
        success: false,
        error: 'Hub update failed: 403',
      })
    })
  })

  describe('HUB_PATCH_POST', () => {
    function getPatchHandler(): (...args: unknown[]) => Promise<unknown> {
      return getHandlerFor('hub:patch-post')
    }

    it('registers HUB_PATCH_POST handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('hub:patch-post', expect.any(Function))
    })

    it('rejects invalid postId', async () => {
      const handler = getPatchHandler()
      for (const bad of ['', '../escape', 'has/slash']) {
        const result = await handler({ sender: {} }, { postId: bad, title: 'x' })
        expect(result).toEqual({ success: false, error: 'Invalid post ID' })
      }
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('patches successfully', async () => {
      mockHubAuth()
      vi.mocked(patchPostOnHub).mockResolvedValueOnce(undefined)

      const handler = getPatchHandler()
      const result = await handler({ sender: {} }, { postId: 'post-1', title: 'New Title' })

      expect(result).toEqual({ success: true })
      expect(patchPostOnHub).toHaveBeenCalledWith('hub-jwt', 'post-1', { title: 'New Title' })
    })

    it('returns error on failure', async () => {
      mockHubAuth()
      vi.mocked(patchPostOnHub).mockRejectedValueOnce(new Error('Hub patch failed: 404'))

      const handler = getPatchHandler()
      const result = await handler({ sender: {} }, { postId: 'post-1', title: 'x' })

      expect(result).toEqual({ success: false, error: 'Hub patch failed: 404' })
    })
  })

  describe('HUB_DELETE_POST', () => {
    function getDeleteHandler(): (...args: unknown[]) => Promise<unknown> {
      return getHandlerFor('hub:delete-post')
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
      mockHubAuth()
      vi.mocked(deletePostFromHub).mockResolvedValueOnce(undefined)

      const handler = getDeleteHandler()
      const result = await handler({}, 'post-42')

      expect(result).toEqual({ success: true })
      expect(deletePostFromHub).toHaveBeenCalledWith('hub-jwt', 'post-42')
    })

    it('returns error on API failure', async () => {
      mockHubAuth()
      vi.mocked(deletePostFromHub).mockRejectedValueOnce(new Error('Hub delete failed: 500'))

      const handler = getDeleteHandler()
      const result = await handler({}, 'post-1')

      expect(result).toEqual({
        success: false,
        error: 'Hub delete failed: 500',
      })
    })
  })

  describe('HUB_FETCH_MY_POSTS', () => {
    function getFetchMyPostsHandler(): (...args: unknown[]) => Promise<unknown> {
      return getHandlerFor('hub:fetch-my-posts')
    }

    it('registers HUB_FETCH_MY_POSTS handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('hub:fetch-my-posts', expect.any(Function))
    })

    it('fetches posts successfully', async () => {
      const posts = [{ id: 'post-1', title: 'My Keymap', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      mockHubAuth()
      vi.mocked(fetchMyPosts).mockResolvedValueOnce(posts)

      const handler = getFetchMyPostsHandler()
      const result = await handler()

      expect(result).toEqual({ success: true, posts })
      expect(fetchMyPosts).toHaveBeenCalledWith('hub-jwt')
    })

    it('returns error on failure', async () => {
      mockHubAuth()
      vi.mocked(fetchMyPosts).mockRejectedValueOnce(new Error('Hub fetch my posts failed: 500'))

      const handler = getFetchMyPostsHandler()
      const result = await handler()

      expect(result).toEqual({
        success: false,
        error: 'Hub fetch my posts failed: 500',
      })
    })
  })

  describe('HUB_FETCH_AUTH_ME', () => {
    function getFetchAuthMeHandler(): (...args: unknown[]) => Promise<unknown> {
      return getHandlerFor('hub:fetch-auth-me')
    }

    it('registers HUB_FETCH_AUTH_ME handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('hub:fetch-auth-me', expect.any(Function))
    })

    it('fetches user info successfully', async () => {
      const user = { id: 'u1', email: 'test@example.com', display_name: 'Test User', role: 'user' }
      mockHubAuth()
      vi.mocked(fetchAuthMe).mockResolvedValueOnce(user)

      const handler = getFetchAuthMeHandler()
      const result = await handler()

      expect(result).toEqual({ success: true, user })
      expect(fetchAuthMe).toHaveBeenCalledWith('hub-jwt')
    })

    it('returns error when not authenticated', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce(null)

      const handler = getFetchAuthMeHandler()
      const result = await handler()

      expect(result).toEqual({
        success: false,
        error: 'Not authenticated with Google. Please sign in again.',
      })
    })

    it('returns error on failure', async () => {
      mockHubAuth()
      vi.mocked(fetchAuthMe).mockRejectedValueOnce(new Error('Hub fetch auth me failed: 500'))

      const handler = getFetchAuthMeHandler()
      const result = await handler()

      expect(result).toEqual({
        success: false,
        error: 'Hub fetch auth me failed: 500',
      })
    })
  })

  describe('HUB_PATCH_AUTH_ME', () => {
    function getPatchAuthMeHandler(): (...args: unknown[]) => Promise<unknown> {
      return getHandlerFor('hub:patch-auth-me')
    }

    it('registers HUB_PATCH_AUTH_ME handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('hub:patch-auth-me', expect.any(Function))
    })

    it('patches display name successfully', async () => {
      const user = { id: 'u1', email: 'test@example.com', display_name: 'New Name', role: 'user' }
      mockHubAuth()
      vi.mocked(patchAuthMe).mockResolvedValueOnce(user)

      const handler = getPatchAuthMeHandler()
      const result = await handler({}, 'New Name')

      expect(result).toEqual({ success: true, user })
      expect(patchAuthMe).toHaveBeenCalledWith('hub-jwt', 'New Name')
    })

    it('rejects null display name', async () => {
      const handler = getPatchAuthMeHandler()
      const result = await handler({}, null)

      expect(result).toEqual({ success: false, error: 'Display name must not be empty' })
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('returns error when not authenticated', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce(null)

      const handler = getPatchAuthMeHandler()
      const result = await handler({}, 'Name')

      expect(result).toEqual({
        success: false,
        error: 'Not authenticated with Google. Please sign in again.',
      })
    })

    it('returns error on failure', async () => {
      mockHubAuth()
      vi.mocked(patchAuthMe).mockRejectedValueOnce(new Error('Hub patch auth me failed: 403'))

      const handler = getPatchAuthMeHandler()
      const result = await handler({}, 'Name')

      expect(result).toEqual({
        success: false,
        error: 'Hub patch auth me failed: 403',
      })
    })

    it('rejects non-string displayName', async () => {
      const handler = getPatchAuthMeHandler()
      for (const bad of [123, true, { name: 'x' }, ['a']]) {
        const result = await handler({}, bad)
        expect(result).toEqual({ success: false, error: 'Display name must not be empty' })
      }
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('rejects display name exceeding max length', async () => {
      const handler = getPatchAuthMeHandler()
      const result = await handler({}, 'a'.repeat(51))

      expect(result).toEqual({ success: false, error: 'Display name too long' })
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('rejects whitespace-only display name', async () => {
      const handler = getPatchAuthMeHandler()
      const result = await handler({}, '   ')

      expect(result).toEqual({ success: false, error: 'Display name must not be empty' })
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('trims whitespace from display name', async () => {
      const user = { id: 'u1', email: 'test@example.com', display_name: 'Hello', role: 'user' }
      mockHubAuth()
      vi.mocked(patchAuthMe).mockResolvedValueOnce(user)

      const handler = getPatchAuthMeHandler()
      const result = await handler({}, '  Hello  ')

      expect(result).toEqual({ success: true, user })
      expect(patchAuthMe).toHaveBeenCalledWith('hub-jwt', 'Hello')
    })
  })

  describe('HUB_GET_ORIGIN', () => {
    it('registers HUB_GET_ORIGIN handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('hub:get-origin', expect.any(Function))
    })

    it('returns hub origin from client', () => {
      const handler = getHandlerFor('hub:get-origin')
      const result = handler()

      expect(result).toBe('https://pipette-hub-worker.keymaps.workers.dev')
      expect(getHubOrigin).toHaveBeenCalled()
    })
  })
})
