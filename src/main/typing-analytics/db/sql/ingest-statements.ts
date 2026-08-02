// SPDX-License-Identifier: GPL-2.0-or-later
// Ingest-path prepared statements: the additive per-minute upserts used by
// live capture, plus the local-retention deletes. Bigram/trigram ingest
// (also additive) lives in its own ngram-statements.ts module and is
// assembled as a sibling `ngram` group rather than folded in here — see
// typing-analytics-db-base.ts's constructor.

import type { Database as DatabaseType, Statement } from 'better-sqlite3'

export interface IngestStatements {
  upsertScopeStmt: Statement
  upsertCharMinuteStmt: Statement
  upsertMatrixMinuteStmt: Statement
  upsertMinuteStatsStmt: Statement
  insertSessionStmt: Statement
  deleteCharMinuteBeforeStmt: Statement
  deleteMatrixMinuteBeforeStmt: Statement
  deleteMinuteStatsBeforeStmt: Statement
  deleteSessionsBeforeStmt: Statement
}

export function prepareIngestStatements(db: DatabaseType): IngestStatements {
  return {
    upsertScopeStmt: db.prepare(`
      INSERT INTO typing_scopes (
        id, machine_hash, os_platform, os_release, os_arch,
        keyboard_uid, keyboard_vendor_id, keyboard_product_id, keyboard_product_name,
        updated_at, is_deleted
      ) VALUES (
        @id, @machineHash, @osPlatform, @osRelease, @osArch,
        @keyboardUid, @keyboardVendorId, @keyboardProductId, @keyboardProductName,
        @updatedAt, 0
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
        is_deleted = 0
      WHERE excluded.updated_at > typing_scopes.updated_at
    `),

    // app_name on conflict: keep the existing value when the same app
    // is observed twice in a flush; collapse to NULL the moment a
    // different app shows up so app-filtered queries see the minute
    // as mixed. This matches the aggregator's "size>1 set => null"
    // payload contract on the read side.
    upsertCharMinuteStmt: db.prepare(`
      INSERT INTO typing_char_minute (scope_id, minute_ts, char, count, app_name, typing_test, run_id, updated_at, is_deleted)
      VALUES (@scopeId, @minuteTs, @char, @count, @appName, @typingTest, @runId, @updatedAt, 0)
      ON CONFLICT(scope_id, minute_ts, run_id, char) DO UPDATE SET
        count = typing_char_minute.count + excluded.count,
        app_name = CASE
          WHEN typing_char_minute.app_name IS excluded.app_name THEN typing_char_minute.app_name
          ELSE NULL
        END,
        typing_test = CASE
          WHEN typing_char_minute.typing_test IS excluded.typing_test THEN typing_char_minute.typing_test
          ELSE NULL
        END,
        updated_at = excluded.updated_at,
        is_deleted = 0
    `),

    upsertMatrixMinuteStmt: db.prepare(`
      INSERT INTO typing_matrix_minute (
        scope_id, minute_ts, row, col, layer, keycode, count,
        tap_count, hold_count,
        app_name, typing_test, run_id,
        updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @row, @col, @layer, @keycode, @count,
        @tapCount, @holdCount,
        @appName, @typingTest, @runId,
        @updatedAt, 0
      )
      ON CONFLICT(scope_id, minute_ts, run_id, row, col, layer) DO UPDATE SET
        count = typing_matrix_minute.count + excluded.count,
        tap_count = typing_matrix_minute.tap_count + excluded.tap_count,
        hold_count = typing_matrix_minute.hold_count + excluded.hold_count,
        keycode = excluded.keycode,
        app_name = CASE
          WHEN typing_matrix_minute.app_name IS excluded.app_name THEN typing_matrix_minute.app_name
          ELSE NULL
        END,
        typing_test = CASE
          WHEN typing_matrix_minute.typing_test IS excluded.typing_test THEN typing_matrix_minute.typing_test
          ELSE NULL
        END,
        updated_at = excluded.updated_at,
        is_deleted = 0
    `),

    upsertMinuteStatsStmt: db.prepare(`
      INSERT INTO typing_minute_stats (
        scope_id, minute_ts, keystrokes, active_ms,
        interval_avg_ms, interval_min_ms,
        interval_p25_ms, interval_p50_ms, interval_p75_ms, interval_max_ms,
        app_name, typing_test, run_id,
        updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @keystrokes, @activeMs,
        @intervalAvgMs, @intervalMinMs,
        @intervalP25Ms, @intervalP50Ms, @intervalP75Ms, @intervalMaxMs,
        @appName, @typingTest, @runId,
        @updatedAt, 0
      )
      ON CONFLICT(scope_id, minute_ts, run_id) DO UPDATE SET
        keystrokes = typing_minute_stats.keystrokes + excluded.keystrokes,
        active_ms = typing_minute_stats.active_ms + excluded.active_ms,
        interval_avg_ms = excluded.interval_avg_ms,
        interval_min_ms = MIN(typing_minute_stats.interval_min_ms, excluded.interval_min_ms),
        interval_p25_ms = excluded.interval_p25_ms,
        interval_p50_ms = excluded.interval_p50_ms,
        interval_p75_ms = excluded.interval_p75_ms,
        interval_max_ms = MAX(typing_minute_stats.interval_max_ms, excluded.interval_max_ms),
        app_name = CASE
          WHEN typing_minute_stats.app_name IS excluded.app_name THEN typing_minute_stats.app_name
          ELSE NULL
        END,
        typing_test = CASE
          WHEN typing_minute_stats.typing_test IS excluded.typing_test THEN typing_minute_stats.typing_test
          ELSE NULL
        END,
        updated_at = excluded.updated_at,
        is_deleted = 0
    `),

    insertSessionStmt: db.prepare(`
      INSERT INTO typing_sessions (id, scope_id, start_ms, end_ms, updated_at, is_deleted)
      VALUES (@id, @scopeId, @startMs, @endMs, @updatedAt, 0)
      ON CONFLICT(id) DO UPDATE SET
        start_ms = excluded.start_ms,
        end_ms = excluded.end_ms,
        updated_at = excluded.updated_at,
        is_deleted = 0
      WHERE excluded.updated_at > typing_sessions.updated_at
    `),

    deleteCharMinuteBeforeStmt: db.prepare(`
      DELETE FROM typing_char_minute
       WHERE scope_id IN (SELECT id FROM typing_scopes WHERE machine_hash = @machineHash)
         AND minute_ts < @cutoffMs
    `),

    deleteMatrixMinuteBeforeStmt: db.prepare(`
      DELETE FROM typing_matrix_minute
       WHERE scope_id IN (SELECT id FROM typing_scopes WHERE machine_hash = @machineHash)
         AND minute_ts < @cutoffMs
    `),

    deleteMinuteStatsBeforeStmt: db.prepare(`
      DELETE FROM typing_minute_stats
       WHERE scope_id IN (SELECT id FROM typing_scopes WHERE machine_hash = @machineHash)
         AND minute_ts < @cutoffMs
    `),

    deleteSessionsBeforeStmt: db.prepare(`
      DELETE FROM typing_sessions
       WHERE scope_id IN (SELECT id FROM typing_scopes WHERE machine_hash = @machineHash)
         AND end_ms < @cutoffMs
    `),

  }
}
