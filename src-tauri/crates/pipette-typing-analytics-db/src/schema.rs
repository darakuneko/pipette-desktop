// SPDX-License-Identifier: GPL-2.0-or-later
//! Schema setup on open: the same three phases as the TypeScript constructor
//! (typing-analytics-db-base.ts). The meta table comes first so the stored
//! schema version can be read, the additive migrations run next, and the
//! full schema (every table and index) last, so indexes that name a column
//! a migration adds see that column.

use rusqlite::{Connection, OptionalExtension, named_params, params};

use crate::Error;
use crate::sql::{CREATE_META, CREATE_SCHEMA, GET_META, SET_META};

pub const SCHEMA_VERSION: i64 = 8;

/// User-data tables, child before parent (`DATA_TABLE_NAMES`, schema.ts).
pub const DATA_TABLE_NAMES: [&str; 7] = [
    "typing_char_minute",
    "typing_matrix_minute",
    "typing_minute_stats",
    "typing_bigram_minute",
    "typing_trigram_minute",
    "typing_sessions",
    "typing_scopes",
];

/// What opening the database found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchemaOutcome {
    /// A migration dropped tables, so the cache must be rebuilt from the
    /// JSONL masters before it serves queries.
    pub cache_needs_rebuild: bool,
}

/// The stored version as the TypeScript side reads it with `Number()` for
/// decimal text: blank is 0, anything else unparsable is NaN (`None`). A
/// NaN never equals SCHEMA_VERSION and fails every `<` test, so it gets no
/// migration and is overwritten. JavaScript-only forms (`0x10`, `Infinity`)
/// are not reproduced; only this layer writes the value, always decimal.
fn js_number(text: &str) -> Option<f64> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Some(0.0);
    }
    if !trimmed.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'-' | b'+' | b'e' | b'E')) {
        return None;
    }
    trimmed.parse::<f64>().ok()
}

pub(crate) fn prepare_schema(conn: &Connection) -> Result<SchemaOutcome, Error> {
    conn.execute_batch(CREATE_META)?;
    let stored: Option<String> =
        conn.query_row(GET_META, params!["schema_version"], |r| r.get(0)).optional()?;
    let stored_version = stored.as_deref().map(js_number);
    let mut outcome = SchemaOutcome { cache_needs_rebuild: false };
    if let Some(version) = stored_version
        && version != Some(SCHEMA_VERSION as f64)
    {
        outcome = migrate(conn, version)?;
    }
    conn.execute_batch(CREATE_SCHEMA)?;
    if stored_version != Some(Some(SCHEMA_VERSION as f64)) {
        conn.execute(
            SET_META,
            named_params! {"@key": "schema_version", "@value": SCHEMA_VERSION.to_string()},
        )?;
    }
    Ok(outcome)
}

/// The additive migrations of typing-analytics-db-base.ts, in the same
/// order and with the same version tests.
fn migrate(conn: &Connection, from: Option<f64>) -> Result<SchemaOutcome, Error> {
    let mut outcome = SchemaOutcome { cache_needs_rebuild: false };
    let Some(from) = from else { return Ok(outcome) };
    if from > SCHEMA_VERSION as f64 {
        return Err(Error::SchemaTooNew { stored: from, supported: SCHEMA_VERSION });
    }
    if from < 2.0 {
        conn.execute_batch(
            "ALTER TABLE typing_matrix_minute ADD COLUMN tap_count INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE typing_matrix_minute ADD COLUMN hold_count INTEGER NOT NULL DEFAULT 0;",
        )?;
    }
    if from < 4.0 {
        conn.execute_batch(
            "ALTER TABLE typing_char_minute ADD COLUMN app_name TEXT;
             ALTER TABLE typing_matrix_minute ADD COLUMN app_name TEXT;
             ALTER TABLE typing_minute_stats ADD COLUMN app_name TEXT;
             ALTER TABLE typing_bigram_minute ADD COLUMN app_name TEXT;",
        )?;
    }
    if from < 5.0 {
        conn.execute_batch(
            "ALTER TABLE typing_char_minute ADD COLUMN typing_test TEXT;
             ALTER TABLE typing_matrix_minute ADD COLUMN typing_test TEXT;
             ALTER TABLE typing_minute_stats ADD COLUMN typing_test TEXT;
             ALTER TABLE typing_bigram_minute ADD COLUMN typing_test TEXT;",
        )?;
    }
    // run_id joins each rollup's primary key, which ALTER cannot do: the
    // rollups are dropped, CREATE_SCHEMA recreates them and the caller
    // rebuilds them from the JSONL masters.
    if from < 6.0 {
        conn.execute_batch(
            "DROP TABLE IF EXISTS typing_char_minute;
             DROP TABLE IF EXISTS typing_matrix_minute;
             DROP TABLE IF EXISTS typing_minute_stats;
             DROP TABLE IF EXISTS typing_bigram_minute;",
        )?;
        outcome.cache_needs_rebuild = true;
    }
    // Exact version tests: a database older than v6 had these tables
    // dropped above and recreated with the columns already in place.
    if from == 6.0 {
        conn.execute_batch(
            "ALTER TABLE typing_bigram_minute ADD COLUMN sum_iki REAL;
             ALTER TABLE typing_bigram_minute ADD COLUMN sumsq_iki REAL;",
        )?;
    }
    if from == 6.0 || from == 7.0 {
        conn.execute_batch(
            "ALTER TABLE typing_matrix_minute ADD COLUMN dur_hist BLOB;
             ALTER TABLE typing_matrix_minute ADD COLUMN dur_sum REAL;
             ALTER TABLE typing_matrix_minute ADD COLUMN dur_sumsq REAL;
             ALTER TABLE typing_bigram_minute ADD COLUMN overlap_count INTEGER;
             ALTER TABLE typing_bigram_minute ADD COLUMN overlap_n INTEGER;
             ALTER TABLE typing_minute_stats ADD COLUMN poll_p50_ms REAL;
             ALTER TABLE typing_minute_stats ADD COLUMN poll_p95_ms REAL;",
        )?;
    }
    Ok(outcome)
}
