// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handler for Hub upload operations

import { ipcMain } from 'electron'
import { IpcChannels } from '../../shared/ipc/channels'
import type { HubUploadPostParams, HubUpdatePostParams, HubPatchPostParams, HubUploadResult, HubDeleteResult, HubFetchMyPostsResult, HubUserResult } from '../../shared/types/hub'
import { getIdToken } from '../sync/google-auth'
import { authenticateWithHub, uploadPostToHub, updatePostOnHub, patchPostOnHub, deletePostFromHub, fetchMyPosts, fetchAuthMe, patchAuthMe, getHubOrigin } from './hub-client'
import type { HubUploadFiles } from './hub-client'

const AUTH_ERROR = 'Not authenticated with Google. Please sign in again.'
const POST_ID_RE = /^[a-zA-Z0-9_-]+$/
const DISPLAY_NAME_MAX_LENGTH = 50

function validatePostId(postId: string): void {
  if (!postId || !POST_ID_RE.test(postId)) {
    throw new Error('Invalid post ID')
  }
}

function validateDisplayName(displayName: unknown): string {
  if (displayName == null || typeof displayName !== 'string') throw new Error('Display name must not be empty')
  const trimmed = displayName.trim()
  if (trimmed.length === 0) throw new Error('Display name must not be empty')
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) throw new Error('Display name too long')
  return trimmed
}

async function getHubToken(): Promise<string> {
  const idToken = await getIdToken()
  if (!idToken) throw new Error(AUTH_ERROR)
  const auth = await authenticateWithHub(idToken)
  return auth.token
}

function extractError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

function buildFiles(params: HubUploadPostParams): HubUploadFiles {
  const baseName = params.keyboardName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return {
    vil: { name: `${baseName}.vil`, data: Buffer.from(params.vilJson, 'utf-8') },
    pippette: { name: `${baseName}.pippette`, data: Buffer.from(params.pippetteJson, 'utf-8') },
    c: { name: `${baseName}.c`, data: Buffer.from(params.keymapC, 'utf-8') },
    pdf: { name: `${baseName}.pdf`, data: Buffer.from(params.pdfBase64, 'base64') },
    thumbnail: { name: `${baseName}.jpg`, data: Buffer.from(params.thumbnailBase64, 'base64') },
  }
}

export function setupHubIpc(): void {
  ipcMain.handle(
    IpcChannels.HUB_UPLOAD_POST,
    async (_event, params: HubUploadPostParams): Promise<HubUploadResult> => {
      try {
        const jwt = await getHubToken()
        const files = buildFiles(params)
        const result = await uploadPostToHub(jwt, params.title, params.keyboardName, files)
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Upload failed') }
      }
    },
  )

  ipcMain.handle(
    IpcChannels.HUB_UPDATE_POST,
    async (_event, params: HubUpdatePostParams): Promise<HubUploadResult> => {
      try {
        validatePostId(params.postId)
        const jwt = await getHubToken()
        const files = buildFiles(params)
        const result = await updatePostOnHub(jwt, params.postId, params.title, params.keyboardName, files)
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Update failed') }
      }
    },
  )

  ipcMain.handle(
    IpcChannels.HUB_PATCH_POST,
    async (_event, params: HubPatchPostParams): Promise<HubDeleteResult> => {
      try {
        validatePostId(params.postId)
        const jwt = await getHubToken()
        await patchPostOnHub(jwt, params.postId, { title: params.title })
        return { success: true }
      } catch (err) {
        return { success: false, error: extractError(err, 'Patch failed') }
      }
    },
  )

  ipcMain.handle(
    IpcChannels.HUB_DELETE_POST,
    async (_event, postId: string): Promise<HubDeleteResult> => {
      try {
        validatePostId(postId)
        const jwt = await getHubToken()
        await deletePostFromHub(jwt, postId)
        return { success: true }
      } catch (err) {
        return { success: false, error: extractError(err, 'Delete failed') }
      }
    },
  )

  ipcMain.handle(
    IpcChannels.HUB_FETCH_MY_POSTS,
    async (): Promise<HubFetchMyPostsResult> => {
      try {
        const jwt = await getHubToken()
        const posts = await fetchMyPosts(jwt)
        return { success: true, posts }
      } catch (err) {
        return { success: false, error: extractError(err, 'Fetch my posts failed') }
      }
    },
  )

  ipcMain.handle(
    IpcChannels.HUB_FETCH_AUTH_ME,
    async (): Promise<HubUserResult> => {
      try {
        const jwt = await getHubToken()
        const user = await fetchAuthMe(jwt)
        return { success: true, user }
      } catch (err) {
        return { success: false, error: extractError(err, 'Fetch auth failed') }
      }
    },
  )

  ipcMain.handle(
    IpcChannels.HUB_PATCH_AUTH_ME,
    async (_event, displayName: unknown): Promise<HubUserResult> => {
      try {
        const validated = validateDisplayName(displayName)
        const jwt = await getHubToken()
        const user = await patchAuthMe(jwt, validated)
        return { success: true, user }
      } catch (err) {
        return { success: false, error: extractError(err, 'Patch auth failed') }
      }
    },
  )

  ipcMain.handle(IpcChannels.HUB_GET_ORIGIN, (): string => getHubOrigin())
}
