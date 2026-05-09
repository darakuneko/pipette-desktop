// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { fetchI18nPackTimestamps } from '../hub/hub-i18n'
import { Hub429Error } from '../hub/hub-client'

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

describe('fetchI18nPackTimestamps', () => {
  beforeAll(() => {
    delete process.env.PIPETTE_HUB_URL
    delete process.env.ELECTRON_RENDERER_URL
  })

  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('POSTs ids JSON body to /api/i18n-packs/timestamps and unwraps the data envelope', async () => {
    mockFetch.mockResolvedValueOnce(okJson({
      items: [
        { id: 'hub-1', updated_at: '2026-05-10T01:00:00.000Z' },
        { id: 'hub-2', updated_at: '2026-05-10T02:00:00.000Z' },
      ],
    }))

    const result = await fetchI18nPackTimestamps(['hub-1', 'hub-2'])
    expect(result.items).toHaveLength(2)
    expect(result.items[0]).toEqual({ id: 'hub-1', updated_at: '2026-05-10T01:00:00.000Z' })

    expect(mockFetch).toHaveBeenCalledWith(
      `${HUB_BASE}/api/i18n-packs/timestamps`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      }),
    )
    const init = mockFetch.mock.calls[0][1] as { body: string }
    expect(JSON.parse(init.body)).toEqual({ ids: ['hub-1', 'hub-2'] })
  })

  it('translates a 429 response into Hub429Error', async () => {
    // hub-i18n.ts retries the first 429 if Retry-After ≤ 60s, so we
    // emit two so the second exhausts the retry budget. Pair with a
    // long Retry-After so the helper short-circuits the sleep.
    mockFetch.mockResolvedValue(failResponse(429, 'rate limited', '999'))
    await expect(fetchI18nPackTimestamps(['hub-1'])).rejects.toBeInstanceOf(Hub429Error)
  })
})
