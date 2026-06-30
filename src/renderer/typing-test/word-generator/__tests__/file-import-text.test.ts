// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getFileImportTextData,
  getFileImportTextDataSync,
  clearFileImportTextCache,
} from '../file-import-text'

const mockGet = vi.fn()
const originalVialAPI = window.vialAPI

beforeEach(() => {
  vi.clearAllMocks()
  clearFileImportTextCache()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    typingTestTextStoreGet: mockGet,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  clearFileImportTextCache()
  window.vialAPI = originalVialAPI
})

describe('getFileImportTextData', () => {
  it('fetches via IPC, parses words + line breaks, and caches', async () => {
    mockGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 't1' }, data: { name: 'My Text', text: 'one two\nthree four' } },
    })

    const first = await getFileImportTextData('t1')
    // "one two" then a newline then "three four": break after word index 1.
    expect(first).toEqual({ name: 'My Text', words: ['one', 'two', 'three', 'four'], lineBreaks: [1], indents: ['', ''] })
    expect(mockGet).toHaveBeenCalledTimes(1)

    // Second call served from cache — no extra IPC.
    const second = await getFileImportTextData('t1')
    expect(second).toBe(first)
    expect(mockGet).toHaveBeenCalledTimes(1)

    // Sync accessor now hits the warmed cache.
    expect(getFileImportTextDataSync('t1')).toBe(first)
  })

  it('single-line text has no line breaks', async () => {
    mockGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 't2' }, data: { name: 'Flat', text: 'one two three' } },
    })
    const data = await getFileImportTextData('t2')
    expect(data).toEqual({ name: 'Flat', words: ['one', 'two', 'three'], lineBreaks: [], indents: [''] })
  })

  it('returns undefined for a missing entry and does not cache', async () => {
    mockGet.mockResolvedValue({ success: false, errorCode: 'NOT_FOUND' })
    expect(await getFileImportTextData('gone')).toBeUndefined()
    expect(getFileImportTextDataSync('gone')).toBeUndefined()
  })

  it('clearFileImportTextCache(id) forces a re-fetch', async () => {
    mockGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 't1' }, data: { name: 'A', text: 'x y' } },
    })
    await getFileImportTextData('t1')
    clearFileImportTextCache('t1')
    expect(getFileImportTextDataSync('t1')).toBeUndefined()
    await getFileImportTextData('t1')
    expect(mockGet).toHaveBeenCalledTimes(2)
  })
})
