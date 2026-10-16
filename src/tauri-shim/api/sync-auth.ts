// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the Google sign-in of the Tauri build: start, status
// and sign-out, all the backend's (src-tauri/src/sync_commands/auth.rs). The
// start and the sign-out answer a SyncOperationResult, as the Electron
// main process's handlers do.
// coverage.test.ts lists the members each of these modules holds.

import type { SyncOperationResult } from '../../shared/types/sync'
import type { VialAPI } from '../../shared/types/vial-api'
import type { SyncAuthStatus } from '../generated/SyncAuthStatus'
import { call } from '../ipc'

export const syncAuthApi = {
  syncAuthStart: () => call<SyncOperationResult>('sync_auth_start'),
  syncAuthStatus: () => call<SyncAuthStatus>('sync_auth_status'),
  syncAuthSignOut: () => call<SyncOperationResult>('sync_auth_sign_out'),
} satisfies Partial<VialAPI>
