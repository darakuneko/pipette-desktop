// SPDX-License-Identifier: GPL-2.0-or-later
// The VialAPI members of the Google sign-in of the Tauri build: start, status
// and sign-out. The status is the backend's (src-tauri/src/sync_commands/auth.rs);
// the start and the sign-out are not backed by a backend command yet and
// fall back to the stubs of create-vial-api.ts.
// coverage.test.ts lists the members each of these modules holds.

import type { VialAPI } from '../../shared/types/vial-api'
import type { SyncAuthStatus } from '../generated/SyncAuthStatus'
import { call } from '../ipc'

export const syncAuthApi = {
  syncAuthStatus: () => call<SyncAuthStatus>('sync_auth_status'),
} satisfies Partial<VialAPI>
