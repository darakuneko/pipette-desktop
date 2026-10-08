// SPDX-License-Identifier: GPL-2.0-or-later
// Keeps the pending sync units on disk (`userData/local/sync-pending.json`),
// so changes not yet uploaded when the app exits, crashes or is killed are
// sent after the next launch. The file mirrors the in-memory pending state
// of sync-runtime-state.ts: the active units with the account they were
// changed under, and the units held for other accounts.
//
// Writes are synchronous (temp file + rename), so the file is never torn
// and two writes never interleave; each one writes the whole state.

import { app } from 'electron'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isSafePathSegment } from '../utils/safe-filename'
import { isEnoent } from '../utils/is-enoent'
import { writeFileAtomicSync } from '../utils/write-file-atomic'
import {
  syncRuntime,
  markPending,
  pendingSnapshot,
  setPendingPersistence,
  setPendingFileUnreadable,
  type PendingSnapshot,
} from './sync-runtime-state'

const PENDING_FILE_VERSION = 1

/** How long a change waits before the pending state is written. Changes in
 *  that window share one write. */
export const PENDING_WRITE_DELAY_MS = 100

let writeTimer: ReturnType<typeof setTimeout> | null = null
/** True while the last write failed; the next change writes again. */
let dirty = false
/** Whether this process has created the file's directory. */
let dirReady = false

function pendingFilePath(): string {
  return join(app.getPath('userData'), 'local', 'sync-pending.json')
}

/** True when `sync/keyboards/{uid}` exists; only a missing directory counts
 *  as absent, any other error as present. */
function keyboardDirExists(uid: string): boolean {
  try {
    statSync(join(app.getPath('userData'), 'sync', 'keyboards', uid))
    return true
  } catch (err) {
    return !isEnoent(err)
  }
}

/** The units of `raw` whose every segment is a safe path segment (the rule
 *  `mergeSyncUnit`, sync-merge-dispatch.ts, applies before joining a unit
 *  into a local path), minus each `keyboards/{uid}/…` unit whose keyboard
 *  directory is gone (a keyboard reset or removed by hand while the app was
 *  closed): uploading it could recreate that keyboard's data from Drive. */
function liveUnits(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const units = new Set<string>()
  for (const unit of raw) {
    if (typeof unit !== 'string' || !unit.split('/').every(isSafePathSegment)) continue
    const [root, uid] = unit.split('/')
    if (root === 'keyboards' && uid !== undefined && !keyboardDirExists(uid)) continue
    units.add(unit)
  }
  return [...units]
}

/** The pending state written by an earlier run; null when the file exists
 *  but cannot be read. A missing file, or one that is not valid JSON of
 *  the expected shape, reads as an empty state. */
function readPending(): PendingSnapshot | null {
  const empty: PendingSnapshot = { owner: null, units: [], held: {} }
  let raw: string
  try {
    raw = readFileSync(pendingFilePath(), 'utf-8')
  } catch (err) {
    if (isEnoent(err)) return empty
    console.warn('[sync-pending-store] cannot read the pending file; changes are kept in memory only', err)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    console.warn('[sync-pending-store] ignoring a malformed pending file', err)
    return empty
  }
  if (typeof parsed !== 'object' || parsed === null) return empty
  const file = parsed as Record<string, unknown>
  if (file.version !== PENDING_FILE_VERSION || !Array.isArray(file.units)) return empty

  const held: Record<string, string[]> = {}
  if (typeof file.held === 'object' && file.held !== null && !Array.isArray(file.held)) {
    for (const [sub, units] of Object.entries(file.held)) {
      const kept = liveUnits(units)
      if (sub !== '' && kept.length > 0) held[sub] = kept
    }
  }
  return {
    owner: typeof file.owner === 'string' && file.owner !== '' ? file.owner : null,
    units: liveUnits(file.units),
    held,
  }
}

/** Cancels a scheduled write. */
function cancelScheduledPendingWrite(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
}

/** Writes `snapshot` now. Throws when it cannot be written; the file then
 *  keeps its previous content. */
function writePendingNow(snapshot: PendingSnapshot): void {
  cancelScheduledPendingWrite()
  const path = pendingFilePath()
  const content = JSON.stringify({ version: PENDING_FILE_VERSION, ...snapshot })
  dirty = true
  if (!dirReady) {
    mkdirSync(dirname(path), { recursive: true })
    dirReady = true
  }
  try {
    writeFileAtomicSync(path, content)
  } catch (err) {
    // The directory was removed since (e.g. by a reset of local data).
    if (!isEnoent(err)) throw err
    mkdirSync(dirname(path), { recursive: true })
    writeFileAtomicSync(path, content)
  }
  dirty = false
}

/** Writes the pending state `PENDING_WRITE_DELAY_MS` from now, unless a
 *  write is already due. A failure is logged; the next write catches up. */
function schedulePendingWrite(): void {
  if (writeTimer) return
  writeTimer = setTimeout(() => {
    writeTimer = null
    try {
      writePendingNow(pendingSnapshot())
    } catch (err) {
      console.warn('[sync-pending-store] failed to write the pending changes', err)
    }
  }, PENDING_WRITE_DELAY_MS)
}

/** Loads the pending state an earlier run left and starts keeping it on
 *  disk. Units restored here join any already pending; held units and the
 *  owner come from the file. The owner is checked against the signed-in
 *  account by the first pass that uploads (sync-pending-account.ts).
 *  Called once at startup, before anything queues a change. */
export function restorePendingFromDisk(): void {
  const restored = readPending()
  // A file this run cannot read is left as it is, not overwritten.
  if (!restored) {
    setPendingFileUnreadable()
    return
  }
  syncRuntime.pendingOwner = restored.owner
  for (const [sub, units] of Object.entries(restored.held)) {
    syncRuntime.heldPending.set(sub, new Set(units))
  }
  setPendingPersistence({ writeNow: writePendingNow, schedule: schedulePendingWrite, isDirty: () => dirty })
  for (const unit of restored.units) markPending(unit)
  // Units dropped above leave the file too.
  schedulePendingWrite()
}

/** Test-only: cancels a scheduled write and forgets a failed one. Called
 *  by the sync-service facade's `_resetForTests`. */
export function resetPendingStoreForTests(): void {
  cancelScheduledPendingWrite()
  dirty = false
}
