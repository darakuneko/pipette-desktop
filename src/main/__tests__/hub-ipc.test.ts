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

// Mock ipc-guard — bypass origin check (tested in ipc-guard.test.ts)
vi.mock('../ipc-guard', async () => {
  const { ipcMain } = await import('electron')
  return { secureHandle: ipcMain.handle }
})

// Mock google-auth
vi.mock('../sync/google-auth', () => ({
  getIdToken: vi.fn(),
}))

// Mock hub-client
vi.mock('../hub/hub-client', async () => {
  const actual = await vi.importActual<typeof import('../hub/hub-client')>('../hub/hub-client')
  return {
    Hub401Error: actual.Hub401Error,
    Hub403Error: actual.Hub403Error,
    Hub409Error: actual.Hub409Error,
    Hub429Error: actual.Hub429Error,
    authenticateWithHub: vi.fn(),
    uploadPostToHub: vi.fn(),
    updatePostOnHub: vi.fn(),
    patchPostOnHub: vi.fn(),
    deletePostFromHub: vi.fn(),
    fetchMyPosts: vi.fn(),
    fetchMyPostsByKeyboard: vi.fn(),
    fetchAuthMe: vi.fn(),
    patchAuthMe: vi.fn(),
    getHubOrigin: vi.fn(() => 'https://pipette-hub-worker.keymaps.workers.dev'),
  }
})

import { ipcMain } from 'electron'
import { getIdToken } from '../sync/google-auth'
import { HUB_ERROR_DISPLAY_NAME_CONFLICT, HUB_ERROR_ACCOUNT_DEACTIVATED, HUB_ERROR_RATE_LIMITED } from '../../shared/types/hub'
import { Hub401Error, Hub403Error, Hub409Error, Hub429Error, authenticateWithHub, uploadPostToHub, updatePostOnHub, patchPostOnHub, deletePostFromHub, fetchMyPosts, fetchMyPostsByKeyboard, fetchAuthMe, patchAuthMe, getHubOrigin } from '../hub/hub-client'
import { setupHubIpc, clearHubTokenCache } from '../hub/hub-ipc'

describe('hub-ipc', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearHubTokenCache()
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

  async function expectTitleRejection(
    handler: (...args: unknown[]) => Promise<unknown>,
    baseParams: Record<string, unknown>,
  ): Promise<void> {
    for (const [title, error] of [
      ['', 'Title must not be empty'],
      ['   ', 'Title must not be empty'],
      [undefined, 'Title must not be empty'],
      [null, 'Title must not be empty'],
      [123, 'Title must not be empty'],
      ['a'.repeat(201), 'Title too long'],
    ] as const) {
      const result = await handler({}, { ...baseParams, title })
      expect(result).toEqual({ success: false, error })
    }
    expect(getIdToken).not.toHaveBeenCalled()
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
    expect(authenticateWithHub).toHaveBeenCalledWith('id-token', undefined)
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

  it('rejects invalid titles (empty, whitespace-only, too long)', async () => {
    await expectTitleRejection(getHandler(), VALID_PARAMS)
  })

  it('trims whitespace from title', async () => {
    mockHubAuth()
    vi.mocked(uploadPostToHub).mockResolvedValueOnce({ id: 'post-1', title: 'Trimmed' })

    const handler = getHandler()
    const result = await handler({}, { ...VALID_PARAMS, title: '  Trimmed  ' })

    expect(result).toEqual({ success: true, postId: 'post-1' })
    expect(uploadPostToHub).toHaveBeenCalledWith(
      'hub-jwt',
      'Trimmed',
      'TestBoard',
      expect.any(Object),
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

  describe('file size validation', () => {
    const MB = 1024 * 1024

    it('rejects thumbnail exceeding 2 MB', async () => {
      const handler = getHandler()
      const oversized = Buffer.alloc(2 * MB + 1).toString('base64')
      const result = await handler({}, { ...VALID_PARAMS, thumbnailBase64: oversized })

      expect(result).toEqual({ success: false, error: expect.stringContaining('thumbnail') })
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it.each([
      ['vilJson', 'vil'],
      ['pippetteJson', 'pippette'],
      ['keymapC', 'keymap C'],
    ] as const)('rejects %s exceeding 10 MB', async (paramKey, errorLabel) => {
      const handler = getHandler()
      const oversized = 'x'.repeat(10 * MB + 1)
      const result = await handler({}, { ...VALID_PARAMS, [paramKey]: oversized })

      expect(result).toEqual({ success: false, error: expect.stringContaining(errorLabel) })
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('rejects pdf exceeding 10 MB', async () => {
      const handler = getHandler()
      const oversized = Buffer.alloc(10 * MB + 1).toString('base64')
      const result = await handler({}, { ...VALID_PARAMS, pdfBase64: oversized })

      expect(result).toEqual({ success: false, error: expect.stringContaining('PDF') })
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('accepts files at exact size limit', async () => {
      mockHubAuth()
      vi.mocked(uploadPostToHub).mockResolvedValueOnce({ id: 'post-1', title: 'ok' })

      const handler = getHandler()
      const exactThumbnail = Buffer.alloc(2 * MB).toString('base64')
      const result = await handler({}, { ...VALID_PARAMS, thumbnailBase64: exactThumbnail })

      expect(result).toEqual({ success: true, postId: 'post-1' })
    })

    it('also validates file sizes on update', async () => {
      const handler = getHandlerFor('hub:update-post')
      const oversized = Buffer.alloc(2 * MB + 1).toString('base64')
      const result = await handler({}, { ...VALID_PARAMS, postId: 'post-1', thumbnailBase64: oversized })

      expect(result).toEqual({ success: false, error: expect.stringContaining('thumbnail') })
      expect(getIdToken).not.toHaveBeenCalled()
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

    it('rejects invalid titles (empty, whitespace-only, too long)', async () => {
      await expectTitleRejection(getUpdateHandler(), { ...VALID_PARAMS, postId: 'post-1' })
    })

    it('trims whitespace from title', async () => {
      mockHubAuth()
      vi.mocked(updatePostOnHub).mockResolvedValueOnce({ id: 'post-1', title: 'Trimmed' })

      const handler = getUpdateHandler()
      const result = await handler({}, { ...VALID_PARAMS, postId: 'post-1', title: '  Trimmed  ' })

      expect(result).toEqual({ success: true, postId: 'post-1' })
      expect(updatePostOnHub).toHaveBeenCalledWith(
        'hub-jwt',
        'post-1',
        'Trimmed',
        'TestBoard',
        expect.any(Object),
      )
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

    it('rejects invalid titles (empty, whitespace-only, too long)', async () => {
      await expectTitleRejection(getPatchHandler(), { postId: 'post-1' })
    })

    it('trims whitespace from title', async () => {
      mockHubAuth()
      vi.mocked(patchPostOnHub).mockResolvedValueOnce(undefined)

      const handler = getPatchHandler()
      const result = await handler({}, { postId: 'post-1', title: '  Trimmed Title  ' })

      expect(result).toEqual({ success: true })
      expect(patchPostOnHub).toHaveBeenCalledWith('hub-jwt', 'post-1', { title: 'Trimmed Title' })
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

    it('fetches posts successfully with pagination metadata', async () => {
      const posts = [{ id: 'post-1', title: 'My Keymap', keyboard_name: 'TestBoard', created_at: '2025-01-15T10:30:00Z' }]
      mockHubAuth()
      vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: posts, total: 1, page: 1, per_page: 10 })

      const handler = getFetchMyPostsHandler()
      const result = await handler({})

      expect(result).toEqual({
        success: true,
        posts,
        pagination: { total: 1, page: 1, per_page: 10, total_pages: 1 },
      })
      expect(fetchMyPosts).toHaveBeenCalledWith('hub-jwt', { page: undefined, per_page: undefined })
    })

    it('passes page and per_page params to fetchMyPosts', async () => {
      mockHubAuth()
      vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: [], total: 25, page: 3, per_page: 10 })

      const handler = getFetchMyPostsHandler()
      const result = await handler({}, { page: 3, per_page: 10 })

      expect(fetchMyPosts).toHaveBeenCalledWith('hub-jwt', { page: 3, per_page: 10 })
      expect(result).toEqual({
        success: true,
        posts: [],
        pagination: { total: 25, page: 3, per_page: 10, total_pages: 3 },
      })
    })

    it('clamps page to minimum 1', async () => {
      mockHubAuth()
      vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: [], total: 0, page: 1, per_page: 10 })

      const handler = getFetchMyPostsHandler()
      await handler({}, { page: -5, per_page: 10 })

      expect(fetchMyPosts).toHaveBeenCalledWith('hub-jwt', { page: 1, per_page: 10 })
    })

    it('clamps per_page to 1-100 range', async () => {
      mockHubAuth()
      vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: [], total: 0, page: 1, per_page: 100 })

      const handler = getFetchMyPostsHandler()
      await handler({}, { page: 1, per_page: 200 })

      expect(fetchMyPosts).toHaveBeenCalledWith('hub-jwt', { page: 1, per_page: 100 })
    })

    it('ignores non-finite page and per_page values', async () => {
      const handler = getFetchMyPostsHandler()
      for (const bad of [NaN, Infinity, -Infinity]) {
        clearHubTokenCache()
        mockHubAuth()
        vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: [], total: 0, page: 1, per_page: 10 })

        await handler({}, { page: bad, per_page: bad })

        expect(fetchMyPosts).toHaveBeenLastCalledWith('hub-jwt', { page: undefined, per_page: undefined })
      }
    })

    it('handles per_page=0 from backend without Infinity total_pages', async () => {
      mockHubAuth()
      vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: [], total: 5, page: 1, per_page: 0 })

      const handler = getFetchMyPostsHandler()
      const result = await handler({})

      expect(result).toEqual({
        success: true,
        posts: [],
        pagination: { total: 5, page: 1, per_page: 0, total_pages: 5 },
      })
    })

    it('sanitizes non-finite backend total and per_page', async () => {
      mockHubAuth()
      vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: [], total: NaN, page: 1, per_page: NaN })

      const handler = getFetchMyPostsHandler()
      const result = await handler({})

      expect(result).toEqual({
        success: true,
        posts: [],
        pagination: { total: NaN, page: 1, per_page: NaN, total_pages: 1 },
      })
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

    it('returns DISPLAY_NAME_CONFLICT on Hub409Error', async () => {
      mockHubAuth()
      vi.mocked(patchAuthMe).mockRejectedValueOnce(new Hub409Error('Hub patch auth me failed', 'Display name already taken'))

      const handler = getPatchAuthMeHandler()
      const result = await handler({}, 'TakenName')

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_DISPLAY_NAME_CONFLICT,
      })
      expect(getIdToken).toHaveBeenCalled()
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

  describe('HUB_FETCH_MY_KEYBOARD_POSTS', () => {
    function getFetchKeyboardPostsHandler(): (...args: unknown[]) => Promise<unknown> {
      return getHandlerFor('hub:fetch-my-keyboard-posts')
    }

    it('registers HUB_FETCH_MY_KEYBOARD_POSTS handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('hub:fetch-my-keyboard-posts', expect.any(Function))
    })

    it('fetches keyboard posts successfully', async () => {
      const posts = [{ id: 'post-1', title: 'My Keymap', keyboard_name: 'Corne', created_at: '2025-01-15T10:30:00Z' }]
      mockHubAuth()
      vi.mocked(fetchMyPostsByKeyboard).mockResolvedValueOnce(posts)

      const handler = getFetchKeyboardPostsHandler()
      const result = await handler({}, 'Corne')

      expect(result).toEqual({ success: true, posts })
      expect(fetchMyPostsByKeyboard).toHaveBeenCalledWith('hub-jwt', 'Corne')
    })

    it('rejects empty keyboard name', async () => {
      const handler = getFetchKeyboardPostsHandler()
      const result = await handler({}, '')

      expect(result).toEqual({ success: false, error: 'Missing keyboard name' })
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('rejects non-string keyboard name', async () => {
      const handler = getFetchKeyboardPostsHandler()
      const result = await handler({}, 123)

      expect(result).toEqual({ success: false, error: 'Missing keyboard name' })
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('rejects keyboard name exceeding 100 characters', async () => {
      const handler = getFetchKeyboardPostsHandler()
      const result = await handler({}, 'a'.repeat(101))

      expect(result).toEqual({ success: false, error: 'Keyboard name too long' })
      expect(getIdToken).not.toHaveBeenCalled()
    })

    it('trims whitespace from keyboard name', async () => {
      mockHubAuth()
      vi.mocked(fetchMyPostsByKeyboard).mockResolvedValueOnce([])

      const handler = getFetchKeyboardPostsHandler()
      await handler({}, '  Corne  ')

      expect(fetchMyPostsByKeyboard).toHaveBeenCalledWith('hub-jwt', 'Corne')
    })

    it('returns error on failure', async () => {
      mockHubAuth()
      vi.mocked(fetchMyPostsByKeyboard).mockRejectedValueOnce(new Error('Hub fetch keyboard posts failed: 500'))

      const handler = getFetchKeyboardPostsHandler()
      const result = await handler({}, 'Corne')

      expect(result).toEqual({
        success: false,
        error: 'Hub fetch keyboard posts failed: 500',
      })
    })
  })

  describe('Hub JWT caching', () => {
    it('reuses cached token for consecutive API calls', async () => {
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValue({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(fetchMyPosts).mockResolvedValue({ items: [], total: 0, page: 1, per_page: 10 })
      vi.mocked(fetchAuthMe).mockResolvedValue({ id: 'u1', email: 'test@example.com', display_name: null })

      const fetchPostsHandler = getHandlerFor('hub:fetch-my-posts')
      const fetchAuthHandler = getHandlerFor('hub:fetch-auth-me')

      await fetchPostsHandler()
      await fetchAuthHandler()

      expect(authenticateWithHub).toHaveBeenCalledTimes(1)
    })

    it('deduplicates concurrent auth requests', async () => {
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValue({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(fetchMyPosts).mockResolvedValue({ items: [], total: 0, page: 1, per_page: 10 })
      vi.mocked(fetchMyPostsByKeyboard).mockResolvedValue([])
      vi.mocked(fetchAuthMe).mockResolvedValue({ id: 'u1', email: 'test@example.com', display_name: null })

      const fetchPostsHandler = getHandlerFor('hub:fetch-my-posts')
      const fetchKeyboardHandler = getHandlerFor('hub:fetch-my-keyboard-posts')
      const fetchAuthHandler = getHandlerFor('hub:fetch-auth-me')

      await Promise.all([
        fetchPostsHandler(),
        fetchKeyboardHandler({}, 'TestBoard'),
        fetchAuthHandler(),
      ])

      expect(authenticateWithHub).toHaveBeenCalledTimes(1)
    })

    it('clearHubTokenCache forces re-authentication', async () => {
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValue({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(fetchMyPosts).mockResolvedValue({ items: [], total: 0, page: 1, per_page: 10 })

      const handler = getHandlerFor('hub:fetch-my-posts')
      await handler()
      expect(authenticateWithHub).toHaveBeenCalledTimes(1)

      clearHubTokenCache()
      await handler()
      expect(authenticateWithHub).toHaveBeenCalledTimes(2)
    })

    it('does not cache token when auth fails', async () => {
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub)
        .mockRejectedValueOnce(new Error('Hub auth failed: 401'))
        .mockResolvedValueOnce({
          token: 'hub-jwt',
          user: { id: 'u1', email: 'test@example.com', display_name: null },
        })
      vi.mocked(fetchMyPosts).mockResolvedValue({ items: [], total: 0, page: 1, per_page: 10 })

      const handler = getHandlerFor('hub:fetch-my-posts')
      const result1 = await handler()
      expect(result1).toEqual({ success: false, error: 'Hub auth failed: 401' })

      const result2 = await handler()
      expect(result2).toEqual({
        success: true,
        posts: [],
        pagination: { total: 0, page: 1, per_page: 10, total_pages: 1 },
      })
      expect(authenticateWithHub).toHaveBeenCalledTimes(2)
    })

    it('does not write cache if cleared during inflight auth', async () => {
      let resolveAuth!: (value: { token: string; user: { id: string; email: string; display_name: null } }) => void
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub).mockImplementationOnce(
        () => new Promise((r) => { resolveAuth = r }),
      )
      vi.mocked(fetchMyPosts).mockResolvedValue({ items: [], total: 0, page: 1, per_page: 10 })

      const handler = getHandlerFor('hub:fetch-my-posts')
      const pending = handler()

      // Wait for authenticateWithHub to be called (after getIdToken microtask)
      await vi.waitFor(() => expect(authenticateWithHub).toHaveBeenCalledTimes(1))

      // Sign-out while auth is in flight
      clearHubTokenCache()

      // Resolve the inflight auth
      resolveAuth({ token: 'stale-jwt', user: { id: 'u1', email: 'test@example.com', display_name: null } })
      await pending

      // Next call should re-authenticate (stale-jwt was not cached)
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'fresh-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      await handler()
      expect(authenticateWithHub).toHaveBeenCalledTimes(2)
    })
  })

  describe('withTokenRetry', () => {
    function mockHubAuthPersistent(): void {
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValue({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
    }

    it('retries on Hub401Error and succeeds on second attempt', async () => {
      mockHubAuthPersistent()
      vi.mocked(fetchAuthMe)
        .mockRejectedValueOnce(new Hub401Error('Hub fetch auth me failed', 'Unauthorized'))
        .mockResolvedValueOnce({ id: 'u1', email: 'test@example.com', display_name: 'User' })

      const handler = getHandlerFor('hub:fetch-auth-me')
      const result = await handler()

      expect(result).toEqual({
        success: true,
        user: { id: 'u1', email: 'test@example.com', display_name: 'User' },
      })
      expect(authenticateWithHub).toHaveBeenCalledTimes(2)
      expect(fetchAuthMe).toHaveBeenCalledTimes(2)
    })

    it('does not retry more than once on consecutive 401s', async () => {
      mockHubAuthPersistent()
      vi.mocked(fetchAuthMe)
        .mockRejectedValueOnce(new Hub401Error('Hub fetch auth me failed', 'Unauthorized'))
        .mockRejectedValueOnce(new Hub401Error('Hub fetch auth me failed', 'Unauthorized'))

      const handler = getHandlerFor('hub:fetch-auth-me')
      const result = await handler()

      expect(result).toEqual({
        success: false,
        error: 'Hub fetch auth me failed: 401 Unauthorized',
      })
      expect(fetchAuthMe).toHaveBeenCalledTimes(2)
    })

    it('does not retry on non-401 errors', async () => {
      mockHubAuthPersistent()
      vi.mocked(fetchAuthMe)
        .mockRejectedValueOnce(new Error('Hub fetch auth me failed: 500 Internal Server Error'))

      const handler = getHandlerFor('hub:fetch-auth-me')
      const result = await handler()

      expect(result).toEqual({
        success: false,
        error: 'Hub fetch auth me failed: 500 Internal Server Error',
      })
      expect(fetchAuthMe).toHaveBeenCalledTimes(1)
    })

    it('retries upload handler on 401', async () => {
      mockHubAuthPersistent()
      vi.mocked(uploadPostToHub)
        .mockRejectedValueOnce(new Hub401Error('Hub upload failed', 'Unauthorized'))
        .mockResolvedValueOnce({ id: 'post-1', title: 'My Keymap' })

      const handler = getHandlerFor('hub:upload-post')
      const result = await handler({}, VALID_PARAMS)

      expect(result).toEqual({ success: true, postId: 'post-1' })
      expect(uploadPostToHub).toHaveBeenCalledTimes(2)
      expect(authenticateWithHub).toHaveBeenCalledTimes(2)
    })

    it('propagates auth failure during retry', async () => {
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub)
        .mockResolvedValueOnce({
          token: 'hub-jwt',
          user: { id: 'u1', email: 'test@example.com', display_name: null },
        })
        .mockRejectedValueOnce(new Error('Hub auth failed: 401 Unauthorized'))
      vi.mocked(fetchAuthMe)
        .mockRejectedValueOnce(new Hub401Error('Hub fetch auth me failed', 'Unauthorized'))

      const handler = getHandlerFor('hub:fetch-auth-me')
      const result = await handler()

      expect(result).toEqual({
        success: false,
        error: 'Hub auth failed: 401 Unauthorized',
      })
    })
  })

  describe('403 account deactivated', () => {
    function mockHubAuthPersistent(): void {
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValue({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
    }

    it('returns ACCOUNT_DEACTIVATED when fetchMyPosts throws Hub403Error', async () => {
      mockHubAuthPersistent()
      vi.mocked(fetchMyPosts).mockRejectedValueOnce(
        new Hub403Error('Hub fetch my posts failed', 'Account is deactivated'),
      )

      const handler = getHandlerFor('hub:fetch-my-posts')
      const result = await handler({})

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_ACCOUNT_DEACTIVATED,
      })
    })

    it('returns ACCOUNT_DEACTIVATED when uploadPostToHub throws Hub403Error', async () => {
      mockHubAuthPersistent()
      vi.mocked(uploadPostToHub).mockRejectedValueOnce(
        new Hub403Error('Hub upload failed', 'Account is deactivated'),
      )

      const handler = getHandlerFor('hub:upload-post')
      const result = await handler({}, VALID_PARAMS)

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_ACCOUNT_DEACTIVATED,
      })
    })

    it('returns ACCOUNT_DEACTIVATED when fetchAuthMe throws Hub403Error', async () => {
      mockHubAuthPersistent()
      vi.mocked(fetchAuthMe).mockRejectedValueOnce(
        new Hub403Error('Hub fetch auth me failed', 'Account is deactivated'),
      )

      const handler = getHandlerFor('hub:fetch-auth-me')
      const result = await handler()

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_ACCOUNT_DEACTIVATED,
      })
    })

    it('returns ACCOUNT_DEACTIVATED when deletePostFromHub throws Hub403Error', async () => {
      mockHubAuthPersistent()
      vi.mocked(deletePostFromHub).mockRejectedValueOnce(
        new Hub403Error('Hub delete failed', 'Account is deactivated'),
      )

      const handler = getHandlerFor('hub:delete-post')
      const result = await handler({}, 'post-1')

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_ACCOUNT_DEACTIVATED,
      })
    })

    it('returns ACCOUNT_DEACTIVATED when authenticateWithHub throws Hub403Error (token acquisition)', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockRejectedValueOnce(
        new Hub403Error('Hub auth failed', 'Account is deactivated'),
      )

      const handler = getHandlerFor('hub:fetch-my-posts')
      const result = await handler({})

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_ACCOUNT_DEACTIVATED,
      })
    })

    it('returns ACCOUNT_DEACTIVATED when 403 occurs on post-401 retry path', async () => {
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValue({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(fetchAuthMe)
        .mockRejectedValueOnce(new Hub401Error('Hub fetch auth me failed', 'Unauthorized'))
        .mockRejectedValueOnce(new Hub403Error('Hub fetch auth me failed', 'Account is deactivated'))

      const handler = getHandlerFor('hub:fetch-auth-me')
      const result = await handler()

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_ACCOUNT_DEACTIVATED,
      })
    })
  })

  describe('auth 409 display name conflict', () => {
    it('returns DISPLAY_NAME_CONFLICT when authenticateWithHub throws Hub409Error', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockRejectedValueOnce(
        new Hub409Error('Hub auth failed', 'Conflict'),
      )

      const handler = getHandlerFor('hub:fetch-my-posts')
      const result = await handler({})

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_DISPLAY_NAME_CONFLICT,
      })
    })

    it('returns DISPLAY_NAME_CONFLICT on any IPC handler when auth 409 occurs', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockRejectedValueOnce(
        new Hub409Error('Hub auth failed', 'Conflict'),
      )

      const handler = getHandlerFor('hub:fetch-auth-me')
      const result = await handler()

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_DISPLAY_NAME_CONFLICT,
      })
    })
  })

  describe('HUB_SET_AUTH_DISPLAY_NAME', () => {
    it('registers HUB_SET_AUTH_DISPLAY_NAME handler', () => {
      expect(ipcMain.handle).toHaveBeenCalledWith('hub:set-auth-display-name', expect.any(Function))
    })

    it('sets pendingAuthDisplayName and uses it in next auth', async () => {
      const setHandler = getHandlerFor('hub:set-auth-display-name')
      setHandler({}, 'CustomName')

      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: 'CustomName' },
      })
      vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: [], total: 0, page: 1, per_page: 10 })

      const fetchHandler = getHandlerFor('hub:fetch-my-posts')
      await fetchHandler({})

      expect(authenticateWithHub).toHaveBeenCalledWith('id-token', 'CustomName')
    })

    it('clears pendingAuthDisplayName when null is passed', async () => {
      const setHandler = getHandlerFor('hub:set-auth-display-name')
      setHandler({}, 'SomeName')
      setHandler({}, null)

      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: [], total: 0, page: 1, per_page: 10 })

      const fetchHandler = getHandlerFor('hub:fetch-my-posts')
      await fetchHandler({})

      expect(authenticateWithHub).toHaveBeenCalledWith('id-token', undefined)
    })

    it('clearHubTokenCache also clears pendingAuthDisplayName', async () => {
      const setHandler = getHandlerFor('hub:set-auth-display-name')
      setHandler({}, 'SomeName')

      clearHubTokenCache()

      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: [], total: 0, page: 1, per_page: 10 })

      const fetchHandler = getHandlerFor('hub:fetch-my-posts')
      await fetchHandler({})

      expect(authenticateWithHub).toHaveBeenCalledWith('id-token', undefined)
    })

    it('invalidates cached JWT when display name is set so next auth uses it', async () => {
      // First, populate the JWT cache
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'hub-jwt-1',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(fetchMyPosts).mockResolvedValue({ items: [], total: 0, page: 1, per_page: 10 })

      const fetchHandler = getHandlerFor('hub:fetch-my-posts')
      await fetchHandler({})
      expect(authenticateWithHub).toHaveBeenCalledTimes(1)

      // Now set display name — this should invalidate the cache
      const setHandler = getHandlerFor('hub:set-auth-display-name')
      setHandler({}, 'NewName')

      // Next call should re-authenticate with the new display name
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'hub-jwt-2',
        user: { id: 'u1', email: 'test@example.com', display_name: 'NewName' },
      })
      await fetchHandler({})

      expect(authenticateWithHub).toHaveBeenCalledTimes(2)
      expect(authenticateWithHub).toHaveBeenLastCalledWith('id-token', 'NewName')
    })

    it('rejects non-string displayName by setting null', async () => {
      const setHandler = getHandlerFor('hub:set-auth-display-name')
      setHandler({}, 123)

      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValueOnce({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
      vi.mocked(fetchMyPosts).mockResolvedValueOnce({ items: [], total: 0, page: 1, per_page: 10 })

      const fetchHandler = getHandlerFor('hub:fetch-my-posts')
      await fetchHandler({})

      expect(authenticateWithHub).toHaveBeenCalledWith('id-token', undefined)
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

  describe('429 rate limiting', () => {
    function mockHubAuthPersistent(): void {
      vi.mocked(getIdToken).mockResolvedValue('id-token')
      vi.mocked(authenticateWithHub).mockResolvedValue({
        token: 'hub-jwt',
        user: { id: 'u1', email: 'test@example.com', display_name: null },
      })
    }

    it('returns RATE_LIMITED when fetchMyPosts throws Hub429Error', async () => {
      mockHubAuthPersistent()
      vi.mocked(fetchMyPosts).mockRejectedValueOnce(
        new Hub429Error('Hub fetch my posts failed', 'Too Many Requests'),
      )

      const handler = getHandlerFor('hub:fetch-my-posts')
      const result = await handler({})

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_RATE_LIMITED,
      })
    })

    it('returns RATE_LIMITED when uploadPostToHub throws Hub429Error', async () => {
      mockHubAuthPersistent()
      vi.mocked(uploadPostToHub).mockRejectedValueOnce(
        new Hub429Error('Hub upload failed', 'Too Many Requests'),
      )

      const handler = getHandlerFor('hub:upload-post')
      const result = await handler({}, VALID_PARAMS)

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_RATE_LIMITED,
      })
    })

    it('returns RATE_LIMITED when deletePostFromHub throws Hub429Error', async () => {
      mockHubAuthPersistent()
      vi.mocked(deletePostFromHub).mockRejectedValueOnce(
        new Hub429Error('Hub delete failed', 'Too Many Requests'),
      )

      const handler = getHandlerFor('hub:delete-post')
      const result = await handler({}, 'post-1')

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_RATE_LIMITED,
      })
    })

    it('returns RATE_LIMITED when authenticateWithHub throws Hub429Error (token acquisition)', async () => {
      vi.mocked(getIdToken).mockResolvedValueOnce('id-token')
      vi.mocked(authenticateWithHub).mockRejectedValueOnce(
        new Hub429Error('Hub auth failed', 'Too Many Requests'),
      )

      const handler = getHandlerFor('hub:fetch-my-posts')
      const result = await handler({})

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_RATE_LIMITED,
      })
    })

    it('returns RATE_LIMITED when patchAuthMe throws Hub429Error', async () => {
      mockHubAuthPersistent()
      vi.mocked(patchAuthMe).mockRejectedValueOnce(
        new Hub429Error('Hub patch auth me failed', 'Too Many Requests'),
      )

      const handler = getHandlerFor('hub:patch-auth-me')
      const result = await handler({}, 'SomeName')

      expect(result).toEqual({
        success: false,
        error: HUB_ERROR_RATE_LIMITED,
      })
    })
  })
})
