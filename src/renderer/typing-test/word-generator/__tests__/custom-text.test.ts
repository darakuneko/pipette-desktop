// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getCustomTextData,
  getCustomTextDataSync,
  clearCustomTextCache,
} from '../custom-text'

const mockGet = vi.fn()
const originalVialAPI = window.vialAPI

beforeEach(() => {
  vi.clearAllMocks()
  clearCustomTextCache()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    typingTestTextStoreGet: mockGet,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  clearCustomTextCache()
  window.vialAPI = originalVialAPI
})

describe('getCustomTextData', () => {
  it('fetches via IPC, parses words + line breaks, and caches', async () => {
    mockGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 't1' }, data: { name: 'My Text', text: 'one two\nthree four' } },
    })

    const first = await getCustomTextData('t1')
    // "one two" then a newline then "three four": break after word index 1.
    expect(first).toEqual({ name: 'My Text', words: ['one', 'two', 'three', 'four'], lineBreaks: [1], indents: ['', ''] })
    expect(mockGet).toHaveBeenCalledTimes(1)

    // Second call served from cache — no extra IPC.
    const second = await getCustomTextData('t1')
    expect(second).toBe(first)
    expect(mockGet).toHaveBeenCalledTimes(1)

    // Sync accessor now hits the warmed cache.
    expect(getCustomTextDataSync('t1')).toBe(first)
  })

  it('single-line text has no line breaks', async () => {
    mockGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 't2' }, data: { name: 'Flat', text: 'one two three' } },
    })
    const data = await getCustomTextData('t2')
    expect(data).toEqual({ name: 'Flat', words: ['one', 'two', 'three'], lineBreaks: [], indents: [''] })
  })

  it('returns undefined for a missing entry and does not cache', async () => {
    mockGet.mockResolvedValue({ success: false, errorCode: 'NOT_FOUND' })
    expect(await getCustomTextData('gone')).toBeUndefined()
    expect(getCustomTextDataSync('gone')).toBeUndefined()
  })

  it('clearCustomTextCache(id) forces a re-fetch', async () => {
    mockGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 't1' }, data: { name: 'A', text: 'x y' } },
    })
    await getCustomTextData('t1')
    clearCustomTextCache('t1')
    expect(getCustomTextDataSync('t1')).toBeUndefined()
    await getCustomTextData('t1')
    expect(mockGet).toHaveBeenCalledTimes(2)
  })
})
