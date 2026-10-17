// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the Analyze posts on the Hub and their preview, each the backend command
// of src-tauri/src/hub_commands/analytics.rs. The parameters go as the text of
// `JSON.stringify(params)`, which the backend reads as `JSON.parse` would, so it
// answers a field of an unexpected type as the Electron handler does. The export
// is built and sent in the backend; the Hub token stays there.

import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import type { Answer } from './hub-answer'

export const hubAnalyticsApi = {
  hubUploadAnalyticsPost: (params) =>
    call<Answer<'hubUploadAnalyticsPost'>>('hub_upload_analytics_post', { params: JSON.stringify(params) }),
  hubUpdateAnalyticsPost: (params) =>
    call<Answer<'hubUpdateAnalyticsPost'>>('hub_update_analytics_post', { params: JSON.stringify(params) }),
  hubPreviewAnalyticsPost: (params) =>
    call<Answer<'hubPreviewAnalyticsPost'>>('hub_preview_analytics_post', { params: JSON.stringify(params) }),
  hubUploadPrivateAnalyticsPost: (params) =>
    call<Answer<'hubUploadPrivateAnalyticsPost'>>('hub_upload_private_analytics_post', { params: JSON.stringify(params) }),
} satisfies Partial<VialAPI>
