// SPDX-License-Identifier: GPL-2.0-or-later
//! TypeScript → Rust, method by method: the calls and write scenarios of
//! tests/fixtures/methods.json and methods_tz/, which the real TypeScript
//! DB layer on better-sqlite3 answered on the same seed, recorded as
//! goldens. Every answer must be equal
//! to the bit in canonical form, and after each write scenario every table
//! cell by cell. The calls that group by local days run once per time zone
//! they were recorded in, each in a process of its own.

#![allow(clippy::unwrap_used)]

mod common;

use std::path::PathBuf;

use common::{assert_tables, fixtures_dir, open_read_only, read_json, remove_db, run_call};
use pipette_time::test_util::{in_each_time_zone, sqlite_time_zones};
use pipette_typing_analytics_db::TypingAnalyticsDb;
use serde_json::Value;

fn seed() -> String {
    std::fs::read_to_string(fixtures_dir().join("methods-seed.jsonl")).unwrap()
}

fn seeded() -> TypingAnalyticsDb {
    let mut db = TypingAnalyticsDb::open_in_memory().unwrap();
    db.apply_day_jsonl(&seed()).unwrap();
    db
}

fn assert_calls(db: &mut TypingAnalyticsDb, calls: &Value, label: &str) {
    let calls = calls.as_array().unwrap();
    assert!(!calls.is_empty());
    for (i, call) in calls.iter().enumerate() {
        let method = call["method"].as_str().unwrap();
        let got = run_call(db, method, call["args"].as_array().unwrap());
        assert_eq!(got, call["result"], "{label}: call {i} {method}({})", call["args"]);
    }
}

#[test]
fn reads_match_typescript() {
    let expected = read_json(fixtures_dir().join("methods.json"));
    let mut db = TypingAnalyticsDb::open_in_memory().unwrap();
    let applied = db.apply_day_jsonl(&seed()).unwrap();
    assert_eq!(serde_json::to_value(applied).unwrap(), expected["seedApplied"]);
    assert_calls(&mut db, &expected["calls"], "reads");
}

#[test]
fn write_scenarios_match_typescript() {
    let expected = read_json(fixtures_dir().join("methods.json"));
    let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("pipette-typing-analytics-db");
    std::fs::create_dir_all(&dir).unwrap();
    for scenario in expected["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let path = dir.join(format!("methods-{name}.db"));
        remove_db(&path);
        let mut db = TypingAnalyticsDb::open(&path).unwrap();
        if scenario["seeded"].as_bool().unwrap() {
            db.apply_day_jsonl(&seed()).unwrap();
        }
        assert_calls(&mut db, &scenario["ops"], name);
        assert_tables(&open_read_only(&path), &scenario["tables"], name);
    }
}

#[test]
fn local_time_reads_match_typescript() {
    let dir = fixtures_dir().join("methods_tz");
    let mut fixtures: Vec<Value> =
        std::fs::read_dir(&dir).unwrap().map(|entry| read_json(entry.unwrap().path())).collect();
    fixtures.sort_by_key(|f| f["timeZone"].as_str().unwrap().to_owned());
    let zones: Vec<&str> = fixtures.iter().map(|f| f["timeZone"].as_str().unwrap()).collect();
    assert_eq!(zones.len(), 5);
    let zones = sqlite_time_zones(&zones);
    let Some(zone) = in_each_time_zone("local_time_reads_match_typescript", &zones) else { return };
    let fixture = fixtures.iter().find(|f| f["timeZone"].as_str() == Some(&zone)).unwrap();
    assert_calls(&mut seeded(), &fixture["calls"], &zone);
}
