// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// The favorite Hub upload and update handlers (use-hub-favorite-handlers.ts)
// on both vialAPI implementations (hub-favorite-backends.ts): the same
// post members are called with the same arguments, the Hub link is stored,
// and the Hub's errors reach the result. On the Tauri shim the post also
// carries the stored entry's export JSON.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { clearMocks } from '@tauri-apps/api/mocks'
import type { TFunction } from 'i18next'
import { useHubFavoriteHandlers } from '../use-hub-favorite-handlers'
import type { SavedFavoriteMeta } from '../../../shared/types/favorite-store'
import { HUB_ERROR_ACCOUNT_DEACTIVATED } from '../../../shared/types/hub'
import { hubFavoriteBackends } from './hub-favorite-backends'

vi.mock('../../../tauri-shim/workers/favorite-transfer-client', () => ({ transfer: vi.fn() }))

const spies = {
  favoriteStoreList: vi.fn(),
  favoriteStoreSetHubPostId: vi.fn(),
  favoriteStoreSetHubPrivate: vi.fn(),
  hubUploadFavoritePost: vi.fn(),
  hubUpdateFavoritePost: vi.fn(),
  hubUploadPrivateFavoritePost: vi.fn(),
  hubDeletePost: vi.fn(),
  hubDeletePrivatePost: vi.fn(),
}
const requestUploadOptions = vi.fn()
const markAccountDeactivated = vi.fn()
const setFavHubUploading = vi.fn()
const setFavHubUploadResult = vi.fn()

const originalVialAPI = window.vialAPI

function entries(overrides: Partial<SavedFavoriteMeta> = {}): SavedFavoriteMeta[] {
  return [{ id: 'e1', label: 'Fav', savedAt: '2026-01-01T00:00:00.000Z', filename: 'e1.json', ...overrides }]
}

function render() {
  return renderHook(() =>
    useHubFavoriteHandlers({
      requestUploadOptions,
      t: ((key: string) => key) as unknown as TFunction,
      favVialProtocol: 6,
      markAccountDeactivated,
      hubReady: true,
      setFavHubUploading,
      setFavHubUploadResult,
    }),
  ).result
}

const PUBLIC_EXPORT =
  '{"app":"pipette","version":3,"scope":"fav","exportedAt":"2026-01-02T00:00:00.000Z","vial_protocol":6,' +
  '"categories":{"td":[{"label":"Stored","savedAt":"2026-01-01T00:00:00.000Z",' +
  '"data":{"onTap":"KC_A","onHold":"KC_NO","onDoubleTap":"KC_NO","onTapHold":"KC_NO","tappingTerm":200}}]}}'

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 0, 2))
  spies.favoriteStoreSetHubPostId.mockResolvedValue({ success: true })
  spies.favoriteStoreSetHubPrivate.mockResolvedValue({ success: true })
  spies.hubUploadFavoritePost.mockResolvedValue({ success: true, postId: 'post-1' })
  spies.hubUpdateFavoritePost.mockResolvedValue({ success: true, postId: 'post-1' })
  spies.hubUploadPrivateFavoritePost.mockResolvedValue({
    success: true, id: 'priv-1', url: '/p/priv-1?token=t', expiresAt: '2026-02-01T00:00:00.000Z',
  })
  spies.hubDeletePost.mockResolvedValue({ success: true })
  spies.hubDeletePrivatePost.mockResolvedValue({ success: true })
})

afterEach(() => {
  vi.useRealTimers()
  clearMocks()
  window.vialAPI = originalVialAPI
})

describe.each(hubFavoriteBackends(spies))('useHubFavoriteHandlers on the $name', (backend) => {
  beforeEach(() => backend.install())

  it('uploads publicly and stores the post id', async () => {
    spies.favoriteStoreList.mockResolvedValue({ success: true, entries: entries() })
    requestUploadOptions.mockResolvedValue({ visibility: 'public' })
    const handlers = render()
    await act(() => handlers.current.handleFavUploadToHub('tapDance', 'e1'))

    expect(spies.hubUploadFavoritePost).toHaveBeenCalledWith({ type: 'tapDance', entryId: 'e1', title: 'Fav', vialProtocol: 6 })
    expect(spies.favoriteStoreSetHubPostId).toHaveBeenCalledWith('tapDance', 'e1', 'post-1')
    expect(setFavHubUploadResult).toHaveBeenLastCalledWith({ kind: 'success', message: 'hub.uploadSuccess', entryId: 'e1' })
    expect(backend.sentJson).toEqual(backend.name.startsWith('Tauri') ? [PUBLIC_EXPORT] : [])
  })

  it('uploads privately and stores the link', async () => {
    spies.favoriteStoreList.mockResolvedValue({ success: true, entries: entries() })
    requestUploadOptions.mockResolvedValue({ visibility: 'private', expiresInDays: 30 })
    const handlers = render()
    await act(() => handlers.current.handleFavUploadToHub('tapDance', 'e1'))

    expect(spies.hubUploadPrivateFavoritePost).toHaveBeenCalledWith({
      type: 'tapDance', entryId: 'e1', title: 'Fav', vialProtocol: 6, expiresInDays: 30,
    })
    expect(spies.favoriteStoreSetHubPrivate).toHaveBeenCalledWith('tapDance', 'e1', {
      id: 'priv-1', url: '/p/priv-1?token=t', expiresAt: '2026-02-01T00:00:00.000Z',
    })
  })

  it('updates a public post in place', async () => {
    spies.favoriteStoreList.mockResolvedValue({ success: true, entries: entries({ hubPostId: 'post-1' }) })
    requestUploadOptions.mockResolvedValue({ visibility: 'public' })
    const handlers = render()
    await act(() => handlers.current.handleFavUpdateOnHub('tapDance', 'e1'))

    expect(spies.hubUpdateFavoritePost).toHaveBeenCalledWith({
      type: 'tapDance', entryId: 'e1', title: 'Fav', postId: 'post-1', vialProtocol: 6,
    })
    expect(spies.hubDeletePost).not.toHaveBeenCalled()
    expect(setFavHubUploadResult).toHaveBeenLastCalledWith({ kind: 'success', message: 'hub.updateSuccess', entryId: 'e1' })
  })

  it('reports a deactivated account and stores nothing', async () => {
    spies.favoriteStoreList.mockResolvedValue({ success: true, entries: entries() })
    spies.hubUploadFavoritePost.mockResolvedValue({ success: false, error: HUB_ERROR_ACCOUNT_DEACTIVATED })
    requestUploadOptions.mockResolvedValue({ visibility: 'public' })
    const handlers = render()
    await act(() => handlers.current.handleFavUploadToHub('tapDance', 'e1'))

    expect(markAccountDeactivated).toHaveBeenCalledTimes(1)
    expect(spies.favoriteStoreSetHubPostId).not.toHaveBeenCalled()
    expect(setFavHubUploadResult).toHaveBeenLastCalledWith({ kind: 'error', message: 'hub.accountDeactivated', entryId: 'e1' })
  })
})
