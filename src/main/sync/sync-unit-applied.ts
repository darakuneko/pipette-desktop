// SPDX-License-Identifier: GPL-2.0-or-later
// Tells open windows that a sync merge rewrote a unit's local files, so lists
// showing that unit can re-read it.

import { IpcChannels } from '../../shared/ipc/channels'
import { broadcastToAllWindows } from '../utils/broadcast'

/** Sent only from the merge layer (`mergeSyncUnit` in sync-merge-dispatch.ts
 *  and the keyboard-meta merge/backfill), so a store write that does not go
 *  through it does not notify. */
export function notifySyncUnitApplied(syncUnit: string): void {
  broadcastToAllWindows(IpcChannels.SYNC_UNIT_APPLIED, { syncUnit })
}
