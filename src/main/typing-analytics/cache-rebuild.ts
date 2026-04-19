// SPDX-License-Identifier: GPL-2.0-or-later
// Rebuild the local SQLite cache from the JSONL master files. The
// cache is always derivable from the JSONL files, so a missing /
// stale / machine-migrated cache is never fatal: this module drops the
// user rows, re-reads every master file, and re-applies every row via
// the LWW merge path. See .claude/plans/typing-analytics.md.

import { applyRowsToCache } from './jsonl/apply-to-cache'
import { readRows } from './jsonl/jsonl-reader'
import { listAllDeviceJsonlFiles, readPointerKey } from './jsonl/paths'
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

/** Read every `{sync}/keyboards/*\/devices/*.jsonl` from disk, apply each
 * row to `db` in order, and return the new `read_pointers` map plus the
 * number of rows touched in each table. Scope rows inside a single file
 * are applied before non-scope rows via `applyRowsToCache`; across files
 * scopes are interleaved with data rows but the cache merge is LWW so
 * ordering across files does not matter. */
export async function rebuildCacheFromMasterFiles(
  db: TypingAnalyticsDB,
  userDataDir: string,
): Promise<{
  result: CacheRebuildResult
  pointers: Record<string, string | null>
}> {
  truncateCache(db)
  const refs = await listAllDeviceJsonlFiles(userDataDir)
  const pointers: Record<string, string | null> = {}
  const result: CacheRebuildResult = {
    scopes: 0,
    charMinutes: 0,
    matrixMinutes: 0,
    minuteStats: 0,
    sessions: 0,
    jsonlFilesRead: 0,
  }

  for (const ref of refs) {
    const { rows, lastId } = await readRows(ref.path)
    pointers[readPointerKey(ref.uid, ref.machineHash)] = lastId
    if (rows.length === 0) continue
    const applied = applyRowsToCache(db, rows)
    result.scopes += applied.scopes
    result.charMinutes += applied.charMinutes
    result.matrixMinutes += applied.matrixMinutes
    result.minuteStats += applied.minuteStats
    result.sessions += applied.sessions
    result.jsonlFilesRead += 1
  }

  return { result, pointers }
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
  const state: TypingSyncState = {
    ...emptySyncState(myDeviceId),
    read_pointers: pointers,
    last_synced_at: Date.now(),
  }
  await saveSyncState(userDataDir, state)
  return { rebuilt: true, state }
}
