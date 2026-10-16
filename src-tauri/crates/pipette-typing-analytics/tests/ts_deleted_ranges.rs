// SPDX-License-Identifier: GPL-2.0-or-later
//! The deleted-ranges store, the clip to a UTC day, the applied record and
//! the ranges of local days against what the TypeScript code did
//! (tests/fixtures/deleted_ranges.json and deleted_ranges_local_days/, written
//! by `pnpm run generate:analytics-db-fixtures`). The local days run once
//! per recorded time zone, each in a process of its own.

// Helpers outside #[test] functions unwrap fixture data too.
#![allow(clippy::unwrap_used)]

mod common;

use std::path::PathBuf;

use common::{array, build_tree, field, fixture, js_text, number, record_tree, text, tree_of};
use pipette_entry_store::WriteLocks;
use pipette_js_json::Value;
use pipette_time::test_util::in_each_time_zone;
use pipette_typing_analytics::deleted_ranges::{
    DeletedRangeEntry, bundle_deleted_ranges, clip_to_utc_day, deleted_ranges_for_local_days,
    parse_deleted_ranges_file, read_applied_ids, read_deleted_ranges, read_deleted_ranges_lenient,
    serialize_deleted_ranges, union_deleted_ranges, update_deleted_ranges, write_applied_ids,
};
use pipette_typing_analytics::jsonl::{deleted_ranges_applied_path, deleted_ranges_path};
use pipette_typing_analytics_db::DeleteRange;

fn entries_of(text: &str) -> Vec<DeletedRangeEntry> {
    parse_deleted_ranges_file(&pipette_js_json::parse(text).unwrap()).unwrap()
}

fn text_or_null(text: Option<String>) -> Value {
    text.map_or(Value::Null, Value::from)
}

#[test]
fn the_store_matches_typescript() {
    let fixture = fixture("deleted_ranges.json");
    let (uid, hash) = (text(&fixture, "uid"), text(&fixture, "hash"));
    let other = entries_of(text(&fixture, "other"));
    for case in array(&fixture, "files") {
        let name = text(case, "name");
        let dir = tempfile::tempdir().unwrap();
        let path = deleted_ranges_path(dir.path(), uid, hash);
        match field(case, "file") {
            Value::String(file) if file == "missing" => {}
            Value::String(file) if file == "dir" => std::fs::create_dir_all(&path).unwrap(),
            file => {
                let relative = path.strip_prefix(dir.path()).unwrap().to_str().unwrap().replace('\\', "/");
                build_tree(
                    dir.path(),
                    &tree_of(&Value::Object([(relative, file.clone())].into_iter().collect())),
                );
            }
        }
        let locks = WriteLocks::new();
        let read = read_deleted_ranges(dir.path(), uid, hash).ok().map(|e| serialize_deleted_ranges(&e));
        assert_eq!(text_or_null(read), *field(case, "read"), "{name}: read");
        let lenient = serialize_deleted_ranges(&read_deleted_ranges_lenient(dir.path(), uid, hash));
        assert_eq!(lenient, text(case, "lenient"), "{name}: lenient read");
        let bundle = bundle_deleted_ranges(&locks, dir.path(), uid, hash);
        assert_eq!(text_or_null(bundle), *field(case, "bundle"), "{name}: bundle");

        let update = update_deleted_ranges(&locks, dir.path(), uid, hash, |local| {
            union_deleted_ranges(&local, &other)
        });
        match field(case, "update") {
            Value::Null => assert!(update.is_err(), "{name}: update"),
            expected => {
                let update = update.unwrap();
                assert_eq!(serialize_deleted_ranges(&update.entries), text(expected, "entries"), "{name}");
                assert_eq!(Value::Bool(update.local_changed), *field(expected, "localChanged"), "{name}");
                assert_eq!(
                    Value::Bool(update.remote_needs_update),
                    *field(expected, "remoteNeedsUpdate"),
                    "{name}"
                );
            }
        }
        let unchanged = update_deleted_ranges(&locks, dir.path(), uid, hash, |local| {
            union_deleted_ranges(&local, &local)
        });
        assert_eq!(Value::Bool(unchanged.is_err()), *field(case, "unchangedError"), "{name}: unchanged");
        assert_eq!(record_tree(dir.path()), tree_of(field(case, "after")), "{name}: tree");
    }
}

fn range(value: &Value) -> DeleteRange {
    let ms = |key| number(field(value, key)) as i64;
    DeleteRange { start_ms: ms("startMs"), end_ms: ms("endMs"), cutoff_ms: ms("cutoffMs") }
}

#[test]
fn clips_match_typescript() {
    for case in array(&fixture("deleted_ranges.json"), "clips") {
        let ranges: Vec<DeleteRange> = array(case, "entries").iter().map(range).collect();
        let clipped = clip_to_utc_day(&ranges, text(case, "day"));
        match field(case, "clipped") {
            Value::Null => assert!(clipped.is_err(), "{case:?}"),
            Value::Array(expected) => {
                assert_eq!(clipped.unwrap(), expected.iter().map(range).collect::<Vec<_>>(), "{case:?}");
            }
            other => panic!("clipped: {other:?}"),
        }
    }
}

#[test]
fn the_applied_record_matches_typescript() {
    let fixture = fixture("deleted_ranges.json");
    let (uid, own_hash) = (text(&fixture, "uid"), text(&fixture, "ownHash"));
    for case in array(&fixture, "applied") {
        let name = text(case, "name");
        let dir = tempfile::tempdir().unwrap();
        let path = deleted_ranges_applied_path(dir.path(), uid, own_hash);
        match field(case, "file") {
            Value::String(file) if file == "no-dir" => {}
            Value::String(file) if file == "missing" => {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap()
            }
            file => {
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                let relative = path.strip_prefix(dir.path()).unwrap().to_str().unwrap().replace('\\', "/");
                build_tree(
                    dir.path(),
                    &tree_of(&Value::Object([(relative, file.clone())].into_iter().collect())),
                );
            }
        }
        let mut ids = read_applied_ids(&path);
        ids.insert(js_text(field(case, "id")).clone());
        let failed = write_applied_ids(&path, &ids).is_err();
        assert_eq!(Value::Bool(failed), *field(case, "error"), "{name}");
        assert_eq!(record_tree(dir.path()), tree_of(field(case, "after")), "{name}");
    }
}

fn local_day_fixtures() -> Vec<(String, Value)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/deleted_ranges_local_days");
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).collect();
    paths.sort();
    paths
        .iter()
        .map(|path| {
            let value = pipette_js_json::parse(&std::fs::read_to_string(path).unwrap()).unwrap();
            (text(&value, "timeZone").to_owned(), value)
        })
        .collect()
}

#[test]
fn ranges_of_local_days_match_typescript_in_each_time_zone() {
    let fixtures = local_day_fixtures();
    let zones: Vec<&str> = fixtures.iter().map(|(zone, _)| zone.as_str()).collect();
    let Some(zone) = in_each_time_zone("ranges_of_local_days_match_typescript_in_each_time_zone", &zones)
    else {
        return;
    };
    let (_, fixture) = fixtures.iter().find(|(z, _)| *z == zone).unwrap();
    let cutoff = number(field(fixture, "cutoffMs")) as i64;
    for case in array(fixture, "cases") {
        let dates: Vec<&str> = array(case, "dates").iter().map(|d| d.as_str().unwrap()).collect();
        let mut n = 0;
        let entries = deleted_ranges_for_local_days(&dates, cutoff, || {
            n += 1;
            format!("id-{n}")
        });
        match field(case, "entries") {
            Value::Null => assert!(entries.is_err(), "{zone} {dates:?}"),
            Value::Array(expected) => {
                let expected: Vec<DeletedRangeEntry> = expected
                    .iter()
                    .map(|e| DeletedRangeEntry { id: js_text(field(e, "id")).clone(), range: range(e) })
                    .collect();
                assert_eq!(entries.unwrap(), expected, "{zone} {dates:?}");
            }
            other => panic!("entries: {other:?}"),
        }
    }
}
