// SPDX-License-Identifier: GPL-2.0-or-later
// Deletion / retention paths for the Data modal: per-date (delete marks
// appended to this device's JSONL master files) and delete-all-for-keyboard
// (this device's files unlinked), each also tombstoning the matching cache
// rows so the affected days disappear from Analyze immediately.

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { unlink } from 'node:fs/promises'
import { localDayRangeMs } from '../../shared/local-day-range'
import { emptyTombstoneResult } from '../../shared/types/typing-analytics'
import { log } from '../logger'
import {
  getTypingAnalyticsDB,
  type TypingTombstoneResult,
} from './db/typing-analytics-db'
import { getMachineHash } from './machine-hash'
import { deletedRangeForAll, unionDeletedRanges } from './deleted-ranges'
import { updateDeletedRanges } from './deleted-ranges-store'
import { recordOwnDeletedRangeApplied } from './deleted-ranges-apply'
import { deviceDayJsonlPath, listDeviceDays } from './jsonl/paths'
import type { UtcDay } from './jsonl/utc-day'
import {
  closeSessionsForUid,
  discardBufferedTyping,
  notifyDeletedRangesChanged,
  notifyOwnDaysChanged,
} from './typing-analytics-pipeline'
import { deleteOwnTypingInRanges, type TimeRange } from './typing-analytics-day-delete'

/** Delete this device's typing of the requested local calendar dates.
 * The rows inside each date are marked deleted in the UTC day files they
 * live in (see deleteOwnTypingInRanges, typing-analytics-day-delete.ts);
 * rows of other devices are left alone. `cutoffMs` is when the user asked
 * for the delete (see discardBufferedTyping, typing-analytics-pipeline.ts). */
export async function deleteTypingDailySummaries(
  uid: string,
  dates: string[],
  cutoffMs = Date.now(),
): Promise<TypingTombstoneResult> {
  const ranges: TimeRange[] = []
  for (const date of dates) {
    const range = localDayRangeMs(date)
    if (range) ranges.push(range)
  }
  if (ranges.length === 0) {
    return emptyTombstoneResult()
  }
  return deleteOwnTypingInRanges(uid, ranges, cutoffMs)
}

/** Delete every per-day JSONL file owned by this device for the given
 * keyboard uid and tombstone that uid's cache rows: only this device's
 * rows for `scope: 'own'` (the Local tab's Delete All), every device's for
 * `scope: 'all'` (Reset Keyboard Data, which also removes the other
 * devices' downloaded files). Other devices' files are untouched by this
 * function. For `'own'` the delete also reaches the devices that already
 * replayed this device's files: see addOwnDeleteAllRange.
 * `cutoffMs` is when the user asked for the delete;
 * what was typed in later minutes stays buffered and is written
 * afterwards (see discardBufferedTyping, typing-analytics-pipeline.ts).
 * Rows of those later minutes already on disk are still removed with the
 * day file: only a final flush (TYPING_ANALYTICS_FLUSH) while the caller
 * waited for the sync lock writes them, since a later minute cannot close
 * within that wait. */
export async function deleteAllTypingForKeyboard(
  uid: string,
  cutoffMs: number,
  scope: 'own' | 'all',
): Promise<TypingTombstoneResult> {
  // Finalize this keyboard's active session so the discard below drops it
  // (when it started by the cutoff); otherwise closeAll() on quit would
  // persist the open session and resurrect the deleted keyboard in Analyze.
  closeSessionsForUid(uid)
  // Buffered data is dropped instead of flushed: a kept entry of today would
  // be reopened by the next keystroke in its minute, and its next finalize
  // would write the pre-delete counts back.
  await discardBufferedTyping(uid, cutoffMs)
  const machineHash = await getMachineHash()
  const userDataDir = app.getPath('userData')
  // A ranges file that cannot be updated fails the delete here, before any
  // day file is removed.
  const rangeId = scope === 'own' ? await addOwnDeleteAllRange(uid, machineHash, userDataDir, cutoffMs) : null
  // Snapshot the days *before* unlinking so the post-tombstone notify
  // can still iterate over them — once the unlink loop has removed every
  // per-day file, a fresh listDeviceDays would only see the now-empty
  // directory and return [].
  const days = await listDeviceDays(userDataDir, uid, machineHash)
  let everyFileRemoved = true
  for (const day of days) {
    try {
      await unlinkOwnDayFile(userDataDir, uid, machineHash, day)
    } catch (err) {
      everyFileRemoved = false
      log('warn', `typing-analytics per-day unlink failed for ${uid}/${machineHash}/${day}: ${String(err)}`)
    }
  }
  const db = getTypingAnalyticsDB()
  const updatedAt = Date.now()
  const result = scope === 'own'
    ? db.tombstoneAllRowsForUidHash(uid, machineHash, updatedAt)
    : db.tombstoneAllRowsForUid(uid, updatedAt)
  const touched =
    result.charMinutes + result.matrixMinutes + result.minuteStats +
    result.bigramMinutes + result.trigramMinutes + result.sessions
  // `days` was listed before the unlink, so the removed days are announced.
  if (touched > 0) notifyOwnDaysChanged(uid, machineHash, days)
  if (rangeId !== null) {
    notifyDeletedRangesChanged(uid, machineHash)
    if (everyFileRemoved) await recordOwnDeleteAllApplied(uid, rangeId)
  }
  return result
}

/** Adds "everything up to `cutoffMs`" to this device's own-hash
 * deleted-ranges file and returns the entry's id. Other devices merge the
 * file to hide the rows they hold from this device's files, in the cache
 * and in every rebuild. Done even when nothing is left here: the other
 * devices still hold the rows. Takes the ranges file's lock; called
 * outside the flush chain and holding nothing a lock holder waits for. */
async function addOwnDeleteAllRange(
  uid: string,
  machineHash: string,
  userDataDir: string,
  cutoffMs: number,
): Promise<string> {
  const entry = deletedRangeForAll(cutoffMs, randomUUID())
  await updateDeletedRanges(userDataDir, uid, machineHash, (local) => unionDeletedRanges(local, [entry]))
  return entry.id
}

/** Records the Delete All range as applied once every day file is gone, so
 * this device never applies it to itself: applying it would also remove
 * what was typed after the click in the same minute. When a file could not
 * be removed (or this is never reached), the id stays unrecorded and the
 * next apply pass marks the rows of the files left, the same-minute typing
 * included. A failed record is logged and leaves the same state. */
async function recordOwnDeleteAllApplied(uid: string, rangeId: string): Promise<void> {
  try {
    await recordOwnDeletedRangeApplied(uid, rangeId)
  } catch (err) {
    log('warn', `typing-analytics: Delete All range of ${uid} not recorded as applied: ${String(err)}`)
  }
}

async function unlinkOwnDayFile(
  userDataDir: string,
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): Promise<void> {
  try {
    await unlink(deviceDayJsonlPath(userDataDir, uid, machineHash, utcDay))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
