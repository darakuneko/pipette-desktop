// SPDX-License-Identifier: GPL-2.0-or-later
// Rebuild the local SQLite cache from the JSONL master files. The
// cache is always derivable from the JSONL files, so a missing /
// stale / machine-migrated cache is never fatal: this module drops the
// user rows, re-reads every master file, and re-applies every row via
// the LWW merge path. See .claude/plans/typing-analytics.md.

import { applyRowsToCache } from './jsonl/apply-to-cache'
import { readRows } from './jsonl/jsonl-reader'
import { listAllDeviceDayJsonlFiles } from './jsonl/paths'
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

/** Read every per-day JSONL master file from disk, apply its rows to
 * `db`, and return the number of rows touched per table. Per-day files
 * (`{uid}/devices/{hash}/{YYYY-MM-DD}.jsonl`) are scanned in ascending
 * date order; the cache merge is LWW so file order does not affect row
 * content. */
export async function rebuildCacheFromMasterFiles(
  db: TypingAnalyticsDB,
  userDataDir: string,
): Promise<CacheRebuildResult> {
  truncateCache(db)
  const result: CacheRebuildResult = {
    scopes: 0,
    charMinutes: 0,
    matrixMinutes: 0,
    minuteStats: 0,
    sessions: 0,
    jsonlFilesRead: 0,
  }

  const applyFile = async (ref: { path: string }): Promise<void> => {
    const { rows } = await readRows(ref.path)
    if (rows.length === 0) return
    const applied = applyRowsToCache(db, rows)
    result.scopes += applied.scopes
    result.charMinutes += applied.charMinutes
    result.matrixMinutes += applied.matrixMinutes
    result.minuteStats += applied.minuteStats
    result.sessions += applied.sessions
    result.jsonlFilesRead += 1
  }

  for (const ref of await listAllDeviceDayJsonlFiles(userDataDir)) {
    await applyFile(ref)
  }

  return result
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
 * Returns the fresh sync-state and a flag indicating whether a rebuild
 * actually ran. */
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

  await rebuildCacheFromMasterFiles(db, userDataDir)
  const state: TypingSyncState = {
    ...emptySyncState(myDeviceId),
    last_synced_at: Date.now(),
  }
  await saveSyncState(userDataDir, state)
  return { rebuilt: true, state }
}
