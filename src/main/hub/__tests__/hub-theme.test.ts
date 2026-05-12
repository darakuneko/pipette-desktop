// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import {
  fetchThemePostList,
  downloadThemePostBody,
  fetchThemePackTimestamps,
  uploadThemePostToHub,
  updateThemePostOnHub,
  deleteThemePostFromHub,
  MAX_HUB_THEME_JSON_BYTES,
} from '../hub-theme'
import { Hub401Error, Hub403Error, Hub409Error, Hub429Error } from '../hub-client'
import type { HubThemePackBody } from '../../../shared/types/hub'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const HUB_BASE = 'https://pipette-hub-worker.keymaps.workers.dev'

function okJson<T>(data: T): {
  ok: true
  status: number
  json: () => Promise<{ ok: true; data: T }>
  text: () => Promise<string>
  headers: Headers
} {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, data }),
    text: async () => '',
    headers: new Headers(),
  }
}

function rawJson<T>(raw: T): {
  ok: true
  status: number
  json: () => Promise<T>
  text: () => Promise<string>
  headers: Headers
} {
  return {
    ok: true,
    status: 200,
    json: async () => raw,
    text: async () => '',
    headers: new Headers(),
  }
}

function failResponse(
  status: number,
  body = 'err',
  retryAfter?: string,
): {
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

function samplePack(overrides?: Partial<HubThemePackBody>): HubThemePackBody {
  return {
    name: 'Nord',
    version: '1.0.0',
    colorScheme: 'both',
    colors: { '--bg': '#2e3440', '--fg': '#eceff4' },
    ...overrides,
  }
}

describe('hub-theme', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeAll(() => {
    savedEnv.PIPETTE_HUB_URL = process.env.PIPETTE_HUB_URL
    savedEnv.ELECTRON_RENDERER_URL = process.env.ELECTRON_RENDERER_URL
    delete process.env.PIPETTE_HUB_URL
    delete process.env.ELECTRON_RENDERER_URL
  })

  afterAll(() => {
    if (savedEnv.PIPETTE_HUB_URL !== undefined) process.env.PIPETTE_HUB_URL = savedEnv.PIPETTE_HUB_URL
    if (savedEnv.ELECTRON_RENDERER_URL !== undefined) process.env.ELECTRON_RENDERER_URL = savedEnv.ELECTRON_RENDERER_URL
  })

  beforeEach(() => {
    mockFetch.mockReset()
  })

  describe('fetchThemePostList', () => {
    it('passes q/name/page/per_page as query params', async () => {
      mockFetch.mockResolvedValueOnce(
        okJson({
          items: [],
          total: 0,
          page: 2,
          per_page: 10,
        }),
      )

      await fetchThemePostList({ q: 'nord', name: 'Nord Theme', page: 2, perPage: 10 })

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs?q=nord&name=Nord+Theme&page=2&per_page=10`,
        { method: 'GET' },
      )
    })

    it('omits empty/undefined params', async () => {
      mockFetch.mockResolvedValueOnce(
        okJson({ items: [], total: 0, page: 1, per_page: 20 }),
      )

      await fetchThemePostList({})

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs`,
        { method: 'GET' },
      )
    })

    it('trims whitespace-only q param', async () => {
      mockFetch.mockResolvedValueOnce(
        okJson({ items: [], total: 0, page: 1, per_page: 20 }),
      )

      await fetchThemePostList({ q: '   ' })

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs`,
        { method: 'GET' },
      )
    })

    it('maps snake_case response fields to camelCase', async () => {
      mockFetch.mockResolvedValueOnce(
        okJson({
          items: [
            {
              id: 'theme-1',
              name: 'Nord',
              version: '1.0.0',
              uploaded_by: 'user-abc',
              uploader_name: 'Alice',
              created_at: '2026-05-01T00:00:00Z',
              updated_at: '2026-05-10T00:00:00Z',
            },
          ],
          total: 1,
          page: 1,
          per_page: 20,
        }),
      )

      const result = await fetchThemePostList({})

      expect(result.items).toHaveLength(1)
      expect(result.items[0]).toEqual({
        id: 'theme-1',
        name: 'Nord',
        version: '1.0.0',
        uploadedBy: 'user-abc',
        uploaderName: 'Alice',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-10T00:00:00Z',
      })
      expect(result.total).toBe(1)
      expect(result.page).toBe(1)
      expect(result.perPage).toBe(20)
    })

    it('defaults uploadedBy/uploaderName to null when absent', async () => {
      mockFetch.mockResolvedValueOnce(
        okJson({
          items: [
            {
              id: 'theme-2',
              name: 'Solarized',
              version: '2.0.0',
              created_at: '2026-05-02T00:00:00Z',
            },
          ],
          total: 1,
          page: 1,
          per_page: 20,
        }),
      )

      const result = await fetchThemePostList({})

      expect(result.items[0].uploadedBy).toBeNull()
      expect(result.items[0].uploaderName).toBeNull()
    })
  })

  describe('downloadThemePostBody', () => {
    it('GETs the download route and returns the body', async () => {
      const pack = samplePack()
      mockFetch.mockResolvedValueOnce(okJson(pack))

      const result = await downloadThemePostBody('theme-1')

      expect(result).toEqual(pack)
      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs/theme-1/download`,
        { method: 'GET' },
      )
    })

    it('encodes special characters in postId', async () => {
      mockFetch.mockResolvedValueOnce(okJson(samplePack()))

      await downloadThemePostBody('abc/def')

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs/abc%2Fdef/download`,
        { method: 'GET' },
      )
    })

    it('handles raw JSON response without envelope', async () => {
      const pack = samplePack()
      mockFetch.mockResolvedValueOnce(rawJson(pack))

      const result = await downloadThemePostBody('theme-1')

      expect(result).toEqual(pack)
    })
  })

  describe('fetchThemePackTimestamps', () => {
    it('POSTs ids to /api/theme-packs/timestamps and returns items', async () => {
      mockFetch.mockResolvedValueOnce(
        okJson({
          items: [
            { id: 'theme-1', updated_at: '2026-05-10T01:00:00.000Z' },
            { id: 'theme-2', updated_at: '2026-05-10T02:00:00.000Z' },
          ],
        }),
      )

      const result = await fetchThemePackTimestamps(['theme-1', 'theme-2'])

      expect(result.items).toHaveLength(2)
      expect(result.items[0]).toEqual({
        id: 'theme-1',
        updated_at: '2026-05-10T01:00:00.000Z',
      })

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs/timestamps`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
        }),
      )
      const init = mockFetch.mock.calls[0][1] as { body: string }
      expect(JSON.parse(init.body)).toEqual({ ids: ['theme-1', 'theme-2'] })
    })

    it('handles empty ids array', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ items: [] }))

      const result = await fetchThemePackTimestamps([])

      expect(result.items).toHaveLength(0)
    })
  })

  describe('uploadThemePostToHub', () => {
    it('POSTs multipart body with auth header', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ id: 'new-theme', title: 'Nord' }))
      const pack = samplePack()

      const result = await uploadThemePostToHub('my-jwt', pack)

      expect(result.id).toBe('new-theme')
      expect(result.title).toBe('Nord')

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer my-jwt',
          }),
        }),
      )
    })

    it('sends multipart content type with boundary', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ id: 'new-theme', title: 'Nord' }))

      await uploadThemePostToHub('jwt', samplePack())

      const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> }
      expect(init.headers['Content-Type']).toMatch(
        /^multipart\/form-data; boundary=----PipetteThemeBoundary\d+$/,
      )
    })

    it('includes JSON pack data in multipart body', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ id: 'new-theme', title: 'Nord' }))
      const pack = samplePack()

      await uploadThemePostToHub('jwt', pack)

      const init = mockFetch.mock.calls[0][1] as { body: Buffer }
      const bodyStr = init.body.toString('utf-8')
      expect(bodyStr).toContain('Content-Disposition: form-data; name="json"; filename="theme-pack.json"')
      expect(bodyStr).toContain('Content-Type: application/json')
      expect(bodyStr).toContain(JSON.stringify(pack))
    })
  })

  describe('updateThemePostOnHub', () => {
    it('PUTs to /api/theme-packs/:postId', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ id: 'theme-99', title: 'Updated' }))

      await updateThemePostOnHub('jwt', 'theme-99', samplePack())

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs/theme-99`,
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            Authorization: 'Bearer jwt',
          }),
        }),
      )
    })

    it('encodes special characters in postId', async () => {
      mockFetch.mockResolvedValueOnce(okJson({ id: 'a/b', title: 'X' }))

      await updateThemePostOnHub('jwt', 'a/b', samplePack())

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs/a%2Fb`,
        expect.objectContaining({ method: 'PUT' }),
      )
    })
  })

  describe('deleteThemePostFromHub', () => {
    it('DELETEs and resolves on success', async () => {
      mockFetch.mockResolvedValueOnce(okJson(null))

      await deleteThemePostFromHub('jwt', 'theme-42')

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs/theme-42`,
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({ Authorization: 'Bearer jwt' }),
        }),
      )
    })

    it('encodes special characters in postId', async () => {
      mockFetch.mockResolvedValueOnce(okJson(null))

      await deleteThemePostFromHub('jwt', 'x/y/z')

      expect(mockFetch).toHaveBeenCalledWith(
        `${HUB_BASE}/api/theme-packs/x%2Fy%2Fz`,
        expect.objectContaining({ method: 'DELETE' }),
      )
    })
  })

  describe('error handling', () => {
    it('throws Hub401Error on 401', async () => {
      mockFetch.mockResolvedValueOnce(failResponse(401, 'unauthorized'))
      await expect(uploadThemePostToHub('bad-jwt', samplePack())).rejects.toBeInstanceOf(
        Hub401Error,
      )
    })

    it('throws Hub403Error on 403', async () => {
      mockFetch.mockResolvedValueOnce(failResponse(403, 'forbidden'))
      await expect(deleteThemePostFromHub('jwt', 'theme-1')).rejects.toBeInstanceOf(
        Hub403Error,
      )
    })

    it('throws Hub409Error on 409', async () => {
      mockFetch.mockResolvedValueOnce(failResponse(409, 'name taken'))
      await expect(uploadThemePostToHub('jwt', samplePack())).rejects.toBeInstanceOf(
        Hub409Error,
      )
    })

    it('throws Hub429Error on 429 with retryAfterSeconds', async () => {
      mockFetch.mockResolvedValue(failResponse(429, 'rate limited', '999'))
      await expect(fetchThemePostList({})).rejects.toSatisfy((err) => {
        expect(err).toBeInstanceOf(Hub429Error)
        expect((err as Hub429Error).retryAfterSeconds).toBe(999)
        return true
      })
    })

    it('throws generic Error on other status codes', async () => {
      mockFetch.mockResolvedValueOnce(failResponse(500, 'internal'))
      await expect(fetchThemePostList({})).rejects.toThrow('Hub theme list failed: 500 internal')
    })

    it('throws on wrapped error response with ok:false', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, error: 'pack validation failed' }),
        text: async () => '',
        headers: new Headers(),
      })
      await expect(fetchThemePostList({})).rejects.toThrow('pack validation failed')
    })

    it('throws on wrapped error response with ok:false and no error message', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: false }),
        text: async () => '',
        headers: new Headers(),
      })
      await expect(fetchThemePostList({})).rejects.toThrow('unknown error')
    })
  })

  describe('rate limit retry (429)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('retries once after Retry-After delay and succeeds', async () => {
      mockFetch
        .mockResolvedValueOnce(failResponse(429, 'slow down', '1'))
        .mockResolvedValueOnce(okJson({ items: [], total: 0, page: 1, per_page: 20 }))

      const promise = fetchThemePostList({})
      await vi.advanceTimersByTimeAsync(1000)
      const result = await promise

      expect(result.items).toHaveLength(0)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('throws Hub429Error when Retry-After exceeds MAX_RETRY_AFTER_S', async () => {
      mockFetch.mockResolvedValueOnce(failResponse(429, 'slow down', '61'))

      await expect(fetchThemePostList({})).rejects.toBeInstanceOf(Hub429Error)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('throws Hub429Error when Retry-After is absent on first attempt', async () => {
      mockFetch.mockResolvedValueOnce(failResponse(429, 'slow down'))

      await expect(fetchThemePostList({})).rejects.toBeInstanceOf(Hub429Error)
      expect(mockFetch).toHaveBeenCalledTimes(1)
    })

    it('throws Hub429Error on second 429 even with valid Retry-After', async () => {
      mockFetch
        .mockResolvedValueOnce(failResponse(429, 'slow down', '1'))
        .mockResolvedValueOnce(failResponse(429, 'still slow', '1'))

      const promise = fetchThemePostList({}).catch((err: unknown) => {
        expect(err).toBeInstanceOf(Hub429Error)
        return err
      })
      await vi.advanceTimersByTimeAsync(1000)
      await promise
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })

    it('retries with Retry-After at the MAX_RETRY_AFTER_S boundary', async () => {
      mockFetch
        .mockResolvedValueOnce(failResponse(429, 'slow down', '60'))
        .mockResolvedValueOnce(okJson({ items: [], total: 0, page: 1, per_page: 20 }))

      const promise = fetchThemePostList({})
      await vi.advanceTimersByTimeAsync(60_000)
      const result = await promise

      expect(result.items).toHaveLength(0)
      expect(mockFetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('MAX_HUB_THEME_JSON_BYTES', () => {
    it('is exported as 64 KiB', () => {
      expect(MAX_HUB_THEME_JSON_BYTES).toBe(64 * 1024)
    })
  })
})
