// SPDX-License-Identifier: GPL-2.0-or-later
// Hub IPC: i18n language pack + theme pack handlers. Split out of
// hub-ipc.ts to keep it under the project's 800-line Service/Util size
// ceiling.
//
// Targets the standalone /api/i18n-packs and /api/theme-packs
// endpoints. The pack body (HubI18nPackBody / HubThemePackBody) carries
// name + version, so the multipart upload does not need a separate
// title field — the Hub derives identity from `pack.name` + `pack.version`.
// Listing / download stays anonymous; CRUD requires the JWT.

import { secureHandle } from '../ipc-guard'
import { IpcChannels } from '../../shared/ipc/channels'
import {
  uploadI18nPostToHub,
  updateI18nPostOnHub,
  deleteI18nPostFromHub,
  fetchI18nPostList,
  downloadI18nPostBody,
  validateI18nExport,
  fetchI18nPackTimestamps,
  type HubI18nListParams,
  type HubI18nListResponse,
} from './hub-i18n'
import { setHubPostId as setI18nPackHubPostId } from '../i18n-pack-store'
import {
  uploadThemePostToHub,
  updateThemePostOnHub,
  deleteThemePostFromHub,
  fetchThemePostList,
  downloadThemePostBody,
  fetchThemePackTimestamps,
} from './hub-theme'
import { setHubPostId as setThemePackHubPostId } from '../theme-pack-store'
import { validateThemePack } from '../../shared/theme/validate'
import type {
  HubUploadResult, HubDeleteResult,
  HubUploadI18nPostParams,
  HubUpdateI18nPostParams,
  HubI18nExportV1,
  HubI18nPackTimestamp,
  HubI18nPackTimestampsResponse,
  HubUploadThemePostParams,
  HubUpdateThemePostParams,
  HubThemePackBody,
  HubThemePackTimestamp,
  HubThemePackTimestampsResponse,
  HubThemeListParams,
  HubThemeListResponse,
} from '../../shared/types/hub'
import { HUB_I18N_PACK_TIMESTAMPS_BATCH_LIMIT, HUB_THEME_PACK_TIMESTAMPS_BATCH_LIMIT } from '../../shared/types/hub'
import { validatePostId, extractError } from './hub-ipc-shared'
import { withTokenRetry } from './hub-ipc-token'

/**
 * i18n/theme upload responses only carry `{ id, title }` (`HubPostResponse`)
 * — unlike Key Labels' upload/update responses, which return the full
 * `HubKeyLabelItem` including `uploader_name`/`updated_at` directly.
 * Neither `/api/i18n-packs` nor `/api/theme-packs` expose a single-item
 * detail GET to fill that gap, so this re-uses the existing exact-name
 * list filter (`?name=`) to find the just-created/updated item and read
 * its `uploaderName`/`updatedAt` off the list response instead. Matches
 * `fetchHubKeyLabelPayload`'s best-effort contract: on any failure (or if
 * the id is not found in that name's results) both fields come back
 * `undefined` and the caller's `setHubPostId` call simply leaves the
 * previously-cached values alone.
 *
 * Upload is the only caller: a freshly created post needs `uploaderName`
 * (the Author column has nothing else to key off yet). Update deliberately
 * uses the narrower `enrichHubUpdatedAt` below instead of this — Update
 * never changes `uploaderName`, so paying for the name-filtered list
 * lookup (paginated, larger body, and — in the pathological case of two
 * packs sharing a name — order-dependent) would buy nothing over the
 * id-keyed timestamps endpoint. Both helpers cost the same +1 Hub
 * request per action either way; the split is about which endpoint
 * shape fits what the caller actually needs, not request count.
 */
async function enrichHubPackMeta(
  listByName: (params: { name: string }) => Promise<{ items: { id: string; uploaderName?: string | null; updatedAt?: string }[] }>,
  name: string,
  postId: string,
): Promise<{ uploaderName?: string; hubUpdatedAt?: string }> {
  try {
    const list = await listByName({ name })
    const item = list.items.find((i) => i.id === postId)
    return {
      uploaderName: item?.uploaderName ?? undefined,
      hubUpdatedAt: item?.updatedAt ?? undefined,
    }
  } catch {
    return {}
  }
}

/**
 * Update-only counterpart to `enrichHubPackMeta`: since Update never
 * touches `uploaderName` (see the i18n/theme Update handlers below), it
 * only ever needs `hubUpdatedAt`. The id-keyed `/timestamps` endpoint is
 * the better fit for that — no pagination, no name-collision ambiguity,
 * and a much smaller response body than the full list lookup. Same
 * best-effort contract as `enrichHubPackMeta`: any failure returns `{}`
 * and the caller's `setHubPostId` leaves the cached `hubUpdatedAt` alone.
 */
async function enrichHubUpdatedAt(
  fetchTimestamps: (ids: string[]) => Promise<{ items: { id: string; updated_at: string }[] }>,
  postId: string,
): Promise<{ hubUpdatedAt?: string }> {
  try {
    const res = await fetchTimestamps([postId])
    return { hubUpdatedAt: res.items.find((i) => i.id === postId)?.updated_at }
  } catch {
    return {}
  }
}

export function registerHubPackHandlers(): void {
  secureHandle(
    IpcChannels.HUB_UPLOAD_I18N_POST,
    async (_event, params: HubUploadI18nPostParams): Promise<HubUploadResult> => {
      try {
        if (!params || typeof params !== 'object') return { success: false, error: 'Invalid params' }
        const result = await withTokenRetry((jwt) => uploadI18nPostToHub(jwt, params.pack))
        // Carry the response's uploader/updated_at into the local meta
        // (via a name-matched list lookup — see enrichHubPackMeta) so
        // the Author/Updated columns and the isMine gate populate
        // immediately without waiting for a sync.
        const enriched = await enrichHubPackMeta(fetchI18nPostList, params.pack.name, result.id)
        await setI18nPackHubPostId(params.entryId, result.id, enriched.uploaderName, enriched.hubUpdatedAt)
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'i18n upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_UPDATE_I18N_POST,
    async (_event, params: HubUpdateI18nPostParams): Promise<HubUploadResult> => {
      try {
        if (!params || typeof params !== 'object') return { success: false, error: 'Invalid params' }
        validatePostId(params.postId)
        const result = await withTokenRetry((jwt) => updateI18nPostOnHub(jwt, params.postId, params.pack))
        // Refresh hubUpdatedAt only — mirrors Key Labels' Update, which
        // deliberately leaves uploaderName alone (the owner performing
        // an update is assumed unchanged). Uses the id-keyed timestamps
        // endpoint rather than enrichHubPackMeta's name-filtered list
        // lookup, since uploaderName isn't needed here.
        const enriched = await enrichHubUpdatedAt(fetchI18nPackTimestamps, result.id)
        await setI18nPackHubPostId(params.entryId, result.id, undefined, enriched.hubUpdatedAt)
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'i18n update failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_DELETE_I18N_POST,
    async (_event, postId: unknown, localPackId: unknown): Promise<HubDeleteResult> => {
      try {
        if (typeof postId !== 'string') return { success: false, error: 'Invalid post ID' }
        validatePostId(postId)
        await withTokenRetry((jwt) => deleteI18nPostFromHub(jwt, postId))
        if (typeof localPackId === 'string' && localPackId) {
          await setI18nPackHubPostId(localPackId, null)
        }
        return { success: true }
      } catch (err) {
        return { success: false, error: extractError(err, 'i18n delete failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_LIST_I18N_POSTS,
    async (_event, params: unknown): Promise<{ success: boolean; data?: HubI18nListResponse; error?: string }> => {
      try {
        const query: HubI18nListParams = {}
        if (params && typeof params === 'object') {
          const obj = params as Record<string, unknown>
          if (typeof obj.q === 'string') query.q = obj.q
          if (typeof obj.name === 'string') query.name = obj.name
          if (typeof obj.page === 'number') query.page = obj.page
          if (typeof obj.perPage === 'number') query.perPage = obj.perPage
        }
        const data = await fetchI18nPostList(query)
        return { success: true, data }
      } catch (err) {
        return { success: false, error: extractError(err, 'i18n list failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_DOWNLOAD_I18N_POST,
    async (_event, postId: unknown): Promise<{ success: boolean; data?: HubI18nExportV1; error?: string }> => {
      try {
        if (typeof postId !== 'string') return { success: false, error: 'Invalid post ID' }
        validatePostId(postId)
        const exportData = await downloadI18nPostBody(postId)
        const validation = validateI18nExport(exportData)
        if (!validation.ok) {
          return { success: false, error: `Hub returned an invalid pack: ${validation.reason ?? 'unknown reason'}` }
        }
        return { success: true, data: exportData }
      } catch (err) {
        return { success: false, error: extractError(err, 'i18n download failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_I18N_PACK_TIMESTAMPS,
    async (_event, ids: unknown): Promise<{ success: boolean; data?: HubI18nPackTimestampsResponse; error?: string }> => {
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
        return { success: false, error: 'ids must be an array of strings' }
      }
      const unique = Array.from(new Set(ids as string[]))
      if (unique.length === 0) return { success: true, data: { items: [] } }
      try {
        const chunks: string[][] = []
        for (let i = 0; i < unique.length; i += HUB_I18N_PACK_TIMESTAMPS_BATCH_LIMIT) {
          chunks.push(unique.slice(i, i + HUB_I18N_PACK_TIMESTAMPS_BATCH_LIMIT))
        }
        const responses = await Promise.all(chunks.map((chunk) => fetchI18nPackTimestamps(chunk)))
        const byId = new Map<string, HubI18nPackTimestamp>()
        for (const r of responses) {
          for (const item of r.items) byId.set(item.id, item)
        }
        const items: HubI18nPackTimestamp[] = []
        for (const id of unique) {
          const found = byId.get(id)
          if (found) items.push(found)
        }
        return { success: true, data: { items } }
      } catch (err) {
        return { success: false, error: extractError(err, 'Hub i18n timestamps failed') }
      }
    },
  )

  // --- Hub theme pack handlers ---

  secureHandle(
    IpcChannels.HUB_UPLOAD_THEME_POST,
    async (_event, params: HubUploadThemePostParams): Promise<HubUploadResult> => {
      try {
        if (!params || typeof params !== 'object') return { success: false, error: 'Invalid params' }
        const result = await withTokenRetry((jwt) => uploadThemePostToHub(jwt, params.pack))
        const enriched = await enrichHubPackMeta(fetchThemePostList, params.pack.name, result.id)
        await setThemePackHubPostId(params.entryId, result.id, enriched.uploaderName, enriched.hubUpdatedAt)
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'theme upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_UPDATE_THEME_POST,
    async (_event, params: HubUpdateThemePostParams): Promise<HubUploadResult> => {
      try {
        if (!params || typeof params !== 'object') return { success: false, error: 'Invalid params' }
        validatePostId(params.postId)
        const result = await withTokenRetry((jwt) => updateThemePostOnHub(jwt, params.postId, params.pack))
        // hubUpdatedAt only, via the id-keyed timestamps endpoint —
        // see the i18n Update handler's comment.
        const enriched = await enrichHubUpdatedAt(fetchThemePackTimestamps, result.id)
        await setThemePackHubPostId(params.entryId, result.id, undefined, enriched.hubUpdatedAt)
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'theme update failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_DELETE_THEME_POST,
    async (_event, postId: unknown, localPackId: unknown): Promise<HubDeleteResult> => {
      try {
        if (typeof postId !== 'string') return { success: false, error: 'Invalid post ID' }
        validatePostId(postId)
        await withTokenRetry((jwt) => deleteThemePostFromHub(jwt, postId))
        if (typeof localPackId === 'string' && localPackId) {
          await setThemePackHubPostId(localPackId, null)
        }
        return { success: true }
      } catch (err) {
        return { success: false, error: extractError(err, 'theme delete failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_LIST_THEME_POSTS,
    async (_event, params: unknown): Promise<{ success: boolean; data?: HubThemeListResponse; error?: string }> => {
      try {
        const query: HubThemeListParams = {}
        if (params && typeof params === 'object') {
          const obj = params as Record<string, unknown>
          if (typeof obj.q === 'string') query.q = obj.q
          if (typeof obj.name === 'string') query.name = obj.name
          if (typeof obj.page === 'number') query.page = obj.page
          if (typeof obj.perPage === 'number') query.perPage = obj.perPage
        }
        const data = await fetchThemePostList(query)
        return { success: true, data }
      } catch (err) {
        return { success: false, error: extractError(err, 'theme list failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_DOWNLOAD_THEME_POST,
    async (_event, postId: unknown): Promise<{ success: boolean; data?: HubThemePackBody; error?: string }> => {
      try {
        if (typeof postId !== 'string') return { success: false, error: 'Invalid post ID' }
        validatePostId(postId)
        const packBody = await downloadThemePostBody(postId)
        const validation = validateThemePack(packBody)
        if (!validation.ok) {
          return { success: false, error: `Hub returned an invalid theme pack: ${validation.errors[0] ?? 'unknown reason'}` }
        }
        return { success: true, data: packBody }
      } catch (err) {
        return { success: false, error: extractError(err, 'theme download failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_THEME_PACK_TIMESTAMPS,
    async (_event, ids: unknown): Promise<{ success: boolean; data?: HubThemePackTimestampsResponse; error?: string }> => {
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) {
        return { success: false, error: 'ids must be an array of strings' }
      }
      const unique = Array.from(new Set(ids as string[]))
      if (unique.length === 0) return { success: true, data: { items: [] } }
      try {
        const chunks: string[][] = []
        for (let i = 0; i < unique.length; i += HUB_THEME_PACK_TIMESTAMPS_BATCH_LIMIT) {
          chunks.push(unique.slice(i, i + HUB_THEME_PACK_TIMESTAMPS_BATCH_LIMIT))
        }
        const responses = await Promise.all(chunks.map((chunk) => fetchThemePackTimestamps(chunk)))
        const byId = new Map<string, HubThemePackTimestamp>()
        for (const r of responses) {
          for (const item of r.items) byId.set(item.id, item)
        }
        const items: HubThemePackTimestamp[] = []
        for (const id of unique) {
          const found = byId.get(id)
          if (found) items.push(found)
        }
        return { success: true, data: { items } }
      } catch (err) {
        return { success: false, error: extractError(err, 'Hub theme timestamps failed') }
      }
    },
  )
}
