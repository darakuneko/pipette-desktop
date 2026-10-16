// SPDX-License-Identifier: GPL-2.0-or-later
//! The pipette settings storage: the storage cases of the handler tests in
//! src/main/__tests__/device-prefs-store.test.ts, and the etag check the
//! callers build their writes on.

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::fs;
use std::sync::{Arc, Barrier};

use common::Harness;
use pipette_js_json::Value;
use pipette_keyboard_stores::{
    KeyboardSettingsFile, SETTINGS_ETAG_ABSENT, SettingsError, SettingsWrite, StoreError,
    ensure_pipette_settings_dir, keyboard_settings_files_json, read_all_pipette_settings,
    read_pipette_settings, write_pipette_settings,
};

const UID: &str = "0xA1B2";
const FILE: &str = "sync/keyboards/0xA1B2/pipette_settings.json";
/// SHA-256 of `{}`.
const ETAG_OF_EMPTY_OBJECT: &str = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

fn read_text(h: &Harness, path: &str) -> String {
    fs::read_to_string(h.user_data().join(path)).unwrap()
}

#[test]
fn a_missing_file_reads_as_absent() {
    let h = Harness::new();
    let file = read_pipette_settings(&h.ctx, UID).unwrap();
    assert_eq!(file.content, None);
    assert_eq!(file.etag, SETTINGS_ETAG_ABSENT);
}

#[test]
fn a_file_reads_with_the_sha256_of_its_bytes() {
    let h = Harness::new();
    h.write(FILE, "{}");
    let file = read_pipette_settings(&h.ctx, UID).unwrap();
    assert_eq!(file.content.as_deref(), Some("{}"));
    assert_eq!(file.etag, ETAG_OF_EMPTY_OBJECT);
}

#[test]
fn invalid_utf8_reads_as_replacement_characters_with_the_etag_of_the_bytes() {
    let h = Harness::new();
    let path = h.user_data().join(FILE);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, b"{\"a\":\"\xff\"}").unwrap();
    let file = read_pipette_settings(&h.ctx, UID).unwrap();
    assert_eq!(file.content.as_deref(), Some("{\"a\":\"\u{fffd}\"}"));
    assert_eq!(write_pipette_settings(&h.ctx, UID, "{}", &file.etag).unwrap(), SettingsWrite::Written);
}

#[test]
fn a_write_to_a_missing_file_creates_the_directory_and_reports_the_unit() {
    let h = Harness::new();
    let written = write_pipette_settings(&h.ctx, UID, "{\"_rev\":1}", SETTINGS_ETAG_ABSENT).unwrap();
    assert_eq!(written, SettingsWrite::Written);
    assert_eq!(read_text(&h, FILE), "{\"_rev\":1}");
    assert_eq!(h.notified(), ["keyboards/0xA1B2/settings"]);
}

#[test]
fn a_write_with_the_current_etag_replaces_the_file() {
    let h = Harness::new();
    h.write(FILE, "{}");
    let etag = read_pipette_settings(&h.ctx, UID).unwrap().etag;
    assert_eq!(write_pipette_settings(&h.ctx, UID, "{\"b\":2}", &etag).unwrap(), SettingsWrite::Written);
    assert_eq!(read_text(&h, FILE), "{\"b\":2}");
    // The etag now names the new text.
    assert_eq!(write_pipette_settings(&h.ctx, UID, "{\"c\":3}", &etag).unwrap(), SettingsWrite::Conflict);
}

#[test]
fn a_write_with_a_stale_etag_changes_nothing() {
    let h = Harness::new();
    h.write(FILE, "{\"a\":1}");
    assert_eq!(
        write_pipette_settings(&h.ctx, UID, "{}", ETAG_OF_EMPTY_OBJECT).unwrap(),
        SettingsWrite::Conflict
    );
    assert_eq!(
        write_pipette_settings(&h.ctx, UID, "{}", SETTINGS_ETAG_ABSENT).unwrap(),
        SettingsWrite::Conflict
    );
    assert_eq!(read_text(&h, FILE), "{\"a\":1}");
    assert!(h.notified().is_empty());
}

#[test]
fn a_file_created_after_an_absent_read_is_a_conflict() {
    let h = Harness::new();
    let read = read_pipette_settings(&h.ctx, UID).unwrap();
    h.write(FILE, "{}");
    assert_eq!(
        write_pipette_settings(&h.ctx, UID, "{\"x\":1}", &read.etag).unwrap(),
        SettingsWrite::Conflict
    );
}

#[test]
fn concurrent_writes_from_the_same_read_let_exactly_one_through() {
    let h = Harness::new();
    h.write(FILE, "{}");
    let etag = read_pipette_settings(&h.ctx, UID).unwrap().etag;
    let barrier = Arc::new(Barrier::new(8));
    let outcomes: Vec<SettingsWrite> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8)
            .map(|n| {
                let (ctx, etag, barrier) = (h.ctx.clone(), etag.clone(), Arc::clone(&barrier));
                scope.spawn(move || {
                    barrier.wait();
                    write_pipette_settings(&ctx, UID, &format!("{{\"n\":{n}}}"), &etag).unwrap()
                })
            })
            .collect();
        handles.into_iter().map(|handle| handle.join().unwrap()).collect()
    });
    assert_eq!(outcomes.iter().filter(|outcome| **outcome == SettingsWrite::Written).count(), 1);
    assert_eq!(h.notified().len(), 1);
}

#[test]
fn settings_are_kept_per_uid() {
    let h = Harness::new();
    write_pipette_settings(&h.ctx, "uid-a", "\"a\"", SETTINGS_ETAG_ABSENT).unwrap();
    write_pipette_settings(&h.ctx, "uid-b", "\"b\"", SETTINGS_ETAG_ABSENT).unwrap();
    assert_eq!(read_pipette_settings(&h.ctx, "uid-a").unwrap().content.as_deref(), Some("\"a\""));
    assert_eq!(read_pipette_settings(&h.ctx, "uid-b").unwrap().content.as_deref(), Some("\"b\""));
    assert_eq!(h.notified(), ["keyboards/uid-a/settings", "keyboards/uid-b/settings"]);
}

#[test]
fn ensure_dir_creates_the_keyboard_directory_without_a_settings_file() {
    let h = Harness::new();
    ensure_pipette_settings_dir(&h.ctx, "uid-e").unwrap();
    let dir = h.user_data().join("sync/keyboards/uid-e");
    assert_eq!(fs::read_dir(dir).unwrap().count(), 0);
    assert!(h.notified().is_empty());
    // Again, on the directory that is there now.
    ensure_pipette_settings_dir(&h.ctx, "uid-e").unwrap();
}

#[test]
fn uids_that_are_not_one_path_segment_are_refused_and_create_nothing() {
    let h = Harness::new();
    for uid in ["", ".", "..", "../etc", "a/b", "a\\b"] {
        assert!(matches!(read_pipette_settings(&h.ctx, uid), Err(SettingsError::InvalidUid)), "{uid}");
        assert!(
            matches!(
                write_pipette_settings(&h.ctx, uid, "{}", SETTINGS_ETAG_ABSENT),
                Err(SettingsError::InvalidUid)
            ),
            "{uid}"
        );
        assert!(matches!(ensure_pipette_settings_dir(&h.ctx, uid), Err(SettingsError::InvalidUid)), "{uid}");
    }
    assert_eq!(SettingsError::InvalidUid.to_string(), "Invalid uid");
    assert!(!h.user_data().join("sync").exists());
    assert!(h.notified().is_empty());
}

#[test]
fn read_all_lists_every_readable_file_in_byte_order_of_the_uids() {
    let h = Harness::new();
    h.write("sync/keyboards/b/pipette_settings.json", "B");
    h.write("sync/keyboards/a b/pipette_settings.json", "AB");
    h.write("sync/keyboards/A/pipette_settings.json", "upper");
    // A directory without a settings file, and a settings path that is a
    // directory, are left out.
    fs::create_dir_all(h.user_data().join("sync/keyboards/empty")).unwrap();
    fs::create_dir_all(h.user_data().join("sync/keyboards/dir/pipette_settings.json")).unwrap();
    // A file and a symlink in the keyboards directory are not keyboards.
    h.write("sync/keyboards/file", "x");
    #[cfg(unix)]
    std::os::unix::fs::symlink("b", h.user_data().join("sync/keyboards/link")).unwrap();

    let files = read_all_pipette_settings(&h.ctx).unwrap();
    let listed: Vec<(&str, &str)> = files.iter().map(|f| (f.uid.as_str(), f.content.as_str())).collect();
    assert_eq!(listed, [("A", "upper"), ("a b", "AB"), ("b", "B")]);
    assert!(h.notified().is_empty());
}

#[test]
fn read_all_without_a_keyboards_directory_is_empty() {
    let h = Harness::new();
    assert!(read_all_pipette_settings(&h.ctx).unwrap().is_empty());
}

#[test]
fn read_all_names_a_keyboard_by_its_name_then_its_snapshots_else_null() {
    let h = Harness::new();
    for uid in ["named", "self", "gone", "snap", "bare"] {
        h.write(&format!("sync/keyboards/{uid}/pipette_settings.json"), "{}");
    }
    h.write(
        "sync/meta/keyboard-names.json",
        r#"{"type":"keyboard-meta","version":1,"entries":[
            {"uid":"named","deviceName":"Named Board","updatedAt":"2026-01-01T00:00:00.000Z"},
            {"uid":"self","deviceName":"self","updatedAt":"2026-01-01T00:00:00.000Z"},
            {"uid":"gone","deviceName":"Gone Board","updatedAt":"2026-01-01T00:00:00.000Z","deletedAt":"2026-01-02T00:00:00.000Z"}
        ]}"#,
    );
    let snapshot_index = r#"{"uid":"x","entries":[
        {"id":"d","filename":"Deleted_2026-01-01T00-00-00.000Z_d.pipette","deletedAt":"2026-01-02T00:00:00.000Z"},
        {"id":"l","filename":"Snap Board_2026-01-01T00-00-00.000Z_l.pipette"}
    ]}"#;
    for uid in ["self", "gone", "snap"] {
        h.write(&format!("sync/keyboards/{uid}/snapshots/index.json"), snapshot_index);
    }

    let files = read_all_pipette_settings(&h.ctx).unwrap();
    let names: Vec<(&str, Value)> = files.iter().map(|f| (f.uid.as_str(), f.name.clone())).collect();
    assert_eq!(
        names,
        [
            ("bare", Value::Null),
            ("gone", Value::from("Snap Board")),
            ("named", Value::from("Named Board")),
            ("self", Value::from("Snap Board")),
            ("snap", Value::from("Snap Board")),
        ]
    );
    // Reading names records nothing.
    assert!(h.notified().is_empty());
}

#[test]
fn read_all_fails_on_a_null_entry_in_the_keyboard_names() {
    let h = Harness::new();
    h.write("sync/keyboards/a/pipette_settings.json", "{}");
    h.write("sync/meta/keyboard-names.json", r#"{"type":"keyboard-meta","version":1,"entries":[null]}"#);
    assert!(matches!(read_all_pipette_settings(&h.ctx), Err(StoreError::NullEntry(_))));
}

#[test]
fn read_all_json_writes_each_file_as_uid_name_content() {
    let files = [KeyboardSettingsFile { uid: "u".into(), name: 5.0.into(), content: "{\"a\":1}".into() }];
    assert_eq!(keyboard_settings_files_json(&files), r#"[{"uid":"u","name":5,"content":"{\"a\":1}"}]"#);
}
