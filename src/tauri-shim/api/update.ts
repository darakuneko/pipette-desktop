// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI update members for the Tauri build: the in-app update
// (src-tauri/src/updater.rs), with the download's progress as the
// update:progress event.

import { IpcChannels } from '../../shared/ipc/channels'
import type { UpdateCheckResult, UpdateFailure, UpdateInstallResult, UpdateProgress } from '../../shared/types/update'
import type { VialAPI } from '../../shared/types/vial-api'
import { call, subscribe } from '../ipc'

export const updateApi = {
  updateCheck: () => call<UpdateCheckResult>('update_check'),
  updateInstall: (version) => call<UpdateInstallResult>('update_install', { version }),
  updateTakeFailure: () => call<UpdateFailure | null>('update_take_failure'),
  updateOnProgress: (callback) => subscribe<UpdateProgress>(IpcChannels.UPDATE_PROGRESS, callback),
} satisfies Partial<VialAPI>
