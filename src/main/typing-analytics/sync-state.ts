// SPDX-License-Identifier: GPL-2.0-or-later
// Persistent pointer-bookkeeping for the typing-analytics JSONL master
// files. Tracks, per JSONL file, the last row id that has already been
// applied to the local SQLite cache so subsequent passes only read the
// tail. See .claude/plans/typing-analytics.md.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readPointerKey } from './jsonl/paths'
import { isUtcDay, type UtcDay } from './jsonl/utc-day'

/** Current schema version. v1: read_pointers only. v2: adds `uploaded`
 * (per own-hash list of UTC days successfully uploaded to cloud) and
 * `reconciled_at` (timestamp of the last own-hash cloud orphan
 * reconcile, or `null` to force one on the next sync pass). */
export const SYNC_STATE_REV = 2

export interface TypingSyncState {
  _rev: typeof SYNC_STATE_REV
  my_device_id: string
  /** key = `{uid}|{machineHash}`, value = composite id of the last row
   * applied to the local cache from that file. `null` means "nothing
   * applied yet" so the next pass reads from the top. */
  read_pointers: Record<string, string | null>
  /** key = `{uid}|{ownHash}`, value = UTC days this device has uploaded
   * to cloud. Used to distinguish "new day, needs upload" from "day was
   * Sync-deleted remotely, clean local". Only populated for own hashes
   * (other devices' uploads are tracked by their own sync-state). */
  uploaded: Record<string, UtcDay[]>
  /** key = `{uid}|{ownHash}`, value = epoch-ms of the last successful
   * own-hash reconcile pass, or `null` when a reconcile is pending
   * (e.g. after a cache rebuild). A missing entry is treated the same
   * as `null` by the sync pass (pending), so a v1→v2 migration that
   * leaves this map empty still forces an initial reconcile for every
   * own hash before the 3 upload rules run. */
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
    read_pointers: {},
    uploaded: {},
    reconciled_at: {},
    last_synced_at: 0,
  }
}

function isPointersRecord(value: unknown): value is Record<string, string | null> {
  if (typeof value !== 'object' || value === null) return false
  for (const val of Object.values(value)) {
    if (val !== null && typeof val !== 'string') return false
  }
  return true
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
  if (!isPointersRecord(obj.read_pointers)) return null
  if (typeof obj.last_synced_at !== 'number' || !Number.isFinite(obj.last_synced_at)) return null

  if (obj._rev === SYNC_STATE_REV) {
    if (!isUploadedRecord(obj.uploaded)) return null
    if (!isReconciledAtRecord(obj.reconciled_at)) return null
    return {
      _rev: SYNC_STATE_REV,
      my_device_id: obj.my_device_id,
      read_pointers: obj.read_pointers,
      uploaded: obj.uploaded,
      reconciled_at: obj.reconciled_at,
      last_synced_at: obj.last_synced_at,
    }
  }
  // v1 → v2: preserve read_pointers and my_device_id, initialise the
  // new fields empty. Because missing entries in `reconciled_at` are
  // treated as pending (see field comment), v1 users automatically go
  // through the initial orphan-reconcile on their first v7 sync pass.
  if (obj._rev === 1) {
    return {
      _rev: SYNC_STATE_REV,
      my_device_id: obj.my_device_id,
      read_pointers: obj.read_pointers,
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
