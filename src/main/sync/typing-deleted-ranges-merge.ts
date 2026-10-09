// SPDX-License-Identifier: GPL-2.0-or-later
// Merge of a downloaded deleted-ranges bundle
// (`keyboards/{uid}/devices/{hash}/deleted-ranges`, deleted-ranges.ts) into
// the local file. The read-merge-write runs under the file's lock
// (`updateDeletedRanges`); the follow-up work runs after that lock is
// released and takes the merged entries from memory, because
// `withWriteLock` is not reentrant and the follow-up must not read the file
// under the lock again.

import { MalformedSyncBundleError } from './merge'
import {
  parseDeletedRangesFile,
  unionDeletedRanges,
  type DeletedRangeEntry,
  type DeletedRangesUnion,
} from '../typing-analytics/deleted-ranges'
import { DELETED_RANGES_FILENAME } from '../typing-analytics/jsonl/paths'
import { updateDeletedRanges } from '../typing-analytics/deleted-ranges-store'
import { getTypingAnalyticsDB } from '../typing-analytics/db/typing-analytics-db'
import { resetHoldsKeyboard } from './sync-reset-lock'
import { log } from '../logger'
import { getMachineHash } from '../typing-analytics/machine-hash'
import { applyOwnDeletedRanges, applyOwnDeletedRangesForAllKeyboards } from '../typing-analytics/deleted-ranges-apply'
import { app } from 'electron'
import type { SyncBundle } from '../../shared/types/sync'

/** `unionDeletedRanges` against a downloaded file. Invalid entries of the
 * file are dropped; a file of the wrong shape throws
 * `MalformedSyncBundleError`. */
export function mergeRemoteDeletedRanges(
  local: readonly DeletedRangeEntry[],
  remoteFile: unknown,
  syncUnit: string,
): DeletedRangesUnion {
  const remote = parseDeletedRangesFile(remoteFile)
  if (remote === null) throw new MalformedSyncBundleError(syncUnit)
  return unionDeletedRanges(local, remote)
}


/** The parsed file of a remote bundle. A bundle without a string file, or
 * whose file is not JSON, throws `MalformedSyncBundleError`. */
function remoteFile(remoteBundle: SyncBundle, syncUnit: string): unknown {
  const files: unknown = remoteBundle.files
  if (files === null || typeof files !== 'object') throw new MalformedSyncBundleError(syncUnit)
  const raw = Object.hasOwn(files, DELETED_RANGES_FILENAME)
    ? (files as Record<string, unknown>)[DELETED_RANGES_FILENAME]
    : undefined
  if (typeof raw !== 'string') throw new MalformedSyncBundleError(syncUnit)
  try {
    return JSON.parse(raw)
  } catch {
    throw new MalformedSyncBundleError(syncUnit)
  }
}

/** Merges the remote entries into the local file and returns whether Drive
 * lacks entries this device holds. For another device's file, every merged
 * entry is then tombstoned in the cache in one transaction, so a cache
 * tombstone that failed on an earlier merge is made up by the next one. For
 * this device's own file, the entries not yet applied are applied to its
 * own day files (deleted-ranges-apply.ts). The caller has checked that
 * `ref`'s segments are safe path segments. */
export async function mergeTypingDeletedRangesBundle(
  syncUnit: string,
  remoteBundle: SyncBundle,
  ref: { uid: string; machineHash: string },
  userData: string,
  ownHash: string,
): Promise<boolean> {
  const remote = remoteFile(remoteBundle, syncUnit)
  const result = await updateDeletedRanges(userData, ref.uid, ref.machineHash, (local) =>
    mergeRemoteDeletedRanges(local, remote, syncUnit))
  if (ref.machineHash !== ownHash) {
    if (result.entries.length > 0) {
      getTypingAnalyticsDB().tombstoneRowsForUidHashInRanges(ref.uid, ref.machineHash, result.entries, Date.now())
    }
  } else if (result.entries.length > 0) {
    // Queued on the flush chain and not awaited: the caller may hold the
    // unit's `sync:` lock, and the flush chain never waits on a sync lock.
    void applyOwnDeletedRanges(ref.uid, result.entries, () => resetHoldsKeyboard(ref.uid)).catch((err: unknown) => {
      log('warn', `typing-analytics: deleted ranges of ${ref.uid} not applied: ${String(err)}`)
    })
  }
  return result.remoteNeedsUpdate
}

/** Queues the apply of this device's own deleted ranges for every keyboard,
 * read from the local files (entries already applied are skipped). Called
 * at the end of each sync pass, so an apply that was skipped (a reset held
 * the keyboard) or failed is retried even when Drive has nothing new and no
 * merge of the ranges unit runs. Not awaited: the apply waits on the flush
 * chain, and the pass holds a sync lock. */
export function queueOwnDeletedRangesApply(): void {
  void (async () => {
    await applyOwnDeletedRangesForAllKeyboards(app.getPath('userData'), await getMachineHash(), resetHoldsKeyboard)
  })().catch((err: unknown) => {
    log('warn', `typing-analytics: deleted ranges not applied after a sync pass: ${String(err)}`)
  })
}
