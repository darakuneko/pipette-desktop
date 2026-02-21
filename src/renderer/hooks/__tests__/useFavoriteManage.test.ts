// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFavoriteManage } from '../useFavoriteManage'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const mockFavoriteStoreList = vi.fn().mockResolvedValue({ success: true, entries: [] })
const mockFavoriteStoreRename = vi.fn().mockResolvedValue({ success: true })
const mockFavoriteStoreDelete = vi.fn().mockResolvedValue({ success: true })
const mockFavoriteStoreExport = vi.fn().mockResolvedValue({ success: true })
const mockFavoriteStoreImport = vi.fn().mockResolvedValue({ success: true, imported: 2, skipped: 0 })

Object.defineProperty(window, 'vialAPI', {
  value: {
    favoriteStoreList: mockFavoriteStoreList,
    favoriteStoreRename: mockFavoriteStoreRename,
    favoriteStoreDelete: mockFavoriteStoreDelete,
    favoriteStoreExport: mockFavoriteStoreExport,
    favoriteStoreImport: mockFavoriteStoreImport,
  },
  writable: true,
})

describe('useFavoriteManage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts with empty entries', () => {
    const { result } = renderHook(() => useFavoriteManage('tapDance'))
    expect(result.current.entries).toEqual([])
  })

  it('refreshEntries calls favoriteStoreList with correct type', async () => {
    mockFavoriteStoreList.mockResolvedValueOnce({
      success: true,
      entries: [{ id: 'e1', label: 'Test', savedAt: Date.now() }],
    })

    const { result } = renderHook(() => useFavoriteManage('macro'))

    await act(async () => {
      await result.current.refreshEntries()
    })

    expect(mockFavoriteStoreList).toHaveBeenCalledWith('macro')
    expect(result.current.entries).toHaveLength(1)
  })

  it('renameEntry calls favoriteStoreRename and refreshes', async () => {
    const { result } = renderHook(() => useFavoriteManage('combo'))

    await act(async () => {
      await result.current.renameEntry('e1', 'New Name')
    })

    expect(mockFavoriteStoreRename).toHaveBeenCalledWith('combo', 'e1', 'New Name')
    expect(mockFavoriteStoreList).toHaveBeenCalledWith('combo')
  })

  it('deleteEntry calls favoriteStoreDelete and refreshes', async () => {
    const { result } = renderHook(() => useFavoriteManage('keyOverride'))

    await act(async () => {
      await result.current.deleteEntry('e1')
    })

    expect(mockFavoriteStoreDelete).toHaveBeenCalledWith('keyOverride', 'e1')
    expect(mockFavoriteStoreList).toHaveBeenCalledWith('keyOverride')
  })

  it('exportAll calls favoriteStoreExport without entryId', async () => {
    const { result } = renderHook(() => useFavoriteManage('tapDance'))

    await act(async () => {
      await result.current.exportAll()
    })

    expect(mockFavoriteStoreExport).toHaveBeenCalledWith('tapDance')
  })

  it('exportEntry calls favoriteStoreExport with entryId', async () => {
    const { result } = renderHook(() => useFavoriteManage('tapDance'))

    await act(async () => {
      await result.current.exportEntry('e1')
    })

    expect(mockFavoriteStoreExport).toHaveBeenCalledWith('tapDance', 'e1')
  })

  it('importFavorites calls favoriteStoreImport and sets result', async () => {
    const { result } = renderHook(() => useFavoriteManage('altRepeatKey'))

    await act(async () => {
      await result.current.importFavorites()
    })

    expect(mockFavoriteStoreImport).toHaveBeenCalledOnce()
    expect(result.current.importResult).toEqual({ imported: 2, skipped: 0 })
  })

  it('returns false when rename fails', async () => {
    mockFavoriteStoreRename.mockResolvedValueOnce({ success: false })

    const { result } = renderHook(() => useFavoriteManage('tapDance'))

    let success: boolean = true
    await act(async () => {
      success = await result.current.renameEntry('e1', 'New')
    })

    expect(success).toBe(false)
  })

  it('does not refresh entries when rename fails', async () => {
    mockFavoriteStoreRename.mockResolvedValueOnce({ success: false })

    const { result } = renderHook(() => useFavoriteManage('tapDance'))

    await act(async () => {
      await result.current.renameEntry('e1', 'New')
    })

    expect(mockFavoriteStoreList).not.toHaveBeenCalled()
  })

  it('returns false when delete fails', async () => {
    mockFavoriteStoreDelete.mockResolvedValueOnce({ success: false })

    const { result } = renderHook(() => useFavoriteManage('tapDance'))

    let success: boolean = true
    await act(async () => {
      success = await result.current.deleteEntry('e1')
    })

    expect(success).toBe(false)
    expect(mockFavoriteStoreList).not.toHaveBeenCalled()
  })

  it('returns false when export fails', async () => {
    mockFavoriteStoreExport.mockResolvedValueOnce({ success: false })

    const { result } = renderHook(() => useFavoriteManage('tapDance'))

    let success: boolean = true
    await act(async () => {
      success = await result.current.exportAll()
    })

    expect(success).toBe(false)
  })

  it('does not set importResult when import is cancelled', async () => {
    mockFavoriteStoreImport.mockResolvedValueOnce({ success: false, error: 'cancelled' })

    const { result } = renderHook(() => useFavoriteManage('tapDance'))

    await act(async () => {
      await result.current.importFavorites()
    })

    expect(result.current.importResult).toBeNull()
  })

  it('sets importing flag during import', async () => {
    let resolveImport!: (value: { success: boolean; imported: number; skipped: number }) => void
    mockFavoriteStoreImport.mockReturnValueOnce(
      new Promise((resolve) => { resolveImport = resolve })
    )

    const { result } = renderHook(() => useFavoriteManage('tapDance'))

    let importPromise: Promise<boolean>
    act(() => {
      importPromise = result.current.importFavorites()
    })

    expect(result.current.importing).toBe(true)

    await act(async () => {
      resolveImport({ success: true, imported: 1, skipped: 0 })
      await importPromise!
    })

    expect(result.current.importing).toBe(false)
  })
})
