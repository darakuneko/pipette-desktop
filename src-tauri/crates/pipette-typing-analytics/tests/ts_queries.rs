// SPDX-License-Identifier: GPL-2.0-or-later
//! The query layer against the TypeScript IPC handlers, member call by
//! member call (tests/fixtures/queries.json and queries_tz/, written by
//! `pnpm run generate:analytics-db-fixtures`): on the same seed and
//! userData tree, each answer must be the same JSON text, and a call the
//! handler threw on must fail. The calls that go through local days run
//! once per time zone they were recorded in, each in a process of its own.
//!
//! Also `localeCompare` on n-gram ids (tests/fixtures/collation.json): the
//! order of the recorder's characters, the pairs of ids made of them, and
//! pairs with other characters, which compare by code points here.

// Helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

mod common;

use std::cmp::Ordering;
use std::path::{Path, PathBuf};

use common::{array, build_tree, field, fixture, text, tree_of, untag};
use pipette_js_json::Value;
use pipette_time::test_util::in_each_time_zone;
use pipette_typing_analytics::bigram_aggregate::{RECORDED_ID_ORDER, collate};
use pipette_typing_analytics::queries::{Context, Query, local_device_days};
use pipette_typing_analytics_db::TypingAnalyticsDb;

fn seeded() -> TypingAnalyticsDb {
    let seed = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/queries-seed.jsonl");
    let mut db = TypingAnalyticsDb::open_in_memory().unwrap();
    db.apply_day_jsonl(&std::fs::read_to_string(seed).unwrap()).unwrap();
    db
}

/// The answer to one call as JSON text, `None` when it failed.
fn answer(member: &str, args: &[Value], cx: &Context<'_>) -> Option<String> {
    if member == "typingAnalyticsListLocalDeviceDays" {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        return Some(pipette_js_json::stringify(&local_device_days(cx.user_data, &arg(0), &arg(1))));
    }
    let query = Query::from_member(member).unwrap_or_else(|| panic!("no query for {member}"));
    query.answer(args, cx).ok()
}

fn assert_calls(calls: &[Value], user_data: &Path, label: &str) {
    let queries = fixture("queries.json");
    let os = field(&queries, "os");
    let db = seeded();
    let cx = Context {
        db: &db,
        user_data,
        own_hash: text(&queries, "ownHash"),
        os_platform: text(os, "platform"),
        os_release: text(os, "release"),
        recorder: None,
    };
    assert!(!calls.is_empty());
    for (i, call) in calls.iter().enumerate() {
        let member = text(call, "member");
        let Some(Value::Array(args)) = untag(field(call, "args")) else { panic!("args of call {i}") };
        let expected = field(call, "response").as_str();
        let threw = call.as_object().unwrap().contains_key("error");
        let got = answer(member, &args, &cx);
        if threw {
            assert_eq!(got, None, "{label}: call {i} {member} {args:?} should fail");
        } else {
            assert_eq!(got.as_deref(), expected, "{label}: call {i} {member} {args:?}");
        }
    }
}

fn user_data() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    build_tree(dir.path(), &tree_of(field(&fixture("queries.json"), "tree")));
    dir
}

#[test]
fn members_match_typescript() {
    let dir = user_data();
    assert_calls(array(&fixture("queries.json"), "calls"), dir.path(), "queries");
}

#[test]
fn local_time_members_match_typescript_in_each_time_zone() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/queries_tz");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
    paths.sort();
    let fixtures: Vec<Value> =
        paths.iter().map(|p| pipette_js_json::parse(&std::fs::read_to_string(p).unwrap()).unwrap()).collect();
    let zones: Vec<&str> = fixtures.iter().map(|f| text(f, "timeZone")).collect();
    assert_eq!(zones.len(), 5);
    let Some(zone) = in_each_time_zone("local_time_members_match_typescript_in_each_time_zone", &zones)
    else {
        return;
    };
    let fixture = fixtures.iter().find(|f| text(f, "timeZone") == zone).unwrap();
    let user_data = user_data();
    assert_calls(array(fixture, "calls"), user_data.path(), &zone);
}

fn ordering(sign: &Value) -> Ordering {
    match common::number(sign) {
        n if n < 0.0 => Ordering::Less,
        n if n > 0.0 => Ordering::Greater,
        _ => Ordering::Equal,
    }
}

#[test]
fn collation_matches_v8_for_recorded_ids() {
    let fixture = fixture("collation.json");
    assert_eq!(text(&fixture, "order"), RECORDED_ID_ORDER);
    for pair in array(&fixture, "recorded") {
        let Value::Array(pair) = pair else { panic!("pair") };
        let (a, b) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        assert_eq!(collate(a, b), ordering(&pair[2]), "{a:?} vs {b:?}");
    }
    // Other characters compare by code points; at least one such pair
    // compares otherwise in V8.
    let mut differs = 0;
    for pair in array(&fixture, "others") {
        let Value::Array(pair) = pair else { panic!("pair") };
        let (a, b) = (pair[0].as_str().unwrap(), pair[1].as_str().unwrap());
        assert_eq!(collate(a, b), a.cmp(b), "{a:?} vs {b:?}");
        differs += usize::from(collate(a, b) != ordering(&pair[2]));
    }
    assert!(differs > 0);
}
