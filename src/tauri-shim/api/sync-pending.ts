// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the pending sync units for the Tauri build
// (src-tauri/src/store_commands/sync_pending.rs). The backend sends whether
// anything is pending after each change as the sync:pending-status event,
// on the channel the Electron main process uses.

import { IpcChannels } from '../../shared/ipc/channels'
import type { VialAPI } from '../../shared/types/vial-api'
import { call, subscribe } from '../ipc'

export const syncPendingApi = {
  syncHasPendingChanges: () => call<boolean>('sync_has_pending_changes'),
  syncOnPendingChange: (callback) => subscribe<boolean>(IpcChannels.SYNC_PENDING_STATUS, callback),
} satisfies Partial<VialAPI>
