// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the key labels on the Hub, each the backend command
// of src-tauri/src/hub_commands/key_labels.rs with its arguments by name.
// `keyLabelHubReal` holds the members the backend implements; the others stay
// fakes (fakes.ts) or stubs. coverage.test.ts checks them.

import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'
import type { Answer } from './hub-answer'

export const keyLabelHubApi = {
  keyLabelHubList: (params) => call<Answer<'keyLabelHubList'>>('key_label_hub_list', { params }),
  keyLabelHubDetail: (hubPostId) => call<Answer<'keyLabelHubDetail'>>('key_label_hub_detail', { hubPostId }),
  keyLabelHubDownload: (hubPostId) => call<Answer<'keyLabelHubDownload'>>('key_label_hub_download', { hubPostId }),
  keyLabelHubUpload: (localId) => call<Answer<'keyLabelHubUpload'>>('key_label_hub_upload', { localId }),
  keyLabelHubUpdate: (localId) => call<Answer<'keyLabelHubUpdate'>>('key_label_hub_update', { localId }),
  keyLabelHubSync: (localId) => call<Answer<'keyLabelHubSync'>>('key_label_hub_sync', { localId }),
  keyLabelHubTimestamps: (ids) => call<Answer<'keyLabelHubTimestamps'>>('key_label_hub_timestamps', { ids }),
  keyLabelHubDelete: (localId) => call<Answer<'keyLabelHubDelete'>>('key_label_hub_delete', { localId }),
} satisfies Partial<VialAPI>

export const keyLabelHubReal = {} satisfies Partial<VialAPI>
