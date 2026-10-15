// SPDX-License-Identifier: GPL-2.0-or-later
//! The keyboard names and the stored-keyboard list, as specified by the
//! TypeScript tests of src/main/__tests__/keyboard-meta.test.ts, with the
//! write serialization and the files this build cannot read on top.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::thread;

use common::{DAY_MS, Harness, T0, ms};
use pipette_js_json::{JsString, Value};
use pipette_keyboard_stores::{
    KEYBOARD_META_SYNC_UNIT, MetaOutcome, StoreError, active_keyboard_names, keyboard_meta_name_if_missing,
    list_stored_keyboards, name_keyboard_on_connect, upsert_keyboard_meta,
};

fn js(s: &str) -> JsString {
    JsString::from(s)
}

fn active_name(h: &Harness, uid: &str) -> Option<String> {
    let names = active_keyboard_names(&h.meta_entries()).unwrap();
    names.get(uid).map(|name| name.as_str().unwrap().to_owned())
}

fn tombstone(h: &Harness, uid: &str, name: &str, deleted_at: &str) {
    h.write(
        "sync/meta/keyboard-names.json",
        &format!(
            r#"{{"type":"keyboard-meta","version":1,"entries":[{{"uid":"{uid}","deviceName":"{name}","updatedAt":"{deleted_at}","deletedAt":"{deleted_at}"}}]}}"#
        ),
    );
}

#[test]
fn upsert_creates_and_rereads_an_entry_then_does_nothing_when_unchanged() {
    let h = Harness::new();
    assert_eq!(upsert_keyboard_meta(&h.ctx, "0xA", &js("A")).unwrap(), MetaOutcome::Upserted);
    let written = h.read_meta();
    assert_eq!(upsert_keyboard_meta(&h.ctx, "0xA", &js("A")).unwrap(), MetaOutcome::Unchanged);
    assert_eq!(h.read_meta(), written);
    assert_eq!(h.meta_entries().len(), 1);
    assert_eq!(active_name(&h, "0xA").as_deref(), Some("A"));
}

#[test]
fn upsert_revives_a_tombstone_and_clears_deleted_at() {
    let h = Harness::new();
    tombstone(&h, "0xA", "A", "2026-10-15T00:00:00.000Z");
    assert_eq!(upsert_keyboard_meta(&h.ctx, "0xA", &js("A")).unwrap(), MetaOutcome::Upserted);
    let entry = h.meta_entries().remove(0);
    let entry = entry.as_object().unwrap();
    assert!(!entry.contains_key("deletedAt"));
    assert_eq!(entry.get("updatedAt").unwrap().as_str(), Some(T0));
}

#[test]
fn on_connect_records_the_name_of_a_keyboard_with_none() {
    let h = Harness::new();
    assert_eq!(name_keyboard_on_connect(&h.ctx, "0xc5", &js("Ieneko54R")).unwrap(), MetaOutcome::Upserted);
    assert_eq!(active_name(&h, "0xc5").as_deref(), Some("Ieneko54R"));
}

#[test]
fn on_connect_keeps_an_active_name() {
    let h = Harness::new();
    upsert_keyboard_meta(&h.ctx, "0xc5", &js("My Custom Name")).unwrap();
    assert_eq!(name_keyboard_on_connect(&h.ctx, "0xc5", &js("Ieneko54R")).unwrap(), MetaOutcome::Unchanged);
    assert_eq!(active_name(&h, "0xc5").as_deref(), Some("My Custom Name"));
}

#[test]
fn on_connect_does_nothing_for_an_empty_uid_or_name() {
    let h = Harness::new();
    assert_eq!(name_keyboard_on_connect(&h.ctx, "", &js("Name")).unwrap(), MetaOutcome::Unchanged);
    assert_eq!(name_keyboard_on_connect(&h.ctx, "0xc5", &js("   ")).unwrap(), MetaOutcome::Unchanged);
    assert!(!h.meta_path().exists());
}

#[test]
fn on_connect_revives_a_tombstone_so_a_reconnected_keyboard_is_named_again() {
    let h = Harness::new();
    upsert_keyboard_meta(&h.ctx, "0xc5", &js("Ieneko54R")).unwrap();
    tombstone(&h, "0xc5", "Ieneko54R", "2026-10-15T00:00:00.000Z");
    assert_eq!(name_keyboard_on_connect(&h.ctx, "0xc5", &js("Ieneko54R")).unwrap(), MetaOutcome::Upserted);
    assert_eq!(active_name(&h, "0xc5").as_deref(), Some("Ieneko54R"));
}

#[test]
fn active_names_omit_tombstones_and_entries_without_a_name() {
    let entries = pipette_js_json::parse(
        r#"[{"uid":"0xA","deviceName":"A","updatedAt":"t"},
            {"uid":"0xB","deviceName":"B","updatedAt":"t","deletedAt":"t"},
            {"uid":"0xC","deviceName":"","updatedAt":"t"}]"#,
    )
    .unwrap();
    let Value::Array(entries) = entries else { panic!() };
    let names = active_keyboard_names(&entries).unwrap();
    assert_eq!(names.get("0xA"), Some(&Value::from("A")));
    assert!(!names.contains_key("0xB"));
    assert!(!names.contains_key("0xC"));
}

#[test]
fn name_if_missing_reports_the_unit_only_when_the_names_change() {
    let h = Harness::new();
    keyboard_meta_name_if_missing(&h.ctx, Some("0xA"), Some("A")).unwrap();
    keyboard_meta_name_if_missing(&h.ctx, Some("0xA"), Some("B")).unwrap();
    keyboard_meta_name_if_missing(&h.ctx, Some("bad uid"), Some("B")).unwrap();
    keyboard_meta_name_if_missing(&h.ctx, None, Some("B")).unwrap();
    keyboard_meta_name_if_missing(&h.ctx, Some("0xB"), None).unwrap();
    assert_eq!(h.notified(), [KEYBOARD_META_SYNC_UNIT]);
    assert_eq!(h.meta_entries().len(), 1);
}

#[test]
fn a_change_drops_tombstones_older_than_30_days_and_no_change_keeps_them() {
    let h = Harness::new();
    let old = pipette_time::iso_8601_millis(ms(T0) - 30 * DAY_MS);
    tombstone(&h, "0xOld", "Old", &old);
    keyboard_meta_name_if_missing(&h.ctx, Some("0xOld"), Some("Back")).unwrap();
    assert_eq!(active_name(&h, "0xOld").as_deref(), Some("Back"));

    tombstone(&h, "0xOld", "Old", &old);
    let before = h.read_meta();
    upsert_keyboard_meta(&h.ctx, "0xNew", &js("New")).unwrap();
    assert_eq!(h.meta_entries().len(), 1, "the expired tombstone is gone");
    assert_ne!(h.read_meta(), before);
}

#[test]
fn concurrent_writers_never_lose_a_name() {
    let h = Arc::new(Harness::new());
    let writers: Vec<_> = (0..16)
        .map(|i| {
            let h = Arc::clone(&h);
            thread::spawn(move || {
                keyboard_meta_name_if_missing(&h.ctx, Some(&format!("kb{i}")), Some(&format!("Board {i}")))
                    .unwrap();
            })
        })
        .collect();
    for writer in writers {
        writer.join().unwrap();
    }
    let names = active_keyboard_names(&h.meta_entries()).unwrap();
    assert_eq!(names.len(), 16);
    assert_eq!(h.notified().len(), 16);
}

#[test]
fn a_names_file_nested_too_deeply_is_never_replaced() {
    let h = Harness::new();
    let deep = format!(
        r#"{{"type":"keyboard-meta","version":1,"entries":[{{"uid":"kb","deviceName":"Kept","x":{}1{}}}]}}"#,
        "[".repeat(10_000),
        "]".repeat(10_000)
    );
    h.write("sync/meta/keyboard-names.json", &deep);
    h.write(
        "sync/keyboards/kb/snapshots/index.json",
        r#"{"entries":[{"filename":"Snap_2026-01-01T00-00-00.000Z.pipette"}]}"#,
    );

    let err = name_keyboard_on_connect(&h.ctx, "other", &js("Other")).unwrap_err();
    assert!(matches!(err, StoreError::TooDeep(_)), "{err}");
    // The list shows the snapshot's name and leaves the file as it is.
    let list = list_stored_keyboards(&h.ctx).unwrap();
    assert_eq!(list[0].name, Value::from("Snap"));
    assert_eq!(h.read_meta(), deep);
    assert!(h.notified().is_empty());
}

#[test]
fn the_list_records_the_names_it_fills_and_reports_once() {
    let h = Harness::new();
    for uid in ["b", "a"] {
        h.write(
            &format!("sync/keyboards/{uid}/snapshots/index.json"),
            &format!(r#"{{"entries":[{{"filename":"Board {uid}_2026-01-01T00-00-00.000Z.pipette"}}]}}"#),
        );
    }
    let list = list_stored_keyboards(&h.ctx).unwrap();
    let uids: Vec<&str> = list.iter().map(|kb| kb.uid.as_str()).collect();
    assert_eq!(uids, ["a", "b"]);
    assert_eq!(list[1].name, Value::from("Board b"));
    assert_eq!(h.notified(), [KEYBOARD_META_SYNC_UNIT]);
    assert_eq!(active_name(&h, "a").as_deref(), Some("Board a"));

    list_stored_keyboards(&h.ctx).unwrap();
    assert_eq!(h.notified().len(), 1, "nothing more to record");
}
