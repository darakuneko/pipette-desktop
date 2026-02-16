// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { authenticateWithHub, uploadPostToHub, deletePostFromHub, updatePostOnHub, fetchMyPosts, patchPostOnHub, getHubOrigin, type HubUploadFiles } from '../hub/hub-client'

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

    it('throws on HTTP error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      })

      await expect(authenticateWithHub('bad-token')).rejects.toThrow('Hub auth failed: 401')
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
    it('returns array of posts', async () => {
      const posts = [
        { id: 'post-1', title: 'My Keymap' },
        { id: 'post-2', title: 'Second Layout' },
      ]
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { items: posts, total: 2, page: 1, per_page: 20 } }),
      })

      const result = await fetchMyPosts('jwt-token')

      expect(result).toEqual(posts)
      expect(mockFetch).toHaveBeenCalledWith(
        'https://pipette-hub-worker.keymaps.workers.dev/api/files/me',
        expect.objectContaining({
          method: 'GET',
          headers: { Authorization: 'Bearer jwt-token' },
        }),
      )
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

    it('throws on update failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      })

      await expect(
        updatePostOnHub('jwt', 'post-1', 'title', 'board', testFiles),
      ).rejects.toThrow('Hub update failed: 403')
    })

  })

  describe('getHubOrigin', () => {
    it('returns default Hub origin', () => {
      expect(getHubOrigin()).toBe('https://pipette-hub-worker.keymaps.workers.dev')
    })
  })
})
