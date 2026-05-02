// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useKeyLabels } from '../useKeyLabels'

const mockList = vi.fn()
const mockImport = vi.fn()
const mockExport = vi.fn()
const mockReorder = vi.fn()
const mockRename = vi.fn()
const mockDelete = vi.fn()
const mockHubList = vi.fn()
const mockHubDownload = vi.fn()
const mockHubUpload = vi.fn()
const mockHubUpdate = vi.fn()
const mockHubDelete = vi.fn()

Object.defineProperty(window, 'vialAPI', {
  value: {
    keyLabelStoreList: mockList,
    keyLabelStoreImport: mockImport,
    keyLabelStoreExport: mockExport,
    keyLabelStoreReorder: mockReorder,
    keyLabelStoreRename: mockRename,
    keyLabelStoreDelete: mockDelete,
    keyLabelHubList: mockHubList,
    keyLabelHubDownload: mockHubDownload,
    keyLabelHubUpload: mockHubUpload,
    keyLabelHubUpdate: mockHubUpdate,
    keyLabelHubDelete: mockHubDelete,
  },
  writable: true,
})

function meta(overrides: Partial<{ id: string; name: string; uploaderName: string }> = {}) {
  return {
    id: overrides.id ?? 'a',
    name: overrides.name ?? 'A',
    ...(overrides.uploaderName ? { uploaderName: overrides.uploaderName } : {}),
    filename: 'a.json',
    savedAt: 'now',
    updatedAt: 'now',
  }
}

describe('useKeyLabels', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockResolvedValue({ success: true, data: [meta({ id: 'b', name: 'B' }), meta({ id: 'a', name: 'A' })] })
    mockImport.mockResolvedValue({ success: true, data: meta({ id: 'c', name: 'C' }) })
    mockExport.mockResolvedValue({ success: true, data: { filePath: '/tmp/c.json' } })
    mockReorder.mockResolvedValue({ success: true })
    mockRename.mockResolvedValue({ success: true, data: meta({ id: 'a', name: 'A2' }) })
    mockDelete.mockResolvedValue({ success: true })
    mockHubList.mockResolvedValue({ success: true, data: { items: [], total: 0, page: 1, per_page: 20 } })
    mockHubDownload.mockResolvedValue({ success: true, data: meta({ id: 'd', name: 'D' }) })
    mockHubUpload.mockResolvedValue({ success: true, data: meta() })
    mockHubUpdate.mockResolvedValue({ success: true, data: meta() })
    mockHubDelete.mockResolvedValue({ success: true })
  })

  it('preserves store order on mount (no client-side sort)', async () => {
    // The renderer must preserve the index.json order so the user's
    // drag reorder + the "append on download" rule both stick.
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    expect(result.current.metas.map((m) => m.id)).toEqual(['b', 'a'])
  })

  it('exposes the list error', async () => {
    mockList.mockResolvedValueOnce({ success: false, error: 'boom' })
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.error).toBe('boom'))
  })

  it('refreshes after rename succeeds', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))

    // Both the explicit refresh inside `rename()` and the cross-instance
    // refresh-event listener may call the IPC, so use a sticky resolution.
    mockList.mockResolvedValue({ success: true, data: [meta({ id: 'a', name: 'A2' })] })

    await act(async () => {
      await result.current.rename('a', 'A2')
    })

    expect(mockRename).toHaveBeenCalledWith('a', 'A2')
    expect(result.current.metas).toEqual([expect.objectContaining({ name: 'A2' })])
  })

  it('does not refresh when rename fails', async () => {
    mockRename.mockResolvedValueOnce({ success: false, errorCode: 'DUPLICATE_NAME' })
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      const res = await result.current.rename('a', 'B')
      expect(res.success).toBe(false)
    })

    expect(mockList).not.toHaveBeenCalled()
  })

  it('forwards hub search parameters', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))

    await act(async () => {
      await result.current.hubSearch({ q: 'french', perPage: 10 })
    })

    expect(mockHubList).toHaveBeenCalledWith({ q: 'french', perPage: 10 })
  })

  it('refreshes after hub download succeeds', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      await result.current.hubDownload('hub-1')
    })

    expect(mockHubDownload).toHaveBeenCalledWith('hub-1')
    expect(mockList).toHaveBeenCalled()
  })

  it('exportEntry forwards the id and does not refresh', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      await result.current.exportEntry('a')
    })

    expect(mockExport).toHaveBeenCalledWith('a')
    expect(mockList).not.toHaveBeenCalled()
  })

  it('does not refresh on hub upload failure', async () => {
    mockHubUpload.mockResolvedValueOnce({ success: false, errorCode: 'DUPLICATE_NAME' })
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      const res = await result.current.hubUpload('a')
      expect(res.success).toBe(false)
    })

    expect(mockList).not.toHaveBeenCalled()
  })
})
