// SPDX-License-Identifier: GPL-2.0-or-later
// Base of the TypingAnalyticsDB class chain: owns the SQLite connection,
// the 3-phase migration-aware constructor, and the prepared-statement
// bundle every derived class reads from `this.stmts`. Split out of what
// used to be one 3,255-line file/class — see
// .claude/tasks/done/Task-split-typing-analytics-db.md.
//
// typing-analytics-db-writes.ts extends this with the ingest/tombstone/
// export/merge write methods, typing-analytics-db-reads.ts extends that
// with every Analyze-facing read method, and typing-analytics-db.ts's
// `class TypingAnalyticsDB extends TypingAnalyticsDbReads {}` is the public
// facade.

import Database from 'better-sqlite3'
import type { Database as DatabaseType } from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { CREATE_META_SQL, CREATE_SCHEMA_SQL, SCHEMA_VERSION } from './schema'
import { prepareMetaStatements, type MetaStatements } from './sql/meta-statements'
import { prepareIngestStatements, type IngestStatements } from './sql/ingest-statements'
import { prepareMergeStatements, type MergeStatements } from './sql/merge-statements'
import { prepareSyncStatements, type SyncStatements } from './sql/sync-statements'
import { prepareSummaryStatements, type SummaryStatements } from './sql/summary-query-statements'
import { prepareRangeStatements, type RangeStatements } from './sql/range-query-statements'
import { prepareNgramStatements, BIGRAM_OVERLAP_EXTRA_COLUMNS, type NgramStatements } from './sql/ngram-statements'

/** Every prepared statement the class chain uses, grouped by the SQL
 * module that prepared it. `stmts` is assigned exactly once, at the end
 * of the Base constructor, after schema migration has run — see the
 * constructor's phase comment below for why the ordering matters. */
export interface TypingAnalyticsStmts {
  meta: MetaStatements
  ingest: IngestStatements
  merge: MergeStatements
  sync: SyncStatements
  summary: SummaryStatements
  range: RangeStatements
  // Bigram/trigram merge, range-select, tombstone and delete-before
  // statements live behind this map (keyed by gram size) instead of 14
  // separate fields — see prepareNgramStatements in ngram-statements.ts.
  ngram: { readonly 2: NgramStatements; readonly 3: NgramStatements }
}

export abstract class TypingAnalyticsDbBase {
  protected readonly db: DatabaseType
  protected readonly stmts: TypingAnalyticsStmts

  /** Set when a migration dropped tables (a primary-key change can't be
   * done in-place), so the caller must rebuild the cache from the JSONL
   * masters before serving queries. Read once after construction.
   *
   * Declared here (not on a derived class) on purpose: a derived class's
   * own field initializer runs right after `super()` returns, which would
   * silently reset a `true` that this Base constructor's migrateSchema
   * call just set. */
  cacheNeedsRebuild = false

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    // Two-phase init so migrateSchema can run BEFORE the
    // version-aware indices in CREATE_SCHEMA_SQL try to reference
    // newly-added columns:
    //   1. CREATE_META_SQL  → meta table only (lets us read schema_version
    //      against an existing DB without touching anything else)
    //   2. migrateSchema    → ALTER TABLE for column additions
    //   3. CREATE_SCHEMA_SQL → remaining tables (no-op on upgrade) and
    //      every index, including ones referencing the columns we just
    //      ALTERed in.
    this.db.exec(CREATE_META_SQL)

    // Meta statements are prepared standalone, ahead of everything else:
    // reading schema_version must not depend on the migration it's about
    // to gate. `this.stmts` isn't assigned yet at this point in the
    // constructor, so schema_version reads/writes below go through this
    // local `metaStmts` directly rather than `this.getMeta`/`this.setMeta`.
    const metaStmts = prepareMetaStatements(this.db)

    const stored = (metaStmts.getMetaStmt.get('schema_version') as { value: string } | undefined)?.value ?? null
    if (stored != null && Number(stored) !== SCHEMA_VERSION) {
      this.migrateSchema(Number(stored))
    }
    this.db.exec(CREATE_SCHEMA_SQL)
    if (stored == null || Number(stored) !== SCHEMA_VERSION) {
      metaStmts.setMetaStmt.run({ key: 'schema_version', value: String(SCHEMA_VERSION) })
    }

    this.stmts = {
      meta: metaStmts,
      ingest: prepareIngestStatements(this.db),
      merge: prepareMergeStatements(this.db),
      sync: prepareSyncStatements(this.db),
      summary: prepareSummaryStatements(this.db),
      range: prepareRangeStatements(this.db),
      ngram: {
        2: prepareNgramStatements(this.db, 'typing_bigram_minute', 'bigram_id', BIGRAM_OVERLAP_EXTRA_COLUMNS),
        3: prepareNgramStatements(this.db, 'typing_trigram_minute', 'trigram_id', []),
      },
    }
  }

  /** Apply additive migrations for older databases. Only forward
   * migrations are supported; downgrading keeps today's "mismatch is
   * fatal" posture because the reverse direction can't be made safe. */
  private migrateSchema(fromVersion: number): void {
    if (fromVersion > SCHEMA_VERSION) {
      throw new Error(
        `typing-analytics DB schema version ${fromVersion} is newer than this build's ${SCHEMA_VERSION}`,
      )
    }
    // v1 -> v2: Add tap_count / hold_count columns to the matrix
    // rollups so LT/MT tap/hold classification (by release edge or by
    // the renderer's deferred-emit deadline) has somewhere to
    // accumulate. Existing rows default to 0, meaning "unclassified" —
    // the heatmap falls back to the total `count` when both are zero.
    if (fromVersion < 2) {
      this.db.exec(`
        ALTER TABLE typing_matrix_minute
          ADD COLUMN tap_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE typing_matrix_minute
          ADD COLUMN hold_count INTEGER NOT NULL DEFAULT 0;
      `)
    }
    // v3 -> v4: Add app_name to the four minute rollups so app-filtered
    // analytics can restrict to single-app minutes. NULL means
    // mixed/unknown/disabled — existing rows stay at NULL. The matching
    // CREATE INDEX statements live in CREATE_SCHEMA_SQL and are
    // deliberately deferred until the constructor's second-phase
    // exec, which runs after this migrate so the indices see the
    // freshly-ALTERed columns on upgrade.
    if (fromVersion < 4) {
      this.db.exec(`
        ALTER TABLE typing_char_minute ADD COLUMN app_name TEXT;
        ALTER TABLE typing_matrix_minute ADD COLUMN app_name TEXT;
        ALTER TABLE typing_minute_stats ADD COLUMN app_name TEXT;
        ALTER TABLE typing_bigram_minute ADD COLUMN app_name TEXT;
      `)
    }
    // v4 -> v5: Add typing_test to the four minute rollups so
    // TypingTest-filtered analytics can restrict to one test's keystrokes.
    // NULL means ordinary REC input or a mixed minute. Indices are created
    // in CREATE_SCHEMA_SQL's second-phase exec (see app_name note above).
    if (fromVersion < 5) {
      this.db.exec(`
        ALTER TABLE typing_char_minute ADD COLUMN typing_test TEXT;
        ALTER TABLE typing_matrix_minute ADD COLUMN typing_test TEXT;
        ALTER TABLE typing_minute_stats ADD COLUMN typing_test TEXT;
        ALTER TABLE typing_bigram_minute ADD COLUMN typing_test TEXT;
      `)
    }
    // v5 -> v6: Add run_id to the four minute rollups, as part of each
    // table's PRIMARY KEY, so two test runs that share a wall-clock minute
    // stay separate rows (exact per-run filtering). A PK change can't be
    // done with ALTER, so drop the rollup tables and let CREATE_SCHEMA_SQL
    // recreate them with the new schema; the cache is then rebuilt from the
    // JSONL masters (cacheNeedsRebuild). typing_scopes / typing_sessions are
    // untouched so the FK parents and session history survive.
    if (fromVersion < 6) {
      this.db.exec(`
        DROP TABLE IF EXISTS typing_char_minute;
        DROP TABLE IF EXISTS typing_matrix_minute;
        DROP TABLE IF EXISTS typing_minute_stats;
        DROP TABLE IF EXISTS typing_bigram_minute;
      `)
      this.cacheNeedsRebuild = true
    }
    // v6 -> v7: Add sum_iki / sumsq_iki to typing_bigram_minute (nullable —
    // see Plan-trigram-and-iki-variance.md) and introduce typing_trigram_minute.
    // The new table is handled by CREATE_SCHEMA_SQL's unconditional
    // `CREATE TABLE IF NOT EXISTS`, same as any fresh install, so nothing to
    // do here for it. The ALTER below only applies when typing_bigram_minute
    // still has the pre-v7 shape: a DB migrating up from before v6 already
    // dropped that table in the branch above and CREATE_SCHEMA_SQL recreates
    // it with these columns built in, so re-altering here would hit "no such
    // table". No cache rebuild: existing rows just gain nullable columns —
    // there is nothing to replay from the JSONL masters.
    if (fromVersion === 6) {
      this.db.exec(`
        ALTER TABLE typing_bigram_minute ADD COLUMN sum_iki REAL;
        ALTER TABLE typing_bigram_minute ADD COLUMN sumsq_iki REAL;
      `)
    }
    // v7 -> v8: add keypress-duration columns to typing_matrix_minute,
    // physical-overlap columns to typing_bigram_minute, and poll-gap
    // columns to typing_minute_stats — all nullable, no cache rebuild
    // (old JSONL masters have no source data for any of these; see
    // schema.ts). Guarded by `fromVersion === 6 || fromVersion === 7`,
    // not `<= 7`: every one of these three tables was in the `< 6` drop
    // list above, so a DB migrating from before v6 already got them
    // dropped-and-recreated by CREATE_SCHEMA_SQL (today's full v8 DDL,
    // columns included) — re-altering here would hit "no such table" for
    // that path, exactly like the v6->v7 precedent immediately above.
    // Both v6 and v7 DBs, in contrast, kept these tables intact since v6
    // (the v6->v7 step above only touched typing_bigram_minute's
    // sum_iki/sumsq_iki, not the other two), so both need the v8 ALTER.
    if (fromVersion === 6 || fromVersion === 7) {
      this.db.exec(`
        ALTER TABLE typing_matrix_minute ADD COLUMN dur_hist BLOB;
        ALTER TABLE typing_matrix_minute ADD COLUMN dur_sum REAL;
        ALTER TABLE typing_matrix_minute ADD COLUMN dur_sumsq REAL;
        ALTER TABLE typing_bigram_minute ADD COLUMN overlap_count INTEGER;
        ALTER TABLE typing_bigram_minute ADD COLUMN overlap_n INTEGER;
        ALTER TABLE typing_minute_stats ADD COLUMN poll_p50_ms REAL;
        ALTER TABLE typing_minute_stats ADD COLUMN poll_p95_ms REAL;
      `)
    }
  }

  getMeta(key: string): string | null {
    const row = this.stmts.meta.getMetaStmt.get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this.stmts.meta.setMetaStmt.run({ key, value })
  }

  /** Low-level escape hatch for queries the service hasn't wrapped yet. */
  getConnection(): DatabaseType {
    return this.db
  }

  close(): void {
    this.db.close()
  }
}
