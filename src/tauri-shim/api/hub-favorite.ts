// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the favorite posts on the Hub, each the backend command
// of src-tauri/src/hub_commands/favorite.rs with its arguments by name.
// `hubFavoriteReal` holds the members the backend implements; the others stay
// fakes (fakes.ts) or stubs. coverage.test.ts checks them.

import type { VialAPI } from '../../shared/types/vial-api'
import type { FavoriteType } from '../../shared/types/favorite-store'
import { call } from '../ipc'
import type { Answer } from './hub-answer'

export const hubFavoriteApi = {
  hubUploadFavoritePost: (params) => call<Answer<'hubUploadFavoritePost'>>('hub_upload_favorite_post', { params }),
  hubUpdateFavoritePost: (params) => call<Answer<'hubUpdateFavoritePost'>>('hub_update_favorite_post', { params }),
  hubUploadPrivateFavoritePost: (params) => call<Answer<'hubUploadPrivateFavoritePost'>>('hub_upload_private_favorite_post', { params }),
} satisfies Partial<VialAPI>

/** The favorite entry a Hub post is built from (`hub_favorite_entry`). */
export function favoriteEntry(type: FavoriteType, entryId: string): Promise<unknown> {
  return call<unknown>('hub_favorite_entry', { type, entryId })
}

export const hubFavoriteReal = {} satisfies Partial<VialAPI>
