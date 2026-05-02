// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import {
  fetchKeyLabelList,
  fetchKeyLabelDetail,
  downloadKeyLabel,
  uploadKeyLabel,
  updateKeyLabel,
  deleteKeyLabel,
} from '../hub/hub-key-labels'
import { Hub401Error, Hub409Error, Hub429Error } from '../hub/hub-client'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const HUB_BASE = 'https://pipette-hub-worker.keymaps.workers.dev'

function okJson<T>(data: T): { ok: true; status: number; json: () => Promise<{ ok: true; data: T }>; text: () => Promise<string>; headers: Headers } {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data }),
    text: async () => '',
    headers: new Headers(),
  }
}

function failResponse(status: number, body = 'err', retryAfter?: string): {
  ok: false
  status: number
  json: () => Promise<unknown>
  text: () => Promise<string>
  headers: Headers
} {
  const headers = new Headers()
  if (retryAfter) headers.set('Retry-After', retryAfter)
  return {
    ok: false,
    status,
    json: async () => ({ ok: false, error: body }),
    text: async () => body,
    headers,
  }
}

describe('hub-key-labels', () => {
  beforeAll(() => {
    delete process.env.PIPETTE_HUB_URL
    delete process.env.ELECTRON_RENDERER_URL
  })

  beforeEach(() => {
    mockFetch.mockReset()
  })

  describe('fetchKeyLabelList', () => {
    it('passes q/page/per_page as query params', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ items: [], total: 0, page: 1, per_page: 20 }))
      await fetchKeyLabelList({ q: 'french', page: 2, perPage: 10 })

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/key-labels?q=french&page=2&per_page=10`,
        { method: 'GET' },
      )
    })

    it('omits empty params', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ items: [], total: 0, page: 1, per_page: 20 }))
      await fetchKeyLabelList({})

      expect(mockFetch).toHaveBeenCalledWith(`${HUB_BASE}/api/key-labels`, { method: 'GET' })
    })
  })

  describe('fetchKeyLabelDetail', () => {
    it('encodes the id and returns the body', async () => {
      mockFetch.mockResolvedValueOnce(okJson({
        id: 'abc/def',
        name: 'Foo',
        map: {},
        composite_labels: null,
        uploaded_by: null,
        uploader_name: 'pipette',
        created_at: '2026-05-01',
        updated_at: '2026-05-01',
      }))

      const detail = await fetchKeyLabelDetail('abc/def')
      expect(detail.name).toBe('Foo')
      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/key-labels/abc%2Fdef`,
        { method: 'GET' },
      )
    })
  })

  describe('downloadKeyLabel', () => {
    it('returns the JSON body when the request succeeds', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ name: 'X', map: { KC_A: 'A' }, composite_labels: null }),
        text: async () => '',
        headers: new Headers(),
      })

      const body = await downloadKeyLabel('hub-1')
      expect(body.name).toBe('X')
      expect(body.map.KC_A).toBe('A')
    })

    it('throws Hub429Error on rate-limited response', async () => {
      mockFetch.mockResolvedValueOnce(failResponse(429, 'too many', '999'))
      await expect(downloadKeyLabel('hub-1')).rejects.toBeInstanceOf(Hub429Error)
    })
  })

  describe('uploadKeyLabel', () => {
    it('POSTs JSON body with composite_labels included', async () => {
      mockFetch.mockResolvedValueOnce(okJson({
        id: 'new-id',
        name: 'X',
        map: { KC_A: 'A' },
        composite_labels: null,
        uploaded_by: 'user',
        uploader_name: 'me',
        created_at: 'now',
        updated_at: 'now',
      }))

      const result = await uploadKeyLabel('jwt', { name: 'X', map: { KC_A: 'A' }, compositeLabels: null })
      expect(result.id).toBe('new-id')

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/key-labels`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: 'Bearer jwt' }),
        }),
      )
      const init = mockFetch.mock.calls[0][1] as { body: string }
      const body = JSON.parse(init.body) as Record<string, unknown>
      expect(body.composite_labels).toBeNull()
    })

    it('translates 409 into Hub409Error', async () => {
      mockFetch.mockResolvedValueOnce(failResponse(409, 'name taken'))
      await expect(uploadKeyLabel('jwt', { name: 'X', map: {} })).rejects.toBeInstanceOf(Hub409Error)
    })
  })

  describe('updateKeyLabel', () => {
    it('PUTs to /api/key-labels/:id', async () => {
      mockFetch.mockResolvedValueOnce(okJson({
        id: 'hub-2',
        name: 'X',
        map: {},
        composite_labels: null,
        uploaded_by: null,
        uploader_name: null,
        created_at: 'now',
        updated_at: 'now',
      }))

      await updateKeyLabel('jwt', 'hub-2', { name: 'X', map: {} })
      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/key-labels/hub-2`,
        expect.objectContaining({ method: 'PUT' }),
      )
    })

    it('throws Hub401Error on auth failure', async () => {
      mockFetch.mockResolvedValueOnce(failResponse(401, 'unauthorized'))
      await expect(updateKeyLabel('jwt', 'hub-2', { name: 'X', map: {} })).rejects.toBeInstanceOf(Hub401Error)
    })
  })

  describe('deleteKeyLabel', () => {
    it('DELETEs and resolves on success', async () => {
      mockFetch.mockResolvedValueOnce(okJson(null))
      await deleteKeyLabel('jwt', 'hub-2')
      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/key-labels/hub-2`,
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })
})
