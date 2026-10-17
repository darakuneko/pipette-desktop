// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the Analyze posts on the Hub and their preview, each the backend command
// of src-tauri/src/hub_commands/analytics.rs with its arguments by name.
// `hubAnalyticsReal` holds the members the backend implements; the others stay
// fakes (fakes.ts) or stubs. coverage.test.ts checks them.

import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import type { Answer } from './hub-answer'

export const hubAnalyticsApi = {
  hubUploadAnalyticsPost: (params) => call<Answer<'hubUploadAnalyticsPost'>>('hub_upload_analytics_post', { params }),
  hubUpdateAnalyticsPost: (params) => call<Answer<'hubUpdateAnalyticsPost'>>('hub_update_analytics_post', { params }),
  hubPreviewAnalyticsPost: (params) => call<Answer<'hubPreviewAnalyticsPost'>>('hub_preview_analytics_post', { params }),
  hubUploadPrivateAnalyticsPost: (params) => call<Answer<'hubUploadPrivateAnalyticsPost'>>('hub_upload_private_analytics_post', { params }),
} satisfies Partial<VialAPI>

export const hubAnalyticsReal = {} satisfies Partial<VialAPI>
