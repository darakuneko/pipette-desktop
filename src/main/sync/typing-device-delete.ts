// SPDX-License-Identifier: GPL-2.0-or-later
// Sync > Typing delete of another device's typing data. Nothing is removed
// from Drive or from that device's day files here: the deleted time ranges
// are added to that device's deleted-ranges file (deleted-ranges.ts), the
// rows in them are hidden in this cache at once, and the file syncs like
// any other unit. The owner removes the rows from its own files when it
// next merges the file (deleted-ranges-apply.ts), and every device keeps the
// rows hidden when it replays the day files.

import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { deletedRangeForAll, deletedRangesForLocalDays, unionDeletedRanges } from '../typing-analytics/deleted-ranges'
import { updateDeletedRanges } from '../typing-analytics/deleted-ranges-store'
import { getTypingAnalyticsDB } from '../typing-analytics/db/typing-analytics-db'
import { getMachineHash } from '../typing-analytics/machine-hash'
import { typingDeletedRangesSyncUnit } from '../typing-analytics/sync'
import { notifyChange } from './sync-flush'

/** Deletes `machineHash`'s typing of `uid` on the local calendar `dates`
 * (`YYYY-MM-DD`, in this process's time zone), or all of it for `'all'`,
 * limited to what was recorded at or before `cutoffMs`. Works offline.
 * Refuses this device's own hash (`sync.ownDeviceDeleteFromLocal`): its
 * days are deleted from the Local tab. Takes no sync lock itself: the IPC
 * handler holds it (sync-reset-ipc.ts). */
export async function deleteDeviceTypingData(
  uid: string,
  machineHash: string,
  dates: readonly string[] | 'all',
  cutoffMs: number,
): Promise<void> {
  if (machineHash === await getMachineHash()) throw new Error('sync.ownDeviceDeleteFromLocal')
  const entries = dates === 'all'
    ? [deletedRangeForAll(cutoffMs, randomUUID())]
    : deletedRangesForLocalDays(dates, cutoffMs, randomUUID)
  if (entries.length === 0) return
  await updateDeletedRanges(app.getPath('userData'), uid, machineHash, (local) => unionDeletedRanges(local, entries))
  // After the file's lock is released (`withWriteLock` is not reentrant).
  getTypingAnalyticsDB().tombstoneRowsForUidHashInRanges(uid, machineHash, entries, Date.now())
  notifyChange(typingDeletedRangesSyncUnit(uid, machineHash))
}
