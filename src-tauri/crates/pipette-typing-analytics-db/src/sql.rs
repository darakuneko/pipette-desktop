// SPDX-License-Identifier: GPL-2.0-or-later
//! SQL text of every statement this crate runs, character for character the
//! same as the TypeScript DB layer (src/main/typing-analytics/db/). The
//! fixture test `sql_text_matches_typescript` compares each constant with
//! the string the TypeScript code prepares, so an edit on one side fails
//! until the other side follows.

/// The meta table and connection PRAGMAs (`CREATE_META_SQL`, schema.ts). Runs before any migration.
pub const CREATE_META: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS typing_analytics_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#;

/// Every data table and index (`CREATE_SCHEMA_SQL`, schema.ts). Runs after the migrations.
pub const CREATE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS typing_scopes (
  id TEXT PRIMARY KEY,
  machine_hash TEXT NOT NULL,
  os_platform TEXT NOT NULL,
  os_release TEXT NOT NULL,
  os_arch TEXT NOT NULL,
  keyboard_uid TEXT NOT NULL,
  keyboard_vendor_id INTEGER NOT NULL,
  keyboard_product_id INTEGER NOT NULL,
  keyboard_product_name TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scopes_keyboard_uid ON typing_scopes(keyboard_uid);

CREATE TABLE IF NOT EXISTS typing_char_minute (
  scope_id TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  char TEXT NOT NULL,
  count INTEGER NOT NULL,
  -- Active application captured at flush time. NULL for rows that
  -- predate Monitor App, for minutes that observed multiple apps, and
  -- when the lookup failed. App-filtered analytics queries compare
  -- against this column directly.
  app_name TEXT,
  -- Typing test label captured per-event. NULL for ordinary REC input and
  -- for minutes that mixed multiple tests. TypingTest-filtered analytics
  -- queries compare against this column directly (see app_name).
  typing_test TEXT,
  -- Individual test run id, part of the primary key so two runs sharing a
  -- minute stay distinct rows (exact per-run filtering). '' for non-test
  -- (REC) input and rows that predate run tagging.
  run_id TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, minute_ts, run_id, char),
  FOREIGN KEY (scope_id) REFERENCES typing_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_char_minute_ts ON typing_char_minute(minute_ts);
CREATE INDEX IF NOT EXISTS idx_char_minute_scope_app_ts
  ON typing_char_minute(scope_id, app_name, minute_ts);
CREATE INDEX IF NOT EXISTS idx_char_minute_scope_test_ts
  ON typing_char_minute(scope_id, typing_test, minute_ts);
CREATE INDEX IF NOT EXISTS idx_char_minute_scope_run_ts
  ON typing_char_minute(scope_id, run_id, minute_ts);

CREATE TABLE IF NOT EXISTS typing_matrix_minute (
  scope_id TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  row INTEGER NOT NULL,
  col INTEGER NOT NULL,
  layer INTEGER NOT NULL,
  keycode INTEGER NOT NULL,
  count INTEGER NOT NULL,
  -- Portion of count that resolved as a tap vs hold on the release
  -- edge, for LT / MT style tap-hold keys. Non-tap-hold keys leave
  -- both at 0 and the heatmap falls back to the total count column.
  tap_count INTEGER NOT NULL DEFAULT 0,
  hold_count INTEGER NOT NULL DEFAULT 0,
  -- Keypress-duration histogram / sum / sum-of-squares from
  -- matrix-release events landing in this minute (see
  -- bigram-bucket.ts's duration grid -- deliberately tighter than the
  -- IKI grid). All three NULL for rows written before schema v8, or for
  -- a minute that had presses but no matching release yet.
  dur_hist BLOB,
  dur_sum REAL,
  dur_sumsq REAL,
  -- See typing_char_minute.app_name comment.
  app_name TEXT,
  -- See typing_char_minute.typing_test comment.
  typing_test TEXT,
  -- See typing_char_minute.run_id comment.
  run_id TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, minute_ts, run_id, row, col, layer),
  FOREIGN KEY (scope_id) REFERENCES typing_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_matrix_minute_ts ON typing_matrix_minute(minute_ts);
CREATE INDEX IF NOT EXISTS idx_matrix_minute_scope_test_ts
  ON typing_matrix_minute(scope_id, typing_test, minute_ts);
CREATE INDEX IF NOT EXISTS idx_matrix_minute_scope_run_ts
  ON typing_matrix_minute(scope_id, run_id, minute_ts);
-- Supports the typing-view heatmap (scope_id + layer + minute_ts range scan
-- polled every few seconds). Without it the heatmap query falls back to the
-- minute_ts-only index and re-filters every scope/layer row in memory.
CREATE INDEX IF NOT EXISTS idx_matrix_minute_scope_layer_ts ON typing_matrix_minute(scope_id, layer, minute_ts);
CREATE INDEX IF NOT EXISTS idx_matrix_minute_scope_app_ts
  ON typing_matrix_minute(scope_id, app_name, minute_ts);

CREATE TABLE IF NOT EXISTS typing_minute_stats (
  scope_id TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  keystrokes INTEGER NOT NULL,
  active_ms INTEGER NOT NULL,
  interval_avg_ms INTEGER,
  interval_min_ms INTEGER,
  interval_p25_ms INTEGER,
  interval_p50_ms INTEGER,
  interval_p75_ms INTEGER,
  interval_max_ms INTEGER,
  -- See typing_char_minute.app_name comment.
  app_name TEXT,
  -- See typing_char_minute.typing_test comment.
  typing_test TEXT,
  -- See typing_char_minute.run_id comment.
  run_id TEXT NOT NULL DEFAULT '',
  -- Median / p95 sampling gap (ms) between polled matrix frames this
  -- minute (see matrix-press-duration.ts's pollGapMs). NULL for rows
  -- written before schema v8, or a minute with no sample.
  poll_p50_ms REAL,
  poll_p95_ms REAL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, minute_ts, run_id),
  FOREIGN KEY (scope_id) REFERENCES typing_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_minute_stats_scope_app_ts
  ON typing_minute_stats(scope_id, app_name, minute_ts);
CREATE INDEX IF NOT EXISTS idx_minute_stats_scope_test_ts
  ON typing_minute_stats(scope_id, typing_test, minute_ts);
CREATE INDEX IF NOT EXISTS idx_minute_stats_scope_run_ts
  ON typing_minute_stats(scope_id, run_id, minute_ts);

CREATE TABLE IF NOT EXISTS typing_bigram_minute (
  scope_id TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  -- Pair key in the form "${prevKeycode}_${currKeycode}". Numeric keycodes
  -- joined by underscore, kept as TEXT so the existing JSONL row format
  -- maps 1:1 without a packing step.
  bigram_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  -- 8-bucket IKI histogram packed as little-endian u32 (32 bytes). Buckets
  -- are log-scale; count is the sum across
  -- buckets and is denormalized for fast top-N ranking.
  hist BLOB NOT NULL,
  -- Sum / sum-of-squares of the raw IKI values (ms) that fed the hist
  -- column, for a true standard deviation instead of a histogram bucket
  -- approximation.
  -- NULL for rows written before this field existed — a range that mixes
  -- such rows with sum-bearing ones reports SD as null rather than an
  -- approximation.
  sum_iki REAL,
  sumsq_iki REAL,
  -- Physical-overlap accumulators (see OverlapCounts in minute-buffer.ts).
  -- overlap_n counts pairs whose incoming press had a KNOWN overlap
  -- determination; overlap_count is the subset where it was true.
  -- Both NULL for rows written before schema v8, or a pair whose every
  -- contributing event had an undetermined overlap -- never treat NULL
  -- as 0 here, the same null-poisons-aggregation rule as sum_iki above.
  overlap_count INTEGER,
  overlap_n INTEGER,
  -- See typing_char_minute.app_name comment.
  app_name TEXT,
  -- See typing_char_minute.typing_test comment.
  typing_test TEXT,
  -- See typing_char_minute.run_id comment.
  run_id TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, minute_ts, run_id, bigram_id),
  FOREIGN KEY (scope_id) REFERENCES typing_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_bigram_minute_scope_minute
  ON typing_bigram_minute(scope_id, minute_ts);
CREATE INDEX IF NOT EXISTS idx_bigram_minute_scope_app_ts
  ON typing_bigram_minute(scope_id, app_name, minute_ts);
CREATE INDEX IF NOT EXISTS idx_bigram_minute_scope_test_ts
  ON typing_bigram_minute(scope_id, typing_test, minute_ts);
CREATE INDEX IF NOT EXISTS idx_bigram_minute_scope_run_ts
  ON typing_bigram_minute(scope_id, run_id, minute_ts);

CREATE TABLE IF NOT EXISTS typing_trigram_minute (
  scope_id TEXT NOT NULL,
  minute_ts INTEGER NOT NULL,
  -- Triple key in the form "${k1}_${k2}_${k3}". See
  -- typing_bigram_minute.bigram_id comment.
  trigram_id TEXT NOT NULL,
  count INTEGER NOT NULL,
  -- See typing_bigram_minute.hist comment.
  hist BLOB NOT NULL,
  -- See typing_bigram_minute.sum_iki / sumsq_iki comment.
  sum_iki REAL,
  sumsq_iki REAL,
  -- See typing_char_minute.app_name comment.
  app_name TEXT,
  -- See typing_char_minute.typing_test comment.
  typing_test TEXT,
  -- See typing_char_minute.run_id comment.
  run_id TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, minute_ts, run_id, trigram_id),
  FOREIGN KEY (scope_id) REFERENCES typing_scopes(id)
);
-- No (scope_id, minute_ts) index here: it would be a strict prefix of
-- the PRIMARY KEY (scope_id, minute_ts, run_id, trigram_id) above and
-- SQLite can already use that for range scans. typing_bigram_minute
-- carries the equivalent index (idx_bigram_minute_scope_minute) because
-- it predates this table and is left untouched rather than risking an
-- unrelated migration.
CREATE INDEX IF NOT EXISTS idx_trigram_minute_scope_app_ts
  ON typing_trigram_minute(scope_id, app_name, minute_ts);
CREATE INDEX IF NOT EXISTS idx_trigram_minute_scope_test_ts
  ON typing_trigram_minute(scope_id, typing_test, minute_ts);
CREATE INDEX IF NOT EXISTS idx_trigram_minute_scope_run_ts
  ON typing_trigram_minute(scope_id, run_id, minute_ts);

CREATE TABLE IF NOT EXISTS typing_sessions (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (scope_id) REFERENCES typing_scopes(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_scope_start ON typing_sessions(scope_id, start_ms);
"#;

/// LWW upsert of a scope (`mergeScopeStmt`, merge-statements.ts).
pub const MERGE_SCOPE: &str = r#"
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
    "#;

/// LWW upsert of a char-minute row (`mergeCharMinuteStmt`, merge-statements.ts).
pub const MERGE_CHAR_MINUTE: &str = r#"
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
    "#;

/// LWW upsert of a matrix-minute row (`mergeMatrixMinuteStmt`, merge-statements.ts).
pub const MERGE_MATRIX_MINUTE: &str = r#"
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
    "#;

/// LWW upsert of a minute-stats row (`mergeMinuteStatsStmt`, merge-statements.ts).
pub const MERGE_MINUTE_STATS: &str = r#"
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
    "#;

/// LWW upsert of a session (`mergeSessionStmt`, merge-statements.ts).
pub const MERGE_SESSION: &str = r#"
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
    "#;

/// LWW upsert of one bigram of a bigram-minute row (`merge` of `prepareNgramStatements` for typing_bigram_minute, ngram-statements.ts).
pub const MERGE_BIGRAM_MINUTE: &str = r#"
      INSERT INTO typing_bigram_minute (
        scope_id, minute_ts, bigram_id, count, hist, sum_iki, sumsq_iki, overlap_count, overlap_n, app_name, typing_test, run_id, updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @ngramId, @count, @hist, @sumIki, @sumSqIki, @overlapCount, @overlapN, @appName, @typingTest, @runId, @updatedAt, @isDeleted
      )
      ON CONFLICT(scope_id, minute_ts, run_id, bigram_id) DO UPDATE SET
        count = excluded.count,
        hist = excluded.hist,
        sum_iki = excluded.sum_iki,
        sumsq_iki = excluded.sumsq_iki,
        overlap_count = excluded.overlap_count,
        overlap_n = excluded.overlap_n,
        app_name = excluded.app_name,
        typing_test = excluded.typing_test,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_bigram_minute.updated_at
    "#;

/// LWW upsert of one trigram of a trigram-minute row (`merge` of `prepareNgramStatements` for typing_trigram_minute, ngram-statements.ts).
pub const MERGE_TRIGRAM_MINUTE: &str = r#"
      INSERT INTO typing_trigram_minute (
        scope_id, minute_ts, trigram_id, count, hist, sum_iki, sumsq_iki, app_name, typing_test, run_id, updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @ngramId, @count, @hist, @sumIki, @sumSqIki, @appName, @typingTest, @runId, @updatedAt, @isDeleted
      )
      ON CONFLICT(scope_id, minute_ts, run_id, trigram_id) DO UPDATE SET
        count = excluded.count,
        hist = excluded.hist,
        sum_iki = excluded.sum_iki,
        sumsq_iki = excluded.sumsq_iki,
        app_name = excluded.app_name,
        typing_test = excluded.typing_test,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > typing_trigram_minute.updated_at
    "#;

/// Tombstones one machine hash's char-minute rows in a deleted range (sync-statements.ts).
pub const TOMBSTONE_CHAR_MINUTES_FOR_HASH_IN_RANGE: &str = r#"
      UPDATE typing_char_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE 
  scope_id IN (
    SELECT id FROM typing_scopes
     WHERE keyboard_uid = @uid AND machine_hash = @machineHash
  )
    AND is_deleted = 0

         AND minute_ts >= @startMs AND minute_ts < @endMs AND minute_ts <= @cutoffMs
    "#;

/// Tombstones one machine hash's matrix-minute rows in a deleted range (sync-statements.ts).
pub const TOMBSTONE_MATRIX_MINUTES_FOR_HASH_IN_RANGE: &str = r#"
      UPDATE typing_matrix_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE 
  scope_id IN (
    SELECT id FROM typing_scopes
     WHERE keyboard_uid = @uid AND machine_hash = @machineHash
  )
    AND is_deleted = 0

         AND minute_ts >= @startMs AND minute_ts < @endMs AND minute_ts <= @cutoffMs
    "#;

/// Tombstones one machine hash's minute-stats rows in a deleted range (sync-statements.ts).
pub const TOMBSTONE_MINUTE_STATS_FOR_HASH_IN_RANGE: &str = r#"
      UPDATE typing_minute_stats
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE 
  scope_id IN (
    SELECT id FROM typing_scopes
     WHERE keyboard_uid = @uid AND machine_hash = @machineHash
  )
    AND is_deleted = 0

         AND minute_ts >= @startMs AND minute_ts < @endMs AND minute_ts <= @cutoffMs
    "#;

/// Tombstones one machine hash's bigram rows in a deleted range (`tombstoneForHashInRange`, ngram-statements.ts).
pub const TOMBSTONE_BIGRAM_MINUTES_FOR_HASH_IN_RANGE: &str = r#"
      UPDATE typing_bigram_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE 
  scope_id IN (
    SELECT id FROM typing_scopes
     WHERE keyboard_uid = @uid AND machine_hash = @machineHash
  )
    AND is_deleted = 0

         AND minute_ts >= @startMs AND minute_ts < @endMs AND minute_ts <= @cutoffMs
    "#;

/// Tombstones one machine hash's trigram rows in a deleted range (`tombstoneForHashInRange`, ngram-statements.ts).
pub const TOMBSTONE_TRIGRAM_MINUTES_FOR_HASH_IN_RANGE: &str = r#"
      UPDATE typing_trigram_minute
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE 
  scope_id IN (
    SELECT id FROM typing_scopes
     WHERE keyboard_uid = @uid AND machine_hash = @machineHash
  )
    AND is_deleted = 0

         AND minute_ts >= @startMs AND minute_ts < @endMs AND minute_ts <= @cutoffMs
    "#;

/// Tombstones one machine hash's sessions that start in a deleted range (sync-statements.ts).
pub const TOMBSTONE_SESSIONS_FOR_HASH_IN_RANGE: &str = r#"
      UPDATE typing_sessions
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE 
  scope_id IN (
    SELECT id FROM typing_scopes
     WHERE keyboard_uid = @uid AND machine_hash = @machineHash
  )
    AND is_deleted = 0

         AND start_ms >= @startMs AND start_ms < @endMs AND start_ms <= @cutoffMs
    "#;

/// Minute-raw stats of a keyboard for the Analyze WPM / Interval charts (`selectMinuteStatsInRangeForUidStmt`, range-query-statements.ts).
pub const SELECT_MINUTE_STATS_IN_RANGE_FOR_UID: &str = r#"
      SELECT t.minute_ts AS minuteMs,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs,
             MIN(t.interval_min_ms) AS intervalMinMs,
             AVG(t.interval_p25_ms) AS intervalP25Ms,
             AVG(t.interval_p50_ms) AS intervalP50Ms,
             AVG(t.interval_p75_ms) AS intervalP75Ms,
             MAX(t.interval_max_ms) AS intervalMaxMs,
             AVG(t.poll_p50_ms) AS pollP50Ms,
             AVG(t.poll_p95_ms) AS pollP95Ms
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         AND (json_array_length(@appNamesJson) = 0 OR t.app_name IN (SELECT value FROM json_each(@appNamesJson))) AND (json_array_length(@typingTestsJson) = 0 OR t.typing_test IN (SELECT value FROM json_each(@typingTestsJson))) AND (json_array_length(@runIdsJson) = 0 OR t.run_id IN (SELECT value FROM json_each(@runIdsJson)))
       GROUP BY t.minute_ts
       ORDER BY t.minute_ts ASC
    "#;

/// `(constant name in the fixture, constant)` for the text comparison test.
pub const ALL: &[(&str, &str)] = &[
    ("createMeta", CREATE_META),
    ("createSchema", CREATE_SCHEMA),
    ("mergeScope", MERGE_SCOPE),
    ("mergeCharMinute", MERGE_CHAR_MINUTE),
    ("mergeMatrixMinute", MERGE_MATRIX_MINUTE),
    ("mergeMinuteStats", MERGE_MINUTE_STATS),
    ("mergeSession", MERGE_SESSION),
    ("mergeBigramMinute", MERGE_BIGRAM_MINUTE),
    ("mergeTrigramMinute", MERGE_TRIGRAM_MINUTE),
    ("tombstoneCharMinutesForHashInRange", TOMBSTONE_CHAR_MINUTES_FOR_HASH_IN_RANGE),
    ("tombstoneMatrixMinutesForHashInRange", TOMBSTONE_MATRIX_MINUTES_FOR_HASH_IN_RANGE),
    ("tombstoneMinuteStatsForHashInRange", TOMBSTONE_MINUTE_STATS_FOR_HASH_IN_RANGE),
    ("tombstoneBigramMinutesForHashInRange", TOMBSTONE_BIGRAM_MINUTES_FOR_HASH_IN_RANGE),
    ("tombstoneTrigramMinutesForHashInRange", TOMBSTONE_TRIGRAM_MINUTES_FOR_HASH_IN_RANGE),
    ("tombstoneSessionsForHashInRange", TOMBSTONE_SESSIONS_FOR_HASH_IN_RANGE),
    ("selectMinuteStatsInRangeForUid", SELECT_MINUTE_STATS_IN_RANGE_FOR_UID),
];
