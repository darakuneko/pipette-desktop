// SPDX-License-Identifier: GPL-2.0-or-later
//! TypeScript → Rust: the recorded golden scenarios of
//! `tests/fixtures/expected.json`, which the TypeScript DB layer on
//! better-sqlite3 produced from the same JSONL files. Each scenario
//! applies its steps to a fresh database and must end with every table
//! identical cell by cell (storage class included) and every query row
//! identical to the bit. The databases are files, so a second connection
//! can read the tables back, and add the trigger that makes a step fail.

#![allow(clippy::unwrap_used)]

mod common;

use std::path::PathBuf;

use common::{assert_tables, fixtures_dir, open_read_only, query_row_cells, read_json, remove_db, strings};
use pipette_typing_analytics_db::{ApplyRowsResult, DeleteRange, ScopeFilters, TypingAnalyticsDb};
use serde_json::Value;

fn expected() -> Value {
    read_json(fixtures_dir().join("expected.json"))
}

fn scenario(name: &str) -> Value {
    expected()["scenarios"].as_array().unwrap().iter().find(|s| s["name"] == name).unwrap().clone()
}

fn i64_of(value: &Value, key: &str) -> i64 {
    value[key].as_i64().unwrap_or_else(|| panic!("{key} is not an integer in {value}"))
}

fn applied_json(result: &Result<ApplyRowsResult, pipette_typing_analytics_db::Error>) -> Value {
    match result {
        Ok(r) => serde_json::to_value(r).unwrap(),
        Err(_) => serde_json::json!({ "error": true }),
    }
}

fn apply_step(
    db: &mut TypingAnalyticsDb,
    step: &Value,
) -> Result<ApplyRowsResult, pipette_typing_analytics_db::Error> {
    let text = std::fs::read_to_string(fixtures_dir().join(step["input"].as_str().unwrap())).unwrap();
    let Some(hide) = step.get("hide") else { return db.apply_day_jsonl(&text) };
    let ranges: Vec<DeleteRange> = hide["ranges"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| DeleteRange {
            start_ms: i64_of(r, "startMs"),
            end_ms: i64_of(r, "endMs"),
            cutoff_ms: i64_of(r, "cutoffMs"),
        })
        .collect();
    db.apply_day_jsonl_hiding_ranges(
        &text,
        hide["uid"].as_str().unwrap(),
        hide["machineHash"].as_str().unwrap(),
        &ranges,
        i64_of(hide, "updatedAt"),
    )
}

pub fn assert_queries(db: &TypingAnalyticsDb, queries: &Value, label: &str) {
    for q in queries.as_array().unwrap() {
        let filters = ScopeFilters {
            app_names: strings(&q["appScopes"]),
            typing_tests: strings(&q["typingTestScopes"]),
            run_ids: strings(&q["runIdScopes"]),
        };
        let rows = db
            .minute_stats_in_range(
                q["uid"].as_str().unwrap(),
                None,
                q["sinceMs"].as_f64().unwrap(),
                q["untilMs"].as_f64().unwrap(),
                &filters,
            )
            .unwrap();
        let got: Vec<Value> = rows.iter().map(query_row_cells).collect();
        let name = q["name"].as_str().unwrap();
        assert_eq!(&Value::Array(got), &q["rows"], "{label}: query {name}");
    }
}

/// A fresh database file for `name` under CARGO_TARGET_TMPDIR.
fn fresh_db_path(name: &str) -> PathBuf {
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("pipette-typing-analytics-db");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(format!("{name}.db"));
    remove_db(&path);
    path
}

fn check_scenario(name: &str) {
    let s = scenario(name);
    let path = fresh_db_path(name);
    let mut db = TypingAnalyticsDb::open(&path).unwrap();
    for (i, (step, want)) in
        s["steps"].as_array().unwrap().iter().zip(s["applied"].as_array().unwrap()).enumerate()
    {
        if let Some(sql) = step.get("failSql") {
            // A trigger made through a second connection: a schema change the
            // crate's connection picks up on its next statement.
            rusqlite::Connection::open(&path).unwrap().execute_batch(sql.as_str().unwrap()).unwrap();
        }
        let got = apply_step(&mut db, step);
        assert_eq!(applied_json(&got), *want, "{name}: step {i} ({got:?})");
    }
    assert_tables(&open_read_only(&path), &s["tables"], name);
    assert_queries(&db, &s["queries"], name);
}

#[test]
fn day() {
    check_scenario("day");
}

#[test]
fn reapply_then_rollback() {
    check_scenario("reapply-then-rollback");
}

#[test]
fn day_hiding_ranges() {
    check_scenario("day-hiding-ranges");
}

/// The tombstones of the ranges fail after the day's rows were applied:
/// none of them stays.
#[test]
fn day_hiding_ranges_failing_tombstone() {
    check_scenario("day-hiding-ranges-failing-tombstone");
}

/// Applying the rows fails before the ranges are tombstoned.
#[test]
fn orphan_hiding_ranges() {
    check_scenario("orphan-hiding-ranges");
}

/// The bundled SQLite next to the one better-sqlite3 ships, for the record;
/// the scenarios above are what must match.
#[test]
fn reports_sqlite_versions() {
    let ours = TypingAnalyticsDb::open_in_memory().unwrap().pragma_report().unwrap().sqlite_version;
    println!("rusqlite bundled SQLite {ours}, better-sqlite3 SQLite {}", expected()["sqliteVersion"]);
}
