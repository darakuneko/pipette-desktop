// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFavoriteStore } from '../useFavoriteStore'
import type { SavedFavoriteMeta } from '../../../shared/types/favorite-store'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

const mockFavoriteStoreList = vi.fn()
const mockFavoriteStoreSave = vi.fn()
const mockFavoriteStoreLoad = vi.fn()
const mockFavoriteStoreRename = vi.fn()
const mockFavoriteStoreDelete = vi.fn()

const MOCK_ENTRY: SavedFavoriteMeta = {
  id: 'fav-1',
  label: 'My Tap Dance',
  filename: 'tapDance_2026-01-01T00-00-00.json',
  savedAt: '2026-01-01T00:00:00.000Z',
}

const originalVialAPI = window.vialAPI

const MOCK_TAP_DANCE_DATA = { onTap: 4, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }
const mockSerialize = vi.fn(() => MOCK_TAP_DANCE_DATA)
const mockApply = vi.fn()

function hookOpts(overrides: Record<string, unknown> = {}) {
  return { favoriteType: 'tapDance' as const, serialize: mockSerialize, apply: mockApply, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  window.vialAPI = {
    ...(window.vialAPI ?? {}),
    favoriteStoreList: mockFavoriteStoreList,
    favoriteStoreSave: mockFavoriteStoreSave,
    favoriteStoreLoad: mockFavoriteStoreLoad,
    favoriteStoreRename: mockFavoriteStoreRename,
    favoriteStoreDelete: mockFavoriteStoreDelete,
  } as unknown as typeof window.vialAPI
})

afterEach(() => {
  vi.restoreAllMocks()
  window.vialAPI = originalVialAPI
})

describe('useFavoriteStore – modal state', () => {
  it('starts with showModal false', () => {
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))
    expect(result.current.showModal).toBe(false)
  })

  it('openModal refreshes entries and sets showModal true', async () => {
    mockFavoriteStoreList.mockResolvedValueOnce({
      success: true,
      entries: [MOCK_ENTRY],
    })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    await act(async () => {
      await result.current.openModal()
    })

    expect(mockFavoriteStoreList).toHaveBeenCalledWith('tapDance')
    expect(result.current.showModal).toBe(true)
    expect(result.current.entries).toEqual([MOCK_ENTRY])
  })

  it('closeModal sets showModal false', async () => {
    mockFavoriteStoreList.mockResolvedValueOnce({ success: true, entries: [] })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    await act(async () => {
      await result.current.openModal()
    })
    expect(result.current.showModal).toBe(true)

    act(() => {
      result.current.closeModal()
    })
    expect(result.current.showModal).toBe(false)
  })
})

describe('useFavoriteStore – refreshEntries', () => {
  it('fetches entries from vialAPI', async () => {
    mockFavoriteStoreList.mockResolvedValueOnce({
      success: true,
      entries: [MOCK_ENTRY],
    })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    await act(async () => {
      await result.current.refreshEntries()
    })

    expect(mockFavoriteStoreList).toHaveBeenCalledWith('tapDance')
    expect(result.current.entries).toEqual([MOCK_ENTRY])
  })

  it('does not crash on list failure', async () => {
    mockFavoriteStoreList.mockRejectedValueOnce(new Error('fail'))
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    await act(async () => {
      await result.current.refreshEntries()
    })

    expect(result.current.entries).toEqual([])
  })
})

describe('useFavoriteStore – saveFavorite', () => {
  it('calls serialize and saves via vialAPI', async () => {
    mockFavoriteStoreSave.mockResolvedValueOnce({ success: true, entry: MOCK_ENTRY })
    mockFavoriteStoreList.mockResolvedValueOnce({ success: true, entries: [MOCK_ENTRY] })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveFavorite('My Label')
    })

    expect(ok).toBe(true)
    expect(mockSerialize).toHaveBeenCalled()
    expect(mockFavoriteStoreSave).toHaveBeenCalledWith(
      'tapDance',
      JSON.stringify({ type: 'tapDance', data: MOCK_TAP_DANCE_DATA }),
      'My Label',
    )
  })

  it('returns false and sets error on failure', async () => {
    mockFavoriteStoreSave.mockResolvedValueOnce({ success: false, error: 'disk full' })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveFavorite('test')
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('favoriteStore.saveFailed')
  })

  it('manages saving flag', async () => {
    let resolveIpc!: (v: unknown) => void
    mockFavoriteStoreSave.mockReturnValueOnce(
      new Promise((r) => { resolveIpc = r }),
    )
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    expect(result.current.saving).toBe(false)

    let promise: Promise<boolean>
    act(() => {
      promise = result.current.saveFavorite('test')
    })
    expect(result.current.saving).toBe(true)

    await act(async () => {
      resolveIpc({ success: true, entry: MOCK_ENTRY })
      await promise!
    })
    expect(result.current.saving).toBe(false)
  })

  it('returns false without IPC call when enabled is false', async () => {
    const { result } = renderHook(() => useFavoriteStore(hookOpts({ enabled: false })))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveFavorite('test')
    })

    expect(ok).toBe(false)
    expect(mockSerialize).not.toHaveBeenCalled()
    expect(mockFavoriteStoreSave).not.toHaveBeenCalled()
  })

  it('returns false when serialize throws', async () => {
    const throwingSerialize = vi.fn(() => { throw new Error('serialize error') })
    const { result } = renderHook(() => useFavoriteStore(hookOpts({ serialize: throwingSerialize })))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.saveFavorite('test')
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('favoriteStore.saveFailed')
  })
})

describe('useFavoriteStore – loadFavorite', () => {
  it('parses JSON, validates, and calls apply', async () => {
    mockFavoriteStoreLoad.mockResolvedValueOnce({
      success: true,
      data: JSON.stringify({ type: 'tapDance', data: MOCK_TAP_DANCE_DATA }),
    })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadFavorite('fav-1')
    })

    expect(ok).toBe(true)
    expect(mockApply).toHaveBeenCalledWith(MOCK_TAP_DANCE_DATA)
  })

  it('returns false and sets error when IPC fails', async () => {
    mockFavoriteStoreLoad.mockResolvedValueOnce({
      success: false,
      error: 'not found',
    })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadFavorite('bad-id')
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('favoriteStore.loadFailed')
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('returns false when type validation fails', async () => {
    mockFavoriteStoreLoad.mockResolvedValueOnce({
      success: true,
      data: '{"type":"macro","data":[]}',
    })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadFavorite('fav-1')
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('favoriteStore.loadFailed')
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('closes modal on successful load', async () => {
    mockFavoriteStoreList.mockResolvedValueOnce({ success: true, entries: [] })
    mockFavoriteStoreLoad.mockResolvedValueOnce({
      success: true,
      data: JSON.stringify({ type: 'tapDance', data: MOCK_TAP_DANCE_DATA }),
    })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    await act(async () => {
      await result.current.openModal()
    })
    expect(result.current.showModal).toBe(true)

    await act(async () => {
      await result.current.loadFavorite('fav-1')
    })
    expect(result.current.showModal).toBe(false)
  })

  it('returns false when JSON is invalid', async () => {
    mockFavoriteStoreLoad.mockResolvedValueOnce({
      success: true,
      data: 'not valid json{{{',
    })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadFavorite('fav-1')
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('favoriteStore.loadFailed')
    expect(mockApply).not.toHaveBeenCalled()
  })

  it('returns false and keeps modal open when apply throws', async () => {
    const throwingApply = vi.fn(() => { throw new Error('apply error') })
    mockFavoriteStoreList.mockResolvedValueOnce({ success: true, entries: [] })
    mockFavoriteStoreLoad.mockResolvedValueOnce({
      success: true,
      data: JSON.stringify({ type: 'tapDance', data: MOCK_TAP_DANCE_DATA }),
    })
    const { result } = renderHook(() => useFavoriteStore(hookOpts({ apply: throwingApply })))

    await act(async () => {
      await result.current.openModal()
    })
    expect(result.current.showModal).toBe(true)

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.loadFavorite('fav-1')
    })

    expect(ok).toBe(false)
    expect(result.current.error).toBe('favoriteStore.loadFailed')
    expect(result.current.showModal).toBe(true)
  })

  it('manages loading flag', async () => {
    let resolveIpc!: (v: unknown) => void
    mockFavoriteStoreLoad.mockReturnValueOnce(
      new Promise((r) => { resolveIpc = r }),
    )
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    expect(result.current.loading).toBe(false)

    let promise: Promise<boolean>
    act(() => {
      promise = result.current.loadFavorite('fav-1')
    })
    expect(result.current.loading).toBe(true)

    await act(async () => {
      resolveIpc({ success: true, data: JSON.stringify({ type: 'tapDance', data: MOCK_TAP_DANCE_DATA }) })
      await promise!
    })
    expect(result.current.loading).toBe(false)
  })
})

describe('useFavoriteStore – renameEntry', () => {
  it('renames and refreshes', async () => {
    mockFavoriteStoreRename.mockResolvedValueOnce({ success: true })
    mockFavoriteStoreList.mockResolvedValueOnce({
      success: true,
      entries: [{ ...MOCK_ENTRY, label: 'Renamed' }],
    })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.renameEntry('fav-1', 'Renamed')
    })

    expect(ok).toBe(true)
    expect(mockFavoriteStoreRename).toHaveBeenCalledWith('tapDance', 'fav-1', 'Renamed')
  })

  it('returns false on failure', async () => {
    mockFavoriteStoreRename.mockResolvedValueOnce({ success: false })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.renameEntry('fav-1', 'New')
    })

    expect(ok).toBe(false)
  })
})

describe('useFavoriteStore – deleteEntry', () => {
  it('deletes and refreshes', async () => {
    mockFavoriteStoreDelete.mockResolvedValueOnce({ success: true })
    mockFavoriteStoreList.mockResolvedValueOnce({ success: true, entries: [] })
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.deleteEntry('fav-1')
    })

    expect(ok).toBe(true)
    expect(mockFavoriteStoreDelete).toHaveBeenCalledWith('tapDance', 'fav-1')
  })

  it('returns false on failure', async () => {
    mockFavoriteStoreDelete.mockRejectedValueOnce(new Error('fail'))
    const { result } = renderHook(() => useFavoriteStore(hookOpts()))

    let ok: boolean | undefined
    await act(async () => {
      ok = await result.current.deleteEntry('fav-1')
    })

    expect(ok).toBe(false)
  })
})
