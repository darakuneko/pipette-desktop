// SPDX-License-Identifier: GPL-2.0-or-later
// Hub IPC: private (unlisted) upload handlers. Split out of hub-ipc.ts
// to keep it under the project's 800-line Service/Util size ceiling.
//
// Each uploads to `/api/private/*` and returns the relative share URL
// + expiry. Persisting the link onto the local entry is the renderer's
// job (via the per-store `set-hub-private` IPC), mirroring how the
// public keymap/favorite uploads return a postId for the renderer to
// persist. The single delete handler is shared by Remove and the
// visibility-switch path; a 404 (already expired) counts as success.

import { secureHandle } from '../ipc-guard'
import { IpcChannels } from '../../shared/ipc/channels'
import type {
  HubPrivateUploadResult, HubPrivateKind, HubDeleteResult,
  HubPrivateUploadPostParams, HubPrivateUploadFavoritePostParams, HubPrivateUploadAnalyticsPostParams,
} from '../../shared/types/hub'
import {
  Hub404Error, uploadPrivatePostToHub, uploadPrivateFeaturePostToHub,
  uploadPrivateAnalyticsPostToHub, deletePrivatePostFromHub,
} from './hub-client'
import { validateTitle, sanitizeFilenameBase, extractError, buildFiles } from './hub-ipc-shared'
import { withTokenRetry } from './hub-ipc-token'
import { prepareFavoritePost } from './hub-ipc-favorite'
import { prepareAnalyticsExport } from './hub-ipc-analytics-prepare'

function toPrivateResult(res: { id: string; url: string; expires_at: string | null }): HubPrivateUploadResult {
  return { success: true, id: res.id, url: res.url, expiresAt: res.expires_at }
}

export function registerHubPrivateHandlers(): void {
  secureHandle(
    IpcChannels.HUB_UPLOAD_PRIVATE_POST,
    async (_event, params: HubPrivateUploadPostParams): Promise<HubPrivateUploadResult> => {
      try {
        const title = validateTitle(params.title)
        const files = buildFiles(params)
        const res = await withTokenRetry((jwt) =>
          uploadPrivatePostToHub(jwt, title, params.keyboardName, files, params.expiresInDays),
        )
        return toPrivateResult(res)
      } catch (err) {
        return { success: false, error: extractError(err, 'Upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_UPLOAD_PRIVATE_FAVORITE_POST,
    async (_event, params: HubPrivateUploadFavoritePostParams): Promise<HubPrivateUploadResult> => {
      try {
        const { title, postType, jsonFile } = await prepareFavoritePost(params)
        const res = await withTokenRetry((jwt) =>
          uploadPrivateFeaturePostToHub(jwt, title, postType, jsonFile, params.expiresInDays),
        )
        return toPrivateResult(res)
      } catch (err) {
        return { success: false, error: extractError(err, 'Upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_UPLOAD_PRIVATE_ANALYTICS_POST,
    async (_event, params: HubPrivateUploadAnalyticsPostParams): Promise<HubPrivateUploadResult> => {
      try {
        const built = await prepareAnalyticsExport(params)
        if (!built.ok) return { success: false, error: built.error }
        const title = validateTitle(params.title)
        const baseName = sanitizeFilenameBase(params.keyboard.productName, params.uid)
        const jsonBuffer = Buffer.from(JSON.stringify(built.exportData), 'utf-8')
        const thumbnailBuffer = Buffer.from(params.thumbnailBase64, 'base64')
        const res = await withTokenRetry((jwt) =>
          uploadPrivateAnalyticsPostToHub(
            jwt,
            title,
            { name: `${baseName}.json`, data: jsonBuffer },
            { name: `${baseName}.jpg`, data: thumbnailBuffer },
            params.expiresInDays,
          ),
        )
        return toPrivateResult(res)
      } catch (err) {
        return { success: false, error: extractError(err, 'Analytics upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_DELETE_PRIVATE_POST,
    async (_event, kind: HubPrivateKind, id: string): Promise<HubDeleteResult> => {
      try {
        if (typeof id !== 'string' || !id) return { success: false, error: 'Invalid id' }
        await withTokenRetry((jwt) => deletePrivatePostFromHub(jwt, kind, id))
        return { success: true }
      } catch (err) {
        // Already gone (expired / removed elsewhere) — treat as success so
        // the local link can be cleared / a visibility switch can proceed.
        if (err instanceof Hub404Error) return { success: true }
        return { success: false, error: extractError(err, 'Delete failed') }
      }
    },
  )
}
