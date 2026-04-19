// SPDX-License-Identifier: GPL-2.0-or-later
// Persistent pointer-bookkeeping for the typing-analytics JSONL master
// files. Tracks, per JSONL file, the last row id that has already been
// applied to the local SQLite cache so subsequent passes only read the
// tail. See .claude/plans/typing-analytics.md.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readPointerKey } from './jsonl/paths'

export const SYNC_STATE_REV = 1

export interface TypingSyncState {
  _rev: typeof SYNC_STATE_REV
  my_device_id: string
  /** key = `{uid}|{machineHash}`, value = composite id of the last row
   * applied to the local cache from that file. `null` means "nothing
   * applied yet" so the next pass reads from the top. */
  read_pointers: Record<string, string | null>
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

function parseSyncState(raw: unknown): TypingSyncState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const obj = raw as Record<string, unknown>
  if (obj._rev !== SYNC_STATE_REV) return null
  if (typeof obj.my_device_id !== 'string') return null
  if (!isPointersRecord(obj.read_pointers)) return null
  if (typeof obj.last_synced_at !== 'number' || !Number.isFinite(obj.last_synced_at)) return null
  return {
    _rev: SYNC_STATE_REV,
    my_device_id: obj.my_device_id,
    read_pointers: obj.read_pointers,
    last_synced_at: obj.last_synced_at,
  }
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

export { readPointerKey }
