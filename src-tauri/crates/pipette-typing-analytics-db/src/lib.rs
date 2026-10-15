// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing-analytics SQLite cache (src/main/typing-analytics/db/ on the
//! TypeScript side): a rebuildable index over the per-day JSONL masters.
//!
//! The API is coarse on purpose: each call is one unit of work and owns its
//! transaction, so a caller can never leave half a day applied.
//!
//! - [`TypingAnalyticsDb::apply_day_jsonl`] — one day file, one transaction
//!   (`applyRowsToCache`).
//! - [`TypingAnalyticsDb::apply_day_jsonl_hiding_ranges`] — one day file of
//!   another device plus the tombstones of that device's deleted ranges, one
//!   transaction (`replayDayRowsHidingDeletedRanges`).
//! - [`TypingAnalyticsDb::minute_stats_in_range`] — the Analyze WPM /
//!   Interval query.

mod apply;
mod jsonl;
mod query;
mod schema;
mod sql;

use std::path::Path;

use rusqlite::Connection;
use rusqlite::config::DbConfig;
use schema::SchemaOutcome;

pub use apply::{ApplyRowsResult, DeleteRange};
pub use query::{MinuteStatsRow, ScopeFilters};
pub use schema::{DATA_TABLE_NAMES, SCHEMA_VERSION};

/// Statements kept prepared per connection; above the number this crate
/// uses, so none is ever re-prepared.
const STATEMENT_CACHE_CAPACITY: usize = 32;

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
}

impl TypingAnalyticsDb {
    /// Open (creating when missing) the database at `path` and bring its
    /// schema up to [`SCHEMA_VERSION`]. The parent directory must exist.
    pub fn open(path: &Path) -> Result<Self, Error> {
        Self::with_connection(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self, Error> {
        Self::with_connection(Connection::open_in_memory()?)
    }

    fn with_connection(conn: Connection) -> Result<Self, Error> {
        conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE_CAPACITY);
        // better-sqlite3 builds SQLite with SQLITE_DEFAULT_WAL_SYNCHRONOUS=1,
        // so the Electron app runs its WAL database at NORMAL; SQLite's own
        // default (this bundled build) is FULL. NORMAL can lose the last
        // commits on power loss but never corrupts, and the cache is
        // rebuildable from the JSONL masters.
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        // The rest of better-sqlite3's build options (deps/defines.gypi of
        // better-sqlite3) that change how this layer's SQL behaves: a 16 MB
        // page cache (SQLITE_DEFAULT_CACHE_SIZE=-16000) and double-quoted
        // strings read only as identifiers (SQLITE_DQS=0), so SQL that the
        // app rejects is rejected here too.
        conn.pragma_update(None, "cache_size", -16000)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
        conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
        let outcome = schema::prepare_schema(&conn)?;
        Ok(Self { conn, outcome })
    }

    /// True when opening dropped tables, so the cache must be rebuilt from
    /// the JSONL masters before it serves queries.
    pub fn cache_needs_rebuild(&self) -> bool {
        self.outcome.cache_needs_rebuild
    }

    /// Apply one day file's text. On any error nothing of the file stays
    /// applied.
    pub fn apply_day_jsonl(&mut self, text: &str) -> Result<ApplyRowsResult, Error> {
        let rows = jsonl::read_rows(text);
        if rows.is_empty() {
            return Ok(ApplyRowsResult::default());
        }
        let tx = self.conn.transaction()?;
        let result = apply::apply_rows(&tx, &rows)?;
        tx.commit()?;
        Ok(result)
    }

    /// Apply one day file of `machine_hash` and tombstone its rows inside
    /// `ranges` (that device's deleted ranges, clipped to the file's UTC
    /// day) in the same transaction, so a reader never sees an in-range row
    /// live. With no ranges this is [`Self::apply_day_jsonl`].
    pub fn apply_day_jsonl_hiding_ranges(
        &mut self,
        text: &str,
        uid: &str,
        machine_hash: &str,
        ranges: &[DeleteRange],
        updated_at: i64,
    ) -> Result<ApplyRowsResult, Error> {
        if ranges.is_empty() {
            return self.apply_day_jsonl(text);
        }
        let rows = jsonl::read_rows(text);
        let tx = self.conn.transaction()?;
        let result =
            if rows.is_empty() { ApplyRowsResult::default() } else { apply::apply_rows(&tx, &rows)? };
        apply::tombstone_ranges(&tx, uid, machine_hash, ranges, updated_at)?;
        tx.commit()?;
        Ok(result)
    }

    pub fn minute_stats_in_range(
        &self,
        uid: &str,
        since_ms: i64,
        until_ms: i64,
        filters: &ScopeFilters,
    ) -> Result<Vec<MinuteStatsRow>, Error> {
        query::minute_stats_in_range(&self.conn, uid, since_ms, until_ms, filters)
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
