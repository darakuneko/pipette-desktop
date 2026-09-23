// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// useHubState must not forward the emptyState sentinel -1 for
// `vialProtocol` (e.g. the Data modal renders on the disconnected screen,
// where `vialProtocol` is that sentinel) to the Hub IPC calls — it
// substitutes the shared FALLBACK_VIAL_PROTOCOL (6) instead, while
// passing a real protocol (5 in these tests) through as-is.
//
// It also pins the favorite Hub operation lock: a second concurrent call
// is ignored until the first one settles.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useHubState } from '../useHubState'
import type { SavedFavoriteMeta } from '../../../shared/types/favorite-store'

const { mockRequestUploadOptions } = vi.hoisted(() => ({
  mockRequestUploadOptions: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../useUploadConfirm', () => ({
  useUploadConfirm: () => ({ requestUploadOptions: mockRequestUploadOptions, isOpen: false }),
}))

const mockHubGetOrigin = vi.fn().mockResolvedValue('https://hub.example')
const mockFavoriteStoreList = vi.fn()
const mockHubUploadFavoritePost = vi.fn()
const mockHubUploadPrivateFavoritePost = vi.fn()
const mockHubUpdateFavoritePost = vi.fn()
const mockHubDeletePost = vi.fn()
const mockHubDeletePrivatePost = vi.fn()
const mockFavoriteStoreSetHubPostId = vi.fn().mockResolvedValue(undefined)
const mockFavoriteStoreSetHubPrivate = vi.fn().mockResolvedValue(undefined)
const mockHubPatchPost = vi.fn()
const mockHubFetchMyPosts = vi.fn()
const mockHubFetchMyKeyboardPosts = vi.fn()
const mockHubFetchAuthMe = vi.fn()

Object.defineProperty(window, 'vialAPI', {
  value: {
    hubGetOrigin: mockHubGetOrigin,
    favoriteStoreList: mockFavoriteStoreList,
    hubUploadFavoritePost: mockHubUploadFavoritePost,
    hubUploadPrivateFavoritePost: mockHubUploadPrivateFavoritePost,
    hubUpdateFavoritePost: mockHubUpdateFavoritePost,
    hubDeletePost: mockHubDeletePost,
    hubDeletePrivatePost: mockHubDeletePrivatePost,
    favoriteStoreSetHubPostId: mockFavoriteStoreSetHubPostId,
    favoriteStoreSetHubPrivate: mockFavoriteStoreSetHubPrivate,
    hubPatchPost: mockHubPatchPost,
    hubFetchMyPosts: mockHubFetchMyPosts,
    hubFetchMyKeyboardPosts: mockHubFetchMyKeyboardPosts,
    hubFetchAuthMe: mockHubFetchAuthMe,
  },
  writable: true,
})

function baseOptions(vialProtocol: number) {
  return {
    hubEnabled: false,
    authenticated: false,
    keyboardUid: 'uid-1',
    layoutStoreEntries: [],
    layoutStoreRefreshEntries: vi.fn(),
    layoutStoreDeleteEntry: vi.fn(),
    layoutStoreSaveLayout: vi.fn(),
    layoutStoreRenameEntry: vi.fn(),
    deviceName: 'Test KB',
    effectiveIsDummy: false,
    loadEntryVilData: vi.fn(),
    buildHubPostParams: vi.fn(),
    activityCount: 0,
    pipetteFileSavedActivityRef: { current: 0 },
    vialProtocol,
  }
}

function entriesWith(overrides: Partial<SavedFavoriteMeta> = {}): SavedFavoriteMeta[] {
  return [{ id: 'e1', label: 'Fav', savedAt: '2026-01-01T00:00:00.000Z', filename: 'e1.json', ...overrides }]
}

describe('useHubState favorite vialProtocol fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHubGetOrigin.mockResolvedValue('https://hub.example')
    mockHubUploadFavoritePost.mockResolvedValue({ success: true, postId: 'post-1' })
    mockHubUploadPrivateFavoritePost.mockResolvedValue({ success: true, id: 'priv-1', url: 'https://hub.example/p/priv-1', expiresAt: null })
    mockHubUpdateFavoritePost.mockResolvedValue({ success: true, postId: 'post-1' })
    mockHubDeletePost.mockResolvedValue({ success: true })
    mockHubDeletePrivatePost.mockResolvedValue({ success: true })
  })

  // --- handleFavUploadToHub / upload public branch ---

  it('substitutes the fallback protocol when uploading publicly with vialProtocol -1', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'public', expiresInDays: null })
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith() })

    const { result } = renderHook(() => useHubState(baseOptions(-1)))
    await act(async () => {
      await result.current.handleFavUploadToHub('tapDance', 'e1')
    })

    expect(mockHubUploadFavoritePost).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tapDance', entryId: 'e1', vialProtocol: 6 }),
    )
  })

  it('passes the real protocol through unchanged when uploading publicly with vialProtocol 5', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'public', expiresInDays: null })
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith() })

    const { result } = renderHook(() => useHubState(baseOptions(5)))
    await act(async () => {
      await result.current.handleFavUploadToHub('tapDance', 'e1')
    })

    expect(mockHubUploadFavoritePost).toHaveBeenCalledWith(
      expect.objectContaining({ vialProtocol: 5 }),
    )
  })

  // --- handleFavUploadToHub / upload private branch ---

  it('substitutes the fallback protocol when uploading privately with vialProtocol -1', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'private', expiresInDays: 7 })
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith() })

    const { result } = renderHook(() => useHubState(baseOptions(-1)))
    await act(async () => {
      await result.current.handleFavUploadToHub('tapDance', 'e1')
    })

    expect(mockHubUploadPrivateFavoritePost).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tapDance', entryId: 'e1', vialProtocol: 6 }),
    )
  })

  it('passes the real protocol through unchanged when uploading privately with vialProtocol 5', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'private', expiresInDays: 7 })
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith() })

    const { result } = renderHook(() => useHubState(baseOptions(5)))
    await act(async () => {
      await result.current.handleFavUploadToHub('tapDance', 'e1')
    })

    expect(mockHubUploadPrivateFavoritePost).toHaveBeenCalledWith(
      expect.objectContaining({ vialProtocol: 5 }),
    )
  })

  // --- handleFavUpdateOnHub / update public->public branch ---

  it('substitutes the fallback protocol on a public->public update with vialProtocol -1', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'public', expiresInDays: null })
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })

    const { result } = renderHook(() => useHubState(baseOptions(-1)))
    await act(async () => {
      await result.current.handleFavUpdateOnHub('tapDance', 'e1')
    })

    expect(mockHubUpdateFavoritePost).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tapDance', entryId: 'e1', postId: 'post-1', vialProtocol: 6 }),
    )
  })

  it('passes the real protocol through unchanged on a public->public update with vialProtocol 5', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'public', expiresInDays: null })
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })

    const { result } = renderHook(() => useHubState(baseOptions(5)))
    await act(async () => {
      await result.current.handleFavUpdateOnHub('tapDance', 'e1')
    })

    expect(mockHubUpdateFavoritePost).toHaveBeenCalledWith(
      expect.objectContaining({ vialProtocol: 5 }),
    )
  })

  // --- handleFavUpdateOnHub / update private->public branch ---

  it('substitutes the fallback protocol when switching private->public with vialProtocol -1', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'public', expiresInDays: null })
    mockFavoriteStoreList.mockResolvedValue({
      success: true,
      entries: entriesWith({ hubPrivate: { id: 'priv-1', url: 'https://hub.example/p/priv-1', expiresAt: null } }),
    })

    const { result } = renderHook(() => useHubState(baseOptions(-1)))
    await act(async () => {
      await result.current.handleFavUpdateOnHub('tapDance', 'e1')
    })

    expect(mockHubUploadFavoritePost).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tapDance', entryId: 'e1', vialProtocol: 6 }),
    )
  })

  it('passes the real protocol through unchanged when switching private->public with vialProtocol 5', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'public', expiresInDays: null })
    mockFavoriteStoreList.mockResolvedValue({
      success: true,
      entries: entriesWith({ hubPrivate: { id: 'priv-1', url: 'https://hub.example/p/priv-1', expiresAt: null } }),
    })

    const { result } = renderHook(() => useHubState(baseOptions(5)))
    await act(async () => {
      await result.current.handleFavUpdateOnHub('tapDance', 'e1')
    })

    expect(mockHubUploadFavoritePost).toHaveBeenCalledWith(
      expect.objectContaining({ vialProtocol: 5 }),
    )
  })

  // --- handleFavUpdateOnHub / update public->private branch ---

  it('substitutes the fallback protocol when switching public->private with vialProtocol -1', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'private', expiresInDays: 7 })
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })

    const { result } = renderHook(() => useHubState(baseOptions(-1)))
    await act(async () => {
      await result.current.handleFavUpdateOnHub('tapDance', 'e1')
    })

    expect(mockHubUploadPrivateFavoritePost).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'tapDance', entryId: 'e1', vialProtocol: 6 }),
    )
  })

  it('passes the real protocol through unchanged when switching public->private with vialProtocol 5', async () => {
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'private', expiresInDays: 7 })
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })

    const { result } = renderHook(() => useHubState(baseOptions(5)))
    await act(async () => {
      await result.current.handleFavUpdateOnHub('tapDance', 'e1')
    })

    expect(mockHubUploadPrivateFavoritePost).toHaveBeenCalledWith(
      expect.objectContaining({ vialProtocol: 5 }),
    )
  })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

// Favorite Hub operations share one in-flight lock: while one is pending,
// another call returns without touching the Hub API.
describe('useHubState favorite Hub operation lock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHubGetOrigin.mockResolvedValue('https://hub.example')
    mockHubFetchMyPosts.mockResolvedValue({ success: true, posts: [] })
    mockHubFetchMyKeyboardPosts.mockResolvedValue({ success: true, posts: [] })
    mockHubFetchAuthMe.mockResolvedValue({ success: false })
  })

  it('ignores a second remove while the first is pending, then accepts a new one', async () => {
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })
    const first = deferred<{ success: boolean }>()
    mockHubDeletePost.mockReturnValueOnce(first.promise).mockResolvedValue({ success: true })

    const { result } = renderHook(() => useHubState(baseOptions(5)))

    let firstCall!: Promise<void>
    act(() => {
      firstCall = result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    await waitFor(() => expect(mockHubDeletePost).toHaveBeenCalledTimes(1))

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(mockHubDeletePost).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve({ success: true })
      await firstCall
    })

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(mockHubDeletePost).toHaveBeenCalledTimes(2)
  })

  it('ignores a second rename while the first is pending, then accepts a new one', async () => {
    const first = deferred<{ success: boolean }>()
    mockHubPatchPost.mockReturnValueOnce(first.promise).mockResolvedValue({ success: true })

    const { result } = renderHook(() => useHubState({ ...baseOptions(5), hubEnabled: true, authenticated: true }))
    await waitFor(() => expect(result.current.hubReady).toBe(true))

    let firstCall!: Promise<void>
    act(() => {
      firstCall = result.current.handleFavRenameOnHub('e1', 'post-1', 'First')
    })
    expect(mockHubPatchPost).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.handleFavRenameOnHub('e1', 'post-1', 'Second')
    })
    expect(mockHubPatchPost).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve({ success: true })
      await firstCall
    })

    await act(async () => {
      await result.current.handleFavRenameOnHub('e1', 'post-1', 'Third')
    })
    expect(mockHubPatchPost).toHaveBeenCalledTimes(2)
    expect(mockHubPatchPost).toHaveBeenLastCalledWith({ postId: 'post-1', title: 'Third' })
  })

  it('releases the lock when the favorite list rejects during a remove', async () => {
    mockFavoriteStoreList
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })
    mockHubDeletePost.mockResolvedValue({ success: true })

    const { result } = renderHook(() => useHubState(baseOptions(5)))

    await act(async () => {
      await expect(result.current.handleFavRemoveFromHub('tapDance', 'e1')).rejects.toThrow('list failed')
    })
    expect(mockHubDeletePost).not.toHaveBeenCalled()
    expect(result.current.favHubUploading).toBeNull()

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(mockHubDeletePost).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when the locked favorite list rejects during an update', async () => {
    // The update handler reads the list once before taking the lock and
    // once more inside it; only the second read runs under the lock.
    mockFavoriteStoreList
      .mockResolvedValueOnce({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })
      .mockRejectedValueOnce(new Error('list failed'))
      .mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })
    mockRequestUploadOptions.mockResolvedValue({ visibility: 'public', expiresInDays: null })
    mockHubUpdateFavoritePost.mockResolvedValue({ success: true, postId: 'post-1' })

    const { result } = renderHook(() => useHubState(baseOptions(5)))

    await act(async () => {
      await expect(result.current.handleFavUpdateOnHub('tapDance', 'e1')).rejects.toThrow('list failed')
    })
    expect(mockHubUpdateFavoritePost).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.handleFavUpdateOnHub('tapDance', 'e1')
    })
    expect(mockHubUpdateFavoritePost).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when the entry is missing from the list', async () => {
    mockFavoriteStoreList
      .mockResolvedValueOnce({ success: true, entries: [] })
      .mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })
    mockHubDeletePost.mockResolvedValue({ success: true })

    const { result } = renderHook(() => useHubState(baseOptions(5)))

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(mockHubDeletePost).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(mockHubDeletePost).toHaveBeenCalledTimes(1)
  })

  it('releases the lock when the entry is not linked to the Hub', async () => {
    mockFavoriteStoreList
      .mockResolvedValueOnce({ success: true, entries: entriesWith() })
      .mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })
    mockHubDeletePost.mockResolvedValue({ success: true })

    const { result } = renderHook(() => useHubState(baseOptions(5)))

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(mockHubDeletePost).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(mockHubDeletePost).toHaveBeenCalledTimes(1)
  })

  it('clears the uploading state and releases the lock after a failed operation', async () => {
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })
    mockHubDeletePost
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ success: true })

    const { result } = renderHook(() => useHubState(baseOptions(5)))

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(result.current.favHubUploading).toBeNull()
    expect(result.current.favHubUploadResult).toEqual({ kind: 'error', message: 'hub.removeFailed', entryId: 'e1' })

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(mockHubDeletePost).toHaveBeenCalledTimes(2)
  })

  it('keeps the active call\'s lock and uploading state when a concurrent call is skipped', async () => {
    mockFavoriteStoreList.mockResolvedValue({ success: true, entries: entriesWith({ hubPostId: 'post-1' }) })
    const first = deferred<{ success: boolean }>()
    mockHubDeletePost.mockReturnValueOnce(first.promise).mockResolvedValue({ success: true })

    const { result } = renderHook(() => useHubState(baseOptions(5)))

    let firstCall!: Promise<void>
    act(() => {
      firstCall = result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    await waitFor(() => expect(result.current.favHubUploading).toBe('e1'))

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(result.current.favHubUploading).toBe('e1')

    await act(async () => {
      await result.current.handleFavRemoveFromHub('tapDance', 'e1')
    })
    expect(mockHubDeletePost).toHaveBeenCalledTimes(1)
    expect(result.current.favHubUploading).toBe('e1')

    await act(async () => {
      first.resolve({ success: true })
      await firstCall
    })
    expect(result.current.favHubUploading).toBeNull()
  })
})
