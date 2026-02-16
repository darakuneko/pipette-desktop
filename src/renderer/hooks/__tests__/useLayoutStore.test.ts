// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useLayoutStore, type UseLayoutStoreOptions } from '../useLayoutStore'
import {
  VALID_VIL,
  VALID_VIL_JSON,
} from './fixtures/valid-vil'
import type { SnapshotMeta } from '../../../shared/types/snapshot-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const mockSnapshotStoreList = vi.fn()
const mockSnapshotStoreSave = vi.fn()
const mockSnapshotStoreLoad = vi.fn()
const mockSnapshotStoreRename = vi.fn()
const mockSnapshotStoreDelete = vi.fn()

const MOCK_ENTRY: SnapshotMeta = {
  id: 'entry-1',
  label: 'Test Save',
  filename: 'TestKB_2026-01-01T00-00-00-000Z.pipette',
  savedAt: '2026-01-01T00:00:00.000Z',
}

const originalVialAPI = window.vialAPI

beforeEach(() => {
  vi.clearAllMocks()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    snapshotStoreList: mockSnapshotStoreList,
    snapshotStoreSave: mockSnapshotStoreSave,
    snapshotStoreLoad: mockSnapshotStoreLoad,
    snapshotStoreRename: mockSnapshotStoreRename,
    snapshotStoreDelete: mockSnapshotStoreDelete,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  vi.restoreAllMocks()
  window.vialAPI = originalVialAPI
})

function createHookOptions(overrides?: Partial<UseLayoutStoreOptions>) {
  return {
    deviceUid: VALID_VIL.uid,
    deviceName: 'Test Keyboard',
    serialize: vi.fn(() => VALID_VIL),
    applyVilFile: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('useLayoutStore – refreshEntries', () => {
  it('fetches entries from vialAPI', async () => {
    mockSnapshotStoreList.mockResolvedValueOnce({
      success: true,
      entries: [MOCK_ENTRY],
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    await act(async () => {
      await result.current.refreshEntries()
    })

    expect(mockSnapshotStoreList).toHaveBeenCalledWith(VALID_VIL.uid)
    expect(result.current.entries).toEqual([MOCK_ENTRY])
  })

  it('does not crash on list failure', async () => {
    mockSnapshotStoreList.mockRejectedValueOnce(new Error('fail'))
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    await act(async () => {
      await result.current.refreshEntries()
    })

    expect(result.current.entries).toEqual([])
  })
})

describe('useLayoutStore – saveLayout', () => {
  it('serializes and saves via vialAPI', async () => {
    mockSnapshotStoreSave.mockResolvedValueOnce({ success: true, entry: MOCK_ENTRY })
    mockSnapshotStoreList.mockResolvedValueOnce({ success: true, entries: [MOCK_ENTRY] })
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveLayout('My Label')
    })

    expect(ok).toBe(true)
    expect(opts.serialize).toHaveBeenCalledOnce()
    expect(mockSnapshotStoreSave).toHaveBeenCalledWith(
      VALID_VIL.uid,
      JSON.stringify(VALID_VIL, null, 2),
      'Test Keyboard',
      'My Label',
    )
  })

  it('returns false and sets error on failure', async () => {
    mockSnapshotStoreSave.mockResolvedValueOnce({ success: false, error: 'disk full' })
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveLayout('test')
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('layoutStore.saveFailed')
  })

  it('manages saving flag', async () => {
    let resolveIpc!: (v: unknown) => void
    mockSnapshotStoreSave.mockReturnValueOnce(
      new Promise((r) => { resolveIpc = r }),
    )
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    expect(result.current.saving).toBe(false)

    let promise: Promise<boolean>
    act(() => {
      promise = result.current.saveLayout('test')
    })
    expect(result.current.saving).toBe(true)

    await act(async () => {
      resolveIpc({ success: true, entry: MOCK_ENTRY })
      await promise!
    })
    expect(result.current.saving).toBe(false)
  })
})

describe('useLayoutStore – loadLayout', () => {
  it('loads and applies a valid VilFile', async () => {
    mockSnapshotStoreLoad.mockResolvedValueOnce({
      success: true,
      data: VALID_VIL_JSON,
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout('entry-1')
    })

    expect(ok).toBe(true)
    expect(opts.applyVilFile).toHaveBeenCalledOnce()
    expect(opts.applyVilFile).toHaveBeenCalledWith(VALID_VIL)
  })

  it('returns false when IPC fails', async () => {
    mockSnapshotStoreLoad.mockResolvedValueOnce({
      success: false,
      error: 'not found',
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout('bad-id')
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('layoutStore.loadFailed')
  })

  it('returns false when data is invalid VilFile', async () => {
    mockSnapshotStoreLoad.mockResolvedValueOnce({
      success: true,
      data: '{"foo":"bar"}',
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadLayout('entry-1')
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('layoutStore.loadFailed')
    expect(opts.applyVilFile).not.toHaveBeenCalled()
  })

  it('manages loading flag', async () => {
    let resolveIpc!: (v: unknown) => void
    mockSnapshotStoreLoad.mockReturnValueOnce(
      new Promise((r) => { resolveIpc = r }),
    )
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    expect(result.current.loading).toBe(false)

    let promise: Promise<boolean>
    act(() => {
      promise = result.current.loadLayout('entry-1')
    })
    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveIpc({ success: true, data: VALID_VIL_JSON })
      await promise!
    })
    expect(result.current.loading).toBe(false)
  })
})

describe('useLayoutStore – renameEntry', () => {
  it('renames and refreshes', async () => {
    mockSnapshotStoreRename.mockResolvedValueOnce({ success: true })
    mockSnapshotStoreList.mockResolvedValueOnce({
      success: true,
      entries: [{ ...MOCK_ENTRY, label: 'Renamed' }],
    })
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.renameEntry('entry-1', 'Renamed')
    })

    expect(ok).toBe(true)
    expect(mockSnapshotStoreRename).toHaveBeenCalledWith(VALID_VIL.uid, 'entry-1', 'Renamed')
  })

  it('returns false on failure', async () => {
    mockSnapshotStoreRename.mockResolvedValueOnce({ success: false })
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.renameEntry('entry-1', 'New')
    })

    expect(ok).toBe(false)
  })
})

describe('useLayoutStore – deleteEntry', () => {
  it('deletes and refreshes', async () => {
    mockSnapshotStoreDelete.mockResolvedValueOnce({ success: true })
    mockSnapshotStoreList.mockResolvedValueOnce({ success: true, entries: [] })
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.deleteEntry('entry-1')
    })

    expect(ok).toBe(true)
    expect(mockSnapshotStoreDelete).toHaveBeenCalledWith(VALID_VIL.uid, 'entry-1')
  })

  it('returns false on failure', async () => {
    mockSnapshotStoreDelete.mockRejectedValueOnce(new Error('fail'))
    const opts = createHookOptions()
    const { result } = renderHook(() => useLayoutStore(opts))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.deleteEntry('entry-1')
    })

    expect(ok).toBe(false)
  })
})
