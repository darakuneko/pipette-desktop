// SPDX-License-Identifier: GPL-2.0-or-later
// Remote typing-analytics day-file bookkeeping: reconciling own-hash
// cloud state against local + `uploaded` state before an upload pass,
// and the Sync > Typing lazy-expand UI's on-demand cloud reads (list
// remote hashes/days, delete a remote day, fetch a single remote day).
// Split out of sync-service.ts (Task-split-sync-service) — see
// .claude/rules/file-splitting.md.

import { app } from 'electron'
import { join } from 'node:path'
import { readdir, unlink } from 'node:fs/promises'
import { decrypt } from './sync-crypto'
import {
  listFiles,
  downloadFile,
  deleteFile,
  driveFileName,
  syncUnitFromFileName,
  type DriveFile,
} from './google-drive'
import { requireSyncCredentials } from './sync-password'
import { mergeDeviceDayBundle } from './sync-merge-dispatch'
import {
  parseTypingAnalyticsDeviceDaySyncUnit,
  typingAnalyticsDeviceDaySyncUnit,
} from '../typing-analytics/sync'
import { deviceDayJsonlPath, listDeviceDays, readPointerKey } from '../typing-analytics/jsonl/paths'
import { utcDayBoundaryMs, type UtcDay } from '../typing-analytics/jsonl/utc-day'
import { getTypingAnalyticsDB } from '../typing-analytics/db/typing-analytics-db'
import { getMachineHash } from '../typing-analytics/machine-hash'
import {
  emptySyncState,
  isReconcilePending,
  loadSyncState,
  saveSyncState,
  type TypingSyncState,
} from '../typing-analytics/sync-state'
import { log } from '../logger'
import type { SyncBundle } from '../../shared/types/sync'

/** Scan the remote file list for per-day typing-analytics units owned
 * by `ownHash`, grouped by keyboard uid. Units with a malformed
 * filename are skipped. */
export function collectRemoteOwnHashDays(
  remoteFiles: DriveFile[],
  ownHash: string,
): Map<string, Map<UtcDay, DriveFile>> {
  const perUid = new Map<string, Map<UtcDay, DriveFile>>()
  for (const file of remoteFiles) {
    const unit = syncUnitFromFileName(file.name)
    if (!unit) continue
    const ref = parseTypingAnalyticsDeviceDaySyncUnit(unit)
    if (!ref || ref.machineHash !== ownHash) continue
    let byDay = perUid.get(ref.uid)
    if (!byDay) {
      byDay = new Map<UtcDay, DriveFile>()
      perUid.set(ref.uid, byDay)
    }
    byDay.set(ref.utcDay, file)
  }
  return perUid
}

/** Reconcile the own-hash cloud state with local + uploaded bookkeeping
 * before the regular upload pass runs. Three transitions are applied:
 *
 *   Rule 2 — `uploaded` has day X, local does not: user or Local-delete
 *     removed the file locally → delete the cloud copy as well.
 *   Rule 3 — `uploaded` has day X, cloud does not: a Sync-delete from
 *     another device or a GC step removed the cloud copy → drop the
 *     local file and let the next cache rebuild resync (rows added
 *     post-delete are preserved because they were never in `uploaded`).
 *   Orphan — when `reconciled_at` is pending for (uid, ownHash), also
 *     delete any cloud day that is neither in local nor in `uploaded`
 *     (leftover from a previous install / pre-migration state).
 *
 * Rules 2 and 3 run on every pass; orphan cleanup only on the first
 * pass after a cache rebuild or fresh install, then `reconciled_at`
 * is timestamped so the expensive listing is skipped afterwards. */
export async function reconcileOwnHashTypingAnalytics(
  remoteFiles: DriveFile[],
  userData: string,
  ownHash: string,
): Promise<{ state: TypingSyncState; mutated: boolean }> {
  const state = (await loadSyncState(userData)) ?? emptySyncState(ownHash)
  const remotePerUid = collectRemoteOwnHashDays(remoteFiles, ownHash)

  // Every uid that appears in any of the three sources needs a pass:
  // local files, uploaded bookkeeping, or remote cloud listing. Union
  // them so a fully-remote-only uid (no local files left) still gets
  // reconciled.
  const candidateUids = new Set<string>()
  for (const key of Object.keys(state.uploaded)) {
    const parts = key.split('|')
    if (parts.length === 2 && parts[1] === ownHash) candidateUids.add(parts[0])
  }
  for (const uid of remotePerUid.keys()) candidateUids.add(uid)
  try {
    for (const entry of await readdir(join(userData, 'sync', 'keyboards'), { withFileTypes: true })) {
      if (entry.isDirectory()) candidateUids.add(entry.name)
    }
  } catch { /* no keyboards dir */ }

  let mutated = false
  for (const uid of candidateUids) {
    const pointerKey = readPointerKey(uid, ownHash)
    const localDays = new Set<UtcDay>(await listDeviceDays(userData, uid, ownHash))
    const uploadedDays = new Set<UtcDay>(state.uploaded[pointerKey] ?? [])
    const cloudDays = remotePerUid.get(uid) ?? new Map<UtcDay, DriveFile>()

    // Rule 2: uploaded but not local — delete from cloud.
    for (const day of Array.from(uploadedDays)) {
      if (localDays.has(day)) continue
      const cloudFile = cloudDays.get(day)
      if (cloudFile) {
        try {
          await deleteFile(cloudFile.id)
        } catch (err) {
          log('warn', `typing-analytics cloud delete failed for ${uid} ${day}: ${String(err)}`)
        }
        cloudDays.delete(day)
      }
      uploadedDays.delete(day)
      mutated = true
    }

    // Rule 3: uploaded but not cloud — another device Sync-deleted us.
    for (const day of Array.from(uploadedDays)) {
      if (cloudDays.has(day)) continue
      try {
        await unlink(deviceDayJsonlPath(userData, uid, ownHash, day))
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          log('warn', `typing-analytics local delete failed for ${uid} ${day}: ${String(err)}`)
        }
      }
      localDays.delete(day)
      uploadedDays.delete(day)
      mutated = true
    }

    // Orphan cleanup on first reconcile only. Cloud days that are
    // neither local nor in `uploaded` are leftovers (pre-migration
    // flat bundles converted to per-day, or data from a removed
    // install). Deleting them avoids surprising re-download prompts.
    if (isReconcilePending(state, uid, ownHash)) {
      for (const [day, cloudFile] of Array.from(cloudDays.entries())) {
        if (localDays.has(day) || uploadedDays.has(day)) continue
        try {
          await deleteFile(cloudFile.id)
        } catch (err) {
          log('warn', `typing-analytics orphan delete failed for ${uid} ${day}: ${String(err)}`)
        }
        cloudDays.delete(day)
      }
      state.reconciled_at[pointerKey] = Date.now()
      mutated = true
    }

    // Persist the trimmed uploaded list (sorted for determinism so
    // the JSON-on-disk diff stays stable).
    state.uploaded[pointerKey] = Array.from(uploadedDays).sort()
  }

  if (mutated) {
    state.last_synced_at = Date.now()
    await saveSyncState(userData, state)
  }
  return { state, mutated }
}

/** True iff cloud currently holds at least one typing per-day file
 * owned by a non-own device. Used to decide whether the Sync > Typing
 * nav subtree is worth showing at all — a single listing is much
 * cheaper than expanding every keyboard. Returns `false` when the
 * user is unauthenticated. */
export async function hasAnyRemoteTypingData(): Promise<boolean> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return false
  const ownHash = await getMachineHash()
  const remoteFiles = await listFiles()
  for (const file of remoteFiles) {
    const unit = syncUnitFromFileName(file.name)
    if (!unit) continue
    const ref = parseTypingAnalyticsDeviceDaySyncUnit(unit)
    if (!ref || ref.machineHash === ownHash) continue
    return true
  }
  return false
}

/** Distinct remote machineHash values (non-own) that cloud currently
 * holds any per-day file for under `uid`. Used by the Sync > Typing
 * subtree to discover remote devices before the user has ever opened
 * one — the cache-only `listRemoteHashesForUid` misses hashes that
 * haven't been merged locally yet. Sorted for stable UI order. */
export async function listRemoteTypingHashesForUidFromCloud(
  uid: string,
): Promise<string[]> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return []
  const ownHash = await getMachineHash()
  const remoteFiles = await listFiles()
  const hashes = new Set<string>()
  for (const file of remoteFiles) {
    const unit = syncUnitFromFileName(file.name)
    if (!unit) continue
    const ref = parseTypingAnalyticsDeviceDaySyncUnit(unit)
    if (!ref || ref.uid !== uid || ref.machineHash === ownHash) continue
    hashes.add(ref.machineHash)
  }
  return Array.from(hashes).sort()
}

/** List the UTC days that cloud currently holds for a remote device
 * `(uid, machineHash)`. Returned in ascending lexicographic order so
 * callers can feed the list straight into a Sync > Typing > Device
 * tree without post-processing. An unauthenticated / network-failed
 * call returns an empty array — UIs surface the network error via
 * scanRemoteData or the sync progress channel separately. */
export async function listRemoteTypingDaysFor(
  uid: string,
  machineHash: string,
): Promise<UtcDay[]> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return []
  const remoteFiles = await listFiles()
  const perUid = collectRemoteOwnHashDays(remoteFiles, machineHash)
  const days = perUid.get(uid)
  if (!days) return []
  return Array.from(days.keys()).sort()
}

/** Delete the cloud copy of a specific (uid, machineHash, day) and
 * its local mirror if we previously downloaded it. Used by the Sync >
 * Typing > Device > Delete-day UX: another device's record is gone
 * from cloud, and when that device next syncs the reconcile pass will
 * see its `uploaded` entry without a cloud file and drop its own
 * local copy (rule 3). Own-hash cache rows are accepted as stale until
 * the next rebuild — they live in the machine that owns the day.
 * Returns `true` when a cloud delete actually ran, `false` when the
 * user is unauthenticated or the cloud file was already missing. */
export async function deleteRemoteTypingDay(
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): Promise<boolean> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return false
  const remoteFiles = await listFiles()
  const targetName = driveFileName(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, utcDay))
  const remoteFile = remoteFiles.find((f) => f.name === targetName)
  const userData = app.getPath('userData')
  try {
    await unlink(deviceDayJsonlPath(userData, uid, machineHash, utcDay))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log('warn', `typing-analytics local delete failed for ${uid} ${machineHash} ${utcDay}: ${String(err)}`)
    }
  }
  // Tombstone the remote hash's cache rows for this day so the Data
  // modal list refreshes immediately after the delete. Scoped to the
  // single hash + day so a same-day local contribution stays visible.
  try {
    const { startMs, endMs } = utcDayBoundaryMs(utcDay)
    const updatedAt = Date.now()
    getTypingAnalyticsDB().tombstoneRowsForUidHashInRange(uid, machineHash, startMs, endMs, updatedAt)
  } catch (err) {
    log('warn', `typing-analytics cache tombstone failed for ${uid} ${machineHash} ${utcDay}: ${String(err)}`)
  }
  if (!remoteFile) return false
  await deleteFile(remoteFile.id)
  return true
}

/** Lazily fetch a single remote (uid, machineHash, day) into the
 * local cache. Returns `true` when the day was downloaded and merged,
 * `false` when the cloud copy was missing or a credential check failed.
 * Designed for the Sync > Typing > Device lazy-expand flow so the UI
 * can pull in only the days the user actually opens. */
export async function fetchRemoteTypingDay(
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): Promise<boolean> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return false
  const { password } = credentials
  const remoteFiles = await listFiles()
  const targetName = driveFileName(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, utcDay))
  const file = remoteFiles.find((f) => f.name === targetName)
  if (!file) return false
  const envelope = await downloadFile(file.id)
  const plaintext = await decrypt(envelope, password)
  const remoteBundle = JSON.parse(plaintext) as SyncBundle
  const userData = app.getPath('userData')
  const ownHash = await getMachineHash()
  await mergeDeviceDayBundle(remoteBundle, { uid, machineHash, utcDay }, userData, ownHash)
  return true
}
