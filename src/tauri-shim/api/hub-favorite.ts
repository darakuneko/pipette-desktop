// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the favorite posts on the Hub. The Electron
// handlers (src/main/hub/hub-ipc-favorite.ts, and the private upload of
// hub-ipc-private.ts) build a post's export JSON in the main process, whose
// keycode tables are the defaults; here the favorite transfer worker
// (workers/favorite-transfer.worker.ts) names the keycodes, so each member
// runs the handler's steps in the handler's order: the post id of an
// update, the checks of `prepareFavoritePost` (the type, the Vial protocol,
// the title), the read of the entry (`hub_favorite_entry`), the JSON from
// the worker, then the command of src-tauri/src/hub_commands/favorite.rs,
// which checks the post again and sends it with the Hub token. A failure of
// any step is the handler's `{ success: false, error }`.

import type { VialAPI } from '../../shared/types/vial-api'
import type { FavoriteType } from '../../shared/types/favorite-store'
import type {
  HubPrivateUploadFavoritePostParams,
  HubPrivateUploadResult,
  HubUpdateFavoritePostParams,
  HubUploadFavoritePostParams,
  HubUploadResult,
} from '../../shared/types/hub'
import type { FavoriteExportBody } from '../../shared/favorite-transfer'
import { isValidFavoriteType, isValidHubVialProtocol } from '../../shared/favorite-data'
import { call } from '../ipc'
import { transfer } from '../workers/favorite-transfer-client'
import { extractError, validatePostId, validateTitle } from './hub-favorite-checks'

type EntryRead = { success: true; entry: FavoriteExportBody } | { success: false; error: string }

/** The favorite entry a Hub post is built from (`hub_favorite_entry`). */
export function favoriteEntry(type: FavoriteType, entryId: string): Promise<EntryRead> {
  return call<EntryRead>('hub_favorite_entry', { favoriteType: type, entryId })
}

/** Sends a favorite post with its export `json`. */
export function uploadFavorite(params: HubUploadFavoritePostParams, json: string): Promise<HubUploadResult> {
  return call('hub_upload_favorite_post', { params, json })
}

export function updateFavorite(params: HubUpdateFavoritePostParams, json: string): Promise<HubUploadResult> {
  return call('hub_update_favorite_post', { params, json })
}

export function uploadPrivateFavorite(
  params: HubPrivateUploadFavoritePostParams,
  json: string,
): Promise<HubPrivateUploadResult> {
  return call('hub_upload_private_favorite_post', { params, json })
}

/** `prepareFavoritePost`: the checks, the read and the export JSON. */
async function prepareFavoritePost(params: HubUploadFavoritePostParams): Promise<string> {
  if (!isValidFavoriteType(params.type)) throw new Error('Invalid favorite type')
  if (!isValidHubVialProtocol(params.vialProtocol)) throw new Error('Invalid vialProtocol')
  validateTitle(params.title)
  const read = await favoriteEntry(params.type, params.entryId)
  if (!read.success) throw new Error(read.error)
  const built = await transfer({ op: 'hubExport', scope: params.type, vialProtocol: params.vialProtocol, entry: read.entry })
  if ('error' in built) throw new Error(built.error)
  // A thrown value that is not an `Error` is rethrown as one that is not
  // either, so `extractError` answers the member's fallback.
  if ('thrown' in built) throw built.thrown === null ? built : new Error(built.thrown)
  return built.json
}

export const hubFavoriteApi = {
  hubUploadFavoritePost: async (params) => {
    try {
      return await uploadFavorite(params, await prepareFavoritePost(params))
    } catch (err) {
      return { success: false, error: extractError(err, 'Upload failed') }
    }
  },
  hubUpdateFavoritePost: async (params) => {
    try {
      validatePostId(params.postId)
      return await updateFavorite(params, await prepareFavoritePost(params))
    } catch (err) {
      return { success: false, error: extractError(err, 'Update failed') }
    }
  },
  hubUploadPrivateFavoritePost: async (params) => {
    try {
      return await uploadPrivateFavorite(params, await prepareFavoritePost(params))
    } catch (err) {
      return { success: false, error: extractError(err, 'Upload failed') }
    }
  },
} satisfies Partial<VialAPI>
