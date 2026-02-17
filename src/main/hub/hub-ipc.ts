// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handler for Hub upload operations

import { ipcMain } from 'electron'
import { IpcChannels } from '../../shared/ipc/channels'
import type { HubUploadPostParams, HubUpdatePostParams, HubPatchPostParams, HubUploadResult, HubDeleteResult, HubFetchMyPostsResult, HubFetchMyKeyboardPostsResult, HubUserResult, HubFetchMyPostsParams } from '../../shared/types/hub'
import { getIdToken } from '../sync/google-auth'
import { Hub401Error, authenticateWithHub, uploadPostToHub, updatePostOnHub, patchPostOnHub, deletePostFromHub, fetchMyPosts, fetchMyPostsByKeyboard, fetchAuthMe, patchAuthMe, getHubOrigin } from './hub-client'
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

const KEYBOARD_NAME_MAX_LENGTH = 100

function validateKeyboardName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) throw new Error('Missing keyboard name')
  const trimmed = name.trim()
  if (trimmed.length > KEYBOARD_NAME_MAX_LENGTH) throw new Error('Keyboard name too long')
  return trimmed
}

function clampInt(value: number | undefined, min: number, max: number): number | undefined {
  if (value == null) return undefined
  const floored = Math.floor(value)
  if (!Number.isFinite(floored)) return undefined
  return Math.max(min, Math.min(max, floored))
}

function computeTotalPages(total: number, perPage: number): number {
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0
  const safePerPage = Number.isFinite(perPage) && perPage > 0 ? perPage : 1
  return Math.max(1, Math.ceil(safeTotal / safePerPage))
}

// Cache Hub JWT to avoid redundant /api/auth/token round-trips.
// Hub JWT is valid for 7 days; we cache for 24 hours.
// withTokenRetry() handles mid-cache expiry via automatic 401 retry.
// The /api/auth/token endpoint has a 10 req/min rate limit.
const HUB_JWT_TTL_MS = 24 * 60 * 60 * 1000
let cachedHubJwt: { token: string; expiresAt: number } | null = null
let inflightHubAuth: Promise<string> | null = null
let cacheGeneration = 0

async function getHubToken(): Promise<string> {
  if (cachedHubJwt && Date.now() < cachedHubJwt.expiresAt) {
    return cachedHubJwt.token
  }
  // Deduplicate concurrent requests
  if (inflightHubAuth) return inflightHubAuth
  const gen = cacheGeneration
  inflightHubAuth = (async () => {
    try {
      const idToken = await getIdToken()
      if (!idToken) throw new Error(AUTH_ERROR)
      const auth = await authenticateWithHub(idToken)
      // Only cache if not invalidated (e.g. by sign-out) during the request
      if (gen === cacheGeneration) {
        cachedHubJwt = { token: auth.token, expiresAt: Date.now() + HUB_JWT_TTL_MS }
      }
      return auth.token
    } finally {
      inflightHubAuth = null
    }
  })()
  return inflightHubAuth
}

export function clearHubTokenCache(): void {
  cachedHubJwt = null
  inflightHubAuth = null
  cacheGeneration++
}

function invalidateCachedHubJwt(): void {
  cachedHubJwt = null
}

function extractError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

async function withTokenRetry<T>(operation: (jwt: string) => Promise<T>): Promise<T> {
  const jwt = await getHubToken()
  try {
    return await operation(jwt)
  } catch (err) {
    if (err instanceof Hub401Error) {
      invalidateCachedHubJwt()
      const freshJwt = await getHubToken()
      return operation(freshJwt)
    }
    throw err
  }
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
        const files = buildFiles(params)
        const result = await withTokenRetry((jwt) =>
          uploadPostToHub(jwt, params.title, params.keyboardName, files),
        )
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
        const files = buildFiles(params)
        const result = await withTokenRetry((jwt) =>
          updatePostOnHub(jwt, params.postId, params.title, params.keyboardName, files),
        )
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
        await withTokenRetry((jwt) =>
          patchPostOnHub(jwt, params.postId, { title: params.title }),
        )
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
        await withTokenRetry((jwt) => deletePostFromHub(jwt, postId))
        return { success: true }
      } catch (err) {
        return { success: false, error: extractError(err, 'Delete failed') }
      }
    },
  )

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
    IpcChannels.HUB_PATCH_AUTH_ME,
    async (_event, displayName: unknown): Promise<HubUserResult> => {
      try {
        const validated = validateDisplayName(displayName)
        const user = await withTokenRetry((jwt) => patchAuthMe(jwt, validated))
        return { success: true, user }
      } catch (err) {
        return { success: false, error: extractError(err, 'Patch auth failed') }
      }
    },
  )

  ipcMain.handle(
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

  ipcMain.handle(IpcChannels.HUB_GET_ORIGIN, (): string => getHubOrigin())
}
