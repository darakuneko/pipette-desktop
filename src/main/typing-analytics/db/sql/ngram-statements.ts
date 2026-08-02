// SPDX-License-Identifier: GPL-2.0-or-later
// Prepared statements shared by typing_bigram_minute / typing_trigram_minute
// — the two tables are structurally identical aside from their id column
// name and (for bigrams only) the physical-overlap columns, so every
// statement is generated from one template.

import type { Database as DatabaseType, Statement } from 'better-sqlite3'
import { appFilterClause, runIdFilterClause, typingTestFilterClause, TOMBSTONE_HASH_RANGE_WHERE, TOMBSTONE_RANGE_WHERE } from './filter-clauses'

/** Prepared statements for one n-gram table (typing_bigram_minute or
 * typing_trigram_minute). Both tables are structurally identical aside
 * from their id column name, so every statement here is generated from
 * the same template with `table` / `idColumn` interpolated — see
 * {@link prepareNgramStatements}. */
export interface NgramStatements {
  merge: Statement
  selectInRangeForUid: Statement
  selectInRangeForUidAndHash: Statement
  tombstoneForHashInRange: Statement
  tombstoneInRange: Statement
  tombstoneAll: Statement
  deleteBefore: Statement
}

/** One extra column an n-gram table may carry beyond the common
 * count/hist/sum/sumSq/tag shape — currently just overlap_count/overlap_n
 * on typing_bigram_minute (see {@link prepareNgramStatements}). `column`
 * is the SQL column name; `bind` is both the named-parameter key
 * (referenced as `@bind` in generated SQL) and the SELECT alias, so it
 * doubles as the camelCase field name the row comes back as (matching
 * NgramMinuteCellRow). */
export interface NgramExtraColumn {
  column: string
  bind: string
}

/** typing_bigram_minute's only extra columns beyond the shape every
 * n-gram table shares — see {@link NgramExtraColumn}. typing_trigram_minute
 * passes an empty array at its {@link prepareNgramStatements} call site:
 * overlap is a pairwise notion that doesn't extend to trigrams, and that
 * table has no such SQL columns to reference. */
export const BIGRAM_OVERLAP_EXTRA_COLUMNS: readonly NgramExtraColumn[] = [
  { column: 'overlap_count', bind: 'overlapCount' },
  { column: 'overlap_n', bind: 'overlapN' },
]

/** Build the seven prepared statements one n-gram table needs. `table`
 * and `idColumn` are always hard-coded literals from the call sites
 * below (never user input), so interpolating them directly into the SQL
 * text is safe — every value-level parameter still goes through
 * better-sqlite3's `@name` binding.
 *
 * `extraColumns` derives all four insert/update/select SQL fragments
 * that need to vary per table from one list, rather than four
 * hand-maintained boolean-gated strings — a table with no extra columns
 * (trigram) just passes an empty array and every fragment below
 * collapses to '' automatically. */
export function prepareNgramStatements(
  db: DatabaseType,
  table: 'typing_bigram_minute' | 'typing_trigram_minute',
  idColumn: 'bigram_id' | 'trigram_id',
  extraColumns: readonly NgramExtraColumn[],
): NgramStatements {
  const insertCols = extraColumns.map((c) => `, ${c.column}`).join('')
  const insertVals = extraColumns.map((c) => `, @${c.bind}`).join('')
  const updateSet = extraColumns.map((c) => `${c.column} = excluded.${c.column},\n        `).join('')
  const selectCols = extraColumns.map((c) => `,\n             t.${c.column} AS ${c.bind}`).join('')
  return {
    // Authoritative LWW upsert for sync merge — replaces the target row
    // wholesale, respects the incoming is_deleted flag, and only fires
    // when excluded.updated_at is strictly newer than the existing row.
    merge: db.prepare(`
      INSERT INTO ${table} (
        scope_id, minute_ts, ${idColumn}, count, hist, sum_iki, sumsq_iki${insertCols}, app_name, typing_test, run_id, updated_at, is_deleted
      )
      VALUES (
        @scopeId, @minuteTs, @ngramId, @count, @hist, @sumIki, @sumSqIki${insertVals}, @appName, @typingTest, @runId, @updatedAt, @isDeleted
      )
      ON CONFLICT(scope_id, minute_ts, run_id, ${idColumn}) DO UPDATE SET
        count = excluded.count,
        hist = excluded.hist,
        sum_iki = excluded.sum_iki,
        sumsq_iki = excluded.sumsq_iki,
        ${updateSet}app_name = excluded.app_name,
        typing_test = excluded.typing_test,
        updated_at = excluded.updated_at,
        is_deleted = excluded.is_deleted
      WHERE excluded.updated_at > ${table}.updated_at
    `),

    // Per-(scope, minute, ngram) rows in range for the Analyze n-gram
    // view. The aggregation layer sums each pair's count + hist across
    // rows; SQL keeps the per-minute / per-ngram granularity so the
    // caller can also emit time-series data (e.g. peak detection)
    // without re-querying. ORDER BY ngramId groups rows for the same
    // pair together so the aggregator can accumulate without an
    // intermediate Map sort.
    selectInRangeForUid: db.prepare(`
      SELECT t.${idColumn} AS ngramId,
             t.minute_ts AS minuteTs,
             t.count AS count,
             t.hist AS hist,
             t.sum_iki AS sumIki,
             t.sumsq_iki AS sumSqIki${selectCols}
        FROM ${table} t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       ORDER BY t.${idColumn} ASC, t.minute_ts ASC
    `),

    // Same as selectInRangeForUid but restricted to a single machine_hash
    // for the Analyze "This device" scope.
    selectInRangeForUidAndHash: db.prepare(`
      SELECT t.${idColumn} AS ngramId,
             t.minute_ts AS minuteTs,
             t.count AS count,
             t.hist AS hist,
             t.sum_iki AS sumIki,
             t.sumsq_iki AS sumSqIki${selectCols}
        FROM ${table} t
        JOIN typing_scopes s ON s.id = t.scope_id
       WHERE s.keyboard_uid = @uid
         AND s.machine_hash = @machineHash
         AND s.is_deleted = 0
         AND t.is_deleted = 0
         AND t.minute_ts >= @sinceMs
         AND t.minute_ts < @untilMs
         ${appFilterClause('t.app_name')} ${typingTestFilterClause('t.typing_test')} ${runIdFilterClause('t.run_id')}
       ORDER BY t.${idColumn} ASC, t.minute_ts ASC
    `),

    tombstoneForHashInRange: db.prepare(`
      UPDATE ${table}
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_HASH_RANGE_WHERE}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `),

    tombstoneInRange: db.prepare(`
      UPDATE ${table}
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_RANGE_WHERE}
         AND minute_ts >= @startMs AND minute_ts < @endMs
    `),

    tombstoneAll: db.prepare(`
      UPDATE ${table}
         SET is_deleted = 1, updated_at = @updatedAt
       WHERE ${TOMBSTONE_RANGE_WHERE}
    `),

    deleteBefore: db.prepare(`
      DELETE FROM ${table}
       WHERE scope_id IN (SELECT id FROM typing_scopes WHERE machine_hash = @machineHash)
         AND minute_ts < @cutoffMs
    `),
  }
}
