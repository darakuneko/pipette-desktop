// SPDX-License-Identifier: GPL-2.0-or-later
// Persistent bookkeeping for the typing-analytics sync pipeline.
// Tracks per-keyboard own-hash upload state so the sync pass can tell
// "never uploaded" apart from "uploaded then remotely deleted", plus a
// reconcile-pending timestamp per own hash. See
// .claude/plans/typing-analytics.md.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readPointerKey } from './jsonl/paths'
import { isUtcDay, type UtcDay } from './jsonl/utc-day'

/** Current schema version.
 *  - v1 / v2: tracked `read_pointers` for the now-removed flat-file
 *    merge path; v2 added `uploaded` and `reconciled_at`.
 *  - v3 drops `read_pointers` since per-day bundles are replayed in
 *    full and the merge layer never consulted the pointer. */
export const SYNC_STATE_REV = 3

export interface TypingSyncState {
  _rev: typeof SYNC_STATE_REV
  my_device_id: string
  /** key = `{uid}|{ownHash}`, value = UTC days this device has uploaded
   * to cloud. Used to distinguish "new day, needs upload" from "day was
   * Sync-deleted remotely, clean local". Only populated for own hashes
   * (other devices' uploads are tracked by their own sync-state). */
  uploaded: Record<string, UtcDay[]>
  /** key = `{uid}|{ownHash}`, value = epoch-ms of the last successful
   * own-hash reconcile pass, or `null` when a reconcile is pending
   * (e.g. after a cache rebuild). A missing entry is treated the same
   * as `null` by the sync pass (pending), so an older state that
   * migrates with an empty map still forces an initial reconcile for
   * every own hash before the upload rules run. */
  reconciled_at: Record<string, number | null>
  last_synced_at: number
}

export function syncStatePath(userDataDir: string): string {
  return join(userDataDir, 'local', 'typing-analytics', 'sync_state.json')
}

export function emptySyncState(myDeviceId: string): TypingSyncState {
  return {
    _rev: SYNC_STATE_REV,
    my_device_id: myDeviceId,
    uploaded: {},
    reconciled_at: {},
    last_synced_at: 0,
  }
}

function isUploadedRecord(value: unknown): value is Record<string, UtcDay[]> {
  if (typeof value !== 'object' || value === null) return false
  for (const val of Object.values(value)) {
    if (!Array.isArray(val)) return false
    for (const day of val) {
      if (typeof day !== 'string' || !isUtcDay(day)) return false
    }
  }
  return true
}

function isReconciledAtRecord(value: unknown): value is Record<string, number | null> {
  if (typeof value !== 'object' || value === null) return false
  for (const val of Object.values(value)) {
    if (val === null) continue
    if (typeof val !== 'number' || !Number.isFinite(val)) return false
  }
  return true
}

function parseSyncState(raw: unknown): TypingSyncState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.my_device_id !== 'string') return null
  if (typeof obj.last_synced_at !== 'number' || !Number.isFinite(obj.last_synced_at)) return null

  if (obj._rev === SYNC_STATE_REV) {
    if (!isUploadedRecord(obj.uploaded)) return null
    if (!isReconciledAtRecord(obj.reconciled_at)) return null
    return {
      _rev: SYNC_STATE_REV,
      my_device_id: obj.my_device_id,
      uploaded: obj.uploaded,
      reconciled_at: obj.reconciled_at,
      last_synced_at: obj.last_synced_at,
    }
  }
  // v2 → v3: drop the removed `read_pointers` and keep the upload /
  // reconcile bookkeeping. Older states forced an initial reconcile via
  // the empty `reconciled_at` map; that property is preserved here.
  if (obj._rev === 2) {
    if (!isUploadedRecord(obj.uploaded)) return null
    if (!isReconciledAtRecord(obj.reconciled_at)) return null
    return {
      _rev: SYNC_STATE_REV,
      my_device_id: obj.my_device_id,
      uploaded: obj.uploaded,
      reconciled_at: obj.reconciled_at,
      last_synced_at: obj.last_synced_at,
    }
  }
  // v1 → v3: drop `read_pointers` and start with empty upload /
  // reconcile maps so the first sync pass treats every own hash as
  // pending reconcile.
  if (obj._rev === 1) {
    return {
      _rev: SYNC_STATE_REV,
      my_device_id: obj.my_device_id,
      uploaded: {},
      reconciled_at: {},
      last_synced_at: obj.last_synced_at,
    }
  }
  return null
}

/** Load the sync state from disk. Returns `null` when the file is
 * missing or unreadable so callers can decide whether to fall back to
 * an empty state (first boot) or force a full cache rebuild. */
export async function loadSyncState(userDataDir: string): Promise<TypingSyncState | null> {
  const path = syncStatePath(userDataDir)
  let text: string
  try {
    text = await readFile(path, 'utf-8')
  } catch {
    return null
  }
  try {
    return parseSyncState(JSON.parse(text))
  } catch {
    return null
  }
}

/** Persist the sync state atomically via a temp-file rename so a crash
 * cannot leave a half-written JSON document. Callers should save after
 * every successful flush / import pass that moved a pointer. */
export async function saveSyncState(
  userDataDir: string,
  state: TypingSyncState,
): Promise<void> {
  const path = syncStatePath(userDataDir)
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8')
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

/** True when the own-hash upload pass must run an orphan reconcile
 * before evaluating the normal upload rules. Both a `null` and a
 * missing entry signal "pending" so v1→v2 migrated states and
 * post-rebuild states are treated uniformly. */
export function isReconcilePending(
  state: TypingSyncState,
  uid: string,
  machineHash: string,
): boolean {
  const value = state.reconciled_at[readPointerKey(uid, machineHash)]
  return value === undefined || value === null
}

export { readPointerKey }
