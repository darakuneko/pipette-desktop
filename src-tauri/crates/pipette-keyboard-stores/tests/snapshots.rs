// SPDX-License-Identifier: GPL-2.0-or-later
//! The snapshot store (its limit and its clocks among the rest), with the
//! write serialization and the files this build cannot read on top.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::thread;

use common::{Harness, T0, id, ms};
use pipette_entry_store::Entry;
use pipette_js_json::{Object, Value};
use pipette_keyboard_stores::{
    KEYBOARD_META_SYNC_UNIT, SnapshotError, delete_snapshot, extract_device_name_from_filename,
    list_snapshots, load_snapshot, rename_snapshot, save_snapshot, set_snapshot_hub_post_id,
    set_snapshot_hub_private, update_snapshot,
};

const UID: &str = "uid-1";
const T1: &str = "2026-10-16T12:01:00.000Z";
const T2: &str = "2026-10-16T12:02:00.000Z";

fn dir(h: &Harness, uid: &str) -> std::path::PathBuf {
    h.user_data().join("sync/keyboards").join(uid).join("snapshots")
}

fn save(h: &Harness, json: &str, device: &str, label: &str) -> Entry {
    save_snapshot(&h.ctx, UID, json, device, label, None).unwrap()
}

fn text(entry: &Entry, key: &str) -> String {
    entry.get(key).unwrap().as_str().unwrap().to_owned()
}

/// The entries of the index file as written.
fn index_entries(h: &Harness, uid: &str) -> Vec<Object> {
    let raw = std::fs::read_to_string(dir(h, uid).join("index.json")).unwrap();
    let parsed = pipette_js_json::parse(&raw).unwrap();
    let Some(Value::Array(entries)) = parsed.as_object().unwrap().get("entries").cloned() else { panic!() };
    entries.into_iter().map(|e| e.as_object().unwrap().clone()).collect()
}

fn clock(entry: &Object, group: &str) -> String {
    entry.get("clocks").unwrap().as_object().unwrap().get(group).unwrap().as_str().unwrap().to_owned()
}

fn labels(entries: &[Entry]) -> Vec<String> {
    entries.iter().map(|e| text(e, "label")).collect()
}

#[test]
fn lists_nothing_before_a_save_and_the_saved_entry_after() {
    let h = Harness::new();
    assert!(list_snapshots(&h.ctx, "test-uid").unwrap().is_empty());
    save(&h, r#"{"data":1}"#, "MyKeyboard", "First Save");
    let listed = list_snapshots(&h.ctx, UID).unwrap();
    assert_eq!(labels(&listed), ["First Save"]);
    assert_eq!(listed[0].id().unwrap().as_str(), Some(id(1).as_str()));
}

#[test]
fn a_save_writes_the_body_under_an_id_carrying_name_and_records_the_device_name() {
    let h = Harness::new();
    let json = r#"{"uid":"uid-1","keymap":{}}"#;
    let entry = save(&h, json, "TestKB", "My Label");
    let filename = text(&entry, "filename");
    assert_eq!(filename, format!("TestKB_2026-10-16T12-00-00.000Z_{}.pipette", id(1)));
    assert_eq!(
        extract_device_name_from_filename(&filename.as_str().into()).unwrap().as_str(),
        Some("TestKB")
    );
    assert_eq!(text(&entry, "savedAt"), T0);
    assert_eq!(text(&entry, "updatedAt"), T0);
    assert_eq!(std::fs::read_to_string(dir(&h, UID).join(&filename)).unwrap(), json);
    assert_eq!(h.notified(), ["keyboards/uid-1/snapshots", KEYBOARD_META_SYNC_UNIT]);
    assert!(h.read_meta().contains(r#""deviceName": "TestKB""#));

    // The same name again changes no keyboard name.
    save(&h, "{}", "TestKB", "Again");
    assert_eq!(h.notified().len(), 3);
}

#[test]
fn two_snapshots_saved_in_the_same_millisecond_get_their_own_files() {
    let h = Harness::new();
    let first = save(&h, r#"{"a":1}"#, "KB", "First");
    let second = save(&h, r#"{"a":2}"#, "KB", "Second");
    assert_ne!(text(&first, "filename"), text(&second, "filename"));
    let read = |e: &Entry| std::fs::read_to_string(dir(&h, UID).join(text(e, "filename"))).unwrap();
    assert_eq!(read(&first), r#"{"a":1}"#);
    assert_eq!(read(&second), r#"{"a":2}"#);
    // Newest first.
    assert_eq!(labels(&list_snapshots(&h.ctx, UID).unwrap()), ["Second", "First"]);
}

#[test]
fn a_device_name_is_cleaned_into_the_filename() {
    let h = Harness::new();
    let entry = save(&h, "{}", "My/Key*board", "test");
    assert!(!text(&entry, "filename").contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|']));
    let entry = save(&h, "{}", "  ...", "test");
    assert!(text(&entry, "filename").starts_with("keyboard_"));
}

#[test]
fn loads_a_saved_body_and_refuses_a_missing_or_deleted_entry() {
    let h = Harness::new();
    let json = r#"{"uid":"uid-1","data":"hello"}"#;
    let saved = save(&h, json, "KB", "test");
    let saved_id = saved.id().unwrap().as_str().unwrap().to_owned();
    assert_eq!(load_snapshot(&h.ctx, UID, &saved_id).unwrap(), json);
    assert!(matches!(load_snapshot(&h.ctx, UID, "nonexistent-id"), Err(SnapshotError::NotFound)));
    delete_snapshot(&h.ctx, UID, &saved_id).unwrap();
    assert!(matches!(load_snapshot(&h.ctx, UID, &saved_id), Err(SnapshotError::Deleted)));
}

#[test]
fn rename_moves_the_name_clock_only() {
    let h = Harness::new();
    let saved = save(&h, "{}", "KB", "Old Name");
    h.clock.set(ms(T1));
    rename_snapshot(&h.ctx, UID, saved.id().unwrap().as_str().unwrap(), "New Name").unwrap();
    assert_eq!(labels(&list_snapshots(&h.ctx, UID).unwrap()), ["New Name"]);
    let entry = &index_entries(&h, UID)[0];
    assert_eq!(clock(entry, "name"), T1);
    assert_eq!(clock(entry, "body"), T0);
    assert_eq!(entry.get("updatedAt").unwrap().as_str(), Some(T1));
}

#[test]
fn every_change_of_a_missing_entry_is_not_found() {
    let h = Harness::new();
    save(&h, "{}", "KB", "x");
    for result in [
        rename_snapshot(&h.ctx, UID, "bad-id", "New"),
        delete_snapshot(&h.ctx, UID, "bad-id"),
        set_snapshot_hub_post_id(&h.ctx, UID, "bad-id", Some("post-1")),
        set_snapshot_hub_private(&h.ctx, UID, "bad-id", None),
        update_snapshot(&h.ctx, UID, "bad-id", "{}", None, None),
    ] {
        assert_eq!(result.unwrap_err().to_string(), "Entry not found");
    }
}

#[test]
fn a_delete_keeps_the_body_and_a_tombstone_for_sync() {
    let h = Harness::new();
    let saved = save(&h, "{}", "KB", "ToDelete");
    h.clock.set(ms(T1));
    delete_snapshot(&h.ctx, UID, saved.id().unwrap().as_str().unwrap()).unwrap();
    assert!(list_snapshots(&h.ctx, UID).unwrap().is_empty());
    assert_eq!(std::fs::read_to_string(dir(&h, UID).join(text(&saved, "filename"))).unwrap(), "{}");
    let entries = index_entries(&h, UID);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].get("deletedAt").unwrap().as_str(), Some(T1));
    assert_eq!(entries[0].get("updatedAt").unwrap().as_str(), Some(T1));
}

#[test]
fn entries_are_kept_per_uid() {
    let h = Harness::new();
    save_snapshot(&h.ctx, "uid-A", "{}", "KB", "A-entry", None).unwrap();
    save_snapshot(&h.ctx, "uid-B", "{}", "KB", "B-entry", None).unwrap();
    assert_eq!(labels(&list_snapshots(&h.ctx, "uid-A").unwrap()), ["A-entry"]);
    assert_eq!(labels(&list_snapshots(&h.ctx, "uid-B").unwrap()), ["B-entry"]);
}

#[test]
fn a_uid_that_is_not_one_path_segment_is_refused_by_every_operation() {
    let h = Harness::new();
    for uid in ["../..", "foo/bar", "a\\b", "", ".", ".."] {
        let errors = [
            list_snapshots(&h.ctx, uid).map(|_| ()),
            save_snapshot(&h.ctx, uid, "{}", "KB", "x", None).map(|_| ()),
            load_snapshot(&h.ctx, uid, "x").map(|_| ()),
            update_snapshot(&h.ctx, uid, "x", "{}", None, None),
            rename_snapshot(&h.ctx, uid, "x", "y"),
            delete_snapshot(&h.ctx, uid, "x"),
            set_snapshot_hub_post_id(&h.ctx, uid, "x", None),
            set_snapshot_hub_private(&h.ctx, uid, "x", None),
        ];
        for error in errors {
            assert_eq!(error.unwrap_err().to_string(), "Error: Invalid uid", "{uid:?}");
        }
    }
    assert!(!h.user_data().join("sync").exists());
}

#[test]
fn hub_post_ids_are_trimmed_cleared_when_blank_and_exclusive_with_private_links() {
    let h = Harness::new();
    let saved = save(&h, "{}", "KB", "test");
    let saved_id = saved.id().unwrap().as_str().unwrap().to_owned();
    let post_id = |h: &Harness| index_entries(h, UID)[0].get("hubPostId").cloned();

    let mut link = Object::new();
    link.insert("id", "p1".into());
    link.insert("url", "/p/p1?token=t".into());
    link.insert("expiresAt", Value::Null);
    set_snapshot_hub_private(&h.ctx, UID, &saved_id, Some(Value::Object(link.clone()))).unwrap();
    assert_eq!(index_entries(&h, UID)[0].get("hubPrivate"), Some(&Value::Object(link.clone())));

    h.clock.set(ms(T1));
    set_snapshot_hub_post_id(&h.ctx, UID, &saved_id, Some(" post-42\u{3000}")).unwrap();
    assert_eq!(post_id(&h), Some("post-42".into()));
    assert!(index_entries(&h, UID)[0].get("hubPrivate").is_none());
    assert_eq!(clock(&index_entries(&h, UID)[0], "hub"), T1);

    for blank in [Some(""), Some("  "), Some("\t"), None] {
        set_snapshot_hub_post_id(&h.ctx, UID, &saved_id, Some("post-42")).unwrap();
        set_snapshot_hub_post_id(&h.ctx, UID, &saved_id, blank).unwrap();
        assert_eq!(post_id(&h), None, "{blank:?}");
    }

    set_snapshot_hub_post_id(&h.ctx, UID, &saved_id, Some("post-1")).unwrap();
    set_snapshot_hub_private(&h.ctx, UID, &saved_id, Some(Value::Object(link))).unwrap();
    assert_eq!(post_id(&h), None);
    set_snapshot_hub_private(&h.ctx, UID, &saved_id, None).unwrap();
    assert!(index_entries(&h, UID)[0].get("hubPrivate").is_none());
}

#[test]
fn an_index_that_is_not_json_lists_nothing_and_the_next_save_replaces_it() {
    let h = Harness::new();
    h.write("sync/keyboards/uid-1/snapshots/index.json", "not json!!!");
    assert!(list_snapshots(&h.ctx, UID).unwrap().is_empty());
    save(&h, "{}", "KB", "x");
    assert_eq!(index_entries(&h, UID).len(), 1);
}

#[test]
fn an_index_of_another_uid_lists_nothing() {
    let h = Harness::new();
    h.write(
        "sync/keyboards/uid-1/snapshots/index.json",
        r#"{"uid":"uid-2","entries":[{"id":"a","label":"x","filename":"a","savedAt":"x"}]}"#,
    );
    assert!(list_snapshots(&h.ctx, UID).unwrap().is_empty());
}

fn limit_index(live: usize, deleted: usize) -> String {
    let mut entries = Vec::new();
    for i in 0..live {
        entries.push(format!(
            r#"{{"id":"entry-{i}","label":"Label {i}","filename":"keyboard_2025-01-01T00-00-0{i}.000Z_entry-{i}.pipette","savedAt":"2025-01-01T00:00:00.000Z"}}"#
        ));
    }
    for i in 0..deleted {
        entries.push(format!(
            r#"{{"id":"deleted-{i}","label":"Deleted {i}","filename":"keyboard_2025-01-01T00-00-0{i}.000Z_deleted-{i}.pipette","savedAt":"2025-01-01T00:00:00.000Z","deletedAt":"2025-01-02T00:00:00.000Z"}}"#
        ));
    }
    format!(r#"{{"uid":"test-uid","entries":[{}]}}"#, entries.join(","))
}

#[test]
fn a_save_is_refused_at_30_live_entries_without_writing_anything() {
    let h = Harness::new();
    h.write("sync/keyboards/test-uid/snapshots/index.json", &limit_index(30, 0));
    let before = common::recorded(h.user_data());
    let result = save_snapshot(&h.ctx, "test-uid", "{}", "keyboard", "New Entry", None);
    assert_eq!(result.unwrap_err().to_string(), "max entries reached");
    assert_eq!(common::recorded(h.user_data()), before);
    assert!(h.notified().is_empty());
}

#[test]
fn a_save_below_the_limit_counting_live_entries_only_succeeds() {
    for (live, deleted) in [(29, 0), (25, 10)] {
        let h = Harness::new();
        h.write("sync/keyboards/test-uid/snapshots/index.json", &limit_index(live, deleted));
        save_snapshot(&h.ctx, "test-uid", r#"{"keymap":{}}"#, "keyboard", "New", None).unwrap();
        assert_eq!(index_entries(&h, "test-uid").len(), live + deleted + 1);
    }
}

fn save_v1(h: &Harness) -> String {
    let saved = save_snapshot(&h.ctx, UID, r#"{"v":1}"#, "KB", "L", Some(1.0)).unwrap();
    saved.id().unwrap().as_str().unwrap().to_owned()
}

#[test]
fn an_update_is_an_explicit_overwrite_moving_created_and_body() {
    let h = Harness::new();
    let saved_id = save_v1(&h);
    h.clock.set(ms(T1));
    update_snapshot(&h.ctx, UID, &saved_id, r#"{"v":2}"#, Some(2.0), None).unwrap();
    let entry = &index_entries(&h, UID)[0];
    assert_eq!((clock(entry, "created"), clock(entry, "body")), (T1.into(), T1.into()));
    assert_eq!((clock(entry, "name"), clock(entry, "hub")), (T0.into(), T0.into()));
    assert_eq!(entry.get("vilVersion"), Some(&Value::Number(2.0)));
}

#[test]
fn a_migration_update_moves_body_1_ms_past_its_old_value_and_only_over_the_body_it_read() {
    let h = Harness::new();
    let saved_id = save_v1(&h);
    h.clock.set(ms(T2));
    update_snapshot(&h.ctx, UID, &saved_id, r#"{"v":2}"#, Some(2.0), Some(r#"{"v":1}"#)).unwrap();
    let entry = &index_entries(&h, UID)[0];
    assert_eq!(clock(entry, "body"), "2026-10-16T12:00:00.001Z");
    assert_eq!(clock(entry, "created"), T0);

    let stale = update_snapshot(&h.ctx, UID, &saved_id, r#"{"v":3}"#, Some(2.0), Some(r#"{"v":1}"#));
    assert_eq!(stale.unwrap_err().to_string(), "Entry changed since it was read");
    let entry = &index_entries(&h, UID)[0];
    assert_eq!(clock(entry, "body"), "2026-10-16T12:00:00.001Z");
    let filename = entry.get("filename").unwrap().as_str().unwrap();
    assert_eq!(std::fs::read_to_string(dir(&h, UID).join(filename)).unwrap(), r#"{"v":2}"#);
}

#[test]
fn a_user_update_of_a_deleted_entry_brings_it_back() {
    let h = Harness::new();
    let saved_id = save_v1(&h);
    h.clock.set(ms(T1));
    delete_snapshot(&h.ctx, UID, &saved_id).unwrap();
    h.clock.set(ms(T2));
    update_snapshot(&h.ctx, UID, &saved_id, r#"{"v":2}"#, Some(2.0), None).unwrap();
    let entry = &index_entries(&h, UID)[0];
    assert!(entry.get("deletedAt").is_none());
    assert_eq!(clock(entry, "created"), T2);
    assert_eq!(load_snapshot(&h.ctx, UID, &saved_id).unwrap(), r#"{"v":2}"#);
}

#[test]
fn a_migration_update_never_brings_a_deleted_entry_back() {
    let h = Harness::new();
    let saved_id = save_v1(&h);
    h.clock.set(ms(T1));
    delete_snapshot(&h.ctx, UID, &saved_id).unwrap();
    let result = update_snapshot(&h.ctx, UID, &saved_id, r#"{"v":2}"#, Some(2.0), Some(r#"{"v":1}"#));
    assert_eq!(result.unwrap_err().to_string(), "Entry has been deleted");
    assert_eq!(index_entries(&h, UID)[0].get("deletedAt").unwrap().as_str(), Some(T1));
}

#[test]
fn a_locked_write_moves_a_pre_id_filename_and_a_read_does_not() {
    let h = Harness::new();
    h.write(
        "sync/keyboards/uid1/snapshots/index.json",
        r#"{"uid":"uid1","entries":[{"id":"s1","label":"L","filename":"KB_2025-01-01T00-00-00.000Z.pipette","savedAt":"2026-01-01T00:00:00.000Z"}]}"#,
    );
    h.write("sync/keyboards/uid1/snapshots/KB_2025-01-01T00-00-00.000Z.pipette", "BODY");
    assert_eq!(load_snapshot(&h.ctx, "uid1", "s1").unwrap(), "BODY");
    list_snapshots(&h.ctx, "uid1").unwrap();
    assert!(dir(&h, "uid1").join("KB_2025-01-01T00-00-00.000Z.pipette").exists());

    rename_snapshot(&h.ctx, "uid1", "s1", "L2").unwrap();
    let entry = &index_entries(&h, "uid1")[0];
    assert_eq!(entry.get("filename").unwrap().as_str(), Some("KB_2025-01-01T00-00-00.000Z_s1.pipette"));
    assert_eq!(load_snapshot(&h.ctx, "uid1", "s1").unwrap(), "BODY");
    assert!(!dir(&h, "uid1").join("KB_2025-01-01T00-00-00.000Z.pipette").exists());
}

#[test]
fn a_body_filename_that_is_not_a_safe_name_is_never_read_or_written() {
    let h = Harness::new();
    h.write(
        "sync/keyboards/uid-1/snapshots/index.json",
        r#"{"uid":"uid-1","entries":[{"id":"a","filename":"../escape"},{"id":"b"},{"id":"c","filename":5},{"id":"d","filename":0}]}"#,
    );
    for (entry, error) in [
        ("a", "Error: Invalid filename"),
        ("b", "Error: Invalid filename"),
        ("c", "TypeError: The \"path\" argument must be of type string"),
        ("d", "Error: Invalid filename"),
    ] {
        assert_eq!(load_snapshot(&h.ctx, UID, entry).unwrap_err().to_string(), error);
        let updated = update_snapshot(&h.ctx, UID, entry, "{}", None, None);
        assert_eq!(updated.unwrap_err().to_string(), error);
    }
    assert!(!h.user_data().join("sync/keyboards/escape").exists());
}

#[test]
fn an_index_nested_too_deeply_is_never_replaced() {
    let h = Harness::new();
    let deep = format!(r#"{{"uid":"uid-1","entries":[],"x":{}{}}}"#, "[".repeat(2000), "]".repeat(2000));
    h.write("sync/keyboards/uid-1/snapshots/index.json", &deep);
    assert!(matches!(list_snapshots(&h.ctx, UID), Err(SnapshotError::TooDeep(_))));
    assert!(matches!(save_snapshot(&h.ctx, UID, "{}", "KB", "x", None), Err(SnapshotError::TooDeep(_))));
    assert_eq!(std::fs::read_to_string(dir(&h, UID).join("index.json")).unwrap(), deep);
}

#[test]
fn concurrent_saves_of_one_keyboard_never_lose_an_entry() {
    let h = Arc::new(Harness::new());
    let workers: Vec<_> = (0..8)
        .map(|i| {
            let h = Arc::clone(&h);
            thread::spawn(move || {
                save_snapshot(&h.ctx, UID, "{}", &format!("KB {}", i % 2), "x", None).unwrap()
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(list_snapshots(&h.ctx, UID).unwrap().len(), 8);
}
