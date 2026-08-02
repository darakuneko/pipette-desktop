// SPDX-License-Identifier: GPL-2.0-or-later
// Hub IPC: favorite (feature) post upload/update, plus the shared
// `prepareFavoritePost` assembly step reused by the private-upload
// handler. Split out of hub-ipc.ts (Task-split-hub-ipc) — see
// .claude/rules/file-splitting.md.

import { secureHandle } from '../ipc-guard'
import { IpcChannels } from '../../shared/ipc/channels'
import type { HubUploadFavoritePostParams, HubUpdateFavoritePostParams, HubUploadResult } from '../../shared/types/hub'
import { uploadFeaturePostToHub, updateFeaturePostOnHub } from './hub-client'
import { isValidFavoriteType, isValidHubVialProtocol, FAV_TYPE_TO_EXPORT_KEY, serializeFavData, buildFavExportFile } from '../../shared/favorite-data'
import { serialize as serializeKeycode } from '../../shared/keycodes/keycodes'
import { withSerializeProtocol } from '../../shared/keycodes/with-protocol'
import type { FavoriteType, FavoriteIndex } from '../../shared/types/favorite-store'
import { validatePostId, validateTitle, extractError } from './hub-ipc-shared'
import { withTokenRetry } from './hub-ipc-token'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

// Deliberately stricter than the shared `isSafePathSegment` (ASCII
// allowlist vs separator denylist) because these filenames cross the
// Hub upload boundary; not consolidated by design.
function isSafeExportFilename(segment: string): boolean {
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

  if (!isSafeExportFilename(entry.filename)) throw new Error('Invalid filename')
  const filePath = join(favDir, entry.filename)
  const fileRaw = await readFile(filePath, 'utf-8')
  const parsed = JSON.parse(fileRaw) as { type: string; data: unknown }
  if (parsed.data == null) throw new Error('Entry data is empty')
  if (parsed.type !== type) throw new Error('Entry type mismatch')

  const exportKey = FAV_TYPE_TO_EXPORT_KEY[type]
  const serializedData = withSerializeProtocol(vialProtocol, () => serializeFavData(type, parsed.data, serializeKeycode))

  const exportFile = buildFavExportFile(vialProtocol, {
    [exportKey]: [{
      label: entry.label,
      savedAt: entry.savedAt,
      data: serializedData,
    }],
  })

  return JSON.stringify(exportFile)
}

export async function prepareFavoritePost(
  params: HubUploadFavoritePostParams,
): Promise<{ title: string; postType: string; jsonFile: { name: string; data: Buffer } }> {
  if (!isValidFavoriteType(params.type)) throw new Error('Invalid favorite type')
  // Hub-specific: stricter than the general `isValidVialProtocol` (see
  // favorite-data.ts) because a raw negative sentinel (e.g. -1, the
  // disconnected-state placeholder) must fail fast locally with a clear
  // error instead of reaching the Hub server as a confusing 400.
  if (!isValidHubVialProtocol(params.vialProtocol)) throw new Error('Invalid vialProtocol')
  const title = validateTitle(params.title)
  const postType = FAV_TYPE_TO_EXPORT_KEY[params.type]
  const jsonStr = await buildFavoriteExportJson(params.type, params.entryId, params.vialProtocol)
  return { title, postType, jsonFile: { name: `${postType}.json`, data: Buffer.from(jsonStr, 'utf-8') } }
}

export function registerHubFavoriteHandlers(): void {
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
}
