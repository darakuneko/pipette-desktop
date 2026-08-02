// SPDX-License-Identifier: GPL-2.0-or-later
// Sync-facing prepared statements: cross-device export selects, remote
// device discovery, per-scope row listing (for building tombstone JSONL),
// and tombstone writes (range / hash-scoped / all). Bigram/trigram
// tombstones live alongside their other per-table statements in
// ngram-statements.ts.

import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { TOMBSTONE_HASH_RANGE_WHERE, TOMBSTONE_RANGE_WHERE } from './filter-clauses'

export interface SyncStatements {
  selectScopesForUidStmt: Statement
  selectCharMinutesForUidStmt: Statement
  selectMatrixMinutesForUidStmt: Statement
  selectMinuteStatsForUidStmt: Statement
  selectSessionsForUidStmt: Statement
  selectLocalKeyboardUidsStmt: Statement
  selectRemoteHashesForUidStmt: Statement
  selectOwnScopeIdsForUidStmt: Statement
  selectLiveCharMinutesForScopeStmt: Statement
  selectLiveMatrixMinutesForScopeStmt: Statement
  selectLiveMinuteStatsForScopeStmt: Statement
  selectLiveSessionsForScopeStmt: Statement
  tombstoneCharMinutesInRangeStmt: Statement
  tombstoneMatrixMinutesInRangeStmt: Statement
  tombstoneMinuteStatsInRangeStmt: Statement
  tombstoneSessionsInRangeStmt: Statement
  tombstoneCharMinutesForHashInRangeStmt: Statement
  tombstoneMatrixMinutesForHashInRangeStmt: Statement
  tombstoneMinuteStatsForHashInRangeStmt: Statement
  tombstoneSessionsForHashInRangeStmt: Statement
  tombstoneAllCharMinutesStmt: Statement
  tombstoneAllMatrixMinutesStmt: Statement
  tombstoneAllMinuteStatsStmt: Statement
  tombstoneAllSessionsStmt: Statement
}

export function prepareSyncStatements(db: DatabaseType): SyncStatements {
  return {
    // Sync export selects. Live rows within the live window or tombstones
    // within the longer tombstone window. typing_scopes is selected without
    // a time filter so every scope a remote might reference still resolves
    // its FK parent on the receiving side.
    selectScopesForUidStmt: db.prepare(`
      SELECT id, machine_hash AS machineHash,
             os_platform AS osPlatform, os_release AS osRelease, os_arch AS osArch,
             keyboard_uid AS keyboardUid,
             keyboard_vendor_id AS keyboardVendorId,
             keyboard_product_id AS keyboardProductId,
             keyboard_product_name AS keyboardProductName,
             updated_at AS updatedAt,
             is_deleted AS isDeleted
        FROM typing_scopes
       WHERE keyboard_uid = @uid
         AND (is_deleted = 0 OR updated_at >= @tombstoneSinceMs)
    `),

    selectCharMinutesForUidStmt: db.prepare(`
      SELECT c.scope_id AS scopeId, c.minute_ts AS minuteTs, c.char AS char,
             c.count AS count, c.updated_at AS updatedAt, c.is_deleted AS isDeleted
        FROM typing_char_minute c
        JOIN typing_scopes s ON s.id = c.scope_id
       WHERE s.keyboard_uid = @uid
         AND (
           (c.is_deleted = 0 AND c.minute_ts >= @liveSinceMinuteMs)
           OR
           (c.is_deleted = 1 AND c.updated_at >= @tombstoneSinceMs)
         )
    `),

    // dur_hist/dur_sum/dur_sumsq (v8) are included even though this export
    // path has no live caller today (see exportMatrixMinutesForUid) —
    // omitting them here would mean a future revival of sync export
    // silently drops every cell's duration data on the wholesale LWW
    // replace at the receiving end, and every field involved being
    // optional means no compile error would ever flag the gap.
    selectMatrixMinutesForUidStmt: db.prepare(`
      SELECT m.scope_id AS scopeId, m.minute_ts AS minuteTs,
             m.row AS row, m.col AS col, m.layer AS layer,
             m.keycode AS keycode, m.count AS count,
             m.tap_count AS tapCount, m.hold_count AS holdCount,
             m.dur_hist AS dh, m.dur_sum AS ds, m.dur_sumsq AS dq,
             m.updated_at AS updatedAt, m.is_deleted AS isDeleted
        FROM typing_matrix_minute m
        JOIN typing_scopes s ON s.id = m.scope_id
       WHERE s.keyboard_uid = @uid
         AND (
           (m.is_deleted = 0 AND m.minute_ts >= @liveSinceMinuteMs)
           OR
           (m.is_deleted = 1 AND m.updated_at >= @tombstoneSinceMs)
         )
    `),

    // poll_p50_ms/poll_p95_ms (v8) — same "no live caller yet, but must
    // not silently vanish if this export path is revived" reasoning as
    // dur_hist/dur_sum/dur_sumsq above.
    selectMinuteStatsForUidStmt: db.prepare(`
      SELECT t.scope_id AS scopeId, t.minute_ts AS minuteTs,
             t.keystrokes AS keystrokes, t.active_ms AS activeMs,
             t.interval_avg_ms AS intervalAvgMs,
             t.interval_min_ms AS intervalMinMs,
             t.interval_p25_ms AS intervalP25Ms,
             t.interval_p50_ms AS intervalP50Ms,
             t.interval_p75_ms AS intervalP75Ms,
             t.interval_max_ms AS intervalMaxMs,
             t.poll_p50_ms AS pollP50Ms, t.poll_p95_ms AS pollP95Ms,
             t.updated_at AS updatedAt, t.is_deleted AS isDeleted
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND (
           (t.is_deleted = 0 AND t.minute_ts >= @liveSinceMinuteMs)
           OR
           (t.is_deleted = 1 AND t.updated_at >= @tombstoneSinceMs)
         )
    `),

    selectSessionsForUidStmt: db.prepare(`
      SELECT x.id AS id, x.scope_id AS scopeId,
             x.start_ms AS startMs, x.end_ms AS endMs,
             x.updated_at AS updatedAt, x.is_deleted AS isDeleted
        FROM typing_sessions x
        JOIN typing_scopes s ON s.id = x.scope_id
       WHERE s.keyboard_uid = @uid
         AND (
           (x.is_deleted = 0 AND x.start_ms >= @liveSinceStartMs)
           OR
           (x.is_deleted = 1 AND x.updated_at >= @tombstoneSinceMs)
         )
    `),

    selectLocalKeyboardUidsStmt: db.prepare(`
      SELECT DISTINCT keyboard_uid AS keyboardUid
        FROM typing_scopes
       WHERE machine_hash = @machineHash
         AND is_deleted = 0
    `),
    // Remote devices (machine_hash != @ownHash) that currently hold at
    // least one live minute-stats row for this keyboard. The OS info
    // travels alongside the hash so the Analyze > Device filter can
    // render a "{platform} - {release} ({hash})" label without an
    // extra round-trip per entry. `canonicalScopeKey` includes os.release
    // in the scope id, so an OS upgrade splits a single physical machine
    // into multiple scope rows. We pick the most recently updated scope
    // per machine_hash so the dropdown shows exactly one entry per device
    // with the latest release label. Ties on updated_at fall back to scope
    // id ascending so the result is deterministic.
    selectRemoteHashesForUidStmt: db.prepare(`
      WITH ranked AS (
        SELECT s.machine_hash AS machineHash,
               s.os_platform AS osPlatform,
               s.os_release AS osRelease,
               ROW_NUMBER() OVER (
                 PARTITION BY s.machine_hash
                 ORDER BY s.updated_at DESC, s.id ASC
               ) AS rn
          FROM typing_scopes s
         WHERE s.keyboard_uid = @uid
           AND s.machine_hash != @ownHash
           AND s.is_deleted = 0
           AND EXISTS (
             SELECT 1 FROM typing_minute_stats t
              WHERE t.scope_id = s.id AND t.is_deleted = 0
           )
      )
      SELECT machineHash, osPlatform, osRelease
        FROM ranked
       WHERE rn = 1
       ORDER BY machineHash
    `),

    // Row-listing queries scoped to a single scope_id — used by the
    // delete APIs to build tombstone JSONL rows for our own machine's
    // scope only. The range window is half-open `[startMs, endMs)` for
    // minute rows and overlap (`end_ms > startMs AND start_ms < endMs`)
    // for sessions that can span day boundaries.
    selectOwnScopeIdsForUidStmt: db.prepare(`
      SELECT id FROM typing_scopes
       WHERE machine_hash = @machineHash
         AND keyboard_uid = @uid
         AND is_deleted = 0
    `),

    selectLiveCharMinutesForScopeStmt: db.prepare(`
      SELECT scope_id AS scopeId, minute_ts AS minuteTs, char, count
        FROM typing_char_minute
       WHERE scope_id = @scopeId
         AND minute_ts >= @startMs
         AND minute_ts < @endMs
         AND is_deleted = 0
    `),

    selectLiveMatrixMinutesForScopeStmt: db.prepare(`
      SELECT scope_id AS scopeId, minute_ts AS minuteTs,
             row, col, layer, keycode, count,
             tap_count AS tapCount, hold_count AS holdCount
        FROM typing_matrix_minute
       WHERE scope_id = @scopeId
         AND minute_ts >= @startMs
         AND minute_ts < @endMs
         AND is_deleted = 0
    `),

    selectLiveMinuteStatsForScopeStmt: db.prepare(`
      SELECT scope_id AS scopeId, minute_ts AS minuteTs,
             keystrokes, active_ms AS activeMs,
             interval_avg_ms AS intervalAvgMs,
             interval_min_ms AS intervalMinMs,
             interval_p25_ms AS intervalP25Ms,
             interval_p50_ms AS intervalP50Ms,
             interval_p75_ms AS intervalP75Ms,
             interval_max_ms AS intervalMaxMs
        FROM typing_minute_stats
       WHERE scope_id = @scopeId
         AND minute_ts >= @startMs
         AND minute_ts < @endMs
         AND is_deleted = 0
    `),

    selectLiveSessionsForScopeStmt: db.prepare(`
      SELECT id, scope_id AS scopeId, start_ms AS startMs, end_ms AS endMs
        FROM typing_sessions
       WHERE scope_id = @scopeId
         AND end_ms > @startMs
         AND start_ms < @endMs
         AND is_deleted = 0
    `),

    // Tombstone range deletes. Only flips live rows (is_deleted = 0) so
    // existing tombstones keep their original updated_at for GC purposes.
    // Bigram/trigram range/all-tombstone statements live in
    // this.stmts.ngram[gram] — see ngram-statements.ts.
    tombstoneCharMinutesInRangeStmt: db.prepare(`
      UPDATE typing_char_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_RANGE_WHERE}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `),
    tombstoneMatrixMinutesInRangeStmt: db.prepare(`
      UPDATE typing_matrix_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_RANGE_WHERE}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `),
    tombstoneMinuteStatsInRangeStmt: db.prepare(`
      UPDATE typing_minute_stats
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_RANGE_WHERE}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `),
    // Sessions use overlap semantics instead of start_ms-containment so a
    // session that spans midnight (start before the window, end inside)
    // still gets tombstoned when the user deletes that day. Matches the
    // per-minute rows that contribute to the same day bucket.
    tombstoneSessionsInRangeStmt: db.prepare(`
      UPDATE typing_sessions
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_RANGE_WHERE}
         AND end_ms > @startMs AND start_ms < @endMs
    `),

    // Hash-scoped range variants — Sync-delete of another device's day
    // removes only that device's rows while keeping same-day contributions
    // from other hashes intact.
    tombstoneCharMinutesForHashInRangeStmt: db.prepare(`
      UPDATE typing_char_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_HASH_RANGE_WHERE}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `),
    tombstoneMatrixMinutesForHashInRangeStmt: db.prepare(`
      UPDATE typing_matrix_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_HASH_RANGE_WHERE}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `),
    tombstoneMinuteStatsForHashInRangeStmt: db.prepare(`
      UPDATE typing_minute_stats
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_HASH_RANGE_WHERE}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `),
    tombstoneSessionsForHashInRangeStmt: db.prepare(`
      UPDATE typing_sessions
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_HASH_RANGE_WHERE}
         AND end_ms > @startMs AND start_ms < @endMs
    `),

    tombstoneAllCharMinutesStmt: db.prepare(`
      UPDATE typing_char_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_RANGE_WHERE}
    `),
    tombstoneAllMatrixMinutesStmt: db.prepare(`
      UPDATE typing_matrix_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_RANGE_WHERE}
    `),
    tombstoneAllMinuteStatsStmt: db.prepare(`
      UPDATE typing_minute_stats
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_RANGE_WHERE}
    `),
    tombstoneAllSessionsStmt: db.prepare(`
      UPDATE typing_sessions
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_RANGE_WHERE}
    `),
  }
}
