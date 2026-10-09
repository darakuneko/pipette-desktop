// SPDX-License-Identifier: GPL-2.0-or-later
// Remote typing-analytics day-file bookkeeping: reconciling own-hash
// cloud state against local + `uploaded` state before an upload pass,
// and the Sync > Typing lazy-expand UI's on-demand cloud reads (list
// remote hashes/days, fetch a single remote day).

import { app } from 'electron'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { decrypt } from './sync-crypto'
import {
  listFiles,
  downloadFile,
  deleteFilesById,
  driveFileName,
  syncUnitFromFileName,
  type DriveFile,
} from './google-drive'
import { requireSyncCredentials, ensurePasswordCheckValidated } from './sync-password'
import { localSyncBlock, remoteSyncBlock } from './sync-password-guard'
import { syncFormatGeneration } from './sync-format'
import { mergeDeviceDayBundle, mergeWithRemote } from './sync-merge-dispatch'
import { isKnownRemoteRevision, lockFreeWriterBlocked, syncRuntime } from './sync-runtime-state'
import { canonicalFiles, filesNamedWithTrash, namesWithTrash, pickCanonicalFile } from './drive-canonical'
import {
  parseTypingAnalyticsDeviceDaySyncUnit,
  typingAnalyticsDeviceDaySyncUnit,
  typingDeletedRangesSyncUnit,
} from '../typing-analytics/sync'
import { deletedRangesPath, listDeviceDays, readPointerKey } from '../typing-analytics/jsonl/paths'
import type { UtcDay } from '../typing-analytics/jsonl/utc-day'
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

/** A typing day file on Drive: `live` is the copy sync reads, absent when
 * only trash files of the day's name are left (drive-trash.ts). */
interface RemoteDay {
  name: string
  live?: DriveFile
}

/** Scan the remote file list for per-day typing-analytics units owned
 * by `ownHash`, grouped by keyboard uid. Units with a malformed
 * filename are skipped. A day with several files of its name maps to the
 * copy `pickCanonicalFile` (drive-canonical.ts) chooses; a day with only
 * trash files is listed without `live`. */
export function collectRemoteOwnHashDays(
  remoteFiles: DriveFile[],
  ownHash: string,
): Map<string, Map<UtcDay, RemoteDay>> {
  const perUid = new Map<string, Map<UtcDay, RemoteDay>>()
  const add = (name: string, live: DriveFile | undefined): void => {
    const unit = syncUnitFromFileName(name)
    if (!unit) return
    const ref = parseTypingAnalyticsDeviceDaySyncUnit(unit)
    if (!ref || ref.machineHash !== ownHash) return
    let byDay = perUid.get(ref.uid)
    if (!byDay) {
      byDay = new Map<UtcDay, RemoteDay>()
      perUid.set(ref.uid, byDay)
    }
    if (live || !byDay.has(ref.utcDay)) byDay.set(ref.utcDay, { name, live })
  }
  for (const file of canonicalFiles(remoteFiles)) add(file.name, file)
  for (const name of namesWithTrash(remoteFiles)) add(name, undefined)
  return perUid
}

/** Reconcile the own-hash cloud state with local + uploaded bookkeeping
 * before the regular upload pass runs. Three transitions are applied:
 *
 *   Rule 2 — `uploaded` has day X, local does not: user or Local-delete
 *     removed the file locally → delete the cloud copy as well.
 *   Rule 3 — `uploaded` has day X, cloud does not: something else removed
 *     the cloud copy (a Reset Sync Data, another device) → drop the day from
 *     `uploaded` and keep the local file, so the upload pass sends it again.
 *     Another device never removes this device's data by deleting its
 *     files; it adds deleted ranges instead (typing-device-delete.ts).
 *   Orphan — when `reconciled_at` is pending for (uid, ownHash), also
 *     delete any cloud day that is neither in local nor in `uploaded`
 *     (leftover from a previous install / pre-migration state).
 *
 * Rules 2 and 3 run on every pass; orphan cleanup only on the first
 * pass after a cache rebuild or fresh install, then `reconciled_at`
 * is timestamped so the expensive listing is skipped afterwards.
 *
 * A cloud delete removes every file with that day's name and every trash
 * file of it, so nothing is left behind to be picked up or renamed back.
 * Rules 2 and orphan also see a day that has only trash files; rule 3 needs
 * a live copy, so a day with only trash is uploaded again. */
export async function reconcileOwnHashTypingAnalytics(
  remoteFiles: DriveFile[],
  userData: string,
  ownHash: string,
): Promise<{ state: TypingSyncState; mutated: boolean }> {
  const state = (await loadSyncState(userData)) ?? emptySyncState(ownHash)
  const remotePerUid = collectRemoteOwnHashDays(remoteFiles, ownHash)
  // Deletes every copy and trash file of `day`'s name; a failed delete is
  // logged (by deleteFilesById and here) and the pass goes on.
  const deleteAllCopies = async (day: RemoteDay, failure: string): Promise<void> => {
    const result = await deleteFilesById(filesNamedWithTrash(remoteFiles, day.name).map((copy) => copy.id))
    if (result.failed > 0) log('warn', `${failure}: ${result.firstError}`)
  }

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
    const cloudDays = remotePerUid.get(uid) ?? new Map<UtcDay, RemoteDay>()

    // Rule 2: uploaded but not local — delete from cloud.
    for (const day of Array.from(uploadedDays)) {
      if (localDays.has(day)) continue
      const cloudDay = cloudDays.get(day)
      if (cloudDay) {
        await deleteAllCopies(cloudDay, `typing-analytics cloud delete failed for ${uid} ${day}`)
        cloudDays.delete(day)
      }
      uploadedDays.delete(day)
      mutated = true
    }

    // Rule 3: uploaded but not cloud — forget the upload; the local file
    // stays and the upload pass sends it again.
    for (const day of Array.from(uploadedDays)) {
      if (cloudDays.get(day)?.live) continue
      uploadedDays.delete(day)
      mutated = true
    }

    // Orphan cleanup on first reconcile only. Cloud days that are
    // neither local nor in `uploaded` are leftovers (pre-migration
    // flat bundles converted to per-day, or data from a removed
    // install). Deleting them avoids surprising re-download prompts.
    if (isReconcilePending(state, uid, ownHash)) {
      for (const [day, cloudDay] of Array.from(cloudDays.entries())) {
        if (localDays.has(day) || uploadedDays.has(day)) continue
        await deleteAllCopies(cloudDay, `typing-analytics orphan delete failed for ${uid} ${day}`)
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
 * user is unauthenticated or a sync password change is in progress. */
export async function hasAnyRemoteTypingData(): Promise<boolean> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return false
  const ownHash = await getMachineHash()
  if (await localSyncBlock()) return false
  const formatGeneration = syncFormatGeneration()
  const remoteFiles = await listFiles()
  if (remoteSyncBlock(remoteFiles, formatGeneration)) return false
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
 * haven't been merged locally yet. Sorted for stable UI order. Empty
 * while a sync password change is in progress. */
export async function listRemoteTypingHashesForUidFromCloud(
  uid: string,
): Promise<string[]> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return []
  const ownHash = await getMachineHash()
  if (await localSyncBlock()) return []
  const formatGeneration = syncFormatGeneration()
  const remoteFiles = await listFiles()
  if (remoteSyncBlock(remoteFiles, formatGeneration)) return []
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
 * scanRemoteData or the sync progress channel separately. So does a call
 * while a sync password change is in progress. */
export async function listRemoteTypingDaysFor(
  uid: string,
  machineHash: string,
): Promise<UtcDay[]> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return []
  if (await localSyncBlock()) return []
  const formatGeneration = syncFormatGeneration()
  const remoteFiles = await listFiles()
  if (remoteSyncBlock(remoteFiles, formatGeneration)) return []
  const perUid = collectRemoteOwnHashDays(remoteFiles, machineHash)
  const days = perUid.get(uid)
  if (!days) return []
  return Array.from(days).filter(([, day]) => day.live).map(([utcDay]) => utcDay).sort()
}

/** Lazily fetch a single remote (uid, machineHash, day) into the
 * local cache. Returns `true` when the day was downloaded and merged,
 * `false` when the cloud copy was missing, a credential check failed, a
 * reset of this keyboard is running, a sign-in or sign-out is switching
 * tokens, or a sync password change is in progress. Throws
 * `PasswordMismatchError` when the password-check does not open with the
 * stored password.
 * Designed for the Sync > Typing > Device lazy-expand flow so the UI
 * can pull in only the days the user actually opens.
 * Doesn't take the sync lock: it is counted in `remoteTypingDayFetches`
 * before its first await; a password change refuses to start, and a reset
 * that removes this keyboard's data waits or refuses, while it is counted. */
export async function fetchRemoteTypingDay(
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): Promise<boolean> {
  // A password change, a reset of this keyboard and a token switch each
  // wait or refuse while this fetch is counted (`lockFreeWriterRunning`).
  // The check and the count below are synchronous, so they never overlap.
  if (lockFreeWriterBlocked(uid)) return false
  const fetches = syncRuntime.remoteTypingDayFetches
  fetches.set(uid, (fetches.get(uid) ?? 0) + 1)
  try {
    return await fetchAndMergeRemoteTypingDay(uid, machineHash, utcDay)
  } finally {
    const remaining = (fetches.get(uid) ?? 1) - 1
    if (remaining > 0) fetches.set(uid, remaining)
    else fetches.delete(uid)
  }
}

async function fetchAndMergeRemoteTypingDay(
  uid: string,
  machineHash: string,
  utcDay: UtcDay,
): Promise<boolean> {
  const credentials = await requireSyncCredentials()
  if (!credentials.ok) return false
  const { password } = credentials
  if (await localSyncBlock()) return false
  const formatGeneration = syncFormatGeneration()
  const remoteFiles = await listFiles()
  if (remoteSyncBlock(remoteFiles, formatGeneration)) return false
  const file = pickCanonicalFile(remoteFiles, driveFileName(typingAnalyticsDeviceDaySyncUnit(uid, machineHash, utcDay)))
  if (!file) return false
  await ensurePasswordCheckValidated(password, remoteFiles)
  // The device's deleted ranges first, so the day's rows in them are hidden
  // as the day is replayed (mergeDeviceDayBundle). Skipped only when the
  // revision is known and the local file exists: a poll also records the
  // revisions of keyboards it leaves alone because they are not local, so
  // a known revision alone does not mean the file was merged. A failed
  // merge fails the fetch before the day is downloaded.
  const rangesUnit = typingDeletedRangesSyncUnit(uid, machineHash)
  const rangesFile = pickCanonicalFile(remoteFiles, driveFileName(rangesUnit))
  const userData = app.getPath('userData')
  if (rangesFile && !(isKnownRemoteRevision(rangesFile) && existsSync(deletedRangesPath(userData, uid, machineHash)))) {
    await mergeWithRemote(rangesFile, rangesUnit, password, remoteFiles)
  }
  const envelope = await downloadFile(file.id)
  const plaintext = await decrypt(envelope, password)
  const remoteBundle = JSON.parse(plaintext) as SyncBundle
  const ownHash = await getMachineHash()
  await mergeDeviceDayBundle(remoteBundle, { uid, machineHash, utcDay }, userData, ownHash)
  return true
}
