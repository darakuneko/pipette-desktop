// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { Hub401Error, Hub403Error, Hub409Error, Hub429Error, authenticateWithHub, uploadPostToHub, deletePostFromHub, updatePostOnHub, fetchMyPosts, fetchMyPostsByKeyboard, patchPostOnHub, getHubOrigin, patchAuthMe, type HubUploadFiles } from '../hub/hub-client'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('hub-client', () => {
  beforeAll(() => {
    // Ensure env var doesn't leak from the developer's shell
    delete process.env.PIPETTE_HUB_URL
    delete process.env.ELECTRON_RENDERER_URL
  })

  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('uses PIPETTE_HUB_URL env var in dev mode', async () => {
    process.env.PIPETTE_HUB_URL = 'http://localhost:8788'
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173'
    try {
      vi.resetModules()
      const { authenticateWithHub: authFn } = await import('../hub/hub-client')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: { token: 't', user: { id: '1', email: 'a@b.c', display_name: null } },
        }),
      })
      await authFn('token')
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:8788/api/auth/token',
        expect.anything(),
      )
    } finally {
      delete process.env.PIPETTE_HUB_URL
      delete process.env.ELECTRON_RENDERER_URL
      vi.resetModules()
    }
  })

  it('ignores PIPETTE_HUB_URL in production mode', async () => {
    process.env.PIPETTE_HUB_URL = 'http://localhost:8788'
    delete process.env.ELECTRON_RENDERER_URL
    try {
      vi.resetModules()
      const { authenticateWithHub: authFn } = await import('../hub/hub-client')
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: { token: 't', user: { id: '1', email: 'a@b.c', display_name: null } },
        }),
      })
      await authFn('token')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://pipette-hub-worker.keymaps.workers.dev/api/auth/token',
        expect.anything(),
      )
    } finally {
      delete process.env.PIPETTE_HUB_URL
      vi.resetModules()
    }
  })

  describe('authenticateWithHub', () => {
    it('exchanges id_token for Hub JWT', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            token: 'hub-jwt-token',
            user: { id: 'user-1', email: 'test@example.com', display_name: null },
          },
        }),
      })

      const result = await authenticateWithHub('google-id-token')

      expect(result.token).toBe('hub-jwt-token')
      expect(result.user.email).toBe('test@example.com')
      expect(mockFetch).toHaveBeenCalledWith(
        'https://pipette-hub-worker.keymaps.workers.dev/api/auth/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id_token: 'google-id-token' }),
        }),
      )
    })

    it('throws Hub401Error on 401 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      })

      const err = await authenticateWithHub('bad-token').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Hub401Error)
      expect((err as Error).message).toBe('Hub auth failed: 401 Unauthorized')
    })

    it('throws Hub403Error on 403 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Account is deactivated',
      })

      const err = await authenticateWithHub('token').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Hub403Error)
      expect((err as Error).message).toBe('Hub auth failed: 403 Account is deactivated')
    })

    it('throws Hub409Error on 409 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => 'Conflict',
      })

      const err = await authenticateWithHub('token').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Hub409Error)
      expect((err as Error).message).toBe('Hub auth failed: 409 Conflict')
    })

    it('throws plain Error on non-401/non-403/non-409 HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })

      const err = await authenticateWithHub('token').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Error)
      expect(err).not.toBeInstanceOf(Hub401Error)
      expect(err).not.toBeInstanceOf(Hub403Error)
      expect(err).not.toBeInstanceOf(Hub409Error)
      expect((err as Error).message).toBe('Hub auth failed: 500 Internal Server Error')
    })

    it('sends display_name when displayName is provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            token: 'hub-jwt-token',
            user: { id: 'user-1', email: 'test@example.com', display_name: 'Custom Name' },
          },
        }),
      })

      await authenticateWithHub('google-id-token', 'Custom Name')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://pipette-hub-worker.keymaps.workers.dev/api/auth/token',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id_token: 'google-id-token', display_name: 'Custom Name' }),
        }),
      )
    })

    it('sends only id_token when displayName is undefined', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          ok: true,
          data: {
            token: 'hub-jwt-token',
            user: { id: 'user-1', email: 'test@example.com', display_name: null },
          },
        }),
      })

      await authenticateWithHub('google-id-token')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://pipette-hub-worker.keymaps.workers.dev/api/auth/token',
        expect.objectContaining({
          body: JSON.stringify({ id_token: 'google-id-token' }),
        }),
      )
    })

    it('throws on payload-level failure (HTTP 200 + ok:false)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'Invalid or expired token' }),
      })

      await expect(authenticateWithHub('expired-token')).rejects.toThrow(
        'Hub auth failed: Invalid or expired token',
      )
    })
  })

  describe('uploadPostToHub', () => {
    const testFiles: HubUploadFiles = {
      vil: { name: 'test.vil', data: Buffer.from('{"keymap":{}}') },
      pippette: { name: 'test.pippette', data: Buffer.from('{"uid":"0x1234"}') },
      c: { name: 'test.c', data: Buffer.from('const uint16_t PROGMEM keymaps[]') },
      pdf: { name: 'test.pdf', data: Buffer.from('pdf-content') },
      thumbnail: { name: 'test.jpg', data: Buffer.from('jpeg-data') },
    }

    it('uploads files as multipart form data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'post-123', title: 'My Keymap' } }),
      })

      const result = await uploadPostToHub('jwt-token', 'My Keymap', 'TestBoard', testFiles)

      expect(result.id).toBe('post-123')
      expect(result.title).toBe('My Keymap')

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://pipette-hub-worker.keymaps.workers.dev/api/files')
      expect(options.method).toBe('POST')
      expect(options.headers.Authorization).toBe('Bearer jwt-token')
      expect(options.headers['Content-Type']).toContain('multipart/form-data')

      const bodyStr = options.body.toString()
      expect(bodyStr).toContain('name="title"')
      expect(bodyStr).toContain('name="keyboard_name"')
      expect(bodyStr).toContain('name="vil"')
      expect(bodyStr).toContain('name="pippette"')
      expect(bodyStr).toContain('name="c"')
      expect(bodyStr).toContain('name="pdf"')
      expect(bodyStr).toContain('name="thumbnail"')
    })

    it('sanitizes CRLF in text field values', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'post-456', title: 'sanitized' } }),
      })

      await uploadPostToHub('jwt', 'Title\r\nWith\nNewlines', 'Board\rName', testFiles)

      const [, options] = mockFetch.mock.calls[0]
      const bodyStr = options.body.toString()
      expect(bodyStr).not.toContain('Title\r\nWith')
      expect(bodyStr).not.toContain('Board\rName')
      expect(bodyStr).toContain('Title With Newlines')
      expect(bodyStr).toContain('Board Name')
    })

    it('throws on upload failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })

      await expect(
        uploadPostToHub('jwt-token', 'title', 'board', testFiles),
      ).rejects.toThrow('Hub upload failed: 500')
    })
  })

  describe('deletePostFromHub', () => {
    it('sends DELETE request with authorization', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'post-123' } }),
      })

      await deletePostFromHub('jwt-token', 'post-123')

      expect(mockFetch).toHaveBeenCalledWith(
        'https://pipette-hub-worker.keymaps.workers.dev/api/files/post-123',
        expect.objectContaining({
          method: 'DELETE',
          headers: { Authorization: 'Bearer jwt-token' },
        }),
      )
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      })

      await expect(deletePostFromHub('jwt', 'bad-id')).rejects.toThrow('Hub delete failed: 404')
    })

    it('throws on payload-level failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'Forbidden' }),
      })

      await expect(deletePostFromHub('jwt', 'post-1')).rejects.toThrow('Hub delete failed: Forbidden')
    })
  })

  describe('fetchMyPosts', () => {
    it('returns page object with items', async () => {
      const posts = [
        { id: 'post-1', title: 'My Keymap' },
        { id: 'post-2', title: 'Second Layout' },
      ]
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { items: posts, total: 2, page: 1, per_page: 20 } }),
      })

      const result = await fetchMyPosts('jwt-token')

      expect(result).toEqual({ items: posts, total: 2, page: 1, per_page: 20 })
      expect(mockFetch).toHaveBeenCalledWith(
        'https://pipette-hub-worker.keymaps.workers.dev/api/files/me',
        expect.objectContaining({
          method: 'GET',
          headers: { Authorization: 'Bearer jwt-token' },
        }),
      )
    })

    it('appends page and per_page query parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { items: [], total: 0, page: 2, per_page: 10 } }),
      })

      await fetchMyPosts('jwt-token', { page: 2, per_page: 10 })

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://pipette-hub-worker.keymaps.workers.dev/api/files/me?page=2&per_page=10')
    })

    it('omits query string when no params are provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { items: [], total: 0, page: 1, per_page: 20 } }),
      })

      await fetchMyPosts('jwt-token')

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://pipette-hub-worker.keymaps.workers.dev/api/files/me')
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      })

      await expect(fetchMyPosts('bad-jwt')).rejects.toThrow('Hub fetch my posts failed: 401')
    })

    it('throws on payload-level failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'Token expired' }),
      })

      await expect(fetchMyPosts('expired-jwt')).rejects.toThrow('Hub fetch my posts failed: Token expired')
    })
  })

  describe('patchPostOnHub', () => {
    it('sends PATCH request with JSON body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: {} }),
      })

      await patchPostOnHub('jwt', 'post-1', { title: 'New Title' })

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://pipette-hub-worker.keymaps.workers.dev/api/files/post-1')
      expect(options.method).toBe('PATCH')
      expect(options.headers.Authorization).toBe('Bearer jwt')
      expect(options.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(options.body as string)).toEqual({ title: 'New Title' })
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        text: async () => 'Not Found',
      })

      await expect(patchPostOnHub('jwt', 'bad-id', { title: 'x' })).rejects.toThrow('Hub patch failed: 404')
    })

    it('encodes postId in URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: {} }),
      })

      await patchPostOnHub('jwt', 'id with spaces', { title: 'test' })

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://pipette-hub-worker.keymaps.workers.dev/api/files/id%20with%20spaces')
    })
  })

  describe('patchAuthMe', () => {
    it('throws Hub409Error on 409 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => 'Display name already taken',
      })

      const err = await patchAuthMe('jwt', 'TakenName').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Hub409Error)
      expect((err as Error).message).toBe('Hub patch auth me failed: 409 Display name already taken')
    })
  })

  describe('updatePostOnHub', () => {
    const testFiles: HubUploadFiles = {
      vil: { name: 'test.vil', data: Buffer.from('{"keymap":{}}') },
      pippette: { name: 'test.pippette', data: Buffer.from('{"uid":"0x1234"}') },
      c: { name: 'test.c', data: Buffer.from('const uint16_t PROGMEM keymaps[]') },
      pdf: { name: 'test.pdf', data: Buffer.from('pdf-content') },
      thumbnail: { name: 'test.jpg', data: Buffer.from('jpeg-data') },
    }

    it('sends PUT request with multipart body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'post-123', title: 'Updated' } }),
      })

      const result = await updatePostOnHub('jwt', 'post-123', 'Updated', 'Board', testFiles)

      expect(result.id).toBe('post-123')
      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://pipette-hub-worker.keymaps.workers.dev/api/files/post-123')
      expect(options.method).toBe('PUT')
      expect(options.headers.Authorization).toBe('Bearer jwt')
      expect(options.headers['Content-Type']).toContain('multipart/form-data')
    })

    it('throws Hub403Error on 403 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      })

      const err = await updatePostOnHub('jwt', 'post-1', 'title', 'board', testFiles).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Hub403Error)
      expect((err as Error).message).toBe('Hub update failed: 403 Forbidden')
    })

  })

  describe('fetchMyPostsByKeyboard', () => {
    it('sends keyboard name as query parameter', async () => {
      const posts = [
        { id: 'post-1', title: 'My Keymap', keyboard_name: 'Corne', created_at: '2025-01-15T10:30:00Z' },
      ]
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: posts }),
      })

      const result = await fetchMyPostsByKeyboard('jwt-token', 'Corne')

      expect(result).toEqual(posts)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://pipette-hub-worker.keymaps.workers.dev/api/files/me/keyboard?name=Corne',
        expect.objectContaining({
          method: 'GET',
          headers: { Authorization: 'Bearer jwt-token' },
        }),
      )
    })

    it('encodes keyboard name with special characters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: [] }),
      })

      await fetchMyPostsByKeyboard('jwt', 'My Board / v2')

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://pipette-hub-worker.keymaps.workers.dev/api/files/me/keyboard?name=My%20Board%20%2F%20v2')
    })

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Missing name',
      })

      await expect(fetchMyPostsByKeyboard('jwt', '')).rejects.toThrow('Hub fetch keyboard posts failed: 400')
    })

    it('throws on payload-level failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'Invalid name' }),
      })

      await expect(fetchMyPostsByKeyboard('jwt', 'x')).rejects.toThrow('Hub fetch keyboard posts failed: Invalid name')
    })
  })

  describe('getHubOrigin', () => {
    it('returns default Hub origin', () => {
      expect(getHubOrigin()).toBe('https://pipette-hub-worker.keymaps.workers.dev')
    })
  })

  describe('429 rate limiting', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('throws Hub429Error on 429 response without Retry-After', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: () => null },
        text: async () => 'Too Many Requests',
      })

      const err = await authenticateWithHub('token').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Hub429Error)
      expect((err as Hub429Error).retryAfterSeconds).toBeNull()
    })

    it('throws Hub429Error on 429 with Retry-After exceeding max wait', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '120' : null },
        text: async () => 'Too Many Requests',
      })

      const err = await authenticateWithHub('token').catch((e: unknown) => e)
      expect(err).toBeInstanceOf(Hub429Error)
      expect((err as Hub429Error).retryAfterSeconds).toBe(120)
    })

    it('retries on 429 with short Retry-After and succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '2' : null },
          text: async () => 'Too Many Requests',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            data: { token: 'jwt', user: { id: '1', email: 'a@b.c', display_name: null } },
          }),
        })

      const promise = authenticateWithHub('token')
      await vi.advanceTimersByTimeAsync(2000)
      const result = await promise

      expect(result.token).toBe('jwt')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('throws Hub429Error when retry also returns 429', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '1' : null },
          text: async () => 'Too Many Requests',
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: () => null },
          text: async () => 'Still rate limited',
        })

      const promise = authenticateWithHub('token').catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(1000)
      const err = await promise

      expect(err).toBeInstanceOf(Hub429Error)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('retries fetchMyPosts on 429 with Retry-After header', async () => {
      const posts = [{ id: 'post-1', title: 'Test' }]
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? '3' : null },
          text: async () => 'Too Many Requests',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ ok: true, data: { items: posts, total: 1, page: 1, per_page: 20 } }),
        })

      const promise = fetchMyPosts('jwt-token')
      await vi.advanceTimersByTimeAsync(3000)
      const result = await promise

      expect(result.items).toEqual(posts)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('parses Retry-After as HTTP date', async () => {
      const futureDate = new Date(Date.now() + 5000).toUTCString()
      mockFetch
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          headers: { get: (name: string) => name.toLowerCase() === 'retry-after' ? futureDate : null },
          text: async () => 'Too Many Requests',
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            data: { token: 'jwt', user: { id: '1', email: 'a@b.c', display_name: null } },
          }),
        })

      const promise = authenticateWithHub('token')
      await vi.advanceTimersByTimeAsync(6000)
      const result = await promise

      expect(result.token).toBe('jwt')
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })
})
