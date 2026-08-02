// SPDX-License-Identifier: GPL-2.0-or-later
// Hub IPC: public keymap post CRUD, auth-me, and the auth-display-name
// handler. Split out of hub-ipc.ts (Task-split-hub-ipc) — see
// .claude/rules/file-splitting.md.

import { secureHandle } from '../ipc-guard'
import { IpcChannels } from '../../shared/ipc/channels'
import { HUB_ERROR_DISPLAY_NAME_CONFLICT } from '../../shared/types/hub'
import type {
  HubUploadPostParams, HubUpdatePostParams, HubPatchPostParams, HubUploadResult, HubDeleteResult,
  HubFetchMyPostsResult, HubFetchMyKeyboardPostsResult, HubUserResult, HubFetchMyPostsParams,
} from '../../shared/types/hub'
import {
  Hub409Error, uploadPostToHub, updatePostOnHub, patchPostOnHub, deletePostFromHub,
  fetchMyPosts, fetchMyPostsByKeyboard, fetchAuthMe, patchAuthMe, getHubOrigin,
} from './hub-client'
import { validatePostId, validateTitle, validateKeyboardName, validateDisplayName, clampInt, computeTotalPages, extractError, buildFiles } from './hub-ipc-shared'
import { withTokenRetry, setPendingAuthDisplayName } from './hub-ipc-token'

export function registerHubPostHandlers(): void {
  secureHandle(
    IpcChannels.HUB_UPLOAD_POST,
    async (_event, params: HubUploadPostParams): Promise<HubUploadResult> => {
      try {
        const title = validateTitle(params.title)
        const files = buildFiles(params)
        const result = await withTokenRetry((jwt) =>
          uploadPostToHub(jwt, title, params.keyboardName, files),
        )
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_UPDATE_POST,
    async (_event, params: HubUpdatePostParams): Promise<HubUploadResult> => {
      try {
        validatePostId(params.postId)
        const title = validateTitle(params.title)
        const files = buildFiles(params)
        const result = await withTokenRetry((jwt) =>
          updatePostOnHub(jwt, params.postId, title, params.keyboardName, files),
        )
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Update failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_PATCH_POST,
    async (_event, params: HubPatchPostParams): Promise<HubDeleteResult> => {
      try {
        validatePostId(params.postId)
        const title = validateTitle(params.title)
        await withTokenRetry((jwt) =>
          patchPostOnHub(jwt, params.postId, { title }),
        )
        return { success: true }
      } catch (err) {
        return { success: false, error: extractError(err, 'Patch failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_DELETE_POST,
    async (_event, postId: string): Promise<HubDeleteResult> => {
      try {
        validatePostId(postId)
        await withTokenRetry((jwt) => deletePostFromHub(jwt, postId))
        return { success: true }
      } catch (err) {
        return { success: false, error: extractError(err, 'Delete failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_FETCH_MY_POSTS,
    async (_event, params?: HubFetchMyPostsParams): Promise<HubFetchMyPostsResult> => {
      try {
        const page = clampInt(params?.page, 1, Number.MAX_SAFE_INTEGER)
        const perPage = clampInt(params?.per_page, 1, 100)
        const result = await withTokenRetry((jwt) =>
          fetchMyPosts(jwt, { page, per_page: perPage }),
        )
        const totalPages = computeTotalPages(result.total, result.per_page)
        return {
          success: true,
          posts: result.items,
          pagination: {
            total: result.total,
            page: result.page,
            per_page: result.per_page,
            total_pages: totalPages,
          },
        }
      } catch (err) {
        return { success: false, error: extractError(err, 'Fetch my posts failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_FETCH_AUTH_ME,
    async (): Promise<HubUserResult> => {
      try {
        const user = await withTokenRetry((jwt) => fetchAuthMe(jwt))
        return { success: true, user }
      } catch (err) {
        return { success: false, error: extractError(err, 'Fetch auth failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_PATCH_AUTH_ME,
    async (_event, displayName: unknown): Promise<HubUserResult> => {
      try {
        const validated = validateDisplayName(displayName)
        const user = await withTokenRetry((jwt) => patchAuthMe(jwt, validated))
        return { success: true, user }
      } catch (err) {
        if (err instanceof Hub409Error) {
          return { success: false, error: HUB_ERROR_DISPLAY_NAME_CONFLICT }
        }
        return { success: false, error: extractError(err, 'Patch auth failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_FETCH_MY_KEYBOARD_POSTS,
    async (_event, keyboardName: unknown): Promise<HubFetchMyKeyboardPostsResult> => {
      try {
        const validated = validateKeyboardName(keyboardName)
        const posts = await withTokenRetry((jwt) =>
          fetchMyPostsByKeyboard(jwt, validated),
        )
        return { success: true, posts }
      } catch (err) {
        return { success: false, error: extractError(err, 'Fetch keyboard posts failed') }
      }
    },
  )

  secureHandle(IpcChannels.HUB_GET_ORIGIN, (): string => getHubOrigin())

  secureHandle(
    IpcChannels.HUB_SET_AUTH_DISPLAY_NAME,
    (_event, displayName: string | null): void => {
      setPendingAuthDisplayName(displayName)
    },
  )
}
