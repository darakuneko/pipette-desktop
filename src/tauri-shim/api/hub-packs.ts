// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the language and theme packs on the Hub, each the backend command
// of src-tauri/src/hub_commands/packs.rs with its arguments by name.
// `hubPacksReal` holds the members the backend implements; the others stay
// fakes (fakes.ts) or stubs. coverage.test.ts lists them.

import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import type { Answer } from './hub-answer'

export const hubPacksApi = {
  i18nPackHubTimestamps: (ids) => call<Answer<'i18nPackHubTimestamps'>>('i18n_pack_hub_timestamps', { ids }),
  hubListI18nPosts: (params) => call<Answer<'hubListI18nPosts'>>('hub_list_i18n_posts', { params }),
  hubDownloadI18nPost: (postId) => call<Answer<'hubDownloadI18nPost'>>('hub_download_i18n_post', { postId }),
  hubUploadI18nPost: (params) => call<Answer<'hubUploadI18nPost'>>('hub_upload_i18n_post', { params }),
  hubUpdateI18nPost: (params) => call<Answer<'hubUpdateI18nPost'>>('hub_update_i18n_post', { params }),
  hubDeleteI18nPost: (postId, localPackId) => call<Answer<'hubDeleteI18nPost'>>('hub_delete_i18n_post', { postId, localPackId }),
  themePackHubTimestamps: (ids) => call<Answer<'themePackHubTimestamps'>>('theme_pack_hub_timestamps', { ids }),
  hubListThemePosts: (params) => call<Answer<'hubListThemePosts'>>('hub_list_theme_posts', { params }),
  hubDownloadThemePost: (postId) => call<Answer<'hubDownloadThemePost'>>('hub_download_theme_post', { postId }),
  hubUploadThemePost: (params) => call<Answer<'hubUploadThemePost'>>('hub_upload_theme_post', { params }),
  hubUpdateThemePost: (params) => call<Answer<'hubUpdateThemePost'>>('hub_update_theme_post', { params }),
  hubDeleteThemePost: (postId, localPackId) => call<Answer<'hubDeleteThemePost'>>('hub_delete_theme_post', { postId, localPackId }),
} satisfies Partial<VialAPI>

export const hubPacksReal = {} satisfies Partial<VialAPI>
