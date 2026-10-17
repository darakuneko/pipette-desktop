// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the resets of the Tauri build: the reset targets on
// Drive, a keyboard's data and the local data. Each is a backend command
// (src-tauri/src/sync_commands/reset.rs).
// coverage.test.ts lists the members each of these modules holds.

import type { SyncOperationResult } from '../../shared/types/sync'
import type { VialAPI } from '../../shared/types/vial-api'
import { call } from '../ipc'

export const syncResetApi = {
  syncResetTargets: (targets) => call<SyncOperationResult>('sync_reset_targets', { targets }),
  resetKeyboardData: (uid) => call<SyncOperationResult>('reset_keyboard_data', { uid }),
  resetLocalTargets: (targets) => call<SyncOperationResult>('reset_local_targets', { targets }),
} satisfies Partial<VialAPI>
