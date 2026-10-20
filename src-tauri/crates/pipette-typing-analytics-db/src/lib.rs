// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing-analytics SQLite cache: a rebuildable index over the per-day
//! JSONL masters, with every read the Analyze view and the Data modal make
//! of it.
//!
//! Each call that writes is one unit of work and owns its transaction, so a
//! caller can never leave half of it applied. Where one write runs inside
//! another's transaction (the replay that hides a device's deleted ranges), the
//! inner write is a function that takes the outer transaction. The transactions
//! are savepoints, so the calls also run inside the migration that
//! [`TypingAnalyticsDb::open`] leaves open for the cache rebuild.
//!
//! - [`TypingAnalyticsDb::apply_day_jsonl`] — one day file.
//! - [`TypingAnalyticsDb::apply_day_jsonl_hiding_ranges`] — one day file of
//!   another device plus the tombstones of that device's deleted ranges.
//! - tombstone.rs, ingest.rs — the other writes; summary.rs, range.rs,
//!   ngram.rs, scopes.rs — the reads, whose rows (rows.rs) give the objects
//!   as JavaScript values ([`ToJs`]).

mod apply;
mod ingest;
mod js;
mod jsonl;
mod ngram;
mod query;
mod range;
mod row_codec;
mod rows;
mod schema;
mod scopes;
mod sql;
mod summary;
mod tombstone;

use std::path::Path;

use rusqlite::Connection;
use rusqlite::config::DbConfig;
use schema::SchemaOutcome;

pub use apply::ApplyRowsResult;
pub use ingest::{CharMinuteInput, MatrixMinuteInput, MinuteStatsInput, ScopeInput, SessionInput};
pub use js::ToJs;
pub use jsonl::HIST_BUCKETS;
pub use ngram::Gram;
pub use query::ScopeFilters;
pub use range::AppAggregate;
pub use rows::{
    ActivityCell, BksMinuteRow, DailySummary, IntervalDailySummary, KeyboardSummary, LayerUsageRow,
    LongestSession, MatrixCellDailyRow, MatrixCellRow, MatrixCounts, MatrixDurationCellRow, MinuteStatsRow,
    NamedTotals, NgramMinuteCellRow, Overlap, PeakAt, PeakDay, PeakRecords, RemoteDeviceInfo,
    RolloverMinuteRow, SessionRow, TypingTestRun,
};
pub use schema::{DATA_TABLE_NAMES, SCHEMA_VERSION};
pub use tombstone::{DeleteRange, TombstoneResult};

/// Statements kept prepared per connection; above the number of statements
/// in sql.rs, so none is ever re-prepared.
const STATEMENT_CACHE_CAPACITY: usize = 128;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("typing-analytics DB schema version {stored} is newer than this build's {supported}")]
    SchemaTooNew { stored: f64, supported: i64 },
    #[error("histogram bucket {0} does not fit in u32")]
    HistogramBucketOutOfRange(f64),
}

pub struct TypingAnalyticsDb {
    conn: Connection,
    outcome: SchemaOutcome,
    /// The schema transaction of a migration that dropped tables is still
    /// open (see [`Self::commit_migration`]).
    migration_open: bool,
}

impl TypingAnalyticsDb {
    /// Open (creating when missing) the database at `path` and bring its
    /// schema up to [`SCHEMA_VERSION`]. The parent directory must exist.
    ///
    /// The schema changes run in one transaction. When a migration dropped
    /// tables ([`Self::cache_needs_rebuild`]), that transaction stays open:
    /// the drop and the new schema version reach the file only with
    /// [`Self::commit_migration`], after the rebuild refilled the tables.
    /// Closing the database without it (or [`Self::rollback_migration`])
    /// leaves the file at its old version, so the next open migrates and
    /// asks for the rebuild again.
    pub fn open(path: &Path) -> Result<Self, Error> {
        Self::with_connection(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self, Error> {
        Self::with_connection(Connection::open_in_memory()?)
    }

    fn with_connection(conn: Connection) -> Result<Self, Error> {
        conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE_CAPACITY);
        // The WAL database runs at NORMAL; SQLite's own default (this bundled
        // build) is FULL. NORMAL can lose the last
        // commits on power loss but never corrupts, and the cache is
        // rebuildable from the JSONL masters.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        // Two more settings that change how this layer's SQL behaves: a
        // 16 MB page cache (SQLITE_DEFAULT_CACHE_SIZE=-16000) and
        // double-quoted strings read only as identifiers (SQLITE_DQS=0).
        conn.pragma_update(None, "cache_size", -16000)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
        let outcome = schema::prepare_schema(&conn)?;
        Ok(Self { conn, outcome, migration_open: outcome.cache_needs_rebuild })
    }

    /// True when opening dropped tables, so the cache must be rebuilt from
    /// the JSONL masters before it serves queries.
    pub fn cache_needs_rebuild(&self) -> bool {
        self.outcome.cache_needs_rebuild
    }

    /// Commit the migration left open by [`Self::open`], with whatever the
    /// rebuild applied. Does nothing when none is open.
    pub fn commit_migration(&mut self) -> Result<(), Error> {
        if self.migration_open {
            self.conn.execute_batch("COMMIT")?;
            self.migration_open = false;
        }
        Ok(())
    }

    /// Roll back the migration left open by [`Self::open`] and everything
    /// applied since, leaving the file as it was before the open. The
    /// connection then still has the old schema, so it is only to be
    /// dropped. Does nothing when none is open.
    pub fn rollback_migration(&mut self) -> Result<(), Error> {
        if self.migration_open {
            self.conn.execute_batch("ROLLBACK")?;
            self.migration_open = false;
        }
        Ok(())
    }

    /// Apply one day file's text. On any error nothing of the file stays
    /// applied.
    pub fn apply_day_jsonl(&mut self, text: &str) -> Result<ApplyRowsResult, Error> {
        self.apply_day_rows(&DayRows::parse(text))
    }

    /// [`Self::apply_day_jsonl`] for a file already parsed.
    pub fn apply_day_rows(&mut self, rows: &DayRows) -> Result<ApplyRowsResult, Error> {
        if rows.is_empty() {
            return Ok(ApplyRowsResult::default());
        }
        let tx = self.conn.savepoint()?;
        let result = apply::apply_rows(&tx, &rows.0)?;
        tx.commit()?;
        Ok(result)
    }

    /// Apply one day file of `machine_hash` and tombstone its rows inside
    /// `ranges` (that device's deleted ranges, clipped to the file's UTC
    /// day) in the same transaction, so a reader never sees an in-range row
    /// live. A failure of either leaves nothing of the file applied. With
    /// no ranges this is [`Self::apply_day_jsonl`].
    pub fn apply_day_jsonl_hiding_ranges(
        &mut self,
        text: &str,
        uid: &str,
        machine_hash: &str,
        ranges: &[DeleteRange],
        updated_at: i64,
    ) -> Result<ApplyRowsResult, Error> {
        self.apply_day_rows_hiding_ranges(&DayRows::parse(text), uid, machine_hash, ranges, updated_at)
    }

    /// [`Self::apply_day_jsonl_hiding_ranges`] for a file already parsed.
    pub fn apply_day_rows_hiding_ranges(
        &mut self,
        rows: &DayRows,
        uid: &str,
        machine_hash: &str,
        ranges: &[DeleteRange],
        updated_at: i64,
    ) -> Result<ApplyRowsResult, Error> {
        if ranges.is_empty() {
            return self.apply_day_rows(rows);
        }
        let tx = self.conn.savepoint()?;
        let result =
            if rows.is_empty() { ApplyRowsResult::default() } else { apply::apply_rows(&tx, &rows.0)? };
        tombstone::tombstone_ranges(&tx, uid, machine_hash, ranges, updated_at)?;
        tx.commit()?;
        Ok(result)
    }

    /// Delete every row of the data tables, keeping the schema and the meta
    /// table, in one transaction.
    pub fn truncate_cache(&mut self) -> Result<(), Error> {
        let tx = self.conn.savepoint()?;
        for table in DATA_TABLE_NAMES {
            tx.execute_batch(&format!("DELETE FROM {table}"))?;
        }
        tx.commit()?;
        Ok(())
    }

    /// The bundled SQLite version and this connection's journal mode and
    /// synchronous level, for the benchmark and tests to report.
    #[doc(hidden)]
    pub fn pragma_report(&self) -> Result<PragmaReport, Error> {
        Ok(PragmaReport {
            sqlite_version: self.conn.query_row("SELECT sqlite_version()", [], |r| r.get(0))?,
            journal_mode: self.conn.pragma_query_value(None, "journal_mode", |r| r.get(0))?,
            synchronous: self.conn.pragma_query_value(None, "synchronous", |r| r.get(0))?,
        })
    }
}

#[doc(hidden)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PragmaReport {
    pub sqlite_version: String,
    pub journal_mode: String,
    pub synchronous: i64,
}

/// The rows of one day file (blank, invalid and crash-truncated lines
/// dropped), for a caller that looks at them before applying them.
#[derive(Debug, Clone, Default)]
pub struct DayRows(Vec<jsonl::JsonlRow>);

impl DayRows {
    pub fn parse(text: &str) -> Self {
        Self(jsonl::read_rows(text))
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: &str = include_str!("../tests/fixtures/day.jsonl");

    /// A database at `path` holding the fixture day, its schema version set
    /// back to 5 (the drop of the v6 migration is the only step from 5).
    fn v5_database(path: &Path) {
        let mut db = TypingAnalyticsDb::open(path).unwrap();
        db.apply_day_jsonl(DAY).unwrap();
        db.conn
            .execute("UPDATE typing_analytics_meta SET value = '5' WHERE key = 'schema_version'", [])
            .unwrap();
    }

    /// The stored schema version and the matrix rollup rows, read without
    /// migrating.
    fn on_disk(path: &Path) -> (String, i64) {
        let conn = Connection::open(path).unwrap();
        let version = conn
            .query_row("SELECT value FROM typing_analytics_meta WHERE key = 'schema_version'", [], |r| {
                r.get(0)
            })
            .unwrap();
        let rows = conn.query_row("SELECT COUNT(*) FROM typing_matrix_minute", [], |r| r.get(0)).unwrap();
        (version, rows)
    }

    #[test]
    fn a_dropping_migration_stays_due_until_committed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("typing-analytics.db");
        v5_database(&path);
        let before = on_disk(&path);
        assert_eq!(before.0, "5");
        assert!(before.1 > 0);

        // A rebuild that fails rolls back; one that never finishes (the
        // connection closes) does the same.
        let mut db = TypingAnalyticsDb::open(&path).unwrap();
        assert!(db.cache_needs_rebuild());
        db.rollback_migration().unwrap();
        drop(db);
        assert_eq!(on_disk(&path), before);
        let db = TypingAnalyticsDb::open(&path).unwrap();
        assert!(db.cache_needs_rebuild());
        drop(db);
        assert_eq!(on_disk(&path), before);

        // The rebuild applies inside the open migration and commits with it.
        let mut db = TypingAnalyticsDb::open(&path).unwrap();
        assert!(db.cache_needs_rebuild());
        assert_eq!(
            db.conn
                .query_row("SELECT COUNT(*) FROM typing_matrix_minute", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        db.apply_day_jsonl(DAY).unwrap();
        db.commit_migration().unwrap();
        drop(db);
        assert_eq!(on_disk(&path), (SCHEMA_VERSION.to_string(), before.1));
        assert!(!TypingAnalyticsDb::open(&path).unwrap().cache_needs_rebuild());
    }

    #[test]
    fn an_open_without_a_dropping_migration_commits_at_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("typing-analytics.db");
        let mut db = TypingAnalyticsDb::open(&path).unwrap();
        assert!(!db.cache_needs_rebuild());
        db.rollback_migration().unwrap();
        db.apply_day_jsonl(DAY).unwrap();
        drop(db);
        let (version, rows) = on_disk(&path);
        assert_eq!(version, SCHEMA_VERSION.to_string());
        assert!(rows > 0);
    }
}
