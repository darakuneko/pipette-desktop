// SPDX-License-Identifier: GPL-2.0-or-later
//! The key label store, with the Hub-side save options
//! (an id, the current name kept, a tombstone brought back).

#![allow(clippy::unwrap_used, clippy::panic)]

mod common;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use common::{Harness, T0, ms};
use pipette_entry_store::Entry;
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::{
    KEY_LABEL_SYNC_UNIT, KeyLabelSave, delete_key_label, export_key_label, get_key_label, has_key_label_name,
    import_key_label_files, list_key_labels, rename_key_label, reorder_key_labels, save_key_label,
    set_key_label_hub_post_id,
};

fn json(text: &str) -> Value {
    pipette_js_json::parse(text).unwrap()
}

fn input(name: &str, map: &str) -> KeyLabelSave {
    KeyLabelSave {
        id: None,
        name: name.into(),
        uploader_name: Some("me".into()),
        map: json(map),
        composite_labels: None,
        keymap_applicable: false,
        hub_post_id: None,
        hub_updated_at: None,
        keep_current_name: false,
    }
}

fn save(h: &Harness, name: &str) -> Entry {
    save_key_label(&h.ctx, &input(name, "{}")).unwrap()
}

fn id_of(entry: &Entry) -> JsString {
    entry.id().unwrap().clone()
}

fn field<'a>(entry: &'a Entry, key: &str) -> Option<&'a str> {
    entry.get(key).and_then(Value::as_str)
}

fn names(entries: &[Entry]) -> Vec<String> {
    entries.iter().map(|e| field(e, "name").unwrap().to_owned()).collect()
}

fn data_of(record: &Object) -> &Object {
    record.get("data").unwrap().as_object().unwrap()
}

fn store_path(h: &Harness, name: &str) -> PathBuf {
    h.user_data().join("sync/key-labels").join(name)
}

/// Writes `files` (name → text) under userData/in and returns their paths.
fn files(h: &Harness, files: &[(&str, &str)]) -> Vec<PathBuf> {
    files
        .iter()
        .map(|(name, text)| {
            let path = h.user_data().join("in").join(name);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(&path, text).unwrap();
            path
        })
        .collect()
}

fn items<'a>(batch: &'a Object, key: &str) -> &'a [Value] {
    match batch.get(key) {
        Some(Value::Array(items)) => items,
        other => panic!("{key}: {other:?}"),
    }
}

#[test]
fn a_save_writes_the_entry_and_its_body_and_reports_the_change() {
    let h = Harness::new();
    let meta = save_key_label(&h.ctx, &input("Brazilian", r#"{"KC_Q":"Q"}"#)).unwrap();
    assert_eq!(field(&meta, "name"), Some("Brazilian"));
    assert_eq!(field(&meta, "uploaderName"), Some("me"));
    assert_eq!(h.notified(), [KEY_LABEL_SYNC_UNIT]);
    let body = fs::read_to_string(store_path(&h, field(&meta, "filename").unwrap())).unwrap();
    assert_eq!(body, "{\n  \"name\": \"Brazilian\",\n  \"map\": {\n    \"KC_Q\": \"Q\"\n  }\n}");
}

#[test]
fn a_save_refuses_a_blank_or_taken_name() {
    let h = Harness::new();
    assert_eq!(save_key_label(&h.ctx, &input("   ", "{}")).unwrap_err().code(), "INVALID_NAME");
    save(&h, "Italian");
    let taken = save_key_label(&h.ctx, &input("italian", "{}")).unwrap_err();
    assert_eq!(
        (taken.code(), taken.to_string().as_str()),
        ("DUPLICATE_NAME", "A label with the same name already exists")
    );
}

#[test]
fn a_save_keeps_a_hub_post_id() {
    let h = Harness::new();
    let meta = save_key_label(
        &h.ctx,
        &KeyLabelSave { hub_post_id: Some("hub-uuid-1".into()), ..input("Spanish", "{}") },
    )
    .unwrap();
    assert_eq!(field(&meta, "hubPostId"), Some("hub-uuid-1"));
}

#[test]
fn maps_with_dangerous_keys_are_refused() {
    let h = Harness::new();
    for map in [r#"{"KC_A":"A","__proto__":"x"}"#, r#"{"constructor":"x"}"#] {
        let err = save_key_label(&h.ctx, &input("Proto", map)).unwrap_err();
        assert_eq!(
            (err.code(), err.to_string().as_str()),
            ("INVALID_FILE", "map must be an object of strings")
        );
    }
    let composite =
        KeyLabelSave { composite_labels: Some(json(r#"{"prototype":"evil"}"#)), ..input("C", "{}") };
    let err = save_key_label(&h.ctx, &composite).unwrap_err();
    assert_eq!(err.to_string(), "compositeLabels must be an object of strings");
}

#[test]
fn a_list_has_the_live_entries_and_qwerty_and_a_get_reads_the_body() {
    let h = Harness::new();
    let a = save(&h, "A");
    let b = save(&h, "B");
    delete_key_label(&h.ctx, &id_of(&a)).unwrap();
    let live = list_key_labels(&h.ctx, false).unwrap();
    assert_eq!(names(&live), ["QWERTY", "B"]);
    let record = get_key_label(&h.ctx, &id_of(&b)).unwrap();
    assert_eq!(data_of(&record).get("map"), Some(&json("{}")));
    assert_eq!(names(&list_key_labels(&h.ctx, true).unwrap()), ["QWERTY", "A", "B"]);
}

#[test]
fn a_body_filename_outside_the_store_is_refused() {
    let h = Harness::new();
    h.write(
        "sync/key-labels/index.json",
        r#"{"entries":[{"id":"evil-entry","name":"Evil","filename":"../../etc/passwd","savedAt":"2025-01-01T00:00:00.000Z"}]}"#,
    );
    let err = get_key_label(&h.ctx, &"evil-entry".into()).unwrap_err();
    assert_eq!((err.code(), err.to_string().as_str()), ("IO_ERROR", "Error: Invalid filename"));
}

#[test]
fn a_rename_changes_the_index_and_refuses_a_taken_name() {
    let h = Harness::new();
    let old = save(&h, "Old");
    let renamed = rename_key_label(&h.ctx, &id_of(&old), &"New".into()).unwrap();
    assert_eq!(field(&renamed, "name"), Some("New"));
    let record = get_key_label(&h.ctx, &id_of(&old)).unwrap();
    assert_eq!(data_of(&record).get("name"), Some(&Value::from("New")));
    // The body keeps the name it was saved with.
    assert!(
        fs::read_to_string(store_path(&h, field(&old, "filename").unwrap())).unwrap().contains("\"Old\"")
    );

    let b = save(&h, "B");
    assert_eq!(rename_key_label(&h.ctx, &id_of(&b), &"new".into()).unwrap_err().code(), "DUPLICATE_NAME");
}

#[test]
fn a_delete_leaves_a_tombstone_and_the_body() {
    let h = Harness::new();
    let x = save(&h, "X");
    delete_key_label(&h.ctx, &id_of(&x)).unwrap();
    assert!(store_path(&h, field(&x, "filename").unwrap()).is_file());
    assert_eq!(names(&list_key_labels(&h.ctx, false).unwrap()), ["QWERTY"]);
    let all = list_key_labels(&h.ctx, true).unwrap();
    assert!(all.iter().find(|e| e.id() == Some(&id_of(&x))).unwrap().is_deleted());
}

#[test]
fn qwerty_cannot_be_deleted() {
    let h = Harness::new();
    list_key_labels(&h.ctx, false).unwrap();
    let err = delete_key_label(&h.ctx, &"qwerty".into()).unwrap_err();
    assert_eq!((err.code(), err.to_string().as_str()), ("INVALID_NAME", "QWERTY cannot be deleted"));
    let qwerty =
        list_key_labels(&h.ctx, false).unwrap().into_iter().find(|e| field(e, "id") == Some("qwerty"));
    assert!(!qwerty.unwrap().is_deleted());
}

#[test]
fn a_hub_post_id_is_set_trimmed_and_cleared_with_its_hub_time() {
    let h = Harness::new();
    let y = save_key_label(
        &h.ctx,
        &KeyLabelSave { hub_updated_at: Some("2026-06-01T00:00:00.000Z".into()), ..input("Y", "{}") },
    )
    .unwrap();
    let id = id_of(&y);
    let set = set_key_label_hub_post_id(&h.ctx, &id, Some(&" hub-id-2 ".into()), None, None).unwrap();
    assert_eq!(field(&set, "hubPostId"), Some("hub-id-2"));
    assert_eq!(field(&set, "hubUpdatedAt"), Some("2026-06-01T00:00:00.000Z"));
    let cleared = set_key_label_hub_post_id(&h.ctx, &id, None, None, None).unwrap();
    assert_eq!((cleared.get("hubPostId"), cleared.get("hubUpdatedAt")), (None, None));
}

#[test]
fn a_hub_link_sets_the_author_and_hub_time_only_when_given() {
    let h = Harness::new();
    let id = id_of(&save(&h, "Hub"));
    let ts: JsString = "2026-01-15T10:00:00.000Z".into();
    let set = set_key_label_hub_post_id(
        &h.ctx,
        &id,
        Some(&"hub-1".into()),
        Some(Some(&" new-author ".into())),
        Some(Some(&ts)),
    )
    .unwrap();
    assert_eq!(
        (field(&set, "uploaderName"), field(&set, "hubUpdatedAt")),
        (Some("new-author"), Some(ts.as_str().unwrap()))
    );
    let kept = set_key_label_hub_post_id(&h.ctx, &id, Some(&"hub-2".into()), None, None).unwrap();
    assert_eq!(
        (field(&kept, "uploaderName"), field(&kept, "hubUpdatedAt")),
        (Some("new-author"), Some(ts.as_str().unwrap()))
    );
    let removed =
        set_key_label_hub_post_id(&h.ctx, &id, Some(&"hub-3".into()), Some(None), Some(Some(&" ".into())))
            .unwrap();
    assert_eq!((removed.get("uploaderName"), removed.get("hubUpdatedAt")), (None, None));
}

#[test]
fn a_name_check_ignores_case_and_the_excluded_id() {
    let h = Harness::new();
    let a = save(&h, "French");
    assert!(has_key_label_name(&h.ctx, &"FRENCH".into(), None).unwrap());
    assert!(!has_key_label_name(&h.ctx, &"FRENCH".into(), Some(&id_of(&a))).unwrap());
    assert!(!has_key_label_name(&h.ctx, &"Spanish".into(), None).unwrap());
}

#[test]
fn an_import_saves_each_good_file_and_reports_the_bad_ones() {
    let h = Harness::new();
    let paths = files(
        &h,
        &[
            (
                "sample.json",
                r#"{"name":"Hebrew","author":"pipette","map":{"KC_A":"A"},"composite_labels":null}"#,
            ),
            ("bad.json", r#"{"notAValidShape":true}"#),
            ("b.json", r#"{"name":"Multi B","map":{"KC_B":"B"}}"#),
        ],
    );
    let batch = import_key_label_files(&h.ctx, &paths);
    let imported = items(&batch, "imported");
    let file_names: Vec<&str> =
        imported.iter().map(|i| i.as_object().unwrap().get("fileName").unwrap().as_str().unwrap()).collect();
    assert_eq!(file_names, ["sample.json", "b.json"]);
    assert_eq!(
        pipette_js_json::stringify(&Value::Array(items(&batch, "rejections").to_vec())),
        r#"[{"fileName":"bad.json","errorCode":"INVALID_FILE","error":"Invalid key label file"}]"#
    );
}

#[test]
fn two_files_of_one_name_in_a_batch_end_in_one_entry() {
    let h = Harness::new();
    let paths = files(
        &h,
        &[
            ("first.json", r#"{"name":"Duplicate","map":{"KC_A":"A"}}"#),
            ("second.json", r#"{"name":"Duplicate","map":{"KC_B":"B"}}"#),
        ],
    );
    let batch = import_key_label_files(&h.ctx, &paths);
    let ids: Vec<&Value> = items(&batch, "imported")
        .iter()
        .map(|i| i.as_object().unwrap().get("meta").unwrap().as_object().unwrap().get("id").unwrap())
        .collect();
    assert_eq!(ids[0], ids[1]);
    let live = list_key_labels(&h.ctx, false).unwrap();
    let dup: Vec<&Entry> = live.iter().filter(|e| field(e, "name") == Some("Duplicate")).collect();
    assert_eq!(dup.len(), 1);
    let record = get_key_label(&h.ctx, &id_of(dup[0])).unwrap();
    assert_eq!(data_of(&record).get("map"), Some(&json(r#"{"KC_B":"B"}"#)));
}

#[test]
fn an_import_over_a_live_name_keeps_its_id_author_and_hub_link() {
    let h = Harness::new();
    let first =
        save_key_label(&h.ctx, &KeyLabelSave { hub_post_id: Some("post".into()), ..input("Linked", "{}") })
            .unwrap();
    let batch = import_key_label_files(&h.ctx, &files(&h, &[("l.json", r#"{"name":"LINKED","map":{}}"#)]));
    let meta =
        items(&batch, "imported")[0].as_object().unwrap().get("meta").unwrap().as_object().unwrap().clone();
    assert_eq!(meta.get("id"), first.get("id"));
    assert_eq!(meta.get("uploaderName"), Some(&Value::from("me")));
    assert_eq!(meta.get("hubPostId"), Some(&Value::from("post")));
    assert_eq!(meta.get("name"), Some(&Value::from("LINKED")));
}

#[test]
fn a_reorder_puts_the_listed_live_entries_first_without_moving_clocks() {
    let h = Harness::new();
    let a = save(&h, "Alpha");
    save(&h, "Beta");
    let c = save(&h, "Gamma");
    let gone = save(&h, "Gone");
    delete_key_label(&h.ctx, &id_of(&gone)).unwrap();
    let before = list_key_labels(&h.ctx, true).unwrap();
    let notified = h.notified().len();
    h.clock.set(ms(T0) + 1000);

    reorder_key_labels(&h.ctx, &[id_of(&c), id_of(&gone), id_of(&a), "missing".into(), id_of(&c)]).unwrap();
    let after = list_key_labels(&h.ctx, true).unwrap();
    assert_eq!(names(&after), ["Gamma", "Alpha", "QWERTY", "Beta", "Gone"]);
    assert_eq!(h.notified().len(), notified);
    for entry in &after {
        let was = before.iter().find(|e| e.id() == entry.id()).unwrap();
        assert_eq!(entry.updated_at(), was.updated_at());
    }
}

#[test]
fn keymap_applicable_survives_save_get_and_export_and_takes_the_snake_case_alias() {
    let h = Harness::new();
    let colemak = save_key_label(
        &h.ctx,
        &KeyLabelSave { keymap_applicable: true, ..input("Colemak", r#"{"KC_E":"F"}"#) },
    )
    .unwrap();
    let record = get_key_label(&h.ctx, &id_of(&colemak)).unwrap();
    assert_eq!(data_of(&record).get("keymapApplicable"), Some(&Value::Bool(true)));
    assert!(
        export_key_label(&h.ctx, &id_of(&colemak)).unwrap().content.contains("\"keymap_applicable\": true")
    );

    let plain = save(&h, "Plain");
    assert_eq!(data_of(&get_key_label(&h.ctx, &id_of(&plain)).unwrap()).get("keymapApplicable"), None);

    let paths = files(
        &h,
        &[
            ("snake.json", r#"{"name":"Snake","map":{},"keymap_applicable":true}"#),
            ("yes.json", r#"{"name":"BadFlag","map":{},"keymapApplicable":"yes"}"#),
            ("false.json", r#"{"name":"FalseFlag","map":{},"keymapApplicable":false}"#),
        ],
    );
    let batch = import_key_label_files(&h.ctx, &paths);
    let flags: Vec<Option<Value>> = items(&batch, "imported")
        .iter()
        .map(|i| {
            let id =
                i.as_object().unwrap().get("meta").unwrap().as_object().unwrap().get("id").unwrap().clone();
            let Value::String(id) = id else { panic!() };
            data_of(&get_key_label(&h.ctx, &id).unwrap()).get("keymapApplicable").cloned()
        })
        .collect();
    assert_eq!(flags, [Some(Value::Bool(true)), None, None]);
}

#[test]
fn an_export_is_the_hub_download_shape() {
    let h = Harness::new();
    let meta = save_key_label(
        &h.ctx,
        &KeyLabelSave {
            composite_labels: Some(json(r#"{"KC_C":"C"}"#)),
            ..input("Export Test", r#"{"KC_A":"A","KC_B":"B"}"#)
        },
    )
    .unwrap();
    let file = export_key_label(&h.ctx, &id_of(&meta)).unwrap();
    assert_eq!(file.default_name, "key-labels-Export_Test.json");
    assert_eq!(
        file.content,
        "{\n  \"name\": \"Export Test\",\n  \"map\": {\n    \"KC_A\": \"A\",\n    \"KC_B\": \"B\"\n  },\n  \"composite_labels\": {\n    \"KC_C\": \"C\"\n  },\n  \"keymap_applicable\": false\n}"
    );
}

#[test]
fn a_hub_save_keeps_the_current_name_and_brings_a_tombstone_back() {
    let h = Harness::new();
    let entry = save(&h, "Local");
    let id = id_of(&entry);
    rename_key_label(&h.ctx, &id, &"Renamed".into()).unwrap();
    // A later save writes a body of another name.
    h.clock.set(ms(T0) + 1000);
    let refreshed = save_key_label(
        &h.ctx,
        &KeyLabelSave {
            id: Some(id.clone()),
            keep_current_name: true,
            ..input("From Hub", r#"{"KC_A":"a"}"#)
        },
    )
    .unwrap();
    assert_eq!(field(&refreshed, "name"), Some("Renamed"));
    // The previous body is gone: one file per entry.
    assert!(!store_path(&h, field(&entry, "filename").unwrap()).exists());

    delete_key_label(&h.ctx, &id).unwrap();
    h.clock.set(ms(T0) + 5000);
    let revived = save_key_label(
        &h.ctx,
        &KeyLabelSave { id: Some(id.clone()), keep_current_name: true, ..input("Back", "{}") },
    )
    .unwrap();
    assert!(!revived.is_deleted());
    assert_eq!(field(&revived, "name"), Some("Back"));
}

#[test]
fn concurrent_writes_all_land_in_the_index() {
    let h = Arc::new(Harness::new());
    let first = id_of(&save(&h, "One"));
    let threads: Vec<_> = (0..3)
        .map(|n| {
            let h = Arc::clone(&h);
            let first = first.clone();
            std::thread::spawn(move || match n {
                0 => {
                    rename_key_label(&h.ctx, &first, &"Uno".into()).unwrap();
                }
                1 => {
                    save(&h, "Two");
                }
                _ => reorder_key_labels(&h.ctx, &[first]).unwrap(),
            })
        })
        .collect();
    for thread in threads {
        thread.join().unwrap();
    }
    let all = names(&list_key_labels(&h.ctx, false).unwrap());
    assert!(all.contains(&"Uno".to_owned()) && all.contains(&"Two".to_owned()), "{all:?}");
}
