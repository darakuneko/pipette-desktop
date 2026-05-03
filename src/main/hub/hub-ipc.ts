// SPDX-License-Identifier: GPL-2.0-or-later
// IPC handler for Hub upload operations

import { secureHandle } from '../ipc-guard'
import { IpcChannels } from '../../shared/ipc/channels'
import { HUB_ERROR_DISPLAY_NAME_CONFLICT, HUB_ERROR_ACCOUNT_DEACTIVATED, HUB_ERROR_RATE_LIMITED } from '../../shared/types/hub'
import type { HubUploadPostParams, HubUpdatePostParams, HubPatchPostParams, HubUploadResult, HubDeleteResult, HubFetchMyPostsResult, HubFetchMyKeyboardPostsResult, HubUserResult, HubFetchMyPostsParams, HubUploadFavoritePostParams, HubUpdateFavoritePostParams } from '../../shared/types/hub'
import { getIdToken } from '../sync/google-auth'
import { Hub401Error, Hub403Error, Hub409Error, Hub429Error, authenticateWithHub, uploadPostToHub, updatePostOnHub, patchPostOnHub, deletePostFromHub, fetchMyPosts, fetchMyPostsByKeyboard, fetchAuthMe, patchAuthMe, getHubOrigin, uploadFeaturePostToHub, updateFeaturePostOnHub } from './hub-client'
import type { HubAuthResult, HubUploadFiles } from './hub-client'
import { fetchKeyLabelList, fetchKeyLabelDetail, fetchKeyLabelTimestamps, downloadKeyLabel, uploadKeyLabel, updateKeyLabel, deleteKeyLabel } from './hub-key-labels'
import type { HubKeyLabelInput } from './hub-key-labels'
import type { HubKeyLabelItem, HubKeyLabelListResponse, HubKeyLabelListParams, HubKeyLabelTimestamp, HubKeyLabelTimestampsResponse } from '../../shared/types/hub-key-label'
import { HUB_ERROR_KEY_LABEL_DUPLICATE, HUB_KEY_LABEL_TIMESTAMPS_BATCH_LIMIT } from '../../shared/types/hub-key-label'
import { getRecord, saveRecord, setHubPostId } from '../key-label-store'
import type { KeyLabelMeta, KeyLabelStoreResult } from '../../shared/types/key-label-store'
import { isValidFavoriteType, isValidVialProtocol, FAV_TYPE_TO_EXPORT_KEY, serializeFavData, buildFavExportFile } from '../../shared/favorite-data'
import { serialize as serializeKeycode } from '../../shared/keycodes/keycodes'
import type { FavoriteType, FavoriteIndex } from '../../shared/types/favorite-store'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

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

const TITLE_MAX_LENGTH = 200

function validateTitle(title: unknown): string {
  if (typeof title !== 'string' || title.trim().length === 0) throw new Error('Title must not be empty')
  const trimmed = title.trim()
  if (trimmed.length > TITLE_MAX_LENGTH) throw new Error('Title too long')
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
let pendingAuthDisplayName: string | null = null

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
      let auth: HubAuthResult
      try {
        auth = await authenticateWithHub(idToken, pendingAuthDisplayName ?? undefined)
      } catch (err) {
        if (err instanceof Hub409Error) throw new Error(HUB_ERROR_DISPLAY_NAME_CONFLICT)
        rethrowAsHubSentinel(err)
        throw err
      }
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
  pendingAuthDisplayName = null
}

function invalidateCachedHubJwt(): void {
  cachedHubJwt = null
}

function extractError(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback
}

function rethrowAsHubSentinel(err: unknown): void {
  if (err instanceof Hub403Error) throw new Error(HUB_ERROR_ACCOUNT_DEACTIVATED)
  if (err instanceof Hub429Error) throw new Error(HUB_ERROR_RATE_LIMITED)
}

async function withTokenRetry<T>(operation: (jwt: string) => Promise<T>): Promise<T> {
  const jwt = await getHubToken()
  try {
    return await operation(jwt)
  } catch (err) {
    if (err instanceof Hub401Error) {
      invalidateCachedHubJwt()
      const freshJwt = await getHubToken()
      try {
        return await operation(freshJwt)
      } catch (retryErr) {
        rethrowAsHubSentinel(retryErr)
        throw retryErr
      }
    }
    rethrowAsHubSentinel(err)
    throw err
  }
}

const MB = 1024 * 1024
const FILE_SIZE_LIMITS: Record<string, { max: number; label: string }> = {
  thumbnail: { max: 2 * MB, label: 'thumbnail' },
  vil: { max: 10 * MB, label: 'vil' },
  pipette: { max: 10 * MB, label: 'pipette' },
  c: { max: 10 * MB, label: 'keymap C' },
  pdf: { max: 10 * MB, label: 'PDF' },
}

function validateFileSize(files: HubUploadFiles): void {
  for (const [key, limit] of Object.entries(FILE_SIZE_LIMITS)) {
    const file = files[key as keyof HubUploadFiles]
    if (file.data.byteLength > limit.max) {
      throw new Error(`File too large: ${limit.label} exceeds ${limit.max / MB} MB limit`)
    }
  }
}

function buildFiles(params: HubUploadPostParams): HubUploadFiles {
  const baseName = params.keyboardName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const files: HubUploadFiles = {
    vil: { name: `${baseName}.vil`, data: Buffer.from(params.vilJson, 'utf-8') },
    pipette: { name: `${baseName}.pipette`, data: Buffer.from(params.pipetteJson, 'utf-8') },
    c: { name: `${baseName}.c`, data: Buffer.from(params.keymapC, 'utf-8') },
    pdf: { name: `${baseName}.pdf`, data: Buffer.from(params.pdfBase64, 'base64') },
    thumbnail: { name: `${baseName}.jpg`, data: Buffer.from(params.thumbnailBase64, 'base64') },
  }
  validateFileSize(files)
  return files
}

function isSafePathSegment(segment: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(segment) && segment !== '.' && segment !== '..'
}

async function buildFavoriteExportJson(
  type: FavoriteType,
  entryId: string,
  vialProtocol: number,
): Promise<string> {
  const favDir = join(app.getPath('userData'), 'sync', 'favorites', type)
  const indexPath = join(favDir, 'index.json')
  const indexRaw = await readFile(indexPath, 'utf-8')
  const index = JSON.parse(indexRaw) as FavoriteIndex
  const entry = index.entries.find((e) => e.id === entryId && !e.deletedAt)
  if (!entry) throw new Error('Entry not found')

  if (!isSafePathSegment(entry.filename)) throw new Error('Invalid filename')
  const filePath = join(favDir, entry.filename)
  const fileRaw = await readFile(filePath, 'utf-8')
  const parsed = JSON.parse(fileRaw) as { type: string; data: unknown }
  if (parsed.data == null) throw new Error('Entry data is empty')
  if (parsed.type !== type) throw new Error('Entry type mismatch')

  const exportKey = FAV_TYPE_TO_EXPORT_KEY[type]
  const serializedData = serializeFavData(type, parsed.data, serializeKeycode)

  const exportFile = buildFavExportFile(vialProtocol, {
    [exportKey]: [{
      label: entry.label,
      savedAt: entry.savedAt,
      data: serializedData,
    }],
  })

  return JSON.stringify(exportFile)
}

/**
 * Fetch a key-label download body together with the uploader name and
 * Hub-side `updated_at` from the detail endpoint. The detail call is
 * best-effort: if it fails (network blip, 404 on a deleted post, etc.)
 * we keep the caller-supplied uploader fallback so the Author column
 * does not lose its cached value, and `hubUpdatedAt` simply stays
 * undefined for that round.
 */
async function fetchHubKeyLabelPayload(
  hubPostId: string,
  fallbackUploader?: string,
  fallbackHubUpdatedAt?: string,
): Promise<{
  body: { name: string; map: Record<string, string>; composite_labels: Record<string, string> | null }
  uploaderName: string | undefined
  hubUpdatedAt: string | undefined
}> {
  const body = await downloadKeyLabel(hubPostId)
  let uploaderName: string | undefined = fallbackUploader
  let hubUpdatedAt: string | undefined = fallbackHubUpdatedAt
  try {
    const detail = await fetchKeyLabelDetail(hubPostId)
    uploaderName = detail.uploader_name ?? fallbackUploader
    hubUpdatedAt = detail.updated_at ?? fallbackHubUpdatedAt
  } catch {
    // best-effort; keep the fallback values
  }
  return { body, uploaderName, hubUpdatedAt }
}

export function setupHubIpc(): void {
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
      pendingAuthDisplayName = typeof displayName === 'string' ? displayName : null
      // Invalidate cached JWT so the next getHubToken() re-authenticates
      // with the new display name instead of returning a stale cached/inflight result.
      cachedHubJwt = null
      inflightHubAuth = null
    },
  )

  // --- Favorite (feature) post handlers ---

  async function prepareFavoritePost(
    params: HubUploadFavoritePostParams,
  ): Promise<{ title: string; postType: string; jsonFile: { name: string; data: Buffer } }> {
    if (!isValidFavoriteType(params.type)) throw new Error('Invalid favorite type')
    if (!isValidVialProtocol(params.vialProtocol)) throw new Error('Invalid vialProtocol')
    const title = validateTitle(params.title)
    const postType = FAV_TYPE_TO_EXPORT_KEY[params.type]
    const jsonStr = await buildFavoriteExportJson(params.type, params.entryId, params.vialProtocol)
    return { title, postType, jsonFile: { name: `${postType}.json`, data: Buffer.from(jsonStr, 'utf-8') } }
  }

  secureHandle(
    IpcChannels.HUB_UPLOAD_FAVORITE_POST,
    async (_event, params: HubUploadFavoritePostParams): Promise<HubUploadResult> => {
      try {
        const { title, postType, jsonFile } = await prepareFavoritePost(params)
        const result = await withTokenRetry((jwt) =>
          uploadFeaturePostToHub(jwt, title, postType, jsonFile),
        )
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_UPDATE_FAVORITE_POST,
    async (_event, params: HubUpdateFavoritePostParams): Promise<HubUploadResult> => {
      try {
        validatePostId(params.postId)
        const { title, postType, jsonFile } = await prepareFavoritePost(params)
        const result = await withTokenRetry((jwt) =>
          updateFeaturePostOnHub(jwt, params.postId, title, postType, jsonFile),
        )
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Update failed') }
      }
    },
  )

  // --- Key Label Hub handlers ---

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_LIST,
    async (
      _event,
      params: HubKeyLabelListParams | undefined,
    ): Promise<KeyLabelStoreResult<HubKeyLabelListResponse>> => {
      try {
        const page = clampInt(params?.page, 1, Number.MAX_SAFE_INTEGER) ?? 1
        const perPage = clampInt(params?.perPage, 1, 100) ?? 20
        const data = await fetchKeyLabelList({ q: params?.q, page, perPage })
        return { success: true, data }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub list failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_DETAIL,
    async (_event, hubPostId: unknown): Promise<KeyLabelStoreResult<HubKeyLabelItem>> => {
      try {
        if (typeof hubPostId !== 'string' || !POST_ID_RE.test(hubPostId)) {
          return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid hub post id' }
        }
        const detail = await fetchKeyLabelDetail(hubPostId)
        return { success: true, data: detail }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub detail failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_TIMESTAMPS,
    async (_event, ids: unknown): Promise<KeyLabelStoreResult<HubKeyLabelTimestampsResponse>> => {
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string' && POST_ID_RE.test(id))) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'ids must be an array of valid hub post ids' }
      }
      const unique = Array.from(new Set(ids as string[]))
      if (unique.length === 0) return { success: true, data: { items: [] } }
      try {
        // Server caps each request at 100 ids; split larger inputs and
        // run the chunks in parallel. Order is rebuilt from the input
        // array so callers see input-order semantics regardless of
        // chunking.
        const chunks: string[][] = []
        for (let i = 0; i < unique.length; i += HUB_KEY_LABEL_TIMESTAMPS_BATCH_LIMIT) {
          chunks.push(unique.slice(i, i + HUB_KEY_LABEL_TIMESTAMPS_BATCH_LIMIT))
        }
        const responses = await Promise.all(chunks.map((chunk) => fetchKeyLabelTimestamps(chunk)))
        const byId = new Map<string, HubKeyLabelTimestamp>()
        for (const r of responses) {
          for (const item of r.items) byId.set(item.id, item)
        }
        const items: HubKeyLabelTimestamp[] = []
        for (const id of unique) {
          const found = byId.get(id)
          if (found) items.push(found)
        }
        return { success: true, data: { items } }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub timestamps failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_DOWNLOAD,
    async (_event, hubPostId: unknown): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      try {
        if (typeof hubPostId !== 'string' || !POST_ID_RE.test(hubPostId)) {
          return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid hub post id' }
        }
        const { body, uploaderName, hubUpdatedAt } = await fetchHubKeyLabelPayload(hubPostId)
        const composite = body.composite_labels ?? undefined
        // Use the Hub post id as the local id so the saved
        // `keyboardLayout` can be matched against Hub later (e.g. the
        // Missing Key Label dialog needs to look up the human name
        // after the entry has been removed locally).
        return await saveRecord({
          id: hubPostId,
          name: body.name,
          ...(uploaderName ? { uploaderName } : {}),
          map: body.map,
          ...(composite ? { compositeLabels: composite } : {}),
          hubPostId,
          ...(hubUpdatedAt ? { hubUpdatedAt } : {}),
        })
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub download failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_UPLOAD,
    async (_event, localId: unknown): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      if (typeof localId !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const record = await getRecord(localId)
      if (!record.success || !record.data) return record as KeyLabelStoreResult<KeyLabelMeta>
      const input: HubKeyLabelInput = {
        name: record.data.meta.name,
        map: record.data.data.map,
        ...(record.data.data.compositeLabels ? { compositeLabels: record.data.data.compositeLabels } : {}),
      }
      try {
        const result = await withTokenRetry((jwt) => uploadKeyLabel(jwt, input))
        // Carry the response's uploader_name and updated_at into the
        // local meta so the modal immediately shows the Author and
        // Updated columns and the Update / Remove buttons (gated by
        // isMine = author === currentDisplayName) appear without
        // waiting for a sync.
        return setHubPostId(localId, result.id, result.uploader_name, result.updated_at)
      } catch (err) {
        if (err instanceof Hub409Error) {
          return { success: false, errorCode: 'DUPLICATE_NAME', error: HUB_ERROR_KEY_LABEL_DUPLICATE }
        }
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_UPDATE,
    async (_event, localId: unknown): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      if (typeof localId !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const record = await getRecord(localId)
      if (!record.success || !record.data) return record as KeyLabelStoreResult<KeyLabelMeta>
      const hubPostId = record.data.meta.hubPostId
      if (!hubPostId) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Entry has no hub post' }
      }
      const input: HubKeyLabelInput = {
        name: record.data.meta.name,
        map: record.data.data.map,
        ...(record.data.data.compositeLabels ? { compositeLabels: record.data.data.compositeLabels } : {}),
      }
      try {
        const result = await withTokenRetry((jwt) => updateKeyLabel(jwt, hubPostId, input))
        // Persist the new Hub-side updated_at so the Updated column
        // matches Hub's own display. Pass undefined uploaderName so
        // setHubPostId leaves the existing value alone.
        return setHubPostId(localId, hubPostId, undefined, result.updated_at)
      } catch (err) {
        if (err instanceof Hub409Error) {
          return { success: false, errorCode: 'DUPLICATE_NAME', error: HUB_ERROR_KEY_LABEL_DUPLICATE }
        }
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub update failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_SYNC,
    async (_event, localId: unknown): Promise<KeyLabelStoreResult<KeyLabelMeta>> => {
      if (typeof localId !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const record = await getRecord(localId)
      if (!record.success || !record.data) return record as KeyLabelStoreResult<KeyLabelMeta>
      const hubPostId = record.data.meta.hubPostId
      if (!hubPostId) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Entry has no hub post' }
      }
      try {
        const { body, uploaderName, hubUpdatedAt } = await fetchHubKeyLabelPayload(
          hubPostId,
          record.data.meta.uploaderName,
          record.data.meta.hubUpdatedAt,
        )
        const composite = body.composite_labels ?? undefined
        // Preserve the local id, name (drag/rename), and hubPostId; only
        // refresh the payload (map / compositeLabels), uploaderName,
        // and hubUpdatedAt.
        return await saveRecord({
          id: localId,
          name: record.data.meta.name,
          ...(uploaderName ? { uploaderName } : {}),
          map: body.map,
          ...(composite ? { compositeLabels: composite } : {}),
          hubPostId,
          ...(hubUpdatedAt ? { hubUpdatedAt } : {}),
        })
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub sync failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.KEY_LABEL_HUB_DELETE,
    async (_event, localId: unknown): Promise<KeyLabelStoreResult<void>> => {
      if (typeof localId !== 'string') {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Invalid id' }
      }
      const record = await getRecord(localId)
      if (!record.success || !record.data) return record as KeyLabelStoreResult<void>
      const hubPostId = record.data.meta.hubPostId
      if (!hubPostId) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Entry has no hub post' }
      }
      try {
        await withTokenRetry((jwt) => deleteKeyLabel(jwt, hubPostId))
        const cleared = await setHubPostId(localId, null)
        if (!cleared.success) return cleared as KeyLabelStoreResult<void>
        return { success: true }
      } catch (err) {
        return { success: false, errorCode: 'IO_ERROR', error: extractError(err, 'Hub delete failed') }
      }
    },
  )
}
