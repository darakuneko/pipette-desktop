// SPDX-License-Identifier: GPL-2.0-or-later
// What this process remembers about the signed-in Google account, forgotten
// whenever the stored sign-in changes (a sign-in, a sign-out, or a reset
// that signs out; sync-pending-account.ts), so nothing learned under one
// account is used for another.

import { clearHubTokenCache } from '../hub/hub-ipc-token'
import { resetPasswordCheckCache } from './sync-password'
import { clearSyncFormatStatus } from './sync-format-status'

/** Forgets the Hub JWT, the validated / created password-check and the
 *  sync-format status with the marker this process created
 *  (`clearSyncFormatStatus` forgets both). */
export function forgetAccountCaches(): void {
  clearHubTokenCache()
  resetPasswordCheckCache()
  clearSyncFormatStatus()
}
