// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the keymap posts and the private posts on the Hub, each the backend command
// of src-tauri/src/hub_commands/posts.rs with its arguments by name. The
// Hub token stays in the backend; the answers carry results only.

import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import type { Answer } from './hub-answer'

export const hubPostsApi = {
  hubUploadPost: (params) => call<Answer<'hubUploadPost'>>('hub_upload_post', { params }),
  hubUpdatePost: (params) => call<Answer<'hubUpdatePost'>>('hub_update_post', { params }),
  hubPatchPost: (params) => call<Answer<'hubPatchPost'>>('hub_patch_post', { params }),
  hubDeletePost: (postId) => call<Answer<'hubDeletePost'>>('hub_delete_post', { postId }),
  hubFetchMyPosts: (params) => call<Answer<'hubFetchMyPosts'>>('hub_fetch_my_posts', { params }),
  hubFetchMyKeyboardPosts: (keyboardName) => call<Answer<'hubFetchMyKeyboardPosts'>>('hub_fetch_my_keyboard_posts', { keyboardName }),
  hubUploadPrivatePost: (params) => call<Answer<'hubUploadPrivatePost'>>('hub_upload_private_post', { params }),
  hubDeletePrivatePost: (kind, id) => call<Answer<'hubDeletePrivatePost'>>('hub_delete_private_post', { kind, id }),
} satisfies Partial<VialAPI>
