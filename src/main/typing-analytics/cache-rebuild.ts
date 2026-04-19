// SPDX-License-Identifier: GPL-2.0-or-later
// Rebuild the local SQLite cache from the JSONL master files. The
// cache is always derivable from the JSONL files, so a missing /
// stale / machine-migrated cache is never fatal: this module drops the
// user rows, re-reads every master file, and re-applies every row via
// the LWW merge path. See .claude/plans/typing-analytics.md.

import { unlink } from 'node:fs/promises'
import { applyRowsToCache } from './jsonl/apply-to-cache'
import { readRows } from './jsonl/jsonl-reader'
import {
  listAllDeviceDayJsonlFiles,
  listAllDeviceJsonlFiles,
  readPointerKey,
} from './jsonl/paths'
import { DATA_TABLE_NAMES } from './db/schema'
import type { TypingAnalyticsDB } from './db/typing-analytics-db'
import {
  emptySyncState,
  loadSyncState,
  saveSyncState,
  type TypingSyncState,
} from './sync-state'

export interface CacheRebuildResult {
  scopes: number
  charMinutes: number
  matrixMinutes: number
  minuteStats: number
  sessions: number
  jsonlFilesRead: number
}

/** Drop every user-data row while keeping the schema and
 * `typing_analytics_meta` rows (schema_version) intact. */
export function truncateCache(db: TypingAnalyticsDB): void {
  const connection = db.getConnection()
  connection.transaction(() => {
    for (const table of DATA_TABLE_NAMES) {
      connection.exec(`DELETE FROM ${table}`)
    }
  })()
}

/** Read every JSONL master file from disk, apply its rows to `db` in
 * order, and return the new `read_pointers` map plus the number of rows
 * touched in each table. Both the v6 flat layout
 * (`{uid}/devices/{hash}.jsonl`) and the v7 per-day layout
 * (`{uid}/devices/{hash}/{YYYY-MM-DD}.jsonl`) are read so rebuilds
 * survive the transition period. v6 files are applied first; v7 day
 * files are applied in ascending date order afterwards, so for a hash
 * that has both layouts the pointer lands on the latest per-day row.
 * The cache merge is LWW, so file order does not affect row content. */
export async function rebuildCacheFromMasterFiles(
  db: TypingAnalyticsDB,
  userDataDir: string,
): Promise<{
  result: CacheRebuildResult
  pointers: Record<string, string | null>
}> {
  truncateCache(db)
  const pointers: Record<string, string | null> = {}
  const result: CacheRebuildResult = {
    scopes: 0,
    charMinutes: 0,
    matrixMinutes: 0,
    minuteStats: 0,
    sessions: 0,
    jsonlFilesRead: 0,
  }

  const applyFile = async (ref: {
    uid: string
    machineHash: string
    path: string
  }): Promise<void> => {
    const { rows, lastId } = await readRows(ref.path)
    pointers[readPointerKey(ref.uid, ref.machineHash)] = lastId
    if (rows.length === 0) return
    const applied = applyRowsToCache(db, rows)
    result.scopes += applied.scopes
    result.charMinutes += applied.charMinutes
    result.matrixMinutes += applied.matrixMinutes
    result.minuteStats += applied.minuteStats
    result.sessions += applied.sessions
    result.jsonlFilesRead += 1
  }

  // Scan both layouts in parallel; they walk overlapping trees so the
  // filesystem cache warms once. Apply serially afterwards because v7
  // files must run after v6 for a hash that has both, and the cache
  // merge itself is sequential inside better-sqlite3.
  const [flatRefs, dayRefs] = await Promise.all([
    listAllDeviceJsonlFiles(userDataDir),
    listAllDeviceDayJsonlFiles(userDataDir),
  ])
  for (const ref of flatRefs) await applyFile(ref)
  for (const ref of dayRefs) await applyFile(ref)

  return { result, pointers }
}

/** Remove any v6 flat JSONL files discovered on disk. Safe to call
 * after rebuildCacheFromMasterFiles because the rows have already
 * been replayed into the cache from both the flat and per-day files.
 * Silently skips files that were already removed between the listing
 * and the unlink (expected on repeated runs). */
export async function cleanupLegacyFlatMasterFiles(userDataDir: string): Promise<number> {
  const refs = await listAllDeviceJsonlFiles(userDataDir)
  let removed = 0
  for (const ref of refs) {
    try {
      await unlink(ref.path)
      removed += 1
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Leave unexpected errors for the caller's log/tests to surface.
        throw err
      }
    }
  }
  return removed
}

export interface EnsureCacheOptions {
  /** Force a rebuild regardless of sync-state contents. Used by tests
   * and the schema-migration path. */
  force?: boolean
}

/** Decide whether the cache is trustworthy for this device and rebuild
 * it from the master files otherwise. Triggers for a rebuild:
 *
 *  - `sync_state.json` is missing or unreadable (first boot / corrupt).
 *  - `sync_state.my_device_id` differs from the current machine hash
 *    (user migrated / regenerated `installation-id`).
 *  - `options.force` is true.
 *
 * Returns the fresh sync-state (with updated pointers + timestamp) and
 * a flag indicating whether a rebuild actually ran. */
export async function ensureCacheIsFresh(
  db: TypingAnalyticsDB,
  userDataDir: string,
  myDeviceId: string,
  options: EnsureCacheOptions = {},
): Promise<{ rebuilt: boolean; state: TypingSyncState }> {
  const existing = await loadSyncState(userDataDir)
  const needsRebuild =
    options.force === true ||
    existing === null ||
    existing.my_device_id !== myDeviceId

  if (!needsRebuild && existing) {
    return { rebuilt: false, state: existing }
  }

  const { pointers } = await rebuildCacheFromMasterFiles(db, userDataDir)
  // One-shot v7 migration: per-day files are the canonical master now,
  // so delete any v6 flat `{hash}.jsonl` files after their rows have
  // been replayed. Failures are tolerated — the flat files are still
  // harmless, they just become a leftover the next rebuild will re-read.
  try {
    await cleanupLegacyFlatMasterFiles(userDataDir)
  } catch {
    /* non-fatal; rerun on next rebuild */
  }
  const state: TypingSyncState = {
    ...emptySyncState(myDeviceId),
    read_pointers: pointers,
    last_synced_at: Date.now(),
  }
  await saveSyncState(userDataDir, state)
  return { rebuilt: true, state }
}
