// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { useTypingTestTexts } from '../useTypingTestTexts'
import { typingTextsApi } from '../../../tauri-shim/api/typing-texts'

const { clearCache } = vi.hoisted(() => ({ clearCache: vi.fn() }))
vi.mock('../../typing-test/word-generator', () => ({ clearFileImportTextCache: clearCache }))

const mockList = vi.fn()
const mockImport = vi.fn()
const mockConfirm = vi.fn()
const mockRename = vi.fn()
const mockDelete = vi.fn()

const storeMembers = {
  typingTestTextStoreList: mockList,
  typingTestTextStoreImport: mockImport,
  typingTestTextStoreImportConfirm: mockConfirm,
  typingTestTextStoreRename: mockRename,
  typingTestTextStoreDelete: mockDelete,
}

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: { ...members }, writable: true, configurable: true })
}

// Both vialAPI implementations answer from the same spies: a plain
// mock, and the Tauri shim's typing test text members over a mocked Tauri
// IPC, whose commands hand their arguments to the spies in the members'
// order.
const backends = [
  { name: 'plain mock', install: () => installVialAPI(storeMembers) },
  {
    name: 'Tauri shim over mockIPC',
    install: () => {
      mockIPC((cmd, payload) => {
        const a = payload as Record<string, unknown>
        switch (cmd) {
          case 'typing_test_text_store_list': return mockList()
          case 'typing_test_text_store_import': return mockImport()
          case 'typing_test_text_store_import_confirm': return mockConfirm()
          case 'typing_test_text_store_rename': return mockRename(a.id, a.newName)
          case 'typing_test_text_store_delete': return mockDelete(a.id)
          default: throw new Error(`unexpected command ${cmd}`)
        }
      })
      installVialAPI(typingTextsApi)
    },
  },
]

afterEach(() => {
  clearMocks()
})

function meta(id: string, name = id.toUpperCase()) {
  return {
    id,
    name,
    wordCount: 2,
    lineCount: 1,
    filename: `${id}_x.json`,
    savedAt: '2026-10-16T12:00:00.000Z',
    updatedAt: '2026-10-16T12:00:00.000Z',
    romajiCapable: false,
  }
}

describe.each(backends)('useTypingTestTexts ($name)', (backend) => {
  beforeEach(() => {
    vi.clearAllMocks()
    backend.install()
    mockList.mockResolvedValue({ success: true, data: [meta('a'), meta('b')] })
  })

  it('loads the list on mount', async () => {
    const { result } = renderHook(() => useTypingTestTexts())
    await waitFor(() => expect(result.current.metas.map((m) => m.id)).toEqual(['a', 'b']))
    expect(result.current.loading).toBe(false)
    expect(result.current.error).toBeNull()
  })

  it('shows the error of a failed list', async () => {
    mockList.mockResolvedValue({ success: false, errorCode: 'IO_ERROR', error: 'disk gone' })
    const { result } = renderHook(() => useTypingTestTexts())
    await waitFor(() => expect(result.current.error).toBe('disk gone'))
    expect(result.current.metas).toEqual([])
  })

  it('re-reads and tells the other instances after an import', async () => {
    mockImport.mockResolvedValue({ success: true, data: meta('c') })
    const { result } = renderHook(() => useTypingTestTexts())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    const changed = vi.fn()
    window.addEventListener('pipette:typing-test-texts-changed', changed)
    mockList.mockResolvedValue({ success: true, data: [meta('a'), meta('b'), meta('c')] })

    let answer: unknown
    await act(async () => { answer = await result.current.importFromFile() })
    expect(answer).toEqual({ success: true, data: meta('c') })
    expect(clearCache).toHaveBeenCalledWith('c')
    expect(result.current.metas.map((m) => m.id)).toEqual(['a', 'b', 'c'])
    expect(changed).toHaveBeenCalled()
    window.removeEventListener('pipette:typing-test-texts-changed', changed)
  })

  it('answers a same-named import without re-reading, then confirms it', async () => {
    mockImport.mockResolvedValue({ success: false, errorCode: 'DUPLICATE_NAME', error: 'A' })
    mockConfirm.mockResolvedValue({ success: true, data: meta('a') })
    const { result } = renderHook(() => useTypingTestTexts())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    let answer: unknown
    await act(async () => { answer = await result.current.importFromFile() })
    expect(answer).toEqual({ success: false, errorCode: 'DUPLICATE_NAME', error: 'A' })
    expect(mockList).not.toHaveBeenCalled()
    expect(clearCache).not.toHaveBeenCalled()

    await act(async () => { answer = await result.current.confirmImport() })
    expect(answer).toEqual({ success: true, data: meta('a') })
    expect(clearCache).toHaveBeenCalledWith('a')
    expect(mockList).toHaveBeenCalled()
  })

  it('renames and removes through the store, clearing the played text', async () => {
    mockRename.mockResolvedValue({ success: true, data: meta('a', 'Renamed') })
    mockDelete.mockResolvedValue({ success: true })
    const { result } = renderHook(() => useTypingTestTexts())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))

    await act(async () => { await result.current.rename('a', 'Renamed') })
    expect(mockRename).toHaveBeenCalledWith('a', 'Renamed')
    expect(clearCache).toHaveBeenCalledWith('a')

    clearCache.mockClear()
    await act(async () => { await result.current.remove('b') })
    expect(mockDelete).toHaveBeenCalledWith('b')
    expect(clearCache).toHaveBeenCalledWith('b')
  })

  it('leaves the list alone when a rename fails', async () => {
    mockRename.mockResolvedValue({ success: false, errorCode: 'DUPLICATE_NAME', error: 'A text with the same name already exists' })
    const { result } = renderHook(() => useTypingTestTexts())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()
    let answer: unknown
    await act(async () => { answer = await result.current.rename('a', 'b') })
    expect(answer).toEqual({ success: false, errorCode: 'DUPLICATE_NAME', error: 'A text with the same name already exists' })
    expect(mockList).not.toHaveBeenCalled()
    expect(clearCache).not.toHaveBeenCalled()
  })
})
