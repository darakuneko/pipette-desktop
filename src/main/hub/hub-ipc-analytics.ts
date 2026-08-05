// SPDX-License-Identifier: GPL-2.0-or-later
// Hub IPC: analytics post upload/update/preview handlers. Split out of
// hub-ipc.ts to keep it under the project's 800-line Service/Util size
// ceiling.
//
// Pattern mirrors the favorite-post upload: validate inputs → assemble
// payload → withTokenRetry → save the postId on success. Distinct
// because the analytics build step is heavier (fetches across the
// typing-analytics DB) and ships a thumbnail alongside the JSON.

import { secureHandle } from '../ipc-guard'
import { IpcChannels } from '../../shared/ipc/channels'
import type {
  HubUploadAnalyticsPostParams, HubUpdateAnalyticsPostParams, HubPreviewAnalyticsPostParams,
  HubAnalyticsPreview, HubUploadResult,
} from '../../shared/types/hub'
import { uploadAnalyticsPostToHub, updateAnalyticsPostOnHub } from './hub-client'
import { validateAnalyticsExport, estimateAnalyticsExportSizeBytes } from './hub-analytics'
import { setAnalyzeFilterHubPostId } from '../analyze-filter-store'
import { validatePostId, validateTitle, sanitizeFilenameBase, extractError } from './hub-ipc-shared'
import { withTokenRetry } from './hub-ipc-token'
import { prepareAnalyticsExport } from './hub-ipc-analytics-prepare'

export function registerHubAnalyticsHandlers(): void {
  secureHandle(
    IpcChannels.HUB_UPLOAD_ANALYTICS_POST,
    async (_event, params: HubUploadAnalyticsPostParams): Promise<HubUploadResult> => {
      try {
        const built = await prepareAnalyticsExport(params)
        if (!built.ok) return { success: false, error: built.error }
        const title = validateTitle(params.title)
        const baseName = sanitizeFilenameBase(params.keyboard.productName, params.uid)
        const jsonBuffer = Buffer.from(JSON.stringify(built.exportData), 'utf-8')
        const thumbnailBuffer = Buffer.from(params.thumbnailBase64, 'base64')
        const result = await withTokenRetry((jwt) =>
          uploadAnalyticsPostToHub(
            jwt,
            title,
            { name: `${baseName}.json`, data: jsonBuffer },
            { name: `${baseName}.jpg`, data: thumbnailBuffer },
          ),
        )
        // Save the postId synchronously after upload so the panel can
        // immediately show the "↻ Hub" / 🔗 affordances without a
        // round-trip; failures here don't undo the upload (the entry
        // would just appear unsynced and the next click would attempt
        // a fresh upload).
        await setAnalyzeFilterHubPostId(params.uid, params.entryId, result.id)
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Analytics upload failed') }
      }
    },
  )

  secureHandle(
    IpcChannels.HUB_UPDATE_ANALYTICS_POST,
    async (_event, params: HubUpdateAnalyticsPostParams): Promise<HubUploadResult> => {
      try {
        validatePostId(params.postId)
        const built = await prepareAnalyticsExport(params)
        if (!built.ok) return { success: false, error: built.error }
        const title = validateTitle(params.title)
        const baseName = sanitizeFilenameBase(params.keyboard.productName, params.uid)
        const jsonBuffer = Buffer.from(JSON.stringify(built.exportData), 'utf-8')
        const thumbnailBuffer = Buffer.from(params.thumbnailBase64, 'base64')
        const result = await withTokenRetry((jwt) =>
          updateAnalyticsPostOnHub(
            jwt,
            params.postId,
            title,
            { name: `${baseName}.json`, data: jsonBuffer },
            { name: `${baseName}.jpg`, data: thumbnailBuffer },
          ),
        )
        // Re-stamp the postId in case the user manipulated the saved
        // entry's metadata in another window between preview and
        // upload — keeps the local index in sync with the Hub canon.
        await setAnalyzeFilterHubPostId(params.uid, params.entryId, result.id)
        return { success: true, postId: result.id }
      } catch (err) {
        return { success: false, error: extractError(err, 'Analytics update failed') }
      }
    },
  )

  // Preview path used by the upload dialog. Builds the payload with
  // the same builder the upload uses but reports size + validation
  // without crossing the network. The thumbnail is captured later
  // (only when the user confirms), so it's intentionally absent from
  // the preview params.
  secureHandle(
    IpcChannels.HUB_PREVIEW_ANALYTICS_POST,
    async (_event, params: HubPreviewAnalyticsPostParams): Promise<{ success: boolean; preview?: HubAnalyticsPreview; error?: string }> => {
      try {
        const built = await prepareAnalyticsExport({
          ...params,
          // The preview path doesn't ship a thumbnail — pass empty
          // strings to satisfy the shared param shape without
          // triggering the buffer encode for nothing.
          title: 'preview',
          thumbnailBase64: '',
        })
        if (!built.ok) {
          return {
            success: true,
            preview: {
              totalKeystrokes: built.totalKeystrokes,
              rangeMs: built.rangeMs,
              estimatedBytes: 0,
              validation: { ok: false, reason: built.error },
            },
          }
        }
        const validation = validateAnalyticsExport(built.exportData)
        const estimatedBytes = estimateAnalyticsExportSizeBytes(built.exportData)
        return {
          success: true,
          preview: {
            totalKeystrokes: built.exportData.snapshot.totalKeystrokes,
            rangeMs: built.exportData.snapshot.range.toMs - built.exportData.snapshot.range.fromMs,
            estimatedBytes,
            validation,
          },
        }
      } catch (err) {
        return { success: false, error: extractError(err, 'Analytics preview failed') }
      }
    },
  )
}
