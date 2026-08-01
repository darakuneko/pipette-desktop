// SPDX-License-Identifier: GPL-2.0-or-later
// Deletion / retention paths for the Data modal: per-date and
// delete-all-for-keyboard, each unlinking the owning device's JSONL master
// files and tombstoning the matching cache rows so the affected days
// disappear from Analyze immediately.

import { app } from 'electron'
import { unlink } from 'node:fs/promises'
import { emptyTombstoneResult } from '../../shared/types/typing-analytics'
import { log } from '../logger'
import {
  getTypingAnalyticsDB,
  type TypingTombstoneResult,
} from './db/typing-analytics-db'
import { typingAnalyticsDeviceDaySyncUnit } from './sync'
import { getMachineHash } from './machine-hash'
import { deviceDayJsonlPath, listDeviceDays } from './jsonl/paths'
import { utcDayFromMs, type UtcDay } from './jsonl/utc-day'
import { taState } from './typing-analytics-state'
import { closeSessionsForUid, flushNow } from './typing-analytics-pipeline'

/** Convert a 'YYYY-MM-DD' local-calendar date into a [startMs, endMs)
 * window that matches the strftime('%Y-%m-%d', ..., 'localtime') buckets
 * used by listDailySummariesForUid. */
function localDayRangeMs(date: string): { startMs: number; endMs: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return null
  const startMs = new Date(y, mo - 1, d).getTime()
  const endMs = new Date(y, mo - 1, d + 1).getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  return { startMs, endMs }
}

/** Delete the local per-day JSONL files covering the requested
 * calendar dates and tombstone the matching cache rows for an
 * immediate list refresh. The owning device's `uploaded` bookkeeping
 * still holds the day, so the next sync pass drops the cloud copy via
 * reconcile rule 2. `is_deleted` on cache rows is retained so the
 * upcoming list query can hide the affected minutes before the next
 * rebuild runs. */
export async function deleteTypingDailySummaries(
  uid: string,
  dates: string[],
): Promise<TypingTombstoneResult> {
  await flushNow({ final: true })
  const ranges: Array<{ startMs: number; endMs: number }> = []
  for (const date of dates) {
    const range = localDayRangeMs(date)
    if (range) ranges.push(range)
  }
  if (ranges.length === 0) {
    return emptyTombstoneResult()
  }
  const machineHash = await getMachineHash()
  const userDataDir = app.getPath('userData')
  // Map each local-calendar range to the UTC days it overlaps. A local
  // date typically covers one UTC day, but near midnight UTC in
  // non-zero offsets it spans two, so we unlink both.
  const utcDays = new Set<UtcDay>()
  for (const range of ranges) {
    utcDays.add(utcDayFromMs(range.startMs))
    utcDays.add(utcDayFromMs(range.endMs - 1))
  }
  for (const day of utcDays) {
    try {
      await unlinkOwnDayFile(userDataDir, uid, machineHash, day)
    } catch (err) {
      log('warn', `typing-analytics per-day unlink failed for ${uid}/${machineHash}/${day}: ${String(err)}`)
    }
  }
  const db = getTypingAnalyticsDB()
  const updatedAt = Date.now()
  const result = emptyTombstoneResult()
  for (const range of ranges) {
    const r = db.tombstoneRowsForUidInRange(uid, range.startMs, range.endMs, updatedAt)
    result.charMinutes += r.charMinutes
    result.matrixMinutes += r.matrixMinutes
    result.minuteStats += r.minuteStats
    result.bigramMinutes += r.bigramMinutes
    result.trigramMinutes += r.trigramMinutes
    result.sessions += r.sessions
  }
  await notifySyncIfTouched(uid, result, [...utcDays])
  return result
}

/** Delete every per-day JSONL file owned by this device for the given
 * keyboard uid and tombstone all of that uid's cache rows. Other
 * devices' files are untouched — they clear themselves on their own
 * Delete All action. */
export async function deleteAllTypingForKeyboard(uid: string): Promise<TypingTombstoneResult> {
  // Finalize this keyboard's active session first so flushNow persists it and
  // the cache tombstone below covers it; otherwise closeAll() on quit would
  // re-persist the open session and resurrect the deleted keyboard in Analyze.
  closeSessionsForUid(uid)
  await flushNow({ final: true })
  const machineHash = await getMachineHash()
  const userDataDir = app.getPath('userData')
  // Snapshot the days *before* unlinking so the post-tombstone notify
  // can still iterate over them — once the unlink loop has removed every
  // per-day file, a fresh listDeviceDays would only see the now-empty
  // directory and return [].
  const days = await listDeviceDays(userDataDir, uid, machineHash)
  for (const day of days) {
    try {
      await unlinkOwnDayFile(userDataDir, uid, machineHash, day)
    } catch (err) {
      log('warn', `typing-analytics per-day unlink failed for ${uid}/${machineHash}/${day}: ${String(err)}`)
    }
  }
  const db = getTypingAnalyticsDB()
  const updatedAt = Date.now()
  const result = db.tombstoneAllRowsForUid(uid, updatedAt)
  await notifySyncIfTouched(uid, result, days)
  return result
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

/** Emit one per-day sync-unit per affected day so the upload pipeline
 * picks up the new rows for each `(uid, machineHash, day)` independently.
 * Caller is responsible for materialising the affected `days` *before*
 * any unlink so a delete-and-notify flow doesn't lose the day list. */
async function notifySyncIfTouched(
  uid: string,
  result: TypingTombstoneResult,
  days: readonly UtcDay[],
): Promise<void> {
  const touched =
    result.charMinutes + result.matrixMinutes + result.minuteStats +
    result.bigramMinutes + result.trigramMinutes + result.sessions
  if (touched === 0 || days.length === 0) return
  const notifier = taState.syncNotifier
  if (!notifier) return
  try {
    const machineHash = await getMachineHash()
    for (const day of days) {
      notifier(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, day))
    }
  } catch (err) {
    log('warn', `typing-analytics sync notify failed for ${uid}: ${String(err)}`)
  }
}
