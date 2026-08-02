// SPDX-License-Identifier: GPL-2.0-or-later
// Hub IPC: Key Label Hub handlers (list/detail/timestamps/download/
// upload/update/sync/delete). Split out of hub-ipc.ts
// (Task-split-hub-ipc) — see .claude/rules/file-splitting.md.

import { secureHandle } from '../ipc-guard'
import { IpcChannels } from '../../shared/ipc/channels'
import { Hub409Error } from './hub-client'
import { fetchKeyLabelList, fetchKeyLabelDetail, fetchKeyLabelTimestamps, downloadKeyLabel, uploadKeyLabel, updateKeyLabel, deleteKeyLabel } from './hub-key-labels'
import type { HubKeyLabelInput } from './hub-key-labels'
import type { HubKeyLabelItem, HubKeyLabelListResponse, HubKeyLabelListParams, HubKeyLabelTimestamp, HubKeyLabelTimestampsResponse } from '../../shared/types/hub-key-label'
import { HUB_ERROR_KEY_LABEL_DUPLICATE, HUB_KEY_LABEL_TIMESTAMPS_BATCH_LIMIT } from '../../shared/types/hub-key-label'
import { getRecord, saveRecord, setHubPostId } from '../key-label-store'
import type { SaveRecordInput } from '../key-label-store'
import type { KeyLabelMeta, KeyLabelRecord, KeyLabelStoreResult } from '../../shared/types/key-label-store'
import { POST_ID_RE, clampInt, extractError } from './hub-ipc-shared'
import { withTokenRetry } from './hub-ipc-token'

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
  body: {
    name: string
    map: Record<string, string>
    composite_labels: Record<string, string> | null
    keymap_applicable?: boolean
  }
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

/**
 * `HubKeyLabelInput` shared by upload/update — the local record's name,
 * map and compositeLabels, plus `keymapApplicable` (always sent, even
 * `false`, so a re-upload can clear a previously-true flag; see the
 * `buildBody` comment in hub-key-labels.ts).
 */
function buildHubKeyLabelInput(record: KeyLabelRecord): HubKeyLabelInput {
  return {
    name: record.meta.name,
    map: record.data.map,
    ...(record.data.compositeLabels ? { compositeLabels: record.data.compositeLabels } : {}),
    keymapApplicable: record.data.keymapApplicable ?? false,
  }
}

/**
 * `saveRecord()` fields shared by download/sync — the Hub body's map,
 * compositeLabels and keymapApplicable, plus the cached uploader /
 * hub-updated metadata. Callers still supply `id`/`name`/`hubPostId`
 * since those differ (download seeds from the Hub body, sync keeps the
 * local id/name and only refreshes the payload).
 */
function hubBodyToSaveRecordFields(
  body: { map: Record<string, string>; composite_labels: Record<string, string> | null; keymap_applicable?: boolean },
  uploaderName: string | undefined,
  hubUpdatedAt: string | undefined,
): Pick<SaveRecordInput, 'map' | 'uploaderName' | 'compositeLabels' | 'keymapApplicable' | 'hubUpdatedAt'> {
  const composite = body.composite_labels ?? undefined
  return {
    map: body.map,
    ...(uploaderName ? { uploaderName } : {}),
    ...(composite ? { compositeLabels: composite } : {}),
    ...(body.keymap_applicable ? { keymapApplicable: true } : {}),
    ...(hubUpdatedAt ? { hubUpdatedAt } : {}),
  }
}

/** Rebuilds a failed lookup result under a different `T` — `getRecord`
 * resolves `KeyLabelStoreResult<KeyLabelRecord>`, but the handler needs to
 * return `KeyLabelStoreResult<KeyLabelMeta>`, and the two `T`s don't share
 * a `data` shape, so `record as KeyLabelStoreResult<KeyLabelMeta>` would be
 * an unsound cast. Only the failure fields (`success`/`errorCode`/`error`)
 * carry over. */
function toKeyLabelLookupFailure(record: {
  success: boolean
  errorCode?: KeyLabelStoreResult<unknown>['errorCode']
  error?: string
}): KeyLabelStoreResult<KeyLabelMeta> {
  return { success: record.success, errorCode: record.errorCode, error: record.error }
}

export function registerHubKeyLabelHandlers(): void {
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
        // Use the Hub post id as the local id so the saved
        // `keyboardLayout` can be matched against Hub later (e.g. the
        // Missing Key Label dialog needs to look up the human name
        // after the entry has been removed locally).
        return await saveRecord({
          id: hubPostId,
          name: body.name,
          hubPostId,
          ...hubBodyToSaveRecordFields(body, uploaderName, hubUpdatedAt),
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
      if (!record.success || !record.data) {
        return toKeyLabelLookupFailure(record)
      }
      const input = buildHubKeyLabelInput(record.data)
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
      if (!record.success || !record.data) {
        return toKeyLabelLookupFailure(record)
      }
      const hubPostId = record.data.meta.hubPostId
      if (!hubPostId) {
        return { success: false, errorCode: 'NOT_FOUND', error: 'Entry has no hub post' }
      }
      const input = buildHubKeyLabelInput(record.data)
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
      if (!record.success || !record.data) {
        return toKeyLabelLookupFailure(record)
      }
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
        // Preserve the local id, name (drag/rename), and hubPostId; only
        // refresh the payload (map / compositeLabels / keymapApplicable),
        // uploaderName, and hubUpdatedAt.
        return await saveRecord({
          id: localId,
          name: record.data.meta.name,
          hubPostId,
          ...hubBodyToSaveRecordFields(body, uploaderName, hubUpdatedAt),
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
