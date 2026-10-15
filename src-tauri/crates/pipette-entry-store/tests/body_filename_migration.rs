// SPDX-License-Identifier: GPL-2.0-or-later
//! The specs of src/main/sync/__tests__/body-filename-migration.test.ts,
//! and of the index-directory read and the unreferenced-body sweep.

#![allow(clippy::unwrap_used)]

mod common;

use std::cell::Cell;
use std::collections::HashSet;
use std::fs;
use std::io;
use std::path::Path;

use common::*;
use pipette_entry_store::{
    Entry, EntryStore, IndexDirRead, is_body_file_name, migrate_body_filenames, read_index_dir_migrated,
    unlink_unreferenced_body_files,
};
use pipette_js_json::JsString;
use tempfile::TempDir;

fn entry(id: &str, filename: &str, extra: &[(&str, &str)]) -> Entry {
    let mut pairs =
        vec![("id", q(id)), ("filename", q(filename)), ("savedAt", q("2026-01-01T00:00:00.000Z"))];
    pairs.extend(extra.iter().map(|(k, v)| (*k, v.to_string())));
    let refs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    Entry::from_object(obj(&fields(&refs)))
}

fn names(entries: &[Entry]) -> Vec<String> {
    entries.iter().map(|e| e.filename().unwrap().to_string_lossy().into_owned()).collect()
}

fn listing(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
    names.sort();
    names
}

fn read(dir: &Path, name: &str) -> String {
    fs::read_to_string(dir.join(name)).unwrap()
}

#[test]
fn copies_a_legacy_file_shared_by_two_ids_to_each_id_then_removes_it() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    fs::write(dir.join("macro_ts_ab12.json"), "BODY").unwrap();
    let mut entries = vec![entry("id1", "macro_ts_ab12.json", &[]), entry("id2", "macro_ts_ab12.json", &[])];
    let persisted = Cell::new(0);
    let changed = migrate_body_filenames(EntryStore::Favorites, dir, &mut entries, |_| {
        // The index is written while the legacy file still exists.
        assert_eq!(read(dir, "macro_ts_ab12.json"), "BODY");
        persisted.set(persisted.get() + 1);
        Ok(())
    })
    .unwrap();
    assert!(changed);
    assert_eq!(persisted.get(), 1);
    assert_eq!(names(&entries), ["macro_ts_ab12_id1.json", "macro_ts_ab12_id2.json"]);
    assert_eq!(read(dir, "macro_ts_ab12_id1.json"), "BODY");
    assert_eq!(read(dir, "macro_ts_ab12_id2.json"), "BODY");
    assert_eq!(listing(dir), ["macro_ts_ab12_id1.json", "macro_ts_ab12_id2.json"]);
}

#[test]
fn keeps_a_legacy_file_another_entry_still_names_under_that_name() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    // `abc` names its own body in the prefix form and keeps it; `other` gets a copy.
    let mut entries = vec![entry("abc", "abc_x.json", &[]), entry("other", "abc_x.json", &[])];
    fs::write(dir.join("abc_x.json"), "SHARED").unwrap();
    migrate_body_filenames(EntryStore::KeyLabels, dir, &mut entries, |_| Ok(())).unwrap();
    assert_eq!(names(&entries), ["abc_x.json", "other_abc_x.json"]);
    assert_eq!(read(dir, "abc_x.json"), "SHARED");
    assert_eq!(read(dir, "other_abc_x.json"), "SHARED");
}

#[test]
fn renames_a_tombstone_whose_body_file_is_gone_without_failing() {
    let tmp = TempDir::new().unwrap();
    let mut entries = vec![entry("t", "gone.json", &[("deletedAt", "\"2026-01-02T00:00:00.000Z\"")])];
    assert!(
        migrate_body_filenames(EntryStore::AnalyzeFilters, tmp.path(), &mut entries, |_| Ok(())).unwrap()
    );
    assert_eq!(names(&entries), ["gone_t.json"]);
}

#[test]
fn does_nothing_when_every_name_already_carries_its_id() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    fs::write(dir.join("a_ts_ab.json"), "BODY").unwrap();
    let mut entries = vec![entry("id1", "a_ts_ab.json", &[])];
    migrate_body_filenames(EntryStore::Favorites, dir, &mut entries, |_| Ok(())).unwrap();
    let changed =
        migrate_body_filenames(EntryStore::Favorites, dir, &mut entries, |_| panic!("persisted")).unwrap();
    assert!(!changed);
    assert_eq!(listing(dir), ["a_ts_ab_id1.json"]);
}

#[test]
fn leaves_the_legacy_file_in_place_when_writing_the_index_fails() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    fs::write(dir.join("old.json"), "BODY").unwrap();
    let mut entries = vec![entry("id1", "old.json", &[])];
    let err = migrate_body_filenames(EntryStore::Favorites, dir, &mut entries, |_| {
        Err(io::Error::other("disk full"))
    })
    .unwrap_err();
    assert_eq!(err.to_string(), "disk full");
    assert_eq!(read(dir, "old.json"), "BODY");
}

#[test]
fn a_copy_failure_fails_before_the_index_is_written() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    // A directory where the source file should be: the copy fails with an
    // error other than a missing file.
    fs::create_dir(dir.join("old.json")).unwrap();
    let mut entries = vec![entry("id1", "old.json", &[])];
    assert!(
        migrate_body_filenames(EntryStore::Favorites, dir, &mut entries, |_| panic!("persisted")).is_err()
    );
    assert_eq!(names(&entries), ["old.json"]);
}

#[test]
fn skips_unsafe_filenames_and_entries_without_a_string_filename() {
    let tmp = TempDir::new().unwrap();
    let mut entries = vec![
        entry("id1", "../evil.json", &[]),
        entry("id2", "..", &[]),
        Entry::from_object(obj(r#"{"id":"id3","filename":5}"#)),
    ];
    assert!(!migrate_body_filenames(EntryStore::Favorites, tmp.path(), &mut entries, |_| Ok(())).unwrap());
    assert_eq!(text(&entries[0], "filename").as_deref(), Some("../evil.json"));
}

#[test]
fn moves_a_240_byte_legacy_snapshot_name_to_a_name_the_file_system_accepts() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    let id = "0b9f6f1e-3c1a-4e0e-9d7a-2f1d5f6b8a90";
    let ts = "2026-03-15T14-35-29.037Z";
    let legacy = format!("{}_{ts}.pipette", "K".repeat(240 - ts.len() - "_.pipette".len()));
    assert_eq!(legacy.len(), 240);
    fs::write(dir.join(&legacy), "BODY").unwrap();
    let mut entries = vec![entry(id, &legacy, &[])];
    assert!(migrate_body_filenames(EntryStore::Snapshots, dir, &mut entries, |_| Ok(())).unwrap());
    let moved = names(&entries).remove(0);
    assert!(moved.ends_with(&format!("_{ts}_{id}.pipette")));
    assert_eq!(read(dir, &moved), "BODY");
    assert_eq!(listing(dir), [moved]);
}

#[test]
fn the_index_directory_read_tells_missing_corrupt_and_ok_apart() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    assert_eq!(read_index_dir_migrated(EntryStore::Favorites, dir).unwrap(), IndexDirRead::Missing);
    for corrupt in ["{", "[]", "null", r#"{"entries":{}}"#, r#"{"type":"macro"}"#, "\u{feff}{\"entries\":[]}"]
    {
        fs::write(dir.join("index.json"), corrupt).unwrap();
        assert_eq!(
            read_index_dir_migrated(EntryStore::Favorites, dir).unwrap(),
            IndexDirRead::Corrupt,
            "{corrupt:?}"
        );
    }
    fs::remove_file(dir.join("index.json")).unwrap();
    fs::create_dir(dir.join("index.json")).unwrap();
    assert_eq!(read_index_dir_migrated(EntryStore::Favorites, dir).unwrap(), IndexDirRead::Corrupt);
}

#[test]
fn the_index_directory_read_writes_the_index_back_only_when_a_name_moved() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    let current = r#"{"type":"macro","entries":[{"id":"f1","filename":"m_f1.json","savedAt":"2026-01-01T00:00:00.000Z"}]}"#;
    fs::write(dir.join("index.json"), current).unwrap();
    let IndexDirRead::Ok { index, entries } = read_index_dir_migrated(EntryStore::Favorites, dir).unwrap()
    else {
        panic!("not read")
    };
    assert_eq!(json(index), current);
    assert_eq!(entries.len(), 1);
    assert_eq!(read(dir, "index.json"), current);

    let legacy = r#"{"type":"macro","entries":[{"id":"f1","filename":"m.json","savedAt":"2026-01-01T00:00:00.000Z"}],"x":1}"#;
    fs::write(dir.join("index.json"), legacy).unwrap();
    fs::write(dir.join("m.json"), "BODY").unwrap();
    let IndexDirRead::Ok { entries, .. } = read_index_dir_migrated(EntryStore::Favorites, dir).unwrap()
    else {
        panic!("not read")
    };
    assert_eq!(names(&entries), ["m_f1.json"]);
    let written = read(dir, "index.json");
    assert!(written.starts_with("{\n  \"type\": \"macro\",\n  \"entries\": [\n    {\n      \"id\": \"f1\""));
    assert!(written.ends_with("\n  ],\n  \"x\": 1\n}"));
    assert_eq!(listing(dir), ["index.json", "m_f1.json"]);
}

#[test]
fn body_file_names_are_id_carrying_names_with_the_store_extension() {
    assert!(is_body_file_name(EntryStore::Snapshots, "kb_1.pipette"));
    assert!(!is_body_file_name(EntryStore::Snapshots, "kb_1.json"));
    assert!(!is_body_file_name(EntryStore::Favorites, "index.json"));
    assert!(!is_body_file_name(EntryStore::Favorites, "plain.json"));
    assert!(!is_body_file_name(EntryStore::Favorites, "a_b.json.123.abcdef.tmp"));
}

#[test]
fn unlinks_only_unreferenced_body_files() {
    let tmp = TempDir::new().unwrap();
    let dir = tmp.path();
    for name in ["index.json", "keep_a.json", "drop_b.json", "note.txt", "plain.json", "x_y.json.1.abc.tmp"] {
        fs::write(dir.join(name), "").unwrap();
    }
    fs::create_dir(dir.join("dir_c.json")).unwrap();
    let referenced: HashSet<JsString> = [JsString::from("keep_a.json")].into_iter().collect();
    assert_eq!(unlink_unreferenced_body_files(EntryStore::Favorites, dir, &referenced), 1);
    assert_eq!(
        listing(dir),
        ["dir_c.json", "index.json", "keep_a.json", "note.txt", "plain.json", "x_y.json.1.abc.tmp"]
    );
    assert_eq!(unlink_unreferenced_body_files(EntryStore::Favorites, &dir.join("missing"), &referenced), 0);
}
