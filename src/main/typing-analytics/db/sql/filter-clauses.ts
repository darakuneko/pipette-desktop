// SPDX-License-Identifier: GPL-2.0-or-later
// Shared SQL fragments referenced by every Analyze-facing prepared
// statement across the ingest/merge/sync/summary/range/ngram statement
// modules.

/** SQL fragment for the per-app filter shared by every range-aware
 * Analyze query. `column` is interpolated raw (always a hard-coded
 * `m.app_name` / `t.app_name`, never user input — interpolating user
 * input would break parameterised binding). `@appNamesJson` is a JSON
 * array; an empty array (`'[]'`) short-circuits the IN-subquery so
 * the same prepared statement covers single-app, multi-app and
 * unfiltered queries. */
export function appFilterClause(column: string): string {
  return `AND (json_array_length(@appNamesJson) = 0 OR ${column} IN (SELECT value FROM json_each(@appNamesJson)))`
}

/** Same shape as {@link appFilterClause} for the typing_test dimension.
 * `@typingTestsJson` is a JSON array; empty = no filter. */
export function typingTestFilterClause(column: string): string {
  return `AND (json_array_length(@typingTestsJson) = 0 OR ${column} IN (SELECT value FROM json_each(@typingTestsJson)))`
}

/** Same shape as {@link appFilterClause} for the run_id dimension (slice a
 * test material down to individual runs). `@runIdsJson` is a JSON array;
 * empty = no filter. */
export function runIdFilterClause(column: string): string {
  return `AND (json_array_length(@runIdsJson) = 0 OR ${column} IN (SELECT value FROM json_each(@runIdsJson)))`
}

// Tombstone range deletes only flip live rows (is_deleted = 0) so existing
// tombstones keep their original updated_at for GC purposes. Shared by
// every per-table tombstone statement (char/matrix/minute_stats/session
// plus the bigram/trigram pair prepared by prepareNgramStatements in
// ngram-statements.ts) — the WHERE clause itself carries no table-specific
// column, only the FK.
export const TOMBSTONE_RANGE_WHERE = `
  scope_id IN (SELECT id FROM typing_scopes WHERE keyboard_uid = @uid)
    AND is_deleted = 0
`

// Hash-scoped variant — Sync-delete of another device's day removes only
// that device's rows while keeping same-day contributions from other
// hashes intact.
export const TOMBSTONE_HASH_RANGE_WHERE = `
  scope_id IN (
    SELECT id FROM typing_scopes
     WHERE keyboard_uid = @uid AND machine_hash = @machineHash
  )
    AND is_deleted = 0
`
