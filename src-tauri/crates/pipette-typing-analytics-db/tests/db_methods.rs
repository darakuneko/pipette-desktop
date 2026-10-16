// SPDX-License-Identifier: GPL-2.0-or-later
//! The behaviour of each DB method, case by case, as the TypeScript DB
//! layer's own tests (src/main/typing-analytics/db/__tests__/
//! typing-analytics-db.test.ts) pin it. The sync export selects and the
//! per-scope listers those tests also cover have no Rust counterpart.
//!
//! The merges go through JSONL rows, the only way this crate applies them.
//! The tables are read back through a second, read-only connection.

#![allow(clippy::unwrap_used)]

mod common;

use std::path::{Path, PathBuf};

use common::open_read_only;
use pipette_typing_analytics_db::{
    AppAggregate, CharMinuteInput, DeleteRange, Gram, MatrixMinuteInput, MinuteStatsInput,
    NgramMinuteCellRow, Overlap, SCHEMA_VERSION, ScopeFilters, ScopeInput, SessionInput, TombstoneResult,
    TypingAnalyticsDb,
};
use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, params_from_iter};
use serde_json::{Value, json};
use tempfile::TempDir;

const HASH: &str = "hash-abc";

struct Fixture {
    _dir: TempDir,
    path: PathBuf,
    db: TypingAnalyticsDb,
}

impl Fixture {
    fn new() -> Self {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("typing-analytics.db");
        let db = TypingAnalyticsDb::open(&path).unwrap();
        Self { _dir: dir, path, db }
    }

    /// The rows of `query`, each cell as SQLite gives it.
    fn rows(&self, query: &str, params: &[&dyn rusqlite::ToSql]) -> Vec<Vec<SqlValue>> {
        let conn = open_read_only(&self.path);
        let mut stmt = conn.prepare(query).unwrap();
        let width = stmt.column_count();
        stmt.query_map(params_from_iter(params.iter()), |r| (0..width).map(|i| r.get(i)).collect())
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn one(&self, query: &str, params: &[&dyn rusqlite::ToSql]) -> Vec<SqlValue> {
        let mut rows = self.rows(query, params);
        assert_eq!(rows.len(), 1, "{query}");
        rows.remove(0)
    }

    fn scope(&mut self, id: &str, machine_hash: &str, uid: &str) {
        self.db.upsert_scope(&scope_input(id, machine_hash, uid, 1_000.0)).unwrap();
    }

    fn minute(
        &mut self,
        stats: MinuteStatsInput,
        chars: &[CharMinuteInput],
        matrix: &[MatrixMinuteInput],
        at: f64,
    ) {
        self.db.write_minute(&stats, chars, matrix, at).unwrap();
    }

    /// A matrix cell and its minute's stats (`writeMatrix` of the TypeScript
    /// tests).
    fn matrix(
        &mut self,
        scope_id: &str,
        minute_ts: f64,
        cell: (f64, f64, f64),
        count: f64,
        tap_hold: (f64, f64),
    ) {
        let m = MatrixMinuteInput {
            tap_count: Some(tap_hold.0),
            hold_count: Some(tap_hold.1),
            ..matrix_input(scope_id, minute_ts, cell, 4.0, count)
        };
        self.minute(stats(scope_id, minute_ts, 1.0), &[], &[m], 1_000.0);
    }

    /// Apply JSONL rows `(kind, payload, updated_at, is_deleted)`.
    fn merge(&mut self, rows: &[(&str, Value, f64, bool)]) {
        let text: String = rows
            .iter()
            .map(|(kind, payload, updated_at, deleted)| {
                let line = json!({ "id": "x", "kind": kind, "updated_at": updated_at, "is_deleted": deleted, "payload": payload });
                format!("{line}\n")
            })
            .collect();
        self.db.apply_day_jsonl(&text).unwrap();
    }
}

fn scope_input(id: &str, machine_hash: &str, uid: &str, updated_at: f64) -> ScopeInput {
    ScopeInput {
        id: id.into(),
        machine_hash: machine_hash.into(),
        os_platform: "linux".into(),
        os_release: "6.8.0".into(),
        os_arch: "x64".into(),
        keyboard_uid: uid.into(),
        keyboard_vendor_id: f64::from(0xfeed),
        keyboard_product_id: 0.0,
        keyboard_product_name: "Pipette".into(),
        updated_at,
    }
}

fn scope_json(id: &str, machine_hash: &str, uid: &str) -> Value {
    json!({
        "id": id, "machineHash": machine_hash, "osPlatform": "linux", "osRelease": "6.8.0", "osArch": "x64",
        "keyboardUid": uid, "keyboardVendorId": 0xfeed, "keyboardProductId": 0, "keyboardProductName": "Pipette",
    })
}

fn stats(scope_id: &str, minute_ts: f64, keystrokes: f64) -> MinuteStatsInput {
    MinuteStatsInput {
        scope_id: scope_id.into(),
        minute_ts,
        keystrokes,
        active_ms: 1.0,
        interval_avg_ms: Some(1.0),
        interval_min_ms: Some(1.0),
        interval_p25_ms: Some(1.0),
        interval_p50_ms: Some(1.0),
        interval_p75_ms: Some(1.0),
        interval_max_ms: Some(1.0),
        app_name: None,
        typing_test: None,
        run_id: None,
    }
}

fn char_input(scope_id: &str, minute_ts: f64, ch: &str, count: f64) -> CharMinuteInput {
    CharMinuteInput {
        scope_id: scope_id.into(),
        minute_ts,
        char: ch.into(),
        count,
        app_name: None,
        typing_test: None,
        run_id: None,
    }
}

fn matrix_input(
    scope_id: &str,
    minute_ts: f64,
    (row, col, layer): (f64, f64, f64),
    keycode: f64,
    count: f64,
) -> MatrixMinuteInput {
    MatrixMinuteInput {
        scope_id: scope_id.into(),
        minute_ts,
        row,
        col,
        layer,
        keycode,
        count,
        tap_count: None,
        hold_count: None,
        app_name: None,
        typing_test: None,
        run_id: None,
    }
}

fn session(id: &str, scope_id: &str, start_ms: f64, end_ms: f64) -> SessionInput {
    SessionInput { id: id.into(), scope_id: scope_id.into(), start_ms, end_ms }
}

fn hist(values: &[u32]) -> [f64; 8] {
    let mut out = [0.0; 8];
    for (slot, v) in out.iter_mut().zip(values) {
        *slot = f64::from(*v);
    }
    out
}

fn bigram(scope_id: &str, minute_ts: f64, id: &str, entry: Value) -> Value {
    json!({ "scopeId": scope_id, "minuteTs": minute_ts, "bigrams": { id: entry } })
}

fn trigram(scope_id: &str, minute_ts: f64, id: &str, entry: Value) -> Value {
    json!({ "scopeId": scope_id, "minuteTs": minute_ts, "trigrams": { id: entry } })
}

fn entry(count: u32, h: &[u32]) -> Value {
    json!({ "c": count, "h": hist(h) })
}

fn int(v: &SqlValue) -> i64 {
    match v {
        SqlValue::Integer(i) => *i,
        other => panic!("not an integer: {other:?}"),
    }
}

fn text(v: &SqlValue) -> &str {
    match v {
        SqlValue::Text(t) => t,
        other => panic!("not text: {other:?}"),
    }
}

const NO_FILTER: ScopeFilters =
    ScopeFilters { app_names: Vec::new(), typing_tests: Vec::new(), run_ids: Vec::new() };

fn tests(names: &[&str]) -> ScopeFilters {
    ScopeFilters { typing_tests: names.iter().map(|s| (*s).to_owned()).collect(), ..NO_FILTER }
}

fn runs(ids: &[&str]) -> ScopeFilters {
    ScopeFilters { run_ids: ids.iter().map(|s| (*s).to_owned()).collect(), ..NO_FILTER }
}

fn apps(names: &[&str]) -> ScopeFilters {
    ScopeFilters { app_names: names.iter().map(|s| (*s).to_owned()).collect(), ..NO_FILTER }
}

fn has_column(path: &Path, table: &str, name: &str) -> bool {
    let conn = open_read_only(path);
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})")).unwrap();
    stmt.query_map([], |r| r.get::<_, String>("name")).unwrap().any(|n| n.unwrap() == name)
}

fn stored_version(path: &Path) -> String {
    open_read_only(path)
        .query_row("SELECT value FROM typing_analytics_meta WHERE key = 'schema_version'", [], |r| r.get(0))
        .unwrap()
}

// --- schema --------------------------------------------------------------

/// The pre-v8 shape of the four data tables a v6 or v7 database has.
fn legacy_tables(conn: &Connection, bigram_sums: bool, trigram: bool) {
    let sums = if bigram_sums { "sum_iki REAL, sumsq_iki REAL," } else { "" };
    let trigram_table = if trigram {
        "CREATE TABLE typing_trigram_minute (
           scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL, trigram_id TEXT NOT NULL, count INTEGER NOT NULL,
           hist BLOB NOT NULL, sum_iki REAL, sumsq_iki REAL, app_name TEXT, typing_test TEXT,
           run_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (scope_id, minute_ts, run_id, trigram_id));"
    } else {
        ""
    };
    conn.execute_batch(&format!(
        "CREATE TABLE typing_analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE typing_scopes (
           id TEXT PRIMARY KEY, machine_hash TEXT NOT NULL, os_platform TEXT NOT NULL, os_release TEXT NOT NULL,
           os_arch TEXT NOT NULL, keyboard_uid TEXT NOT NULL, keyboard_vendor_id INTEGER NOT NULL,
           keyboard_product_id INTEGER NOT NULL, keyboard_product_name TEXT NOT NULL, updated_at INTEGER NOT NULL,
           is_deleted INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE typing_matrix_minute (
           scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL,
           layer INTEGER NOT NULL, keycode INTEGER NOT NULL, count INTEGER NOT NULL,
           tap_count INTEGER NOT NULL DEFAULT 0, hold_count INTEGER NOT NULL DEFAULT 0, app_name TEXT,
           typing_test TEXT, run_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
           is_deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope_id, minute_ts, run_id, row, col, layer));
         CREATE TABLE typing_minute_stats (
           scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL, keystrokes INTEGER NOT NULL, active_ms INTEGER NOT NULL,
           interval_avg_ms INTEGER, interval_min_ms INTEGER, interval_p25_ms INTEGER, interval_p50_ms INTEGER,
           interval_p75_ms INTEGER, interval_max_ms INTEGER, app_name TEXT, typing_test TEXT,
           run_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (scope_id, minute_ts, run_id));
         CREATE TABLE typing_bigram_minute (
           scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL, bigram_id TEXT NOT NULL, count INTEGER NOT NULL,
           hist BLOB NOT NULL, {sums} app_name TEXT, typing_test TEXT, run_id TEXT NOT NULL DEFAULT '',
           updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (scope_id, minute_ts, run_id, bigram_id));
         {trigram_table}
         INSERT INTO typing_scopes VALUES ('scope-1', 'hash-abc', 'linux', '6.8.0', 'x64', '0xAABB', 65261, 0, 'Pipette', 1000, 0);"
    ))
    .unwrap();
}

const V8_COLUMNS: [(&str, &str); 7] = [
    ("typing_matrix_minute", "dur_hist"),
    ("typing_matrix_minute", "dur_sum"),
    ("typing_matrix_minute", "dur_sumsq"),
    ("typing_bigram_minute", "overlap_count"),
    ("typing_bigram_minute", "overlap_n"),
    ("typing_minute_stats", "poll_p50_ms"),
    ("typing_minute_stats", "poll_p95_ms"),
];

#[test]
fn stores_the_schema_version_on_first_open_with_every_v8_column() {
    let f = Fixture::new();
    assert_eq!(stored_version(&f.path), SCHEMA_VERSION.to_string());
    assert!(!f.db.cache_needs_rebuild());
    for (table, column) in V8_COLUMNS {
        assert!(has_column(&f.path, table, column), "{table}.{column}");
    }
}

#[test]
fn upgrades_a_v3_database_once_the_rebuild_commits() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("typing-analytics.db");
    let v3 = Connection::open(&path).unwrap();
    v3.execute_batch(
        "CREATE TABLE typing_analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE typing_scopes (
           id TEXT PRIMARY KEY, machine_hash TEXT NOT NULL, os_platform TEXT NOT NULL, os_release TEXT NOT NULL,
           os_arch TEXT NOT NULL, keyboard_uid TEXT NOT NULL, keyboard_vendor_id INTEGER NOT NULL,
           keyboard_product_id INTEGER NOT NULL, keyboard_product_name TEXT NOT NULL, updated_at INTEGER NOT NULL,
           is_deleted INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE typing_char_minute (
           scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL, char TEXT NOT NULL, count INTEGER NOT NULL,
           updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (scope_id, minute_ts, char));
         CREATE TABLE typing_matrix_minute (
           scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL,
           layer INTEGER NOT NULL, keycode INTEGER NOT NULL, count INTEGER NOT NULL,
           tap_count INTEGER NOT NULL DEFAULT 0, hold_count INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (scope_id, minute_ts, row, col, layer));
         CREATE TABLE typing_minute_stats (
           scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL, keystrokes INTEGER NOT NULL, active_ms INTEGER NOT NULL,
           interval_avg_ms INTEGER, interval_min_ms INTEGER, interval_p25_ms INTEGER, interval_p50_ms INTEGER,
           interval_p75_ms INTEGER, interval_max_ms INTEGER, updated_at INTEGER NOT NULL,
           is_deleted INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (scope_id, minute_ts));
         CREATE TABLE typing_bigram_minute (
           scope_id TEXT NOT NULL, minute_ts INTEGER NOT NULL, bigram_id TEXT NOT NULL, count INTEGER NOT NULL,
           hist BLOB NOT NULL, updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0,
           PRIMARY KEY (scope_id, minute_ts, bigram_id));
         CREATE TABLE typing_sessions (
           id TEXT PRIMARY KEY, scope_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
           updated_at INTEGER NOT NULL, is_deleted INTEGER NOT NULL DEFAULT 0);
         INSERT INTO typing_analytics_meta (key, value) VALUES ('schema_version', '3');",
    )
    .unwrap();
    drop(v3);

    // The tables dropped for the run_id key are rebuilt from the masters;
    // the new version reaches the file with that rebuild.
    let mut db = TypingAnalyticsDb::open(&path).unwrap();
    assert!(db.cache_needs_rebuild());
    db.commit_migration().unwrap();
    assert_eq!(stored_version(&path), SCHEMA_VERSION.to_string());
    for table in ["typing_char_minute", "typing_matrix_minute", "typing_minute_stats", "typing_bigram_minute"]
    {
        assert!(has_column(&path, table, "app_name"), "{table}");
    }
}

#[test]
fn upgrades_a_v6_database_without_a_rebuild() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("typing-analytics.db");
    let v6 = Connection::open(&path).unwrap();
    legacy_tables(&v6, false, false);
    v6.execute_batch(
        "INSERT INTO typing_bigram_minute (scope_id, minute_ts, bigram_id, count, hist, app_name, typing_test, run_id, updated_at, is_deleted)
           VALUES ('scope-1', 60000, '4_11', 3, X'0300000000000000000000000000000000000000000000000000000000', NULL, NULL, '', 2000, 0);
         INSERT INTO typing_analytics_meta (key, value) VALUES ('schema_version', '6');",
    )
    .unwrap();
    drop(v6);

    let db = TypingAnalyticsDb::open(&path).unwrap();
    assert!(!db.cache_needs_rebuild());
    assert_eq!(stored_version(&path), SCHEMA_VERSION.to_string());
    assert!(has_column(&path, "typing_bigram_minute", "sum_iki"));
    assert!(has_column(&path, "typing_bigram_minute", "sumsq_iki"));
    let conn = open_read_only(&path);
    let row: (i64, Option<f64>, Option<f64>) = conn
        .query_row(
            "SELECT count, sum_iki, sumsq_iki FROM typing_bigram_minute WHERE bigram_id = '4_11'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, (3, None, None));
    let trigram: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'typing_trigram_minute'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(trigram, 1);
    for (table, column) in V8_COLUMNS {
        assert!(has_column(&path, table, column), "{table}.{column}");
    }
}

#[test]
fn upgrades_a_v7_database_keeping_its_rows() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().join("typing-analytics.db");
    let v7 = Connection::open(&path).unwrap();
    legacy_tables(&v7, true, true);
    v7.execute_batch(
        "INSERT INTO typing_matrix_minute (scope_id, minute_ts, row, col, layer, keycode, count, tap_count, hold_count, run_id, updated_at, is_deleted)
           VALUES ('scope-1', 60000, 0, 0, 0, 4, 5, 2, 0, '', 2000, 0);
         INSERT INTO typing_bigram_minute (scope_id, minute_ts, bigram_id, count, hist, sum_iki, sumsq_iki, run_id, updated_at, is_deleted)
           VALUES ('scope-1', 60000, '4_11', 3, X'0300000000000000000000000000000000000000000000000000000000', 250, 22000, '', 2000, 0);
         INSERT INTO typing_minute_stats (scope_id, minute_ts, keystrokes, active_ms, run_id, updated_at, is_deleted)
           VALUES ('scope-1', 60000, 5, 1000, '', 2000, 0);
         INSERT INTO typing_analytics_meta (key, value) VALUES ('schema_version', '7');",
    )
    .unwrap();
    drop(v7);

    let db = TypingAnalyticsDb::open(&path).unwrap();
    assert!(!db.cache_needs_rebuild());
    assert_eq!(stored_version(&path), SCHEMA_VERSION.to_string());
    for (table, column) in V8_COLUMNS {
        assert!(has_column(&path, table, column), "{table}.{column}");
    }
    let conn = open_read_only(&path);
    let matrix: (i64, i64, Option<Vec<u8>>, Option<f64>, Option<f64>) = conn
        .query_row(
            "SELECT count, tap_count, dur_hist, dur_sum, dur_sumsq FROM typing_matrix_minute",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .unwrap();
    assert_eq!(matrix, (5, 2, None, None, None));
    let bigram: (i64, f64, Option<i64>, Option<i64>) = conn
        .query_row("SELECT count, sum_iki, overlap_count, overlap_n FROM typing_bigram_minute", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap();
    assert_eq!(bigram, (3, 250.0, None, None));
    let stats: (i64, Option<f64>, Option<f64>) = conn
        .query_row("SELECT keystrokes, poll_p50_ms, poll_p95_ms FROM typing_minute_stats", [], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap();
    assert_eq!(stats, (5, None, None));
}

#[test]
fn reopens_an_existing_database_file() {
    let mut f = Fixture::new();
    f.scope("scope-1", HASH, "0xAABB");
    let path = f.path.clone();
    drop(f.db);
    let reopened = TypingAnalyticsDb::open(&path).unwrap();
    assert!(!reopened.cache_needs_rebuild());
    assert_eq!(text(&f_one(&path, "SELECT id FROM typing_scopes")[0]), "scope-1");
}

fn f_one(path: &Path, query: &str) -> Vec<SqlValue> {
    let conn = open_read_only(path);
    let mut stmt = conn.prepare(query).unwrap();
    let width = stmt.column_count();
    stmt.query_row([], |r| (0..width).map(|i| r.get(i)).collect()).unwrap()
}

// --- ingest --------------------------------------------------------------

#[test]
fn upserts_a_scope_keeping_the_newest() {
    let mut f = Fixture::new();
    f.db.upsert_scope(&scope_input("scope-1", HASH, "0xAABB", 1_000.0)).unwrap();
    f.db.upsert_scope(&ScopeInput {
        keyboard_product_name: "stale".into(),
        ..scope_input("scope-1", HASH, "0xAABB", 500.0)
    })
    .unwrap();
    let row = f.one("SELECT keyboard_product_name, updated_at FROM typing_scopes WHERE id = 'scope-1'", &[]);
    assert_eq!((text(&row[0]), int(&row[1])), ("Pipette", 1_000));
}

#[test]
fn accumulates_char_and_stats_counts_on_conflict() {
    let mut f = Fixture::new();
    f.scope("scope-1", HASH, "0xAABB");
    let s = |k: f64, active: f64| MinuteStatsInput { active_ms: active, ..stats("scope-1", 60_000.0, k) };
    f.minute(
        s(3.0, 1_500.0),
        &[char_input("scope-1", 60_000.0, "a", 2.0), char_input("scope-1", 60_000.0, "b", 1.0)],
        &[],
        2_000.0,
    );
    f.minute(s(1.0, 500.0), &[char_input("scope-1", 60_000.0, "a", 3.0)], &[], 3_000.0);
    let rows = f.rows("SELECT char, count FROM typing_char_minute ORDER BY char", &[]);
    assert_eq!(
        rows.iter().map(|r| (text(&r[0]).to_owned(), int(&r[1]))).collect::<Vec<_>>(),
        [("a".to_owned(), 5), ("b".to_owned(), 1)]
    );
    let stats_row = f.one("SELECT keystrokes, active_ms FROM typing_minute_stats", &[]);
    assert_eq!((int(&stats_row[0]), int(&stats_row[1])), (4, 2_000));
}

#[test]
fn keeps_two_runs_of_a_minute_apart() {
    let mut f = Fixture::new();
    f.scope("scope-1", HASH, "0xAABB");
    for (run, count) in [(Some("run-1"), 2.0), (Some("run-2"), 3.0), (None, 1.0)] {
        let stats = MinuteStatsInput { run_id: run.map(str::to_owned), ..stats("scope-1", 60_000.0, count) };
        let c =
            CharMinuteInput { run_id: run.map(str::to_owned), ..char_input("scope-1", 60_000.0, "a", count) };
        f.minute(stats, &[c], &[], 2_000.0);
    }
    let chars = f.rows("SELECT run_id, count FROM typing_char_minute ORDER BY run_id", &[]);
    let got: Vec<(String, i64)> = chars.iter().map(|r| (text(&r[0]).to_owned(), int(&r[1]))).collect();
    assert_eq!(got, [("".to_owned(), 1), ("run-1".to_owned(), 2), ("run-2".to_owned(), 3)]);
    let stats_rows = f.rows("SELECT run_id, keystrokes FROM typing_minute_stats ORDER BY run_id", &[]);
    let got: Vec<(String, i64)> = stats_rows.iter().map(|r| (text(&r[0]).to_owned(), int(&r[1]))).collect();
    assert_eq!(got, [("".to_owned(), 1), ("run-1".to_owned(), 2), ("run-2".to_owned(), 3)]);
}

#[test]
fn accumulates_matrix_counts_on_conflict() {
    let mut f = Fixture::new();
    f.scope("scope-1", HASH, "0xAABB");
    let cell = |count| matrix_input("scope-1", 60_000.0, (0.0, 3.0, 0.0), 4.0, count);
    f.minute(stats("scope-1", 60_000.0, 1.0), &[], &[cell(2.0)], 1_000.0);
    f.minute(stats("scope-1", 60_000.0, 1.0), &[], &[cell(3.0)], 2_000.0);
    let row = f.one("SELECT count, keycode FROM typing_matrix_minute", &[]);
    assert_eq!((int(&row[0]), int(&row[1])), (5, 4));
}

#[test]
fn inserts_a_session_and_ignores_an_older_one() {
    let mut f = Fixture::new();
    f.scope("scope-1", HASH, "0xAABB");
    f.db.insert_session(&session("session-1", "scope-1", 10_000.0, 20_000.0), 3_000.0).unwrap();
    f.db.insert_session(&session("session-1", "scope-1", 999.0, 999.0), 1_000.0).unwrap();
    let row = f.one("SELECT start_ms, end_ms FROM typing_sessions", &[]);
    assert_eq!((int(&row[0]), int(&row[1])), (10_000, 20_000));
}

#[test]
fn retains_only_the_local_machines_recent_rows() {
    let mut f = Fixture::new();
    f.scope("local", HASH, "0xAABB");
    f.scope("remote", "other-machine", "0xAABB");
    for scope_id in ["local", "remote"] {
        f.minute(stats(scope_id, 50_000.0, 1.0), &[char_input(scope_id, 50_000.0, "a", 1.0)], &[], 1_000.0);
        f.minute(stats(scope_id, 200_000.0, 1.0), &[char_input(scope_id, 200_000.0, "b", 1.0)], &[], 2_000.0);
        f.db.insert_session(&session(&format!("{scope_id}-old"), scope_id, 10_000.0, 20_000.0), 1_000.0)
            .unwrap();
        f.db.insert_session(&session(&format!("{scope_id}-new"), scope_id, 150_000.0, 180_000.0), 2_000.0)
            .unwrap();
        f.merge(&[
            ("bigram-minute", bigram(scope_id, 50_000.0, "4_11", entry(1, &[1])), 1_000.0, false),
            ("bigram-minute", bigram(scope_id, 200_000.0, "4_11", entry(1, &[1])), 2_000.0, false),
            ("trigram-minute", trigram(scope_id, 50_000.0, "4_11_7", entry(1, &[1])), 1_000.0, false),
            ("trigram-minute", trigram(scope_id, 200_000.0, "4_11_7", entry(1, &[1])), 2_000.0, false),
        ]);
    }
    f.db.retain_own_data(HASH, 100_000.0).unwrap();
    let minutes = |table: &str, scope_id: &str| -> Vec<i64> {
        f.rows(&format!("SELECT minute_ts FROM {table} WHERE scope_id = ? ORDER BY minute_ts"), &[&scope_id])
            .iter()
            .map(|r| int(&r[0]))
            .collect()
    };
    for table in ["typing_char_minute", "typing_bigram_minute", "typing_trigram_minute"] {
        assert_eq!(minutes(table, "local"), [200_000], "{table}");
        assert_eq!(minutes(table, "remote"), [50_000, 200_000], "{table}");
    }
    let sessions = |scope_id: &str| -> Vec<String> {
        f.rows("SELECT id FROM typing_sessions WHERE scope_id = ? ORDER BY id", &[&scope_id])
            .iter()
            .map(|r| text(&r[0]).to_owned())
            .collect()
    };
    assert_eq!(sessions("local"), ["local-new"]);
    assert_eq!(sessions("remote"), ["remote-new", "remote-old"]);
}

// --- merge (authoritative LWW) -------------------------------------------

fn merge_fixture() -> Fixture {
    let mut f = Fixture::new();
    f.scope("scope-1", HASH, "0xAABB");
    f.minute(
        MinuteStatsInput { active_ms: 1_000.0, ..stats("scope-1", 60_000.0, 2.0) },
        &[char_input("scope-1", 60_000.0, "a", 2.0)],
        &[matrix_input("scope-1", 60_000.0, (0.0, 3.0, 0.0), 4.0, 2.0)],
        2_000.0,
    );
    f
}

fn char_row(count: u32) -> Value {
    json!({ "scopeId": "scope-1", "minuteTs": 60_000, "char": "a", "count": count })
}

#[test]
fn a_merge_replaces_a_row_only_when_newer() {
    let mut f = merge_fixture();
    f.merge(&[("char-minute", char_row(99), 1_000.0, false)]);
    let row = f.one("SELECT count, updated_at FROM typing_char_minute", &[]);
    assert_eq!((int(&row[0]), int(&row[1])), (2, 2_000));
    f.merge(&[("char-minute", char_row(99), 3_000.0, false)]);
    let row = f.one("SELECT count, updated_at FROM typing_char_minute", &[]);
    assert_eq!((int(&row[0]), int(&row[1])), (99, 3_000));
    f.merge(&[("char-minute", char_row(0), 4_000.0, true)]);
    assert_eq!(int(&f.one("SELECT is_deleted FROM typing_char_minute", &[])[0]), 1);
}

#[test]
fn merges_replace_matrix_stats_sessions_and_scopes_wholesale() {
    let mut f = merge_fixture();
    f.db.insert_session(&session("session-1", "scope-1", 10_000.0, 20_000.0), 3_000.0).unwrap();
    f.merge(&[
        (
            "matrix-minute",
            json!({ "scopeId": "scope-1", "minuteTs": 60_000, "row": 0, "col": 3, "layer": 0, "keycode": 4, "count": 7, "tapCount": 0, "holdCount": 0 }),
            3_000.0,
            false,
        ),
        (
            "minute-stats",
            json!({
                "scopeId": "scope-1", "minuteTs": 60_000, "keystrokes": 50, "activeMs": 4_000, "intervalAvgMs": 100,
                "intervalMinMs": 50, "intervalP25Ms": 60, "intervalP50Ms": 90, "intervalP75Ms": 130, "intervalMaxMs": 200,
            }),
            3_000.0,
            false,
        ),
        ("session", json!({ "id": "session-1", "scopeId": "scope-1", "startMs": 50_000, "endMs": 80_000 }), 4_000.0, false),
        ("scope", scope_json("scope-1", HASH, "0xAABB"), 5_000.0, true),
    ]);
    assert_eq!(int(&f.one("SELECT count FROM typing_matrix_minute", &[])[0]), 7);
    let s = f.one("SELECT keystrokes, active_ms, interval_max_ms FROM typing_minute_stats", &[]);
    assert_eq!((int(&s[0]), int(&s[1]), int(&s[2])), (50, 4_000, 200));
    let x = f.one("SELECT start_ms, end_ms FROM typing_sessions", &[]);
    assert_eq!((int(&x[0]), int(&x[1])), (50_000, 80_000));
    assert_eq!(int(&f.one("SELECT is_deleted FROM typing_scopes", &[])[0]), 1);
}

#[test]
fn ngram_merges_fan_out_per_id_follow_lww_and_store_the_sums() {
    let mut f = merge_fixture();
    f.merge(&[
        (
            "bigram-minute",
            json!({ "scopeId": "scope-1", "minuteTs": 60_000, "bigrams": {
                "4_11": { "c": 3, "h": hist(&[0, 1, 2]) },
                "22_22": { "c": 7, "h": hist(&[0, 0, 0, 0, 7]), "s": 240, "sq": 28_800 },
            } }),
            3_000.0,
            false,
        ),
        ("bigram-minute", bigram("scope-1", 60_000.0, "4_11", entry(999, &[9])), 2_500.0, false),
        (
            "trigram-minute",
            trigram(
                "scope-1",
                60_000.0,
                "4_11_7",
                json!({ "c": 3, "h": hist(&[0, 1, 2]), "s": 450, "sq": 67_500 }),
            ),
            3_000.0,
            false,
        ),
        ("trigram-minute", trigram("scope-1", 60_000.0, "4_11_7", entry(999, &[9])), 2_500.0, false),
        (
            "bigram-minute",
            json!({ "scopeId": "scope-1", "minuteTs": 120_000, "bigrams": {} }),
            3_000.0,
            false,
        ),
    ]);
    let rows = f.rows(
        "SELECT bigram_id, count, hist, sum_iki, sumsq_iki FROM typing_bigram_minute ORDER BY bigram_id",
        &[],
    );
    assert_eq!(rows.len(), 2);
    assert_eq!((text(&rows[0][0]), int(&rows[0][1])), ("22_22", 7));
    assert_eq!((rows[0][3].clone(), rows[0][4].clone()), (SqlValue::Real(240.0), SqlValue::Real(28_800.0)));
    assert_eq!((text(&rows[1][0]), int(&rows[1][1])), ("4_11", 3));
    assert_eq!((rows[1][3].clone(), rows[1][4].clone()), (SqlValue::Null, SqlValue::Null));
    let SqlValue::Blob(h) = &rows[1][2] else { panic!("hist is not a BLOB") };
    assert_eq!(h.len(), 32);
    assert_eq!(&h[8..12], &[2, 0, 0, 0]);
    let t = f.one("SELECT trigram_id, count, sum_iki, sumsq_iki FROM typing_trigram_minute", &[]);
    assert_eq!((text(&t[0]), int(&t[1])), ("4_11_7", 3));
    assert_eq!((t[2].clone(), t[3].clone()), (SqlValue::Real(450.0), SqlValue::Real(67_500.0)));
}

// --- the Data modal and the tombstones -----------------------------------

/// Two scopes of 0xAABB on two machines, 0xCCDD, and a keyboard with a
/// scope but no data.
fn data_modal() -> Fixture {
    let mut f = Fixture::new();
    for (id, hash, uid) in [
        ("scope-aabb-local", HASH, "0xAABB"),
        ("scope-aabb-remote", "other-machine", "0xAABB"),
        ("scope-ccdd-local", HASH, "0xCCDD"),
        ("scope-empty", HASH, "0xEEFF"),
    ] {
        f.scope(id, hash, uid);
    }
    let s = |id: &str, minute: f64, k: f64, active: f64| MinuteStatsInput {
        active_ms: active,
        ..stats(id, minute, k)
    };
    f.minute(
        s("scope-aabb-local", 60_000.0, 3.0, 1_000.0),
        &[char_input("scope-aabb-local", 60_000.0, "a", 3.0)],
        &[matrix_input("scope-aabb-local", 60_000.0, (0.0, 0.0, 0.0), 4.0, 3.0)],
        1_000.0,
    );
    f.minute(
        s("scope-aabb-remote", 60_000.0, 2.0, 500.0),
        &[char_input("scope-aabb-remote", 60_000.0, "a", 2.0)],
        &[],
        1_000.0,
    );
    f.minute(
        s("scope-ccdd-local", 120_000.0, 7.0, 2_000.0),
        &[char_input("scope-ccdd-local", 120_000.0, "b", 7.0)],
        &[],
        1_000.0,
    );
    f.db.insert_session(&session("session-aabb-1", "scope-aabb-local", 60_000.0, 61_000.0), 1_000.0).unwrap();
    f
}

fn tagged(
    scope_id: &str,
    minute: f64,
    keystrokes: f64,
    test: &str,
    run: Option<&str>,
) -> (MinuteStatsInput, MatrixMinuteInput) {
    let stats = MinuteStatsInput {
        typing_test: Some(test.into()),
        run_id: run.map(str::to_owned),
        ..stats(scope_id, minute, keystrokes)
    };
    let cell = MatrixMinuteInput {
        typing_test: Some(test.into()),
        run_id: run.map(str::to_owned),
        ..matrix_input(scope_id, minute, (1.0, 1.0, 0.0), 5.0, keystrokes)
    };
    (stats, cell)
}

fn cell_total(f: &Fixture, filters: &ScopeFilters) -> f64 {
    f.db.matrix_cells("0xAABB", None, 0.0, 300_000.0, filters).unwrap().iter().map(|r| r.count).sum()
}

#[test]
fn lists_keyboards_with_live_data_and_sums_days_across_machines() {
    let f = data_modal();
    let mut uids: Vec<String> =
        f.db.keyboards_with_typing_data().unwrap().into_iter().map(|k| k.uid).collect();
    uids.sort();
    assert_eq!(uids, ["0xAABB", "0xCCDD"]);
    let days = f.db.daily_summaries("0xAABB", None, &NO_FILTER).unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!((days[0].keystrokes, days[0].active_ms), (5.0, 1_500.0));
}

#[test]
fn lists_typing_test_labels_and_filters_cells_by_them() {
    let mut f = data_modal();
    for (minute, k, test) in [(180_000.0, 5.0, "words (english)"), (240_000.0, 9.0, "novel.txt")] {
        let (s, m) = tagged("scope-aabb-local", minute, k, test, None);
        f.minute(s, &[], &[m], 2_000.0);
    }
    let mut labels: Vec<String> =
        f.db.app_aggregate(AppAggregate::TypingTests, "0xAABB", Some(HASH), 0.0, 300_000.0)
            .unwrap()
            .into_iter()
            .map(|r| r.name)
            .collect();
    labels.sort();
    assert_eq!(labels, ["novel.txt", "words (english)"]);
    assert_eq!(cell_total(&f, &tests(&["novel.txt"])), 9.0);
    assert_eq!(cell_total(&f, &tests(&["words (english)"])), 5.0);
    assert_eq!(cell_total(&f, &NO_FILTER), 17.0);
}

#[test]
fn filters_cells_by_run() {
    let mut f = data_modal();
    for (k, run) in [(4.0, "run-a"), (6.0, "run-b")] {
        let (s, m) = tagged("scope-aabb-local", 180_000.0, k, "words (english)", Some(run));
        f.minute(s, &[], &[m], 2_000.0);
    }
    assert_eq!(cell_total(&f, &runs(&["run-a"])), 4.0);
    assert_eq!(cell_total(&f, &runs(&["run-b"])), 6.0);
    assert_eq!(cell_total(&f, &runs(&["run-a", "run-b"])), 10.0);
}

#[test]
fn lists_runs_newest_start_first_without_the_untagged_bucket() {
    let mut f = data_modal();
    for (minute, k, test, run) in [
        (120_000.0, 3.0, "novel.txt", "run-old"),
        (180_000.0, 4.0, "words (english)", "run-new"),
        (240_000.0, 5.0, "words (english)", "run-new"),
    ] {
        let (s, _) = tagged("scope-aabb-local", minute, k, test, Some(run));
        f.minute(s, &[], &[], 2_000.0);
    }
    let all = f.db.typing_test_runs("0xAABB", Some(HASH), 0.0, 300_000.0, &[]).unwrap();
    assert_eq!(all.iter().map(|r| r.run_id.as_str()).collect::<Vec<_>>(), ["run-new", "run-old"]);
    assert_eq!((all[0].first_ms, all[0].keystrokes), (180_000.0, 9.0));
    let only = |tests: &[&str]| -> Vec<String> {
        let tests: Vec<String> = tests.iter().map(|s| (*s).to_owned()).collect();
        f.db.typing_test_runs("0xAABB", Some(HASH), 0.0, 300_000.0, &tests)
            .unwrap()
            .into_iter()
            .map(|r| r.run_id)
            .collect()
    };
    assert_eq!(only(&["novel.txt"]), ["run-old"]);
    assert_eq!(only(&["words (english)"]), ["run-new"]);
}

fn range(start_ms: i64, end_ms: i64, cutoff_ms: i64) -> DeleteRange {
    DeleteRange { start_ms, end_ms, cutoff_ms }
}

const ZERO: TombstoneResult = TombstoneResult {
    char_minutes: 0,
    matrix_minutes: 0,
    minute_stats: 0,
    bigram_minutes: 0,
    trigram_minutes: 0,
    sessions: 0,
};

#[test]
fn range_tombstones_bump_updated_at_and_stay_inside_the_range_and_hash() {
    let mut f = data_modal();
    f.merge(&[
        ("bigram-minute", bigram("scope-aabb-local", 60_000.0, "4_11", entry(1, &[1])), 1_000.0, false),
        ("trigram-minute", trigram("scope-aabb-local", 60_000.0, "4_11_7", entry(1, &[1])), 1_000.0, false),
        ("bigram-minute", bigram("scope-aabb-local", 120_000.0, "4_11", entry(1, &[1])), 1_000.0, false),
    ]);
    let result =
        f.db.tombstone_ranges_for_uid_hash("0xAABB", HASH, &[range(0, 90_000, 1_000_000)], 5_000).unwrap();
    assert_eq!(
        result,
        TombstoneResult {
            char_minutes: 1,
            matrix_minutes: 1,
            minute_stats: 1,
            bigram_minutes: 1,
            trigram_minutes: 1,
            sessions: 1
        }
    );
    let local = f.one(
        "SELECT is_deleted, updated_at FROM typing_char_minute WHERE scope_id = 'scope-aabb-local'",
        &[],
    );
    assert_eq!((int(&local[0]), int(&local[1])), (1, 5_000));
    let remote = f.one("SELECT is_deleted FROM typing_char_minute WHERE scope_id = 'scope-aabb-remote'", &[]);
    assert_eq!(int(&remote[0]), 0);
    let ccdd = f.one("SELECT is_deleted FROM typing_char_minute WHERE char = 'b'", &[]);
    assert_eq!(int(&ccdd[0]), 0);
    let bigrams = f.rows("SELECT minute_ts, is_deleted FROM typing_bigram_minute ORDER BY minute_ts", &[]);
    assert_eq!(
        bigrams.iter().map(|r| (int(&r[0]), int(&r[1]))).collect::<Vec<_>>(),
        [(60_000, 1), (120_000, 0)]
    );

    // Rows already tombstoned keep their time.
    let again =
        f.db.tombstone_ranges_for_uid_hash("0xAABB", HASH, &[range(0, 90_000, 1_000_000)], 9_000).unwrap();
    assert_eq!(again, ZERO);
    let kept = f.one("SELECT updated_at FROM typing_char_minute WHERE scope_id = 'scope-aabb-local'", &[]);
    assert_eq!(int(&kept[0]), 5_000);
    assert_eq!(f.db.tombstone_ranges_for_uid_hash("0xAABB", HASH, &[], 8_000).unwrap(), ZERO);
}

#[test]
fn range_tombstones_leave_rows_after_the_cutoff() {
    let mut f = data_modal();
    let after =
        f.db.tombstone_ranges_for_uid_hash("0xAABB", HASH, &[range(0, 90_000, 59_999)], 8_000).unwrap();
    assert_eq!(after, ZERO);
    let at = f.db.tombstone_ranges_for_uid_hash("0xAABB", HASH, &[range(0, 90_000, 60_000)], 8_000).unwrap();
    assert_eq!((at.minute_stats, at.sessions), (1, 1));
}

#[test]
fn range_tombstones_take_sessions_by_start() {
    let mut f = data_modal();
    f.db.insert_session(&session("session-midnight", "scope-aabb-local", 10_000.0, 70_000.0), 1_000.0)
        .unwrap();
    let result =
        f.db.tombstone_ranges_for_uid_hash("0xAABB", HASH, &[range(60_000, 120_000, 60_000)], 8_000).unwrap();
    assert_eq!((result.minute_stats, result.sessions), (1, 1));
    let state = |id: &str| int(&f.one("SELECT is_deleted FROM typing_sessions WHERE id = ?", &[&id])[0]);
    assert_eq!(state("session-midnight"), 0);
    assert_eq!(state("session-aabb-1"), 1);
}

#[test]
fn range_tombstones_sum_over_the_ranges() {
    let mut f = data_modal();
    f.minute(stats("scope-aabb-local", 240_000.0, 2.0), &[], &[], 2_000.0);
    let result =
        f.db.tombstone_ranges_for_uid_hash(
            "0xAABB",
            HASH,
            &[range(0, 90_000, 1_000_000), range(200_000, 300_000, 1_000_000)],
            8_000,
        )
        .unwrap();
    assert_eq!(result.minute_stats, 2);
}

#[test]
fn tombstoning_a_keyboard_or_one_of_its_devices() {
    let mut f = data_modal();
    f.merge(&[(
        "bigram-minute",
        bigram("scope-aabb-remote", 60_000.0, "4_11", entry(1, &[1])),
        1_000.0,
        false,
    )]);
    let device = f.db.tombstone_all_for_uid_hash("0xAABB", HASH, 6_000).unwrap();
    assert_eq!(
        device,
        TombstoneResult { char_minutes: 1, matrix_minutes: 1, minute_stats: 1, sessions: 1, ..ZERO }
    );
    let live = f.rows("SELECT scope_id FROM typing_minute_stats WHERE is_deleted = 0 ORDER BY scope_id", &[]);
    assert_eq!(
        live.iter().map(|r| text(&r[0])).collect::<Vec<_>>(),
        ["scope-aabb-remote", "scope-ccdd-local"]
    );

    let keyboard = f.db.tombstone_all_for_uid("0xAABB", 7_000).unwrap();
    assert_eq!(keyboard, TombstoneResult { char_minutes: 1, minute_stats: 1, bigram_minutes: 1, ..ZERO });
    let uids: Vec<String> = f.db.keyboards_with_typing_data().unwrap().into_iter().map(|k| k.uid).collect();
    assert_eq!(uids, ["0xCCDD"]);
    assert!(f.db.daily_summaries("0xAABB", None, &NO_FILTER).unwrap().is_empty());
}

#[test]
fn lists_the_local_keyboard_uids_of_a_machine() {
    let f = data_modal();
    let mut uids = f.db.local_keyboard_uids(HASH).unwrap();
    uids.sort();
    assert_eq!(uids, ["0xAABB", "0xCCDD", "0xEEFF"]);
    assert_eq!(f.db.local_keyboard_uids("other-machine").unwrap(), ["0xAABB"]);
}

// --- heatmap, layers and cells -------------------------------------------

fn three_scopes() -> Fixture {
    let mut f = Fixture::new();
    f.scope("scope-local", HASH, "0xAABB");
    f.scope("scope-other-machine", "other", "0xAABB");
    f.scope("scope-other-uid", HASH, "0xCCDD");
    f
}

fn heat(f: &Fixture) -> Vec<(f64, f64, f64)> {
    f.db.matrix_counts_since("0xAABB", HASH, 0.0, 60_000.0)
        .unwrap()
        .iter()
        .map(|c| (c.row, c.col, c.total))
        .collect()
}

#[test]
fn the_heatmap_sums_one_machine_one_layer_from_the_cutoff() {
    let mut f = three_scopes();
    f.matrix("scope-local", 30_000.0, (1.0, 2.0, 0.0), 100.0, (0.0, 0.0));
    f.matrix("scope-local", 60_000.0, (1.0, 2.0, 0.0), 3.0, (0.0, 0.0));
    f.matrix("scope-local", 120_000.0, (1.0, 2.0, 0.0), 5.0, (0.0, 0.0));
    f.matrix("scope-local", 180_000.0, (0.0, 0.0, 0.0), 1.0, (0.0, 0.0));
    f.matrix("scope-local", 60_000.0, (1.0, 2.0, 1.0), 100.0, (0.0, 0.0));
    f.matrix("scope-other-machine", 60_000.0, (1.0, 2.0, 0.0), 100.0, (0.0, 0.0));
    f.matrix("scope-other-uid", 60_000.0, (1.0, 2.0, 0.0), 99.0, (0.0, 0.0));
    let mut cells = heat(&f);
    cells.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(cells, [(0.0, 0.0, 1.0), (1.0, 2.0, 8.0)]);
}

#[test]
fn the_heatmap_leaves_out_tombstoned_rows_and_scopes() {
    let mut f = three_scopes();
    f.matrix("scope-local", 60_000.0, (1.0, 2.0, 0.0), 3.0, (0.0, 0.0));
    f.merge(&[(
        "matrix-minute",
        json!({ "scopeId": "scope-local", "minuteTs": 60_000, "row": 1, "col": 2, "layer": 0, "keycode": 4, "count": 0, "tapCount": 0, "holdCount": 0 }),
        5_000.0,
        true,
    )]);
    assert!(heat(&f).is_empty());

    let mut f = three_scopes();
    f.matrix("scope-local", 60_000.0, (1.0, 2.0, 0.0), 3.0, (0.0, 0.0));
    f.merge(&[("scope", scope_json("scope-local", HASH, "0xAABB"), 5_000.0, true)]);
    assert!(heat(&f).is_empty());
}

#[test]
fn the_heatmap_carries_tap_and_hold_counts() {
    let mut f = three_scopes();
    let cell = |tap: Option<f64>, hold: Option<f64>| MatrixMinuteInput {
        tap_count: tap,
        hold_count: hold,
        ..matrix_input("scope-local", 60_000.0, (1.0, 2.0, 0.0), 4.0, 1.0)
    };
    f.minute(
        stats("scope-local", 60_000.0, 1.0),
        &[],
        &[
            cell(Some(1.0), Some(0.0)),
            cell(Some(1.0), Some(0.0)),
            cell(Some(0.0), Some(1.0)),
            cell(None, None),
        ],
        1_000.0,
    );
    let cells = f.db.matrix_counts_since("0xAABB", HASH, 0.0, 60_000.0).unwrap();
    assert_eq!(cells.len(), 1);
    assert_eq!((cells[0].total, cells[0].tap, cells[0].hold), (4.0, 2.0, 1.0));
}

#[test]
fn layer_usage_groups_by_layer_in_the_window_across_or_per_machine() {
    let mut f = three_scopes();
    f.matrix("scope-local", 30_000.0, (0.0, 0.0, 0.0), 100.0, (0.0, 0.0));
    f.matrix("scope-local", 60_000.0, (0.0, 0.0, 0.0), 3.0, (0.0, 0.0));
    f.matrix("scope-local", 60_000.0, (0.0, 1.0, 0.0), 2.0, (0.0, 0.0));
    f.matrix("scope-local", 120_000.0, (0.0, 0.0, 1.0), 7.0, (0.0, 0.0));
    f.matrix("scope-local", 180_000.0, (0.0, 0.0, 2.0), 4.0, (0.0, 0.0));
    f.matrix("scope-local", 240_000.0, (0.0, 0.0, 1.0), 999.0, (0.0, 0.0));
    f.matrix("scope-other-machine", 60_000.0, (0.0, 0.0, 0.0), 4.0, (0.0, 0.0));
    f.matrix("scope-other-uid", 60_000.0, (0.0, 0.0, 0.0), 99.0, (0.0, 0.0));
    let usage = |hash| -> Vec<(f64, f64)> {
        f.db.layer_usage("0xAABB", hash, 60_000.0, 240_000.0, &NO_FILTER)
            .unwrap()
            .iter()
            .map(|r| (r.layer, r.keystrokes))
            .collect()
    };
    assert_eq!(usage(None), [(0.0, 9.0), (1.0, 7.0), (2.0, 4.0)]);
    assert_eq!(usage(Some(HASH)), [(0.0, 5.0), (1.0, 7.0), (2.0, 4.0)]);
}

#[test]
fn layer_usage_leaves_out_tombstoned_rows_and_scopes() {
    let mut f = three_scopes();
    f.matrix("scope-local", 60_000.0, (0.0, 0.0, 0.0), 5.0, (0.0, 0.0));
    f.matrix("scope-other-machine", 60_000.0, (0.0, 0.0, 0.0), 8.0, (0.0, 0.0));
    f.merge(&[
        (
            "matrix-minute",
            json!({ "scopeId": "scope-local", "minuteTs": 60_000, "row": 0, "col": 0, "layer": 0, "keycode": 4, "count": 0, "tapCount": 0, "holdCount": 0 }),
            5_000.0,
            true,
        ),
        ("scope", scope_json("scope-other-machine", "other", "0xAABB"), 5_000.0, true),
    ]);
    assert!(f.db.layer_usage("0xAABB", None, 60_000.0, 120_000.0, &NO_FILTER).unwrap().is_empty());
}

#[test]
fn matrix_cells_keep_layers_and_tap_hold_apart() {
    let mut f = three_scopes();
    f.matrix("scope-local", 60_000.0, (0.0, 1.0, 0.0), 4.0, (3.0, 1.0));
    f.matrix("scope-local", 120_000.0, (0.0, 1.0, 0.0), 2.0, (1.0, 1.0));
    f.matrix("scope-local", 60_000.0, (0.0, 2.0, 0.0), 5.0, (0.0, 0.0));
    f.matrix("scope-local", 60_000.0, (0.0, 0.0, 1.0), 7.0, (0.0, 0.0));
    f.matrix("scope-other-machine", 60_000.0, (0.0, 0.0, 1.0), 4.0, (0.0, 0.0));
    f.matrix("scope-other-uid", 60_000.0, (0.0, 1.0, 0.0), 99.0, (0.0, 0.0));
    let cells = |hash| -> Vec<(f64, f64, f64, f64, f64, f64)> {
        let mut rows: Vec<_> =
            f.db.matrix_cells("0xAABB", hash, 60_000.0, 240_000.0, &NO_FILTER)
                .unwrap()
                .iter()
                .map(|r| (r.layer, r.row, r.col, r.count, r.tap, r.hold))
                .collect();
        rows.sort_by(|a, b| a.partial_cmp(b).unwrap());
        rows
    };
    assert_eq!(
        cells(None),
        [(0.0, 0.0, 1.0, 6.0, 4.0, 2.0), (0.0, 0.0, 2.0, 5.0, 0.0, 0.0), (1.0, 0.0, 0.0, 11.0, 0.0, 0.0)]
    );
    assert_eq!(cells(Some(HASH))[2], (1.0, 0.0, 0.0, 7.0, 0.0, 0.0));
}

fn duration_cell(f: &mut Fixture, scope_id: &str, minute: f64, h: Option<&[u32]>, sums: (f64, f64)) {
    let mut payload = json!({ "scopeId": scope_id, "minuteTs": minute, "row": 0, "col": 0, "layer": 0, "keycode": 4, "count": 1, "tapCount": 0, "holdCount": 0 });
    if let Some(h) = h {
        payload["dh"] = json!(hist(h));
        payload["ds"] = json!(sums.0);
        payload["dq"] = json!(sums.1);
    }
    f.merge(&[("matrix-minute", payload, 1_000.0, false)]);
}

#[test]
fn duration_cells_decode_the_histogram_and_skip_rows_without_samples() {
    let mut f = three_scopes();
    duration_cell(&mut f, "scope-local", 60_000.0, Some(&[0, 1]), (65.0, 4_225.0));
    duration_cell(&mut f, "scope-other-machine", 60_000.0, Some(&[0, 0, 1]), (90.0, 8_100.0));
    duration_cell(&mut f, "scope-local", 30_000.0, Some(&[1]), (40.0, 1_600.0));
    duration_cell(&mut f, "scope-local", 120_000.0, None, (0.0, 0.0));
    let rows = f.db.matrix_duration_cells("0xAABB", Some(HASH), 60_000.0, 180_000.0, &NO_FILTER).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!((rows[0].hist, rows[0].sum, rows[0].sum_sq), ([0, 1, 0, 0, 0, 0, 0, 0], 65.0, Some(4_225.0)));
    assert_eq!(f.db.matrix_duration_cells("0xAABB", None, 60_000.0, 120_000.0, &NO_FILTER).unwrap().len(), 2);
}

#[test]
fn duration_cells_skip_a_histogram_without_its_sum() {
    let mut f = three_scopes();
    duration_cell(&mut f, "scope-local", 60_000.0, Some(&[0, 1]), (65.0, 4_225.0));
    Connection::open(&f.path)
        .unwrap()
        .execute_batch("UPDATE typing_matrix_minute SET dur_sum = NULL")
        .unwrap();
    assert!(f.db.matrix_duration_cells("0xAABB", None, 60_000.0, 120_000.0, &NO_FILTER).unwrap().is_empty());
}

// --- n-grams and rollover -------------------------------------------------

fn ngrams(f: &Fixture, gram: Gram, hash: Option<&str>, until: f64) -> Vec<NgramMinuteCellRow> {
    f.db.ngram_minutes_in_range(gram, "0xAABB", hash, 60_000.0, until, &NO_FILTER).unwrap()
}

#[test]
fn ngram_rows_decode_the_histogram_with_sums_and_overlap_for_bigrams_only() {
    let mut f = three_scopes();
    f.merge(&[
        (
            "bigram-minute",
            bigram(
                "scope-local",
                60_000.0,
                "with-sum",
                json!({ "c": 2, "h": hist(&[0, 2]), "s": 240, "sq": 28_800 }),
            ),
            2_000.0,
            false,
        ),
        (
            "bigram-minute",
            bigram(
                "scope-local",
                60_000.0,
                "with-overlap",
                json!({ "c": 2, "h": hist(&[0, 2]), "oc": 1, "on": 2 }),
            ),
            1_000.0,
            false,
        ),
        ("bigram-minute", bigram("scope-local", 120_000.0, "plain", entry(1, &[1])), 1_000.0, false),
        ("trigram-minute", trigram("scope-local", 60_000.0, "4_11_7", entry(3, &[0, 2, 1])), 1_000.0, false),
    ]);
    let rows = ngrams(&f, Gram::Bigram, None, 180_000.0);
    let get = |id: &str| rows.iter().find(|r| r.ngram_id == id).unwrap().clone();
    assert_eq!(get("with-sum").sum_iki, Some(240.0));
    assert_eq!(get("with-sum").sum_sq_iki, Some(28_800.0));
    assert_eq!(get("with-sum").overlap, Some(Overlap { count: None, n: None }));
    assert_eq!(get("with-overlap").overlap, Some(Overlap { count: Some(1.0), n: Some(2.0) }));
    assert_eq!(get("plain").hist, [1, 0, 0, 0, 0, 0, 0, 0]);
    let trigrams = ngrams(&f, Gram::Trigram, None, 120_000.0);
    assert_eq!(trigrams.len(), 1);
    assert_eq!((trigrams[0].hist, trigrams[0].overlap), ([0, 2, 1, 0, 0, 0, 0, 0], None));
}

#[test]
fn ngram_rows_stay_in_the_window_keyboard_and_device() {
    for gram in [Gram::Bigram, Gram::Trigram] {
        let mut f = three_scopes();
        let row = |scope_id: &str, minute: f64, id: &str, deleted: bool, at: f64| {
            let payload = match gram {
                Gram::Bigram => bigram(scope_id, minute, id, entry(1, &[1])),
                Gram::Trigram => trigram(scope_id, minute, id, entry(1, &[1])),
            };
            let kind = if gram == Gram::Bigram { "bigram-minute" } else { "trigram-minute" };
            (kind, payload, at, deleted)
        };
        f.merge(&[
            row("scope-local", 30_000.0, "before", false, 1_000.0),
            row("scope-local", 60_000.0, "deleted", false, 1_000.0),
            row("scope-local", 60_000.0, "deleted", true, 5_000.0),
            row("scope-local", 120_000.0, "kept", false, 1_000.0),
            row("scope-other-uid", 60_000.0, "other-uid", false, 1_000.0),
            row("scope-other-machine", 60_000.0, "remote", false, 1_000.0),
        ]);
        let ids = |hash| -> Vec<String> {
            ngrams(&f, gram, hash, 240_000.0).into_iter().map(|r| r.ngram_id).collect()
        };
        assert_eq!(ids(None), ["kept", "remote"]);
        assert_eq!(ids(Some(HASH)), ["kept"]);
    }
}

fn overlap_row(
    scope_id: &str,
    minute: f64,
    id: &str,
    oc_on: Option<(u32, u32)>,
    app: Option<&str>,
) -> (&'static str, Value, f64, bool) {
    let mut e = entry(1, &[1]);
    if let Some((oc, on)) = oc_on {
        e["oc"] = json!(oc);
        e["on"] = json!(on);
    }
    let mut payload = bigram(scope_id, minute, id, e);
    if let Some(app) = app {
        payload["appName"] = json!(app);
    }
    ("bigram-minute", payload, 1_000.0, false)
}

fn rollover(f: &Fixture, hash: Option<&str>, until: f64, filters: &ScopeFilters) -> Vec<(f64, f64, f64)> {
    f.db.rollover_minutes("0xAABB", hash, 60_000.0, until, filters)
        .unwrap()
        .iter()
        .map(|r| (r.minute_ts, r.oc, r.on))
        .collect()
}

#[test]
fn rollover_sums_the_determined_overlap_per_minute() {
    let mut f = three_scopes();
    f.merge(&[
        overlap_row("scope-local", 60_000.0, "A_B", Some((1, 2)), Some("Code")),
        overlap_row("scope-local", 60_000.0, "B_C", Some((2, 3)), Some("Chat")),
        overlap_row("scope-local", 60_000.0, "unobserved", None, None),
        overlap_row("scope-local", 59_999.0, "before", Some((1, 1)), None),
        overlap_row("scope-local", 120_000.0, "later", Some((1, 4)), None),
        overlap_row("scope-local", 180_000.0, "at-end", Some((1, 1)), None),
        overlap_row("scope-other-uid", 60_000.0, "other-uid", Some((9, 9)), None),
        overlap_row("scope-other-machine", 60_000.0, "remote", Some((9, 9)), None),
    ]);
    assert_eq!(rollover(&f, None, 180_000.0, &NO_FILTER), [(60_000.0, 12.0, 14.0), (120_000.0, 1.0, 4.0)]);
    assert_eq!(
        rollover(&f, Some(HASH), 180_000.0, &NO_FILTER),
        [(60_000.0, 3.0, 5.0), (120_000.0, 1.0, 4.0)]
    );
    assert_eq!(rollover(&f, Some(HASH), 120_000.0, &apps(&["Code"])), [(60_000.0, 1.0, 2.0)]);
}

#[test]
fn rollover_skips_a_minute_without_overlap_and_a_row_with_half_of_it() {
    let mut f = three_scopes();
    f.merge(&[overlap_row("scope-local", 60_000.0, "unobserved", None, None)]);
    assert!(rollover(&f, None, 120_000.0, &NO_FILTER).is_empty());
    f.merge(&[overlap_row("scope-local", 60_000.0, "valid", Some((1, 2)), None)]);
    // The parser refuses an `on` without its `oc`, so the broken row goes
    // in directly.
    Connection::open(&f.path)
        .unwrap()
        .execute_batch(
            "INSERT INTO typing_bigram_minute (scope_id, minute_ts, bigram_id, count, hist, overlap_n, run_id, updated_at, is_deleted)
               VALUES ('scope-local', 60000, 'malformed', 1, zeroblob(32), 5, '', 1000, 0)",
        )
        .unwrap();
    assert_eq!(rollover(&f, None, 120_000.0, &NO_FILTER), [(60_000.0, 1.0, 2.0)]);
}

// --- minute stats and devices --------------------------------------------

fn poll_stats(scope_id: &str, poll: Option<(f64, f64)>) -> (&'static str, Value, f64, bool) {
    let mut payload = json!({
        "scopeId": scope_id, "minuteTs": 60_000, "keystrokes": 1, "activeMs": 1, "intervalAvgMs": 1,
        "intervalMinMs": 1, "intervalP25Ms": 1, "intervalP50Ms": 1, "intervalP75Ms": 1, "intervalMaxMs": 1,
    });
    if let Some((p50, p95)) = poll {
        payload["pollP50Ms"] = json!(p50);
        payload["pollP95Ms"] = json!(p95);
    }
    ("minute-stats", payload, 1_000.0, false)
}

#[test]
fn minute_stats_average_the_poll_gaps_of_a_minute_ignoring_nulls() {
    let poll = |rows: &[(&'static str, Value, f64, bool)], hash: Option<&str>| {
        let mut f = Fixture::new();
        f.scope("scope-local", HASH, "0xAABB");
        f.scope("scope-local-b", HASH, "0xAABB");
        f.merge(rows);
        let row =
            f.db.minute_stats_in_range("0xAABB", hash, 60_000.0, 120_000.0, &NO_FILTER).unwrap().remove(0);
        (row.poll_p50_ms, row.poll_p95_ms)
    };
    assert_eq!(
        poll(
            &[poll_stats("scope-local", Some((10.0, 30.0))), poll_stats("scope-local-b", Some((20.0, 50.0)))],
            None
        ),
        (Some(15.0), Some(40.0))
    );
    assert_eq!(poll(&[poll_stats("scope-local", None)], None), (None, None));
    assert_eq!(
        poll(&[poll_stats("scope-local", Some((10.0, 30.0))), poll_stats("scope-local-b", None)], None),
        (Some(10.0), Some(30.0))
    );
    assert_eq!(poll(&[poll_stats("scope-local", Some((12.0, 33.0)))], Some(HASH)), (Some(12.0), Some(33.0)));
}

#[test]
fn remote_devices_are_one_per_hash_with_live_stats_and_the_newest_release() {
    let mut f = Fixture::new();
    f.db.upsert_scope(&scope_input("scope-remote-old", "remote-machine", "0xAABB", 1_000.0)).unwrap();
    f.db.upsert_scope(&ScopeInput {
        os_release: "6.10.0".into(),
        ..scope_input("scope-remote-new", "remote-machine", "0xAABB", 2_000.0)
    })
    .unwrap();
    f.scope("scope-local", HASH, "0xAABB");
    f.scope("scope-remote-empty", "remote-empty", "0xAABB");
    for id in ["scope-remote-old", "scope-remote-new", "scope-local"] {
        f.minute(stats(id, 60_000.0, 1.0), &[], &[], 1_000.0);
    }
    let infos = f.db.remote_device_infos("0xAABB", HASH).unwrap();
    assert_eq!(infos.len(), 1);
    assert_eq!(
        (infos[0].machine_hash.as_str(), infos[0].os_platform.as_str(), infos[0].os_release.as_str()),
        ("remote-machine", "linux", "6.10.0")
    );
}
