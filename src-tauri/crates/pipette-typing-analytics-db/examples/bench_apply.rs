// SPDX-License-Identifier: GPL-2.0-or-later
//! Apply + query timing of the Rust cache on the inputs the TypeScript
//! generator timed (`pnpm run generate:analytics-db-fixtures` writes them and
//! its own timings to src-tauri/target/tmp/pipette-typing-analytics-db).
//! Each input is applied into a fresh file-backed database once as a
//! warm-up and then RUNS times; the medians are printed next to the
//! TypeScript ones. heavy.jsonl is also checked against the tables and query
//! results the TypeScript side recorded for it, and the Analyze reads the
//! generator timed on it (`BENCH_CALLS`) are checked and timed too.
//!
//! The generator records in UTC and one of the reads groups by local days,
//! so this runs in UTC as well.
//!
//! Run: TZ=UTC cargo run --release -p pipette-typing-analytics-db --example bench_apply

#![allow(clippy::unwrap_used)]

#[path = "../tests/common/mod.rs"]
mod common;

use std::path::Path;
use std::time::Instant;

use common::{
    assert_tables, bench_dir, fixtures_dir, open_read_only, query_row_cells, read_json, remove_db, run_call,
    strings,
};
use pipette_typing_analytics_db::{Gram, ScopeFilters, TypingAnalyticsDb};
use serde_json::Value;

const RUNS: usize = 7;

fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}

fn run_queries(db: &TypingAnalyticsDb, queries: &Value) -> Vec<Value> {
    queries
        .as_array()
        .unwrap()
        .iter()
        .map(|q| {
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
            Value::Array(rows.iter().map(query_row_cells).collect())
        })
        .collect()
}

/// `(apply ms, query ms)` medians; `check` compares the last run with the
/// TypeScript tables and query rows.
fn bench(input: &Path, queries: &Value, check: Option<&Value>) -> (f64, f64) {
    let db_path = bench_dir().join("bench-rust.db");
    let mut apply_ms = Vec::new();
    let mut query_ms = Vec::new();
    for run in 0..=RUNS {
        remove_db(&db_path);
        let mut db = TypingAnalyticsDb::open(&db_path).unwrap();
        let t0 = Instant::now();
        let text = std::fs::read_to_string(input).unwrap();
        db.apply_day_jsonl(&text).unwrap();
        let t1 = Instant::now();
        let results = run_queries(&db, queries);
        let t2 = Instant::now();
        if run > 0 {
            apply_ms.push((t1 - t0).as_secs_f64() * 1000.0);
            query_ms.push((t2 - t1).as_secs_f64() * 1000.0);
        }
        if run == RUNS
            && let Some(expected) = check
        {
            assert_tables(&open_read_only(&db_path), &expected["tables"], "heavy");
            let want: Vec<Value> = queries.as_array().unwrap().iter().map(|q| q["rows"].clone()).collect();
            assert_eq!(results, want, "heavy: queries");
            println!("heavy.jsonl: tables and queries match the TypeScript result");
        }
    }
    remove_db(&db_path);
    (median(&mut apply_ms), median(&mut query_ms))
}

/// Each of the generator's `BENCH_CALLS` on the heavy database: checked
/// against its recorded answer, then timed RUNS times after a warm-up,
/// the method called directly.
fn bench_calls(expected: &Value, ts_ms: &Value) {
    let path = bench_dir().join("bench-rust-calls.db");
    remove_db(&path);
    let mut db = TypingAnalyticsDb::open(&path).unwrap();
    db.apply_day_jsonl(&std::fs::read_to_string(bench_dir().join("heavy.jsonl")).unwrap()).unwrap();
    println!("| read | TS ms | Rust ms |");
    println!("|---|---|---|");
    for call in expected["calls"].as_array().unwrap() {
        let method = call["method"].as_str().unwrap();
        let args = call["args"].as_array().unwrap();
        assert_eq!(run_call(&mut db, method, args), call["result"], "heavy: {method}");
        let uid = args.iter().find_map(Value::as_str).unwrap();
        let all = ScopeFilters::default();
        let max = 9_007_199_254_740_991.0;
        let mut ms = Vec::new();
        for run in 0..=RUNS {
            let t0 = Instant::now();
            match method {
                "listDailySummariesForUid" => drop(db.daily_summaries(uid, None, &all).unwrap()),
                "listMinuteStatsInRangeForUid" => {
                    drop(db.minute_stats_in_range(uid, None, 0.0, max, &all).unwrap())
                }
                "aggregateMatrixCountsForUidInRange" => {
                    drop(db.matrix_counts_in_range(uid, None, 0.0, 0.0, max, &all).unwrap());
                }
                "listMatrixCellsForUid" => drop(db.matrix_cells(uid, None, 0.0, max, &all).unwrap()),
                "listNgramMinutesInRangeForUid" => {
                    drop(db.ngram_minutes_in_range(Gram::Bigram, uid, None, 0.0, max, &all).unwrap());
                }
                other => panic!("no timing for {other}"),
            }
            if run > 0 {
                ms.push(t0.elapsed().as_secs_f64() * 1000.0);
            }
        }
        println!("| {method} | {:.2} | {:.2} |", ts_ms[method].as_f64().unwrap(), median(&mut ms));
    }
    drop(db);
    remove_db(&path);
}

fn main() {
    assert_eq!(
        std::env::var("TZ").as_deref(),
        Ok("UTC"),
        "run with TZ=UTC, the zone the generator records in"
    );
    let expected = read_json(fixtures_dir().join("expected.json"));
    let day_queries = expected["scenarios"][0]["queries"].clone();
    let heavy_expected = read_json(bench_dir().join("heavy-expected.json"));
    let ts = read_json(bench_dir().join("ts-timings.json"));

    let probe_path = bench_dir().join("bench-probe.db");
    remove_db(&probe_path);
    let report = TypingAnalyticsDb::open(&probe_path).unwrap().pragma_report().unwrap();
    println!(
        "Rust: SQLite {}, journal_mode {}, synchronous {}",
        report.sqlite_version, report.journal_mode, report.synchronous
    );
    println!("TS:   SQLite {}, pragmas {}", ts["runtime"]["sqlite"], ts["pragmas"]);
    remove_db(&probe_path);

    let cases = [
        ("day.jsonl", fixtures_dir().join("day.jsonl"), &day_queries, None),
        ("heavy.jsonl", bench_dir().join("heavy.jsonl"), &heavy_expected["queries"], Some(&heavy_expected)),
    ];
    println!("| input | lines | TS apply ms | Rust apply ms | TS 5 queries ms | Rust 5 queries ms |");
    println!("|---|---|---|---|---|---|");
    for (name, path, queries, check) in cases {
        let lines = std::fs::read_to_string(&path).unwrap().lines().count();
        let (apply, query) = bench(&path, queries, check);
        let t = &ts["timings"][name];
        println!(
            "| {name} | {lines} | {:.1} | {apply:.1} | {:.2} | {query:.2} |",
            t["medianApplyMs"].as_f64().unwrap(),
            t["medianQueryMs"].as_f64().unwrap()
        );
    }
    bench_calls(&heavy_expected, &ts["methodMs"]);
}
