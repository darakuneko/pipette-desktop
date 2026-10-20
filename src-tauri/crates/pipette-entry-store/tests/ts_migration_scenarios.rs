// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the recorded golden store-directory scenarios of the body
//! filename migration: the same files in a temp directory, the same call, then the result and
//! every file left behind compared byte for byte.

#![allow(clippy::unwrap_used)]

mod golden;

use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io;
use std::path::Path;

use golden::*;
use pipette_entry_store::{
    IndexDirRead, migrate_body_filenames, normalize_entries, read_index_dir_migrated,
    unlink_unreferenced_body_files,
};
use pipette_js_json::{JsString, Value, parse, stringify};
use tempfile::TempDir;

/// Path → content bytes; a directory is `path/` → `None`.
type Tree = BTreeMap<String, Option<Vec<u8>>>;

fn hex_bytes(hex: &str) -> Vec<u8> {
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap()).collect()
}

fn expected_tree(value: &Value) -> Tree {
    value
        .as_object()
        .unwrap()
        .iter()
        .map(|(path, content)| {
            let bytes = match content {
                Value::Null => None,
                Value::String(s) => Some(s.as_str().unwrap().as_bytes().to_vec()),
                other => Some(hex_bytes(&text(get(other, "hex")))),
            };
            (path.as_str().unwrap().to_owned(), bytes)
        })
        .collect()
}

fn build(dir: &Path, tree: &Tree) {
    for (path, content) in tree {
        match content {
            None => fs::create_dir_all(dir.join(path)).unwrap(),
            Some(bytes) => fs::write(dir.join(path), bytes).unwrap(),
        }
    }
}

fn record(dir: &Path, prefix: &str, tree: &mut Tree) {
    for item in fs::read_dir(dir).unwrap() {
        let item = item.unwrap();
        let name = item.file_name().into_string().unwrap();
        if item.file_type().unwrap().is_dir() {
            let path = format!("{prefix}{name}/");
            record(&item.path(), &path, tree);
            tree.insert(path, None);
        } else {
            tree.insert(format!("{prefix}{name}"), Some(fs::read(item.path()).unwrap()));
        }
    }
}

fn json(value: impl Into<Value>) -> String {
    stringify(&value.into())
}

fn entries_json(entries: &[pipette_entry_store::Entry]) -> String {
    json(Value::Array(entries.iter().cloned().map(Value::from).collect()))
}

/// The scenario's call, with its result in the shape the generator records.
fn run(scenario: &Value, dir: &Path) -> String {
    let store = store(get(scenario, "store"));
    let result: io::Result<String> = match text(get(scenario, "op")).as_str() {
        "readIndexDir" => read_index_dir_migrated(store, dir).map(|read| match read {
            IndexDirRead::Missing => r#"{"state":"missing"}"#.to_owned(),
            IndexDirRead::Corrupt => r#"{"state":"corrupt"}"#.to_owned(),
            IndexDirRead::Ok { index, entries } => {
                let mut out = pipette_js_json::Object::new();
                out.insert("state", "ok".into());
                out.insert("index", json(index).into());
                out.insert("entries", entries_json(&entries).into());
                json(out)
            }
        }),
        "migrate" => {
            let mut entries =
                normalize_entries(store, Some(&parse(&text(get(scenario, "entries"))).unwrap()));
            let fail = text(get(scenario, "persist")) == "fail";
            migrate_body_filenames(store, dir, &mut entries, |entries| {
                if fail {
                    return Err(io::Error::other("disk full"));
                }
                fs::write(dir.join("persisted.json"), entries_json(entries))
            })
            .map(|changed| {
                let mut out = pipette_js_json::Object::new();
                out.insert("changed", changed.into());
                out.insert("entries", entries_json(&entries).into());
                json(out)
            })
        }
        _ => {
            let referenced: HashSet<JsString> =
                list(get(scenario, "referenced")).iter().map(|r| js(r).clone()).collect();
            let removed = unlink_unreferenced_body_files(store, dir, &referenced);
            Ok(format!(r#"{{"removed":{removed}}}"#))
        }
    };
    result.unwrap_or_else(|_| r#"{"error":true}"#.to_owned())
}

#[test]
fn every_scenario_leaves_the_same_result_and_files() {
    let scenarios = load("ts_migration_scenarios.json");
    let mut failures = Vec::new();
    for scenario in list(&scenarios) {
        let name = text(get(scenario, "name"));
        let tmp = TempDir::new().unwrap();
        let tree = expected_tree(get(scenario, "tree"));
        if let Some(reason) =
            pipette_fs::test_util::unsupported_tree(tmp.path(), tree.keys().map(String::as_str), false)
        {
            eprintln!("SKIPPED {name}: {reason}");
            continue;
        }
        build(tmp.path(), &tree);
        let result = run(scenario, tmp.path());
        expect_eq(&mut failures, format!("{name}: result"), result, json(get(scenario, "result").clone()));
        let mut after = Tree::new();
        record(tmp.path(), "", &mut after);
        let want = expected_tree(get(scenario, "after"));
        let lossy = |tree: &Tree| -> Vec<(String, Option<String>)> {
            tree.iter()
                .map(|(k, v)| (k.clone(), v.as_ref().map(|b| String::from_utf8_lossy(b).into_owned())))
                .collect()
        };
        expect_eq(&mut failures, format!("{name}: files"), lossy(&after), lossy(&want));
        expect_eq(&mut failures, format!("{name}: bytes"), after, want);
    }
    assert!(list(&scenarios).len() > 20);
    assert_none(failures);
}
