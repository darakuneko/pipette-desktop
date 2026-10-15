// SPDX-License-Identifier: GPL-2.0-or-later
// The Rust source of the SQL constants the crate includes (data/sql.rs):
// the exact strings the TypeScript DB layer prepares, collected through a
// fake connection whose `prepare` returns its argument.
//
// Not collected, so hand-written in the crate's src/schema.rs: the migration
// SQL, which typing-analytics-db-base.ts runs inline with `exec`.

import type { Database as DatabaseType } from 'better-sqlite3'
import { CREATE_META_SQL, CREATE_SCHEMA_SQL } from '../../src/main/typing-analytics/db/schema'
import { prepareMergeStatements } from '../../src/main/typing-analytics/db/sql/merge-statements'
import { prepareMetaStatements } from '../../src/main/typing-analytics/db/sql/meta-statements'
import { BIGRAM_OVERLAP_EXTRA_COLUMNS, prepareNgramStatements } from '../../src/main/typing-analytics/db/sql/ngram-statements'
import { prepareSyncStatements } from '../../src/main/typing-analytics/db/sql/sync-statements'
import { prepareRangeStatements } from '../../src/main/typing-analytics/db/sql/range-query-statements'

interface SqlConstant {
  name: string
  doc: string
  text: string
}

function collectSql(): SqlConstant[] {
  const fake = { prepare: (sql: string): string => sql } as unknown as DatabaseType
  const text = (stmts: object): Record<string, string> => stmts as unknown as Record<string, string>
  const meta = text(prepareMetaStatements(fake))
  const merge = text(prepareMergeStatements(fake))
  const bigram = text(prepareNgramStatements(fake, 'typing_bigram_minute', 'bigram_id', BIGRAM_OVERLAP_EXTRA_COLUMNS))
  const trigram = text(prepareNgramStatements(fake, 'typing_trigram_minute', 'trigram_id', []))
  const sync = text(prepareSyncStatements(fake))
  const range = text(prepareRangeStatements(fake))
  return [
    { name: 'CREATE_META', doc: 'The meta table and connection PRAGMAs (`CREATE_META_SQL`, schema.ts). Runs before any migration.', text: CREATE_META_SQL },
    { name: 'CREATE_SCHEMA', doc: 'Every data table and index (`CREATE_SCHEMA_SQL`, schema.ts). Runs after the migrations.', text: CREATE_SCHEMA_SQL },
    { name: 'GET_META', doc: 'One meta value by key (`getMetaStmt`, meta-statements.ts).', text: meta.getMetaStmt },
    { name: 'SET_META', doc: 'Upsert of one meta value (`setMetaStmt`, meta-statements.ts).', text: meta.setMetaStmt },
    { name: 'MERGE_SCOPE', doc: 'LWW upsert of a scope (`mergeScopeStmt`, merge-statements.ts).', text: merge.mergeScopeStmt },
    { name: 'MERGE_CHAR_MINUTE', doc: 'LWW upsert of a char-minute row (`mergeCharMinuteStmt`, merge-statements.ts).', text: merge.mergeCharMinuteStmt },
    { name: 'MERGE_MATRIX_MINUTE', doc: 'LWW upsert of a matrix-minute row (`mergeMatrixMinuteStmt`, merge-statements.ts).', text: merge.mergeMatrixMinuteStmt },
    { name: 'MERGE_MINUTE_STATS', doc: 'LWW upsert of a minute-stats row (`mergeMinuteStatsStmt`, merge-statements.ts).', text: merge.mergeMinuteStatsStmt },
    { name: 'MERGE_SESSION', doc: 'LWW upsert of a session (`mergeSessionStmt`, merge-statements.ts).', text: merge.mergeSessionStmt },
    { name: 'MERGE_BIGRAM_MINUTE', doc: 'LWW upsert of one bigram of a bigram-minute row (`merge` of `prepareNgramStatements` for typing_bigram_minute, ngram-statements.ts).', text: bigram.merge },
    { name: 'MERGE_TRIGRAM_MINUTE', doc: 'LWW upsert of one trigram of a trigram-minute row (`merge` of `prepareNgramStatements` for typing_trigram_minute, ngram-statements.ts).', text: trigram.merge },
    { name: 'TOMBSTONE_CHAR_MINUTES_FOR_HASH_IN_RANGE', doc: "Tombstones one machine hash's char-minute rows in a deleted range (sync-statements.ts).", text: sync.tombstoneCharMinutesForHashInRangeStmt },
    { name: 'TOMBSTONE_MATRIX_MINUTES_FOR_HASH_IN_RANGE', doc: "Tombstones one machine hash's matrix-minute rows in a deleted range (sync-statements.ts).", text: sync.tombstoneMatrixMinutesForHashInRangeStmt },
    { name: 'TOMBSTONE_MINUTE_STATS_FOR_HASH_IN_RANGE', doc: "Tombstones one machine hash's minute-stats rows in a deleted range (sync-statements.ts).", text: sync.tombstoneMinuteStatsForHashInRangeStmt },
    { name: 'TOMBSTONE_BIGRAM_MINUTES_FOR_HASH_IN_RANGE', doc: "Tombstones one machine hash's bigram rows in a deleted range (`tombstoneForHashInRange`, ngram-statements.ts).", text: bigram.tombstoneForHashInRange },
    { name: 'TOMBSTONE_TRIGRAM_MINUTES_FOR_HASH_IN_RANGE', doc: "Tombstones one machine hash's trigram rows in a deleted range (`tombstoneForHashInRange`, ngram-statements.ts).", text: trigram.tombstoneForHashInRange },
    { name: 'TOMBSTONE_SESSIONS_FOR_HASH_IN_RANGE', doc: "Tombstones one machine hash's sessions that start in a deleted range (sync-statements.ts).", text: sync.tombstoneSessionsForHashInRangeStmt },
    { name: 'SELECT_MINUTE_STATS_IN_RANGE_FOR_UID', doc: 'Minute-raw stats of a keyboard for the Analyze WPM / Interval charts (`selectMinuteStatsInRangeForUidStmt`, range-query-statements.ts).', text: range.selectMinuteStatsInRangeForUidStmt },
  ]
}

/** The text of data/sql.rs. Each string becomes a raw string literal, so
 * the SQL reads the same in both languages. */
export function buildSqlSource(): string {
  const items = collectSql().map(({ name, doc, text }) => {
    if (typeof text !== 'string') throw new Error(`${name}: no SQL text collected`)
    if (text.includes('"#')) throw new Error(`${name}: contains "# and cannot be a r#"…"# literal`)
    return `/// ${doc}\npub const ${name}: &str = r#"${text}"#;`
  })
  return `// SPDX-License-Identifier: GPL-2.0-or-later
// Generated by scripts/analytics-db-fixtures/record-analytics-db-fixtures.test.ts
// (pnpm run generate:analytics-db-fixtures). Do not edit by hand.
//
// The SQL text of src/main/typing-analytics/db/, character for character.
// Included by src/sql.rs.

${items.join('\n\n')}
`
}
