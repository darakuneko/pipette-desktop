// SPDX-License-Identifier: GPL-2.0-or-later
//! The JSONL rows, files, UTC days and listings against what the TypeScript
//! code did (the recorded goldens tests/fixtures/jsonl_rows.json and
//! jsonl_files.json).

// Helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

mod common;

use common::{Node, array, build_tree, field, fixture, js_text, number, record_tree, text, tree_of, untag};
use pipette_js_json::Value;
use pipette_typing_analytics::jsonl::{
    JsonlRow, append_rows_to_file, bigram_minute_row_id, char_minute_row_id, is_utc_day,
    list_all_device_day_jsonl_files, list_deleted_ranges_hashes, list_device_days, matrix_minute_row_id,
    minute_stats_row_id, read_rows, scope_row_id, serialize_row, session_row_id, trigram_minute_row_id,
    utc_day_boundary_ms, utc_day_from_ms,
};

fn args(value: &Value) -> Vec<Value> {
    match untag(value) {
        Some(Value::Array(items)) => items,
        other => panic!("args: {other:?}"),
    }
}

fn s(value: &Value) -> &str {
    value.as_str().unwrap()
}

fn n(value: &Value) -> f64 {
    number(value)
}

#[test]
fn row_ids_match_typescript() {
    for case in array(&fixture("jsonl_rows.json"), "ids") {
        let a = args(field(case, "args"));
        let id = match text(case, "fn") {
            "scope" => scope_row_id(s(&a[0])),
            "char" => char_minute_row_id(s(&a[0]), n(&a[1]), s(&a[2]), s(&a[3])),
            "matrix" => matrix_minute_row_id(s(&a[0]), n(&a[1]), s(&a[2]), n(&a[3]), n(&a[4]), n(&a[5])),
            "stats" => minute_stats_row_id(s(&a[0]), n(&a[1]), s(&a[2])),
            "session" => session_row_id(s(&a[0])),
            "bigram" => bigram_minute_row_id(s(&a[0]), n(&a[1]), s(&a[2])),
            "trigram" => trigram_minute_row_id(s(&a[0]), n(&a[1]), s(&a[2])),
            other => panic!("unknown id function {other}"),
        };
        assert_eq!(id, text(case, "id"), "{case:?}");
    }
}

#[test]
fn row_lines_match_typescript() {
    for case in array(&fixture("jsonl_rows.json"), "rows") {
        let row = untag(field(case, "row")).unwrap();
        assert_eq!(serialize_row(&row), text(case, "line"));
    }
}

#[test]
fn parsed_rows_match_typescript() {
    let fixture = fixture("jsonl_rows.json");
    let cases = array(&fixture, "parsed");
    let mut accepted = 0;
    for case in cases {
        let parsed = JsonlRow::parse(text(case, "line")).map(|row| row.serialize());
        let expected = field(case, "parsed").as_str();
        assert_eq!(parsed.as_deref(), expected, "{:?}", text(case, "line"));
        accepted += usize::from(expected.is_some());
    }
    assert!(accepted > 20 && accepted < cases.len());
}

fn session_rows(fixture: &Value, ids: &Value) -> Vec<Value> {
    let Value::Array(ids) = ids else { panic!("ids: {ids:?}") };
    ids.iter().map(|id| pipette_js_json::parse(text(field(fixture, "rows"), s(id))).unwrap()).collect()
}

#[test]
fn appends_match_typescript() {
    let fixture = fixture("jsonl_files.json");
    for case in array(&fixture, "appends") {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("d/day.jsonl");
        match field(case, "start") {
            Value::String(start) if start == "missing" => {}
            Value::String(start) if start == "blocked" => {
                std::fs::write(dir.path().join("d"), "a file").unwrap()
            }
            start => build_tree(
                dir.path(),
                &tree_of(&Value::Object([("d/day.jsonl", start.clone())].into_iter().collect())),
            ),
        }
        let mut failed = false;
        for ids in array(case, "appends") {
            if append_rows_to_file(&path, &session_rows(&fixture, ids)).is_err() {
                failed = true;
                break;
            }
        }
        let name = text(case, "name");
        assert_eq!(failed, field(case, "error") == &Value::Bool(true), "{name}");
        assert_eq!(record_tree(dir.path()), tree_of(field(case, "after")), "{name}");
    }
}

#[test]
fn reads_match_typescript() {
    let fixture = fixture("jsonl_files.json");
    for case in array(&fixture, "reads") {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("day.jsonl");
        match field(case, "file") {
            Value::String(file) if file == "missing" => {}
            Value::String(file) if file == "dir" => std::fs::create_dir(&path).unwrap(),
            file => build_tree(
                dir.path(),
                &tree_of(&Value::Object([("day.jsonl", file.clone())].into_iter().collect())),
            ),
        }
        let after_id = match field(case, "afterId") {
            Value::Null => None,
            id => Some(js_text(id)),
        };
        let name = text(case, "name");
        let read = read_rows(&path, after_id, field(case, "mustExist") == &Value::Bool(true));
        match field(case, "result") {
            Value::Null => assert!(read.is_err(), "{name}"),
            expected => {
                let read = read.unwrap();
                let rows: Vec<Value> = read.rows.iter().map(|row| Value::from(row.serialize())).collect();
                assert_eq!(Value::Array(rows), *field(expected, "rows"), "{name}");
                let last_id = read.last_id.map_or(Value::Null, Value::String);
                assert_eq!(last_id, *field(expected, "lastId"), "{name}");
                assert_eq!(
                    Value::Bool(read.partial_line_skipped),
                    *field(expected, "partialLineSkipped"),
                    "{name}"
                );
            }
        }
    }
}

#[test]
fn utc_days_match_typescript() {
    let fixture = fixture("jsonl_files.json");
    for case in array(&fixture, "utcDaysFromMs") {
        assert_eq!(utc_day_from_ms(number(field(case, "ms"))), text(case, "day"), "{case:?}");
    }
    for case in array(&fixture, "utcDays") {
        let day = text(case, "day");
        assert_eq!(Value::Bool(is_utc_day(day)), *field(case, "isUtcDay"), "{day}");
        let range = match utc_day_boundary_ms(day) {
            Ok((start, end)) => Value::Object(
                [("startMs", Value::Number(start as f64)), ("endMs", Value::Number(end as f64))]
                    .into_iter()
                    .collect(),
            ),
            Err(_) => Value::Null,
        };
        assert_eq!(range, *field(case, "range"), "{day}");
    }
}

#[test]
fn listings_match_typescript() {
    let fixture = fixture("jsonl_files.json");
    let listings = field(&fixture, "listings");
    let dir = tempfile::tempdir().unwrap();
    build_tree(dir.path(), &tree_of(field(listings, "tree")));
    let strings = |items: Vec<String>| Value::Array(items.into_iter().map(Value::from).collect());

    let days = field(listings, "deviceDays");
    assert_eq!(strings(list_device_days(dir.path(), "0xAABB", "hash-a")), *field(days, "hash-a"));
    assert_eq!(strings(list_device_days(dir.path(), "0xAABB", "missing")), *field(days, "missing"));

    let all: Vec<Value> = list_all_device_day_jsonl_files(dir.path())
        .into_iter()
        .map(|r| {
            let path = r.path.strip_prefix(dir.path()).unwrap();
            let path: Vec<&str> = path.components().map(|c| c.as_os_str().to_str().unwrap()).collect();
            let fields = [
                ("uid", Value::from(r.uid)),
                ("machineHash", Value::from(r.machine_hash)),
                ("utcDay", Value::from(r.utc_day)),
                ("path", Value::from(path.join("/"))),
            ];
            Value::Object(fields.into_iter().collect())
        })
        .collect();
    assert_eq!(Value::Array(all), *field(listings, "allDays"));

    let hashes = field(listings, "deletedRangesHashes");
    assert_eq!(strings(list_deleted_ranges_hashes(dir.path(), "0xAABB")), *field(hashes, "0xAABB"));
    assert_eq!(strings(list_deleted_ranges_hashes(dir.path(), "missing")), *field(hashes, "missing"));
}

/// The fixtures cover a byte the trees would not otherwise show.
#[test]
fn the_append_fixtures_keep_invalid_utf8() {
    let fixture = fixture("jsonl_files.json");
    let case = array(&fixture, "appends").iter().find(|c| text(c, "name") == "after invalid UTF-8").unwrap();
    let after = tree_of(field(case, "after"));
    assert!(
        matches!(after.get("d/day.jsonl"), Some(Node::File(bytes)) if bytes.starts_with(&[0xe6, 0x97, b'\n']))
    );
}
