// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'
import { useKeyLabels } from '../useKeyLabels'
import { keyLabelsApi } from '../../../tauri-shim/api/key-labels'
import { keyLabelHubApi } from '../../../tauri-shim/api/key-label-hub'

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
const mockHubSync = vi.fn()
const mockHubTimestamps = vi.fn()

const storeMembers = {
  keyLabelStoreList: mockList,
  keyLabelStoreImport: mockImport,
  keyLabelStoreExport: mockExport,
  keyLabelStoreReorder: mockReorder,
  keyLabelStoreRename: mockRename,
  keyLabelStoreDelete: mockDelete,
}

// The preload-like mock's Hub members; the shim's hand their arguments to
// the same spies.
const hubMembers = {
  keyLabelHubList: mockHubList,
  keyLabelHubDownload: mockHubDownload,
  keyLabelHubUpload: mockHubUpload,
  keyLabelHubUpdate: mockHubUpdate,
  keyLabelHubDelete: mockHubDelete,
  keyLabelHubSync: mockHubSync,
  keyLabelHubTimestamps: mockHubTimestamps,
}

function installVialAPI(members: object): void {
  Object.defineProperty(window, 'vialAPI', { value: { ...hubMembers, ...members }, writable: true, configurable: true })
}

// Both vialAPI implementations answer from the same spies: a preload-like
// mock, and the Tauri shim's key label and key label Hub members over a
// mocked Tauri IPC, whose commands hand their arguments to the spies in the
// members' order.
const backends = [
  { name: 'preload-like mock', install: () => installVialAPI(storeMembers) },
  {
    name: 'Tauri shim over mockIPC',
    install: () => {
      mockIPC((cmd, payload) => {
        const a = payload as Record<string, unknown>
        switch (cmd) {
          case 'key_label_store_list': return mockList()
          case 'key_label_store_import': return mockImport()
          case 'key_label_store_export': return mockExport(a.id)
          case 'key_label_store_reorder': return mockReorder(a.orderedIds)
          case 'key_label_store_rename': return mockRename(a.id, a.newName)
          case 'key_label_store_delete': return mockDelete(a.id)
          case 'key_label_hub_list': return mockHubList(a.params)
          case 'key_label_hub_download': return mockHubDownload(a.hubPostId)
          case 'key_label_hub_upload': return mockHubUpload(a.localId)
          case 'key_label_hub_update': return mockHubUpdate(a.localId)
          case 'key_label_hub_delete': return mockHubDelete(a.localId)
          case 'key_label_hub_sync': return mockHubSync(a.localId)
          case 'key_label_hub_timestamps': return mockHubTimestamps(a.ids)
          default: throw new Error(`unexpected command ${cmd}`)
        }
      })
      installVialAPI({ ...keyLabelsApi, ...keyLabelHubApi })
    },
  },
]

afterEach(() => {
  clearMocks()
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

describe.each(backends)('useKeyLabels ($name)', (backend) => {
  beforeEach(() => {
    vi.clearAllMocks()
    backend.install()
    mockList.mockResolvedValue({ success: true, data: [meta({ id: 'b', name: 'B' }), meta({ id: 'a', name: 'A' })] })
    mockImport.mockResolvedValue({ success: true, data: { imported: [{ fileName: 'c.json', meta: meta({ id: 'c', name: 'C' }) }], rejections: [] } })
    mockExport.mockResolvedValue({ success: true, data: { filePath: '/tmp/c.json' } })
    mockReorder.mockResolvedValue({ success: true })
    mockRename.mockResolvedValue({ success: true, data: meta({ id: 'a', name: 'A2' }) })
    mockDelete.mockResolvedValue({ success: true })
    mockHubList.mockResolvedValue({ success: true, data: { items: [], total: 0, page: 1, per_page: 20 } })
    mockHubDownload.mockResolvedValue({ success: true, data: meta({ id: 'd', name: 'D' }) })
    mockHubUpload.mockResolvedValue({ success: true, data: meta() })
    mockHubUpdate.mockResolvedValue({ success: true, data: meta() })
    mockHubDelete.mockResolvedValue({ success: true })
    mockHubSync.mockResolvedValue({ success: true, data: meta() })
    mockHubTimestamps.mockResolvedValue({ success: true, data: { items: [] } })
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

  it('refreshes after hubSync succeeds', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      await result.current.hubSync('a')
    })

    expect(mockHubSync).toHaveBeenCalledWith('a')
    expect(mockList).toHaveBeenCalled()
  })

  it('does not refresh when hubSync fails', async () => {
    mockHubSync.mockResolvedValueOnce({ success: false, error: 'sync failed' })
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      const res = await result.current.hubSync('a')
      expect(res.success).toBe(false)
    })

    expect(mockList).not.toHaveBeenCalled()
  })

  it('hubTimestamps calls with correct parameters', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))

    await act(async () => {
      await result.current.hubTimestamps(['a', 'b'])
    })

    expect(mockHubTimestamps).toHaveBeenCalledWith(['a', 'b'])
  })

  it('hubTimestamps does not trigger a refresh', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      await result.current.hubTimestamps(['a'])
    })

    expect(mockList).not.toHaveBeenCalled()
  })

  it('refreshes after hubDelete succeeds', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      await result.current.hubDelete('a')
    })

    expect(mockHubDelete).toHaveBeenCalledWith('a')
    expect(mockList).toHaveBeenCalled()
  })

  it('does not refresh when hubDelete fails', async () => {
    mockHubDelete.mockResolvedValueOnce({ success: false, error: 'delete failed' })
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      const res = await result.current.hubDelete('a')
      expect(res.success).toBe(false)
    })

    expect(mockList).not.toHaveBeenCalled()
  })

  it('refreshes after reorder succeeds', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      await result.current.reorder(['a', 'b'])
    })

    expect(mockReorder).toHaveBeenCalledWith(['a', 'b'])
    expect(mockList).toHaveBeenCalled()
  })

  it('does not refresh when reorder fails', async () => {
    mockReorder.mockResolvedValueOnce({ success: false, error: 'reorder failed' })
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      const res = await result.current.reorder(['a', 'b'])
      expect(res.success).toBe(false)
    })

    expect(mockList).not.toHaveBeenCalled()
  })

  it('refreshes after importFromFile succeeds', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))
    mockList.mockClear()

    await act(async () => {
      await result.current.importFromFile()
    })

    expect(mockImport).toHaveBeenCalled()
    expect(mockList).toHaveBeenCalled()
  })

  it('importFromFile returns the batch import result data', async () => {
    const { result } = renderHook(() => useKeyLabels())
    await waitFor(() => expect(result.current.metas).toHaveLength(2))

    let res: Awaited<ReturnType<typeof result.current.importFromFile>>
    await act(async () => {
      res = await result.current.importFromFile()
    })

    expect(res!.success).toBe(true)
    expect(res!.data?.imported).toEqual([
      { fileName: 'c.json', meta: expect.objectContaining({ id: 'c', name: 'C' }) },
    ])
    expect(res!.data?.rejections).toEqual([])
  })
})
