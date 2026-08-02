// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze range-query statements: minute-raw WPM/interval stats, the
// rollover trend, Monitor App aggregates (apps / typing tests / runs /
// app-usage / WPM-by-app), session listings, the Backspace-share proxy,
// peak-record aggregates, and longest-session lookup.

import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { TYPING_APP_UNKNOWN_NAME } from '../../../../shared/types/typing-analytics'
import { appFilterClause, runIdFilterClause, typingTestFilterClause } from './filter-clauses'

export interface RangeStatements {
  selectMinuteStatsInRangeForUidStmt: Statement
  selectMinuteStatsInRangeForUidAndHashStmt: Statement
  selectRolloverMinutesStmt: Statement
  selectAppsForUidInRangeStmt: Statement
  selectTypingTestsForUidInRangeStmt: Statement
  selectTypingTestRunsForUidInRangeStmt: Statement
  selectAppUsageForUidInRangeStmt: Statement
  selectWpmByAppForUidInRangeStmt: Statement
  selectSessionsInRangeForUidStmt: Statement
  selectSessionsInRangeForUidAndHashStmt: Statement
  selectBksMinuteInRangeForUidStmt: Statement
  selectBksMinuteInRangeForUidAndHashStmt: Statement
  selectPeakWpmInRangeForUidStmt: Statement
  selectPeakWpmInRangeForUidAndHashStmt: Statement
  selectLowestWpmInRangeForUidStmt: Statement
  selectLowestWpmInRangeForUidAndHashStmt: Statement
  selectPeakKpmInRangeForUidStmt: Statement
  selectPeakKpmInRangeForUidAndHashStmt: Statement
  selectPeakKpdInRangeForUidStmt: Statement
  selectPeakKpdInRangeForUidAndHashStmt: Statement
  selectLongestSessionInRangeForUidStmt: Statement
  selectLongestSessionInRangeForUidAndHashStmt: Statement
}

export function prepareRangeStatements(db: DatabaseType): RangeStatements {
  return {
    // Minute-raw rows for the Analyze WPM / Interval charts. The client
    // buckets these based on the user-picked datetime range, so the SQL
    // only groups by minute_ts (a scope can legitimately write to the
    // same minute_ts bucket more than once when a machine_hash change
    // lands; SUM / MIN / AVG / MAX merges those scopes into one row).
    // App filter: @appNamesJson is a JSON array of app names; an
    // empty array (`'[]'`) means "no filter" so the same statement
    // serves both filtered and unfiltered queries. Mixed / unknown
    // minutes (app_name IS NULL on the row) only show up when no
    // filter is set, matching the semantic the analytics service uses
    // on the write side.
    // poll_p50_ms/poll_p95_ms: AVG ignores NULL contributors by SQL
    // semantics (a minute with zero non-NULL rows yields NULL for the
    // whole aggregate, not 0) — this is deliberately an unweighted mean
    // across same-minute scopes, not a sample-weighted one: the source
    // values are already percentiles, and there is no way to recover
    // per-scope sample counts to weight them by. See
    // TypingMinuteStatsRow.pollP50Ms for the indicative-not-precise
    // framing this feeds.
    selectMinuteStatsInRangeForUidStmt: db.prepare(`
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
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY t.minute_ts
       ORDER BY t.minute_ts ASC
    `),

    selectMinuteStatsInRangeForUidAndHashStmt: db.prepare(`
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
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY t.minute_ts
       ORDER BY t.minute_ts ASC
    `),

    // Per-minute Σoverlap_count / Σoverlap_n across every bigram pair —
    // the granularity the Analyze rollover trend chart needs (unlike
    // the bigram-aggregate IPC's single whole-range ratio). Filters
    // directly on typing_bigram_minute's own app/typing_test/run_id
    // columns (same convention as prepareNgramStatements' per-ngram
    // selects above) rather than joining through a per-pair breakdown,
    // since this query only needs the minute-level oc/on sums, not
    // per-pair rows. `overlap_n IS NOT NULL` is the same skip-not-poison
    // rule as aggregatePairTotals: a row that never had overlap data
    // (pre-v8, or the frame's overlap was undetermined) contributes
    // nothing rather than counting as a 0-overlap observation — see
    // that function's doc comment for the full rationale, which applies
    // identically here since this query sums the same oc/on pair.
    // `overlap_count IS NOT NULL` guards the all-or-nothing oc/on pair
    // contract at the SQL boundary too: a synced row that somehow has
    // `overlap_n` set but `overlap_count` NULL (malformed write, or a
    // future schema bug) would otherwise make `SUM(overlap_count)`
    // return NULL for the whole minute once any row is missing it,
    // which the renderer would then read as `oc: null` and could
    // fabricate a 0% rather than surfacing "unobserved" — excluding the
    // row up front keeps the two columns' presence in lockstep.
    // Single statement per the Monitor App aggregates' convention above
    // — `@machineHash IS NULL` collapses the hash filter for the
    // all-devices case, so a second physical statement would just
    // duplicate. `"on"` is quoted since it's a SQL keyword; the quoted
    // alias still comes back as a plain `on` property on the row, so
    // the result already matches TypingRolloverMinuteRow with no rename.
    selectRolloverMinutesStmt: db.prepare(`
      SELECT t.minute_ts AS minuteTs,
             SUM(t.overlap_count) AS oc,
             SUM(t.overlap_n) AS "on"
        FROM typing_bigram_minute t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND (@machineHash IS NULL OR s.machine_hash = @machineHash)
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.overlap_n IS NOT NULL
         AND t.overlap_count IS NOT NULL
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY t.minute_ts
       ORDER BY t.minute_ts ASC
    `),

    // --- Monitor App aggregates ---------------------------------------
    // Single SELECT per query — @machineHash IS NULL collapses the
    // hash filter when the caller wants all devices, so two physical
    // statements would just duplicate. Ranking key is keystrokes
    // descending so the dropdown / pie chart picks up the most-used
    // apps without further sorting.
    selectAppsForUidInRangeStmt: db.prepare(`
      SELECT t.app_name AS name,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND (@machineHash IS NULL OR s.machine_hash = @machineHash)
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         AND t.app_name IS NOT NULL
       GROUP BY t.app_name
       ORDER BY keystrokes DESC
    `),

    // Distinct typing_test labels in range — the TypingTest filter's option
    // source (mirrors selectAppsForUidInRange). NULL (REC / mixed) excluded.
    selectTypingTestsForUidInRangeStmt: db.prepare(`
      SELECT t.typing_test AS name,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND (@machineHash IS NULL OR s.machine_hash = @machineHash)
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         AND t.typing_test IS NOT NULL
       GROUP BY t.typing_test
       ORDER BY keystrokes DESC
    `),

    // Distinct typing-test run ids in range — the per-run ("Results") filter's
    // option source. run_id '' is the non-test (REC) bucket, so it's excluded.
    // @typingTestsJson narrows runs to the selected material(s); empty = all.
    // firstMs (MIN minute_ts) is the run's start, used to label runs that have
    // no saved typingTestResults entry.
    selectTypingTestRunsForUidInRangeStmt: db.prepare(`
      SELECT t.run_id AS runId,
             SUM(t.keystrokes) AS keystrokes,
             MIN(t.minute_ts) AS firstMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND (@machineHash IS NULL OR s.machine_hash = @machineHash)
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         AND t.run_id != ''
         ${typingTestFilterClause('t.typing_test')}
       GROUP BY t.run_id
       ORDER BY firstMs DESC
    `),

    // App-Usage Distribution aggregates per app, plus a synthetic
    // bucket for unknown / mixed minutes. NULL groups under the
    // shared sentinel so the renderer can render it as a single
    // "Mixed/Unknown" slice without a special-case query.
    selectAppUsageForUidInRangeStmt: db.prepare(`
      SELECT COALESCE(t.app_name, '${TYPING_APP_UNKNOWN_NAME}') AS name,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND (@machineHash IS NULL OR s.machine_hash = @machineHash)
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
       GROUP BY name
       ORDER BY keystrokes DESC
    `),

    // WPM-by-app uses keystrokes/active_ms ratio per minute averaged
    // across single-app minutes. NULL minutes are excluded — the
    // "single app per minute" rule means mixed minutes can't be
    // attributed to any one app, so they don't belong in this chart.
    // wpm formula matches the renderer's chart-side calculation:
    // keystrokes / 5 (chars / word) / activeMs * 60_000 (ms / min).
    selectWpmByAppForUidInRangeStmt: db.prepare(`
      SELECT t.app_name AS name,
             SUM(t.keystrokes) AS keystrokes,
             SUM(t.active_ms) AS activeMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND (@machineHash IS NULL OR s.machine_hash = @machineHash)
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         AND t.app_name IS NOT NULL
         AND t.active_ms > 0
       GROUP BY t.app_name
       ORDER BY keystrokes DESC
    `),

    // Bigram/trigram per-pair range-select statements live in
    // this.ngramStmts[gram] — see prepareNgramStatements above.

    // Sessions whose start falls inside [@sinceMs, @untilMs). We filter
    // on `start_ms` so "last 24 hours" captures every session the user
    // started today regardless of how long it ran — containment on both
    // edges excluded too many real-world sessions (a 30-minute run
    // that straddles the window boundary would otherwise vanish). The
    // session's *full* length is still reported; that matches how the
    // user experienced it.
    selectSessionsInRangeForUidStmt: db.prepare(`
      SELECT t.id AS id,
             t.start_ms AS startMs,
             t.end_ms AS endMs
        FROM typing_sessions t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.start_ms >= @sinceMs
         AND t.start_ms < @untilMs
       ORDER BY t.start_ms ASC
    `),

    selectSessionsInRangeForUidAndHashStmt: db.prepare(`
      SELECT t.id AS id,
             t.start_ms AS startMs,
             t.end_ms AS endMs
        FROM typing_sessions t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.start_ms >= @sinceMs
         AND t.start_ms < @untilMs
       ORDER BY t.start_ms ASC
    `),

    // Per-minute Backspace counts for the Analyze error-proxy
    // overlay. Sourced from `typing_matrix_minute` so all capture
    // paths (HID matrix reads, typing-test, Vial input) contribute.
    //
    // Matching three Backspace shapes:
    //   - `KC_BSPC` direct (keycode == 0x2A = 42) → every press counts
    //   - `LT(layer, KC_BSPC)` (0x4000-0x4FFF, inner byte == 0x2A)
    //     → count only `tap_count`; holds activate a layer, not delete
    //   - `MT(mod, KC_BSPC)` (0x2000-0x2FFF, inner byte == 0x2A)
    //     → same tap-count rule, holds are modifiers
    //
    // Rows with zero Backspace contribution are filtered by `HAVING`
    // so the result only carries minutes that actually registered a
    // delete — matches the renderer's "skip empty bucket" behaviour.
    selectBksMinuteInRangeForUidStmt: db.prepare(`
      SELECT t.minute_ts AS minuteMs,
             SUM(CASE
               WHEN t.keycode = 42 THEN t.count
               WHEN (t.keycode & 255) = 42
                 AND ((t.keycode & 57344) = 16384 OR (t.keycode & 57344) = 8192)
               THEN t.tap_count
               ELSE 0
             END) AS backspaceCount
        FROM typing_matrix_minute t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY t.minute_ts
       HAVING backspaceCount > 0
       ORDER BY t.minute_ts ASC
    `),

    selectBksMinuteInRangeForUidAndHashStmt: db.prepare(`
      SELECT t.minute_ts AS minuteMs,
             SUM(CASE
               WHEN t.keycode = 42 THEN t.count
               WHEN (t.keycode & 255) = 42
                 AND ((t.keycode & 57344) = 16384 OR (t.keycode & 57344) = 8192)
               THEN t.tap_count
               ELSE 0
             END) AS backspaceCount
        FROM typing_matrix_minute t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY t.minute_ts
       HAVING backspaceCount > 0
       ORDER BY t.minute_ts ASC
    `),

    // Peak records: four narrow aggregates that feed the summary cards
    // at the top of Analyze. Each statement returns at most one row.
    // The WPM formula is `keystrokes * 12000 / active_ms` (five chars
    // per word, sixty thousand ms per minute); active_ms == 0 rows are
    // filtered out so the division is always safe.
    selectPeakWpmInRangeForUidStmt: db.prepare(`
      SELECT (total.keystrokes * 12000.0 / total.active_ms) AS value,
             total.minute_ts AS atMs
        FROM (
          SELECT t.minute_ts,
                 SUM(t.keystrokes) AS keystrokes,
                 SUM(t.active_ms) AS active_ms
            FROM typing_minute_stats t
            JOIN typing_scopes s ON s.id = t.scope_id
           WHERE s.keyboard_uid = @uid
             AND s.is_deleted = 0
             AND t.is_deleted = 0
             AND t.minute_ts >= @sinceMs
             AND t.minute_ts < @untilMs
             ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
           GROUP BY t.minute_ts
        ) AS total
       WHERE total.active_ms > 0
       ORDER BY value DESC
       LIMIT 1
    `),

    selectPeakWpmInRangeForUidAndHashStmt: db.prepare(`
      SELECT (total.keystrokes * 12000.0 / total.active_ms) AS value,
             total.minute_ts AS atMs
        FROM (
          SELECT t.minute_ts,
                 SUM(t.keystrokes) AS keystrokes,
                 SUM(t.active_ms) AS active_ms
            FROM typing_minute_stats t
            JOIN typing_scopes s ON s.id = t.scope_id
           WHERE s.keyboard_uid = @uid
             AND s.machine_hash = @machineHash
             AND s.is_deleted = 0
             AND t.is_deleted = 0
             AND t.minute_ts >= @sinceMs
             AND t.minute_ts < @untilMs
             ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
           GROUP BY t.minute_ts
        ) AS total
       WHERE total.active_ms > 0
       ORDER BY value DESC
       LIMIT 1
    `),

    // Lowest WPM uses the same subquery but sorts ASC. Zero-keystroke
    // minutes still sneak in as "0 WPM" so we exclude them too.
    selectLowestWpmInRangeForUidStmt: db.prepare(`
      SELECT (total.keystrokes * 12000.0 / total.active_ms) AS value,
             total.minute_ts AS atMs
        FROM (
          SELECT t.minute_ts,
                 SUM(t.keystrokes) AS keystrokes,
                 SUM(t.active_ms) AS active_ms
            FROM typing_minute_stats t
            JOIN typing_scopes s ON s.id = t.scope_id
           WHERE s.keyboard_uid = @uid
             AND s.is_deleted = 0
             AND t.is_deleted = 0
             AND t.minute_ts >= @sinceMs
             AND t.minute_ts < @untilMs
             ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
           GROUP BY t.minute_ts
        ) AS total
       WHERE total.active_ms > 0
         AND total.keystrokes > 0
       ORDER BY value ASC
       LIMIT 1
    `),

    selectLowestWpmInRangeForUidAndHashStmt: db.prepare(`
      SELECT (total.keystrokes * 12000.0 / total.active_ms) AS value,
             total.minute_ts AS atMs
        FROM (
          SELECT t.minute_ts,
                 SUM(t.keystrokes) AS keystrokes,
                 SUM(t.active_ms) AS active_ms
            FROM typing_minute_stats t
            JOIN typing_scopes s ON s.id = t.scope_id
           WHERE s.keyboard_uid = @uid
             AND s.machine_hash = @machineHash
             AND s.is_deleted = 0
             AND t.is_deleted = 0
             AND t.minute_ts >= @sinceMs
             AND t.minute_ts < @untilMs
             ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
           GROUP BY t.minute_ts
        ) AS total
       WHERE total.active_ms > 0
         AND total.keystrokes > 0
       ORDER BY value ASC
       LIMIT 1
    `),

    selectPeakKpmInRangeForUidStmt: db.prepare(`
      SELECT SUM(t.keystrokes) AS value, t.minute_ts AS atMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY t.minute_ts
       HAVING value > 0
       ORDER BY value DESC
       LIMIT 1
    `),

    selectPeakKpmInRangeForUidAndHashStmt: db.prepare(`
      SELECT SUM(t.keystrokes) AS value, t.minute_ts AS atMs
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY t.minute_ts
       HAVING value > 0
       ORDER BY value DESC
       LIMIT 1
    `),

    selectPeakKpdInRangeForUidStmt: db.prepare(`
      SELECT strftime('%Y-%m-%d', t.minute_ts / 1000, 'unixepoch', 'localtime') AS day,
             SUM(t.keystrokes) AS value
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY day
       HAVING value > 0
       ORDER BY value DESC
       LIMIT 1
    `),

    selectPeakKpdInRangeForUidAndHashStmt: db.prepare(`
      SELECT strftime('%Y-%m-%d', t.minute_ts / 1000, 'unixepoch', 'localtime') AS day,
             SUM(t.keystrokes) AS value
        FROM typing_minute_stats t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       GROUP BY day
       HAVING value > 0
       ORDER BY value DESC
       LIMIT 1
    `),

    selectLongestSessionInRangeForUidStmt: db.prepare(`
      SELECT (t.end_ms - t.start_ms) AS durationMs,
             t.start_ms AS startedAtMs
        FROM typing_sessions t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.start_ms >= @sinceMs
         AND t.start_ms < @untilMs
       ORDER BY durationMs DESC
       LIMIT 1
    `),

    selectLongestSessionInRangeForUidAndHashStmt: db.prepare(`
      SELECT (t.end_ms - t.start_ms) AS durationMs,
             t.start_ms AS startedAtMs
        FROM typing_sessions t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.start_ms >= @sinceMs
         AND t.start_ms < @untilMs
       ORDER BY durationMs DESC
       LIMIT 1
    `),
  }
}
