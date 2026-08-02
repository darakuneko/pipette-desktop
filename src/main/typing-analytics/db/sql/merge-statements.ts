// SPDX-License-Identifier: GPL-2.0-or-later
// Authoritative LWW (last-write-wins) merge statements used by sync
// import. Unlike the additive ingest-statements.ts upserts, these replace
// the target row wholesale, respect the incoming is_deleted flag, and
// only fire when excluded.updated_at is strictly newer than the existing
// row. Bigram/trigram merge lives in ngram-statements.ts.

import type { Database as DatabaseType, Statement } from 'better-sqlite3'

export interface MergeStatements {
  mergeScopeStmt: Statement
  mergeCharMinuteStmt: Statement
  mergeMatrixMinuteStmt: Statement
  mergeMinuteStatsStmt: Statement
  mergeSessionStmt: Statement
}

export function prepareMergeStatements(db: DatabaseType): MergeStatements {
  return {
    // Authoritative LWW upserts for sync merge. Unlike the additive
    // ingestion upserts above, these replace the target row wholesale,
    // respect the incoming is_deleted flag, and only fire when
    // excluded.updated_at is strictly newer than the existing row.
    mergeScopeStmt: db.prepare(`
      INSERT INTO typing_scopes (
        id, machine_hash, os_platform, os_release, os_arch,
        keyboard_uid, keyboard_vendor_id, keyboard_product_id, keyboard_product_name,
        updated_at, is_deleted
      ) VALUES (
        @id, @machineHash, @osPlatform, @osRelease, @osArch,
        @keyboardUid, @keyboardVendorId, @keyboardProductId, @keyboardProductName,
        @updatedAt, @isDeleted
      )
      ON CONFLICT(id) DO UPDATE SET
        machine_hash = excluded.machine_hash,
        os_platform = excluded.os_platform,
        os_release = excluded.os_release,
        os_arch = excluded.os_arch,
        keyboard_uid = excluded.keyboard_uid,
        keyboard_vendor_id = excluded.keyboard_vendor_id,
        keyboard_product_id = excluded.keyboard_product_id,
        keyboard_product_name = excluded.keyboard_product_name,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_scopes.updated_at
    `),

    // Merge variants pass-through app_name from the LWW winner. Older
    // remote payloads predate app_name and arrive without it; the
    // import layer normalizes missing fields to null so the bind
    // parameter is always defined.
    mergeCharMinuteStmt: db.prepare(`
      INSERT INTO typing_char_minute (
        scope_id, minute_ts, char, count, app_name, typing_test, run_id, updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @char, @count, @appName, @typingTest, @runId, @updatedAt, @isDeleted
      )
      ON CONFLICT(scope_id, minute_ts, run_id, char) DO UPDATE SET
        count = excluded.count,
        app_name = excluded.app_name,
        typing_test = excluded.typing_test,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_char_minute.updated_at
    `),

    mergeMatrixMinuteStmt: db.prepare(`
      INSERT INTO typing_matrix_minute (
        scope_id, minute_ts, row, col, layer, keycode, count,
        tap_count, hold_count,
        dur_hist, dur_sum, dur_sumsq,
        app_name, typing_test, run_id,
        updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @row, @col, @layer, @keycode, @count,
        @tapCount, @holdCount,
        @durHist, @durSum, @durSumSq,
        @appName, @typingTest, @runId,
        @updatedAt, @isDeleted
      )
      ON CONFLICT(scope_id, minute_ts, run_id, row, col, layer) DO UPDATE SET
        keycode = excluded.keycode,
        count = excluded.count,
        tap_count = excluded.tap_count,
        hold_count = excluded.hold_count,
        dur_hist = excluded.dur_hist,
        dur_sum = excluded.dur_sum,
        dur_sumsq = excluded.dur_sumsq,
        app_name = excluded.app_name,
        typing_test = excluded.typing_test,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_matrix_minute.updated_at
    `),

    mergeMinuteStatsStmt: db.prepare(`
      INSERT INTO typing_minute_stats (
        scope_id, minute_ts, keystrokes, active_ms,
        interval_avg_ms, interval_min_ms,
        interval_p25_ms, interval_p50_ms, interval_p75_ms, interval_max_ms,
        poll_p50_ms, poll_p95_ms,
        app_name, typing_test, run_id,
        updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @keystrokes, @activeMs,
        @intervalAvgMs, @intervalMinMs,
        @intervalP25Ms, @intervalP50Ms, @intervalP75Ms, @intervalMaxMs,
        @pollP50Ms, @pollP95Ms,
        @appName, @typingTest, @runId,
        @updatedAt, @isDeleted
      )
      ON CONFLICT(scope_id, minute_ts, run_id) DO UPDATE SET
        keystrokes = excluded.keystrokes,
        active_ms = excluded.active_ms,
        interval_avg_ms = excluded.interval_avg_ms,
        interval_min_ms = excluded.interval_min_ms,
        interval_p25_ms = excluded.interval_p25_ms,
        interval_p50_ms = excluded.interval_p50_ms,
        interval_p75_ms = excluded.interval_p75_ms,
        interval_max_ms = excluded.interval_max_ms,
        poll_p50_ms = excluded.poll_p50_ms,
        poll_p95_ms = excluded.poll_p95_ms,
        app_name = excluded.app_name,
        typing_test = excluded.typing_test,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_minute_stats.updated_at
    `),

    mergeSessionStmt: db.prepare(`
      INSERT INTO typing_sessions (
        id, scope_id, start_ms, end_ms, updated_at, is_deleted
      )
      VALUES (
        @id, @scopeId, @startMs, @endMs, @updatedAt, @isDeleted
      )
      ON CONFLICT(id) DO UPDATE SET
        scope_id = excluded.scope_id,
        start_ms = excluded.start_ms,
        end_ms = excluded.end_ms,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_sessions.updated_at
    `),

  }
}
