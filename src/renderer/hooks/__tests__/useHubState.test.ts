// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Regression coverage for the Data-modal favorite-Hub vial_protocol bug:
// the Data modal renders on the disconnected screen, where `vialProtocol`
// is the emptyState sentinel -1. useHubState must not forward that raw
// sentinel to the Hub IPC calls — it should substitute the shared
// FALLBACK_VIAL_PROTOCOL (6) instead, while passing through any real
// (non-negative integer) protocol unchanged.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
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
