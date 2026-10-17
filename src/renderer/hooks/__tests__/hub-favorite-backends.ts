// SPDX-License-Identifier: GPL-2.0-or-later
// The two vialAPI implementations the favorite Hub handlers' tests
// (use-hub-favorite-handlers.test.ts) run against, both answering from the
// same VialAPI-shaped spies: a preload-like mock (the spies themselves),
// and the Tauri shim's favorite store and favorite post members over a
// mocked Tauri IPC, whose commands hand the spies their arguments in the
// members' order. The post members read the entry `ENTRY_BODY` and build
// its export JSON with the worker's request run in place; the test file
// must mock the worker client
// (src/tauri-shim/workers/favorite-transfer-client.ts) with a `transfer`
// spy, which this module drives. The Hub delete members are not the
// favorite post members' and stay spies on both.

import { vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import { favoritesApi } from '../../../tauri-shim/api/favorites'
import { hubFavoriteApi } from '../../../tauri-shim/api/hub-favorite'
import { runFavoriteTransfer, type FavoriteTransferRequest } from '../../../tauri-shim/workers/favorite-transfer-requests'
import { transfer } from '../../../tauri-shim/workers/favorite-transfer-client'

type Spy = (...args: unknown[]) => unknown
type Member =
  | 'favoriteStoreList'
  | 'favoriteStoreSetHubPostId'
  | 'favoriteStoreSetHubPrivate'
  | 'hubUploadFavoritePost'
  | 'hubUpdateFavoritePost'
  | 'hubUploadPrivateFavoritePost'
  | 'hubDeletePost'
  | 'hubDeletePrivatePost'
export type HubFavoriteSpies = Record<Member, Spy>

export interface HubFavoriteBackend {
  name: string
  /** The export JSON each post the shim sent carried (empty for the mock). */
  sentJson: string[]
  install: () => void
}

/** The stored body of every favorite the shim reads. */
export const ENTRY_BODY = { type: 'tapDance', data: { onTap: 4, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 } }

function installVialAPI(members: object): void {
  window.vialAPI = { ...(window.vialAPI ?? {}), ...members } as unknown as typeof window.vialAPI
}

function installShim(spies: HubFavoriteSpies, sentJson: string[]): void {
  vi.mocked(transfer).mockImplementation(async (request: FavoriteTransferRequest) => runFavoriteTransfer(request))
  mockIPC((cmd, payload) => {
    const a = payload as Record<string, unknown>
    switch (cmd) {
      case 'favorite_store_list': return spies.favoriteStoreList(a.favoriteType)
      case 'favorite_store_set_hub_post_id': return spies.favoriteStoreSetHubPostId(a.favoriteType, a.entryId, a.hubPostId)
      case 'favorite_store_set_hub_private':
        return spies.favoriteStoreSetHubPrivate(a.favoriteType, a.entryId, JSON.parse(String(a.link)))
      case 'hub_favorite_entry':
        return { success: true, entry: { label: 'Stored', savedAt: '2026-01-01T00:00:00.000Z', body: JSON.stringify(ENTRY_BODY) } }
      case 'hub_upload_favorite_post':
      case 'hub_update_favorite_post':
      case 'hub_upload_private_favorite_post': {
        sentJson.push(String(a.json))
        const member = { hub_upload_favorite_post: 'hubUploadFavoritePost', hub_update_favorite_post: 'hubUpdateFavoritePost', hub_upload_private_favorite_post: 'hubUploadPrivateFavoritePost' }[cmd] as Member
        return spies[member](a.params)
      }
      default: throw new Error(`unexpected command ${cmd}`)
    }
  })
  installVialAPI({
    ...favoritesApi,
    ...hubFavoriteApi,
    hubDeletePost: spies.hubDeletePost,
    hubDeletePrivatePost: spies.hubDeletePrivatePost,
  })
}

export function hubFavoriteBackends(spies: HubFavoriteSpies): HubFavoriteBackend[] {
  const shimJson: string[] = []
  return [
    { name: 'preload-like mock', sentJson: [], install: () => installVialAPI(spies) },
    {
      name: 'Tauri shim over mockIPC',
      sentJson: shimJson,
      install: () => {
        shimJson.length = 0
        installShim(spies, shimJson)
      },
    },
  ]
}
