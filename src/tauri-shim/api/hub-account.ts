// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the Hub account: the Hub origin, the display name of the next Hub token, and the account's own record, each the backend command
// of src-tauri/src/hub_commands/account.rs with its arguments by name. The
// Hub token stays in the backend; the answers carry results only.
// `hubAccountReal` holds the members the backend implements; the others stay
// fakes (fakes.ts) or stubs. coverage.test.ts checks them.

import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import type { Answer } from './hub-answer'

export const hubAccountApi = {
  hubGetOrigin: () => call<Answer<'hubGetOrigin'>>('hub_get_origin'),
  // Resolves with nothing, as the Electron handler does.
  hubSetAuthDisplayName: async (displayName) => {
    await call<null>('hub_set_auth_display_name', { displayName })
  },
  hubFetchAuthMe: () => call<Answer<'hubFetchAuthMe'>>('hub_fetch_auth_me'),
  hubPatchAuthMe: (displayName) => call<Answer<'hubPatchAuthMe'>>('hub_patch_auth_me', { displayName }),
} satisfies Partial<VialAPI>

export const hubAccountReal = {
  hubGetOrigin: hubAccountApi.hubGetOrigin,
  hubSetAuthDisplayName: hubAccountApi.hubSetAuthDisplayName,
  hubFetchAuthMe: hubAccountApi.hubFetchAuthMe,
  hubPatchAuthMe: hubAccountApi.hubPatchAuthMe,
} satisfies Partial<VialAPI>
