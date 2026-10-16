// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the entry merges recorded from src/main/sync/entry-merge.ts by
//! scripts/sync-fixtures/record-entry-merge-fixtures.test.ts and compares
//! every result byte for byte.

#![allow(clippy::unwrap_used)]

mod golden;

use std::cmp::Ordering;

use golden::*;
use pipette_entry_store::{
    BodyPolicy, Entry, MergeOptions, MergeSide, compare_bodies, gc_tombstones, merge_entries,
};
use pipette_js_json::{Value, parse, stringify};

fn entries(value: &Value) -> Vec<Entry> {
    match parse(&text(value)).unwrap() {
        Value::Array(items) => items
            .into_iter()
            .map(|v| match v {
                Value::Object(o) => Entry::from_object(o),
                other => panic!("not an entry: {}", stringify(&other)),
            })
            .collect(),
        other => panic!("not a list: {}", stringify(&other)),
    }
}

fn json(entries: &[Entry]) -> String {
    stringify(&Value::Array(entries.iter().cloned().map(Value::from).collect()))
}

/// `true` / `false` for the whole side, or the filenames the side lacks.
fn has_body_rule(rule: &Value, entry: &Entry) -> bool {
    match rule {
        Value::Bool(all) => *all,
        Value::Array(missing) => !missing.iter().any(|name| Some(js(name)) == entry.filename()),
        other => panic!("bad rule {}", stringify(other)),
    }
}

fn side_key(side: MergeSide) -> &'static str {
    match side {
        MergeSide::Local => "local",
        MergeSide::Remote => "remote",
    }
}

#[test]
fn merges_match() {
    let fixture = load("ts_entry_merge.json");
    let mut failures = Vec::new();
    for case in list(get(&fixture, "merges")) {
        let name = text(get(case, "name"));
        let rules = get(case, "hasBody");
        let has_body = |side: MergeSide, e: &Entry| has_body_rule(get(rules, side_key(side)), e);
        let hashes = get(case, "hashes");
        let body_hash = |side: MergeSide, e: &Entry| -> Option<String> {
            get(hashes, side_key(side)).as_object()?.get(e.id()?.as_str()?).map(text)
        };
        let policy = if text(get(case, "policy")) == "localIfPresent" {
            BodyPolicy::LocalIfPresent
        } else {
            BodyPolicy::Clock { has_body: &has_body }
        };
        let mut options = MergeOptions::new(policy, int(get(case, "now")));
        options.preserve_local_order = *get(case, "preserveLocalOrder") == Value::Bool(true);
        if *hashes != Value::Null {
            options.body_hash = Some(&body_hash);
        }
        if let Value::Number(max) = get(case, "runLogRetentionMax") {
            options.run_log_retention_max = Some(*max as usize);
        }
        let r = merge_entries(
            store(get(case, "store")),
            &entries(get(case, "local")),
            &entries(get(case, "remote")),
            &options,
        );

        let want = get(case, "result");
        expect_eq(&mut failures, format!("{name}: entries"), json(&r.entries), text(get(want, "entries")));
        let by_id = Value::Array(
            r.by_id
                .iter()
                .map(|(id, o)| {
                    let mut outcome = pipette_js_json::Object::new();
                    outcome.insert("entry", o.entry.clone().into());
                    outcome.insert("bodyFromRemote", o.body_from_remote.into());
                    outcome.insert("bodyFetchNeeded", o.body_fetch_needed.into());
                    outcome.insert("bodyMissing", o.body_missing.into());
                    Value::Array(vec![Value::String(id.clone()), Value::Object(outcome)])
                })
                .collect(),
        );
        expect_eq(&mut failures, format!("{name}: byId"), stringify(&by_id), text(get(want, "byId")));
        let copies = Value::Array(
            r.remote_files_to_copy
                .iter()
                .map(|c| {
                    let mut o = pipette_js_json::Object::new();
                    o.insert("from", Value::String(c.from.clone()));
                    o.insert("to", Value::String(c.to.clone()));
                    Value::Object(o)
                })
                .collect(),
        );
        expect_eq(
            &mut failures,
            format!("{name}: copies"),
            stringify(&copies),
            text(get(want, "remoteFilesToCopy")),
        );
        let mut referenced: Vec<Vec<u16>> = r.referenced_filenames.iter().map(|f| f.utf16_units()).collect();
        referenced.sort();
        let want_referenced: Vec<Vec<u16>> =
            list(get(want, "referencedFilenames")).iter().map(|f| js(f).utf16_units()).collect();
        expect_eq(&mut failures, format!("{name}: referenced"), referenced, want_referenced);
        expect_eq(
            &mut failures,
            format!("{name}: localNeedsWrite"),
            Value::Bool(r.local_needs_write),
            get(want, "localNeedsWrite").clone(),
        );
        expect_eq(
            &mut failures,
            format!("{name}: remoteNeedsUpdate"),
            Value::Bool(r.remote_needs_update),
            get(want, "remoteNeedsUpdate").clone(),
        );
        expect_eq(&mut failures, format!("{name}: evicted"), json(&r.evicted), text(get(want, "evicted")));
    }
    assert_none(failures);
}

#[test]
fn gc_tombstones_match() {
    let fixture = load("ts_entry_merge.json");
    let mut failures = Vec::new();
    for case in list(get(&fixture, "gcTombstones")) {
        let now = int(get(case, "now"));
        let out = gc_tombstones(&entries(get(case, "entries")), now);
        expect_eq(&mut failures, format!("gc at {now}"), json(&out), text(get(case, "out")));
    }
    assert_none(failures);
}

#[test]
fn compare_bodies_match() {
    let fixture = load("ts_entry_merge.json");
    let mut failures = Vec::new();
    for (i, case) in list(get(&fixture, "compareBodies")).iter().enumerate() {
        let a = Entry::from_object(object(&text(get(case, "a"))));
        let b = Entry::from_object(object(&text(get(case, "b"))));
        let hashes = match get(case, "hashes") {
            Value::Array(pair) => Some((text(&pair[0]), text(&pair[1]))),
            _ => None,
        };
        let hash_fn = |pair: &(String, String)| (Some(pair.0.clone()), Some(pair.1.clone()));
        let order = match &hashes {
            Some(pair) => {
                compare_bodies(pipette_entry_store::EntryStore::Snapshots, &a, &b, Some(&|| hash_fn(pair)))
            }
            None => compare_bodies(pipette_entry_store::EntryStore::Snapshots, &a, &b, None),
        };
        let sign = match order {
            Ordering::Less => -1,
            Ordering::Equal => 0,
            Ordering::Greater => 1,
        };
        expect_eq(&mut failures, format!("compare {i}"), sign, int(get(case, "sign")));
    }
    assert_none(failures);
}
