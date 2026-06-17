// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import {
  Hub404Error,
  Hub403Error,
  uploadPrivatePostToHub,
  deletePrivatePostFromHub,
  type HubUploadFiles,
} from '../hub/hub-client'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const BASE = 'https://pipette-hub-worker.keymaps.workers.dev'

function buf(s: string): { name: string; data: Buffer } {
  return { name: `${s}.bin`, data: Buffer.from(s) }
}

const FILES: HubUploadFiles = {
  vil: buf('vil'),
  pipette: buf('pipette'),
  c: buf('c'),
  pdf: buf('pdf'),
  thumbnail: buf('thumb'),
}

function bodyText(): string {
  const init = mockFetch.mock.calls[0][1] as { body: Buffer }
  return Buffer.from(init.body).toString('utf-8')
}

function okData(data: unknown) {
  return { ok: true, json: async () => ({ ok: true, data }) }
}

describe('hub-client private uploads', () => {
  beforeAll(() => {
    delete process.env.PIPETTE_HUB_URL
    delete process.env.ELECTRON_RENDERER_URL
  })

  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('uploads to /api/private/files and returns the private response', async () => {
    const data = { id: 'p1', token: 'pt_v1_x', url: '/private/post/p1?token=pt_v1_x', expires_at: '2026-09-14T16:00:00.000Z' }
    mockFetch.mockResolvedValueOnce(okData(data))

    const result = await uploadPrivatePostToHub('jwt', 'Title', 'KB', FILES, 7)

    expect(mockFetch).toHaveBeenCalledWith(`${BASE}/api/private/files`, expect.objectContaining({ method: 'POST' }))
    expect(result).toEqual(data)
    const body = bodyText()
    expect(body).toContain('name="expires_in_days"')
    expect(body).toContain('\r\n\r\n7')
  })

  it('omits expires_in_days when expiry is null (no expiry)', async () => {
    mockFetch.mockResolvedValueOnce(okData({ id: 'p2', token: 't', url: '/u', expires_at: null }))
    await uploadPrivatePostToHub('jwt', 'Title', 'KB', FILES, null)
    expect(bodyText()).not.toContain('expires_in_days')
  })

  it('deletes via DELETE /api/private/<kind>/:id with the owner JWT', async () => {
    mockFetch.mockResolvedValueOnce(okData({ id: 'p3' }))
    await deletePrivatePostFromHub('jwt-abc', 'files', 'p3')
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE}/api/private/files/p3`,
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ Authorization: 'Bearer jwt-abc' }),
      }),
    )
  })

  it('throws Hub404Error when the private post is already gone', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, headers: { get: () => null }, text: async () => 'not found' })
    await expect(deletePrivatePostFromHub('jwt', 'files', 'gone')).rejects.toBeInstanceOf(Hub404Error)
  })

  it('throws Hub403Error when deleting someone else\'s post', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, headers: { get: () => null }, text: async () => 'forbidden' })
    await expect(deletePrivatePostFromHub('jwt', 'files', 'other')).rejects.toBeInstanceOf(Hub403Error)
  })
})
