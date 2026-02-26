// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import {
  Hub401Error,
  Hub403Error,
  Hub409Error,
  uploadFeaturePostToHub,
  updateFeaturePostOnHub,
  type HubFeatureUploadFile,
} from '../hub/hub-client'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

describe('hub-client feature posts', () => {
  beforeAll(() => {
    delete process.env.PIPETTE_HUB_URL
    delete process.env.ELECTRON_RENDERER_URL
  })

  beforeEach(() => {
    mockFetch.mockReset()
  })

  const testJsonFile: HubFeatureUploadFile = {
    name: 'favorites.json',
    data: Buffer.from('{"favorites":[]}'),
  }

  describe('uploadFeaturePostToHub', () => {
    it('sends POST to /api/files with multipart body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'feat-1', title: 'My Favorites' } }),
      })

      const result = await uploadFeaturePostToHub('jwt-token', 'My Favorites', 'favorite', testJsonFile)

      expect(result.id).toBe('feat-1')
      expect(result.title).toBe('My Favorites')

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://pipette-hub-worker.keymaps.workers.dev/api/files')
      expect(options.method).toBe('POST')
      expect(options.headers.Authorization).toBe('Bearer jwt-token')
      expect(options.headers['Content-Type']).toContain('multipart/form-data')
    })

    it('includes title, post_type fields and json file in body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'feat-2', title: 'Test' } }),
      })

      await uploadFeaturePostToHub('jwt', 'Test', 'favorite', testJsonFile)

      const [, options] = mockFetch.mock.calls[0]
      const bodyStr = (options.body as Buffer).toString()
      expect(bodyStr).toContain('name="title"')
      expect(bodyStr).toContain('Test')
      expect(bodyStr).toContain('name="post_type"')
      expect(bodyStr).toContain('favorite')
      expect(bodyStr).toContain('name="json"')
      expect(bodyStr).toContain('filename="favorites.json"')
      expect(bodyStr).toContain('application/json')
    })

    it('does not include keyboard_name, vil, c, pdf, or thumbnail fields', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'feat-3', title: 'Test' } }),
      })

      await uploadFeaturePostToHub('jwt', 'Test', 'favorite', testJsonFile)

      const [, options] = mockFetch.mock.calls[0]
      const bodyStr = (options.body as Buffer).toString()
      expect(bodyStr).not.toContain('name="keyboard_name"')
      expect(bodyStr).not.toContain('name="vil"')
      expect(bodyStr).not.toContain('name="c"')
      expect(bodyStr).not.toContain('name="pdf"')
      expect(bodyStr).not.toContain('name="thumbnail"')
    })

    it('returns HubPostResponse with id from response data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'abc-123', title: 'Returned Title' } }),
      })

      const result = await uploadFeaturePostToHub('jwt', 'Returned Title', 'favorite', testJsonFile)

      expect(result).toEqual({ id: 'abc-123', title: 'Returned Title' })
    })

    it('throws on non-ok HTTP response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })

      await expect(
        uploadFeaturePostToHub('jwt', 'title', 'favorite', testJsonFile),
      ).rejects.toThrow('Hub feature upload failed: 500 Internal Server Error')
    })

    it('throws Hub401Error on 401 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      })

      const err = await uploadFeaturePostToHub('bad-jwt', 'title', 'favorite', testJsonFile).catch(
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Hub401Error)
      expect((err as Error).message).toBe('Hub feature upload failed: 401 Unauthorized')
    })

    it('throws Hub403Error on 403 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      })

      const err = await uploadFeaturePostToHub('jwt', 'title', 'favorite', testJsonFile).catch(
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Hub403Error)
      expect((err as Error).message).toBe('Hub feature upload failed: 403 Forbidden')
    })

    it('throws Hub409Error on 409 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 409,
        text: async () => 'Conflict',
      })

      const err = await uploadFeaturePostToHub('jwt', 'title', 'favorite', testJsonFile).catch(
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Hub409Error)
      expect((err as Error).message).toBe('Hub feature upload failed: 409 Conflict')
    })

    it('throws on payload-level failure (HTTP 200 + ok:false)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'Quota exceeded' }),
      })

      await expect(
        uploadFeaturePostToHub('jwt', 'title', 'favorite', testJsonFile),
      ).rejects.toThrow('Hub feature upload failed: Quota exceeded')
    })

    it('sanitizes CRLF in text field values', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'feat-s', title: 'sanitized' } }),
      })

      await uploadFeaturePostToHub('jwt', 'Title\r\nWith\nNewlines', 'type\rwith\ncr', testJsonFile)

      const [, options] = mockFetch.mock.calls[0]
      const bodyStr = (options.body as Buffer).toString()
      expect(bodyStr).toContain('Title With Newlines')
      expect(bodyStr).not.toContain('Title\r\nWith')
      expect(bodyStr).toContain('type with cr')
      expect(bodyStr).not.toContain('type\rwith')
    })
  })

  describe('updateFeaturePostOnHub', () => {
    it('sends PUT to /api/files/{postId} with multipart body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'feat-1', title: 'Updated' } }),
      })

      const result = await updateFeaturePostOnHub('jwt-token', 'feat-1', 'Updated', 'favorite', testJsonFile)

      expect(result.id).toBe('feat-1')
      expect(result.title).toBe('Updated')

      const [url, options] = mockFetch.mock.calls[0]
      expect(url).toBe('https://pipette-hub-worker.keymaps.workers.dev/api/files/feat-1')
      expect(options.method).toBe('PUT')
      expect(options.headers.Authorization).toBe('Bearer jwt-token')
      expect(options.headers['Content-Type']).toContain('multipart/form-data')
    })

    it('includes title, post_type fields and json file in body', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'feat-1', title: 'Updated' } }),
      })

      await updateFeaturePostOnHub('jwt', 'feat-1', 'Updated Title', 'macro', {
        name: 'macros.json',
        data: Buffer.from('{"macros":[]}'),
      })

      const [, options] = mockFetch.mock.calls[0]
      const bodyStr = (options.body as Buffer).toString()
      expect(bodyStr).toContain('name="title"')
      expect(bodyStr).toContain('Updated Title')
      expect(bodyStr).toContain('name="post_type"')
      expect(bodyStr).toContain('macro')
      expect(bodyStr).toContain('name="json"')
      expect(bodyStr).toContain('filename="macros.json"')
    })

    it('encodes postId in URL', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'id with spaces', title: 'test' } }),
      })

      await updateFeaturePostOnHub('jwt', 'id with spaces', 'test', 'favorite', testJsonFile)

      const [url] = mockFetch.mock.calls[0]
      expect(url).toBe('https://pipette-hub-worker.keymaps.workers.dev/api/files/id%20with%20spaces')
    })

    it('returns HubPostResponse with id from response data', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, data: { id: 'xyz-789', title: 'Feature Post' } }),
      })

      const result = await updateFeaturePostOnHub('jwt', 'xyz-789', 'Feature Post', 'favorite', testJsonFile)

      expect(result).toEqual({ id: 'xyz-789', title: 'Feature Post' })
    })

    it('throws on non-ok HTTP response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      })

      await expect(
        updateFeaturePostOnHub('jwt', 'post-1', 'title', 'favorite', testJsonFile),
      ).rejects.toThrow('Hub feature update failed: 500 Internal Server Error')
    })

    it('throws Hub401Error on 401 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      })

      const err = await updateFeaturePostOnHub('bad-jwt', 'post-1', 'title', 'favorite', testJsonFile).catch(
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Hub401Error)
      expect((err as Error).message).toBe('Hub feature update failed: 401 Unauthorized')
    })

    it('throws Hub403Error on 403 response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      })

      const err = await updateFeaturePostOnHub('jwt', 'post-1', 'title', 'favorite', testJsonFile).catch(
        (e: unknown) => e,
      )
      expect(err).toBeInstanceOf(Hub403Error)
      expect((err as Error).message).toBe('Hub feature update failed: 403 Forbidden')
    })

    it('throws on payload-level failure (HTTP 200 + ok:false)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: false, error: 'Not found' }),
      })

      await expect(
        updateFeaturePostOnHub('jwt', 'missing', 'title', 'favorite', testJsonFile),
      ).rejects.toThrow('Hub feature update failed: Not found')
    })
  })
})
