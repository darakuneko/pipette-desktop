// SPDX-License-Identifier: GPL-2.0-or-later
//! Replays the function tables recorded from the TypeScript helpers by
//! scripts/entry-store-fixtures/record-entry-store-fixtures.test.ts and
//! compares every result byte for byte.

#![allow(clippy::unwrap_used)]

mod golden;

use golden::*;
use pipette_entry_store::{
    Entry, EntryMutation, EntryStore, MetaGroup, OverwriteOptions, apply_entry_mutation, body_fields_of,
    body_filename_has_id, body_hash, builtin_entry, canonical_json, clock_ms, create_entry,
    derived_updated_at, group_values, id_body_filename, id_filename_segment, is_safe_key, is_safe_pack_id,
    is_safe_path, is_safe_path_segment, mark_deleted, new_clocks, normalize_entries, normalize_entry,
    overwrite_entry, revive_entry, safe_filename, set_clock, touch_clock, truncate_utf8,
    truncate_utf8_name_part, ts_for_export_filename, ts_for_filename, utf8_byte_length, valid_clock,
};
use pipette_js_json::{JsString, Value, parse, stringify};

const GROUPS: [&str; 5] = ["created", "body", "name", "hub", "enabled"];

fn fixture() -> Value {
    load("ts_functions.json")
}

fn json(value: impl Into<Value>) -> String {
    stringify(&value.into())
}

fn names(value: Option<&'static [&'static str]>) -> Value {
    value.map_or(Value::Null, |fields| Value::Array(fields.iter().map(|f| Value::from(*f)).collect()))
}

#[test]
fn store_groups_match() {
    let mut failures = Vec::new();
    let cases = fixture();
    let cases = list(get(&cases, "storeGroups"));
    assert_eq!(cases.len(), EntryStore::ALL.len());
    for case in cases {
        let store = store(get(case, "store"));
        let def = store.groups();
        let field = |key: &str| case.as_object().unwrap().get(key).cloned().unwrap_or(Value::Null);
        let label = store.name();
        expect_eq(&mut failures, format!("{label} body"), names(Some(def.body)), field("body"));
        expect_eq(
            &mut failures,
            format!("{label} created"),
            names(Some(def.created_fields)),
            field("createdFields"),
        );
        expect_eq(&mut failures, format!("{label} name"), names(def.name), field("name"));
        expect_eq(&mut failures, format!("{label} hub"), names(def.hub), field("hub"));
        expect_eq(&mut failures, format!("{label} enabled"), names(def.enabled), field("enabled"));
        let v1 = match def.v1_body_clock {
            pipette_entry_store::V1BodyClockRule::SavedAt => "savedAt",
            pipette_entry_store::V1BodyClockRule::UpdatedAtOrSavedAt => "updatedAtOrSavedAt",
            pipette_entry_store::V1BodyClockRule::Epoch => "epoch",
        };
        expect_eq(&mut failures, format!("{label} v1"), Value::from(v1), field("v1BodyClock"));
        let rule = match def.filename_id {
            pipette_entry_store::FilenameIdRule::Suffix => "suffix",
            pipette_entry_store::FilenameIdRule::Prefix => "prefix",
            pipette_entry_store::FilenameIdRule::Fixed => "fixed",
        };
        expect_eq(&mut failures, format!("{label} filenameId"), Value::from(rule), field("filenameId"));
        expect_eq(&mut failures, format!("{label} ext"), Value::from(def.body_ext), field("bodyExt"));
        expect_eq(
            &mut failures,
            format!("{label} hashBody"),
            def.hash_body,
            field("hashBody") == Value::Bool(true),
        );
    }
    assert_none(failures);
}

#[test]
fn dates_match() {
    let mut failures = Vec::new();
    let fixture = fixture();
    let dates = get(&fixture, "dates");
    for case in list(get(dates, "texts")) {
        let value = Some(get(case, "text"));
        let label = format!("{:?}", text(get(case, "text")));
        expect_eq(&mut failures, format!("clockMs {label}"), clock_ms(value), int(get(case, "clockMs")));
        let want = match get(case, "validClock") {
            Value::Null => None,
            v => Some(text(v)),
        };
        expect_eq(&mut failures, format!("validClock {label}"), valid_clock(value), want);
    }
    // Forms only V8's fallback parser reads: 0 here (where V8 gives the
    // recorded time).
    let v8_only = list(get(dates, "v8Only"));
    assert!(!v8_only.is_empty());
    for case in v8_only {
        expect_eq(
            &mut failures,
            format!("v8-only {:?}", text(get(case, "text"))),
            clock_ms(Some(get(case, "text"))),
            0,
        );
    }
    for case in list(get(dates, "nonStrings")) {
        let value = parse(&text(get(case, "text"))).unwrap();
        expect_eq(
            &mut failures,
            format!("clockMs {}", text(get(case, "text"))),
            clock_ms(Some(&value)),
            int(get(case, "clockMs")),
        );
    }
    assert_none(failures);
}

#[test]
fn utf8_truncation_matches() {
    let mut failures = Vec::new();
    for case in list(get(&fixture(), "utf8")) {
        let units = js(get(case, "text")).utf16_units();
        let label = format!("{units:x?}");
        expect_eq(
            &mut failures,
            format!("length {label}"),
            utf8_byte_length(&units),
            int(get(case, "byteLength")) as usize,
        );
        for cut in list(get(case, "cuts")) {
            let max = int(get(cut, "max")) as usize;
            expect_eq(
                &mut failures,
                format!("truncate {label} {max}"),
                truncate_utf8(&units, max).to_vec(),
                js(get(cut, "truncate")).utf16_units(),
            );
            expect_eq(
                &mut failures,
                format!("namePart {label} {max}"),
                truncate_utf8_name_part(&units, max).to_vec(),
                js(get(cut, "namePart")).utf16_units(),
            );
        }
    }
    assert_none(failures);
}

#[test]
fn safe_filename_helpers_match() {
    let mut failures = Vec::new();
    let fixture = fixture();
    let cases = get(&fixture, "safeFilename");
    for case in list(get(cases, "safeFilename")) {
        let name = text(get(case, "name"));
        expect_eq(
            &mut failures,
            format!("safeFilename {name:?}"),
            safe_filename(&name, "fallback"),
            text(get(case, "out")),
        );
    }
    for case in list(get(cases, "segments")) {
        let value = text(get(case, "value"));
        let flag = |key| get(case, key) == &Value::Bool(true);
        expect_eq(&mut failures, format!("segment {value:?}"), is_safe_path_segment(&value), flag("segment"));
        expect_eq(&mut failures, format!("key {value:?}"), is_safe_key(&value), flag("key"));
        expect_eq(&mut failures, format!("path {value:?}"), is_safe_path(&value), flag("path"));
        expect_eq(&mut failures, format!("packId {value:?}"), is_safe_pack_id(&value), flag("packId"));
    }
    for case in list(get(cases, "timestamps")) {
        let ms = int(get(case, "ms"));
        expect_eq(
            &mut failures,
            format!("tsForFilename {ms}"),
            ts_for_filename(ms),
            text(get(case, "filename")),
        );
        expect_eq(
            &mut failures,
            format!("tsForExportFilename {ms}"),
            ts_for_export_filename(ms),
            text(get(case, "export")),
        );
    }
    assert_none(failures);
}

#[test]
fn body_filenames_match() {
    let mut failures = Vec::new();
    let fixture = fixture();
    let cases = get(&fixture, "bodyFilenames");
    for case in list(get(cases, "segments")) {
        let id = js(get(case, "id"));
        expect_eq(
            &mut failures,
            format!("segment {id:?}"),
            id_filename_segment(id),
            js(get(case, "segment")).utf16_units(),
        );
    }
    let mut count = 0;
    for case in list(get(cases, "cases")) {
        let (id, filename) = (js(get(case, "id")), js(get(case, "filename")));
        for per_store in list(get(case, "perStore")) {
            let store = store(get(per_store, "store"));
            // Every store with the same filename rule gives the same answers.
            for same_rule in
                EntryStore::ALL.into_iter().filter(|s| s.groups().filename_id == store.groups().filename_id)
            {
                let label = format!("{} {id:?} {filename:?}", same_rule.name());
                let has = get(per_store, "hasId") == &Value::Bool(true);
                expect_eq(
                    &mut failures,
                    format!("hasId {label}"),
                    body_filename_has_id(same_rule, id, filename),
                    has,
                );
                expect_eq(
                    &mut failures,
                    format!("named {label}"),
                    &id_body_filename(same_rule, id, filename),
                    js(get(per_store, "named")),
                );
                count += 1;
            }
        }
    }
    assert!(count > 1000);
    assert_none(failures);
}

#[test]
fn canonical_json_and_body_hash_match() {
    let mut failures = Vec::new();
    let fixture = fixture();
    for case in list(get(&fixture, "canonical")) {
        let source = text(get(case, "text"));
        let value = parse(&source).unwrap();
        expect_eq(
            &mut failures,
            format!("canonical {source}"),
            canonical_json(Some(&value)),
            text(get(case, "out")),
        );
    }
    for case in list(get(&fixture, "bodyHash")) {
        // The body text as the Electron build hashes it: UTF-8, U+FFFD for
        // a lone surrogate.
        let body = js(get(case, "text")).to_string_lossy();
        expect_eq(&mut failures, format!("bodyHash {body:?}"), body_hash(&body), text(get(case, "hash")));
    }
    let new = get(&fixture, "newClocks");
    for case in list(get(new, "cases")) {
        let store = store(get(case, "store"));
        expect_eq(
            &mut failures,
            store.name(),
            json(new_clocks(store, int(get(new, "now")))),
            text(get(case, "clocks")),
        );
    }
    assert_none(failures);
}

#[test]
fn normalization_and_groups_match() {
    let mut failures = Vec::new();
    let fixture = fixture();
    for case in list(get(&fixture, "normalize")) {
        let source = text(get(case, "text"));
        let raw = object(&source);
        for per_store in list(get(case, "perStore")) {
            let store = store(get(per_store, "store"));
            let def = store.groups();
            let label = format!("{} {source}", store.name());
            expect_eq(
                &mut failures,
                format!("normalize {label}"),
                json(normalize_entry(store, &raw)),
                text(get(per_store, "normalized")),
            );
            let fields: Vec<JsString> =
                list(get(per_store, "bodyFields")).iter().map(|f| js(f).clone()).collect();
            expect_eq(&mut failures, format!("bodyFields {label}"), body_fields_of(def, &raw), fields);
            for (i, name) in GROUPS.iter().enumerate() {
                let values = group_values(def, &raw, group(name));
                let canonical = canonical_json(Some(&values.clone().into()));
                expect_eq(
                    &mut failures,
                    format!("groupValues {name} {label}"),
                    json(values),
                    text(&list(get(per_store, "groups"))[i]),
                );
                expect_eq(
                    &mut failures,
                    format!("canonical {name} {label}"),
                    canonical,
                    text(&list(get(per_store, "canonical"))[i]),
                );
            }
        }
    }
    for case in list(get(&fixture, "normalizeEntries")) {
        let store = store(get(case, "store"));
        let source = text(get(case, "text"));
        let entries = normalize_entries(store, Some(&parse(&source).unwrap()));
        let out = Value::Array(entries.into_iter().map(Value::from).collect());
        expect_eq(
            &mut failures,
            format!("normalizeEntries {} {source}", store.name()),
            json(out),
            text(get(case, "out")),
        );
    }
    assert_none(failures);
}

#[test]
fn clock_writers_match() {
    let mut failures = Vec::new();
    let fixture = fixture();
    let writers = get(&fixture, "writers");
    let now: Vec<i64> = list(get(writers, "now")).iter().map(int).collect();
    let set_clocks: Vec<String> = list(get(writers, "setClocks")).iter().map(text).collect();
    let deleted_at = int(get(writers, "reviveDeletedAt"));
    for case in list(get(writers, "cases")) {
        let source = text(get(case, "text"));
        let entry = normalize_entry(EntryStore::Favorites, &object(&source));
        let ops = get(case, "ops");
        for name in GROUPS {
            let g = group(name);
            for (i, &t) in now.iter().enumerate() {
                let mut e = entry.clone();
                let result = touch_clock(&mut e, g, t).map(|()| Some(json(e)));
                check_outcome(
                    &mut failures,
                    &format!("touch {name} {t} {source}"),
                    &list(get(ops, &format!("touch:{name}")))[i],
                    result,
                );
            }
            for (i, iso) in set_clocks.iter().enumerate() {
                let mut e = entry.clone();
                set_clock(&mut e, g, iso);
                check_outcome(
                    &mut failures,
                    &format!("set {name} {iso} {source}"),
                    &list(get(ops, &format!("set:{name}")))[i],
                    Ok(Some(json(e))),
                );
            }
        }
        for (i, &t) in now.iter().enumerate() {
            let mut e = entry.clone();
            mark_deleted(&mut e, t);
            check_outcome(
                &mut failures,
                &format!("markDeleted {t} {source}"),
                &list(get(ops, "markDeleted"))[i],
                Ok(Some(json(e))),
            );
            let mut e = entry.clone();
            mark_deleted(&mut e, deleted_at);
            let result = revive_entry(&mut e, t).map(|()| Some(json(e)));
            check_outcome(
                &mut failures,
                &format!("revive {t} {source}"),
                &list(get(ops, "revive"))[i],
                result,
            );
            let mut e = entry.clone();
            let result = revive_entry(&mut e, t).map(|()| Some(json(e)));
            check_outcome(
                &mut failures,
                &format!("reviveLive {t} {source}"),
                &list(get(ops, "reviveLive"))[i],
                result,
            );
        }
        let derived = derived_updated_at(entry.clocks().unwrap(), entry.deleted_at());
        expect_eq(&mut failures, format!("derived {source}"), derived, text(get(ops, "derived")));
    }
    assert_none(failures);
}

#[test]
fn writes_match() {
    let mut failures = Vec::new();
    let fixture = fixture();
    let writes = get(&fixture, "writes");
    let now = int(get(writes, "now"));
    let next = get(writes, "next").as_object().unwrap();
    let existing = get(writes, "existing").as_object().unwrap();
    for case in list(get(writes, "create")) {
        let store = store(get(case, "store"));
        for (i, (_, fields)) in next.iter().enumerate() {
            let fields = object(&text(fields));
            let label = format!("{} {i}", store.name());
            expect_eq(
                &mut failures,
                format!("create {label}"),
                json(create_entry(store, fields.clone(), now)),
                text(&list(get(case, "created"))[i]),
            );
            expect_eq(
                &mut failures,
                format!("builtin {label}"),
                json(builtin_entry(store, fields)),
                text(&list(get(case, "builtin"))[i]),
            );
        }
    }
    let options: Vec<OverwriteOptions> = list(get(writes, "options"))
        .iter()
        .map(|o| OverwriteOptions {
            body: get(o, "body") == &Value::Bool(true),
            explicit: get(o, "explicit") == &Value::Bool(true),
        })
        .collect();
    for case in list(get(writes, "overwrite")) {
        let store = store(get(case, "store"));
        let (existing_name, next_name) = (text(get(case, "existing")), text(get(case, "next")));
        let existing = match existing.get(&existing_name).unwrap() {
            Value::Null => None,
            v => Some(normalize_entry(store, &object(&text(v)))),
        };
        let fields = object(&text(next.get(&next_name).unwrap()));
        for (i, opts) in options.iter().enumerate() {
            let result =
                overwrite_entry(store, existing.as_ref(), fields.clone(), now, *opts).map(|e| Some(json(e)));
            let label = format!("overwrite {} {existing_name} {next_name} {opts:?}", store.name());
            check_outcome(&mut failures, &label, &list(get(case, "results"))[i], result);
        }
    }
    assert_none(failures);
}

#[test]
fn mutations_match() {
    let mut failures = Vec::new();
    let fixture = fixture();
    let mutations = get(&fixture, "mutations");
    let now = int(get(mutations, "now"));
    let mut entries: Vec<Entry> = list(&parse(&text(get(mutations, "start"))).unwrap())
        .iter()
        .map(|e| Entry::from_object(e.as_object().unwrap().clone()))
        .collect();
    for step in list(get(mutations, "steps")) {
        let id = js(get(step, "id"));
        let mutation = match text(get(step, "group")).as_str() {
            "delete" => EntryMutation::Delete,
            "name" => EntryMutation::Meta(MetaGroup::Name),
            "hub" => EntryMutation::Meta(MetaGroup::Hub),
            _ => EntryMutation::Meta(MetaGroup::Enabled),
        };
        let set = object(&text(get(step, "set")));
        let result = apply_entry_mutation(&mut entries, id, mutation, now, |e| {
            for (key, value) in set.iter() {
                e.set(key.as_str().unwrap(), value.clone());
            }
        })
        .map(|e| Some(e.map_or_else(|| "null".to_owned(), |e| json(e.clone()))));
        let label = format!("{id:?} {mutation:?}");
        check_outcome(&mut failures, &label, get(step, "result"), result);
        let after = Value::Array(entries.iter().cloned().map(Value::from).collect());
        expect_eq(&mut failures, format!("entries after {label}"), json(after), text(get(step, "entries")));
    }
    assert_none(failures);
}
