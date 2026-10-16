// SPDX-License-Identifier: GPL-2.0-or-later
//! Writes a userData tree with the stores of this crate and the pending
//! state of pipette-sync-pending, the way the app does (every change goes
//! to the pending store), into
//! `src-tauri/target/tmp/pipette-keyboard-stores/rust_user_data/`:
//!
//! - `user-data/`: the tree;
//! - `answers.json`: what the stores answer on that tree, as the app's
//!   commands answer it (the handlers' `{success, …}` JSON text).
//!
//! `pnpm run verify:keyboard-store-rust-user-data` then reads a copy of the
//! tree with the real handlers of the Electron build and compares their
//! answers with these, byte for byte.

#![allow(clippy::unwrap_used, clippy::panic)]

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use pipette_entry_store::{SystemClock, WriteLocks};
use pipette_js_json::{JsString, Object, Value};
use pipette_keyboard_stores::{
    FavoriteImport, FavoriteType, KeyLabelSave, SETTINGS_ETAG_ABSENT, StoreContext, TypingTextSave,
    TypingTextSource, TypingTextStore, delete_favorite, delete_key_label, delete_snapshot, field,
    get_key_label, import_favorites, import_key_label_files, key_label_response,
    keyboard_meta_name_if_missing, keyboard_settings_files_json, list_favorites, list_key_labels,
    list_snapshots, list_stored_keyboards, load_favorite, load_snapshot, read_all_pipette_settings,
    read_pipette_settings, rename_favorite, rename_key_label, rename_snapshot, reorder_key_labels,
    response_json, save_favorite, save_key_label, save_snapshot, set_favorite_hub_post_id,
    set_key_label_hub_post_id, set_snapshot_hub_private, stored_keyboards_json, typing_text_response,
    update_snapshot, write_pipette_settings,
};
use pipette_sync_pending::{PendingStore, Scheduler};

/// Drops the delayed writes: the test writes the pending state once, at
/// the end, as the quit sequence does.
struct NoDelayedWrites;

impl Scheduler for NoDelayedWrites {
    fn schedule(&self, _delay: Duration, _task: Box<dyn FnOnce() + Send>) {}
}

fn out_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("pipette-keyboard-stores").join("rust_user_data")
}

fn write(path: &Path, content: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

/// The id of an entry in a list.
fn id_of(entry: &Value) -> String {
    entry.as_object().unwrap().get("id").unwrap().as_str().unwrap().to_owned()
}

fn entries_answer(entries: Vec<pipette_entry_store::Entry>) -> String {
    response_json::<String>(Ok(field(
        "entries",
        Value::Array(entries.into_iter().map(Value::from).collect()),
    )))
}

const KEYBOARD: &str = "0x5A3C9D21E04B7F10";
const SECOND_KEYBOARD: &str = "0x00FF00FF00FF00FF";
/// A keyboard named on connect only: no snapshot, settings only.
const NAMED_ONLY: &str = "0x1111222233334444";

const TYPING_RESULT: &str = r#"{"date":"2026-10-01T09:30:00.000Z","wpm":61,"accuracy":97.5,"wordCount":30,"correctChars":180,"incorrectChars":4,"durationSeconds":30}"#;

#[test]
fn writes_a_user_data_tree_for_the_typescript_handlers() {
    let out = out_dir();
    let _ = fs::remove_dir_all(&out);
    let user_data = out.join("user-data");
    fs::create_dir_all(&user_data).unwrap();

    // A favorites index of an older Electron build: v1 entries without
    // clocks and a body filename without the id, which the first write
    // under its lock moves to the id form.
    let legacy_dir = user_data.join("sync/favorites/macro");
    write(
        &legacy_dir.join("macro_2025-12-31T10-00-00.000Z.json"),
        r#"{"type":"macro","data":[["text","legacy"]]}"#,
    );
    write(
        &legacy_dir.join("index.json"),
        r#"{"type":"macro","entries":[{"id":"legacy-1","label":"Legacy","filename":"macro_2025-12-31T10-00-00.000Z.json","savedAt":"2025-12-31T10:00:00.000Z"}]}"#,
    );

    let pending = PendingStore::restore(&user_data, Arc::new(NoDelayedWrites), Box::new(|_| {}));
    let notified = Arc::new(Mutex::new(Vec::<String>::new()));
    let ctx = {
        let pending = pending.clone();
        let notified = Arc::clone(&notified);
        StoreContext::new(
            &user_data,
            Arc::new(SystemClock),
            Arc::new(WriteLocks::new()),
            Arc::new(move |unit: &str| {
                notified.lock().unwrap().push(unit.to_owned());
                pending.notify_change(unit);
            }),
        )
    };

    // Snapshots of two keyboards: saved, updated, renamed, linked, deleted.
    let first = save_snapshot(
        &ctx,
        KEYBOARD,
        r#"{"version":1,"layout":[[["KC_A"]]]}"#,
        "GPK60-63R",
        "Base",
        Some(2.0),
    )
    .unwrap();
    let second =
        save_snapshot(&ctx, KEYBOARD, "{\"version\":1,\"note\":\"日本語 😀\"}", "GPK60-63R", "", None)
            .unwrap();
    let third = save_snapshot(&ctx, KEYBOARD, "{}", "GPK60-63R", "To delete", Some(2.0)).unwrap();
    let first_id = id_of(&Value::from(first));
    update_snapshot(&ctx, KEYBOARD, &first_id, r#"{"version":1,"layout":[[["KC_B"]]]}"#, Some(2.0), None)
        .unwrap();
    rename_snapshot(&ctx, KEYBOARD, &id_of(&Value::from(second.clone())), "Renamed スナップショット")
        .unwrap();
    let mut link = Object::new();
    link.insert("id", "p1".into());
    link.insert("url", "/files/p1?token=t".into());
    link.insert("expiresAt", Value::Null);
    set_snapshot_hub_private(&ctx, KEYBOARD, &first_id, Some(Value::Object(link))).unwrap();
    delete_snapshot(&ctx, KEYBOARD, &id_of(&Value::from(third))).unwrap();
    save_snapshot(&ctx, SECOND_KEYBOARD, "{\"second\":true}", "Ctrl\u{1}/Name:é", "Other", None).unwrap();

    // Keyboard names, settings.
    keyboard_meta_name_if_missing(&ctx, Some(NAMED_ONLY), Some("Named 鍵盤")).unwrap();
    keyboard_meta_name_if_missing(&ctx, Some(KEYBOARD), Some("Not used: already named")).unwrap();
    let settings = [
        (
            KEYBOARD,
            format!(
                r#"{{"_rev":1,"keyboardLayout":"qwerty","autoAdvance":true,"layerNames":["Base","Fn"],"typingTestResults":[{TYPING_RESULT}],"_updatedAt":"2026-10-16T12:00:00.000Z"}}"#
            ),
        ),
        (
            NAMED_ONLY,
            format!(
                r#"{{"_rev":1,"keyboardLayout":"jis","autoAdvance":false,"layerNames":[],"typingTestResults":[{TYPING_RESULT}],"_updatedAt":"2026-10-16T12:00:01.000Z"}}"#
            ),
        ),
    ];
    for (uid, content) in &settings {
        let etag = read_pipette_settings(&ctx, uid).unwrap().etag;
        assert_eq!(etag, SETTINGS_ETAG_ABSENT);
        write_pipette_settings(&ctx, uid, content, &etag).unwrap();
    }

    // Favorites of every type; the legacy macro index is migrated by the
    // first write of its type.
    let body = |ty: FavoriteType, data: &str| format!(r#"{{"type":"{}","data":{data}}}"#, ty.name());
    for ty in FavoriteType::ALL {
        save_favorite(&ctx, ty, &body(ty, r#"{"n":1}"#), &format!("{} one", ty.name())).unwrap();
    }
    let td =
        save_favorite(&ctx, FavoriteType::TapDance, &body(FavoriteType::TapDance, r#"{"n":2}"#), "TD two")
            .unwrap();
    let td_id = id_of(&Value::from(td));
    rename_favorite(&ctx, FavoriteType::TapDance, &td_id, "TD 名前").unwrap();
    set_favorite_hub_post_id(&ctx, FavoriteType::TapDance, &td_id, Some(" post-9 ")).unwrap();
    let combo = save_favorite(&ctx, FavoriteType::Combo, &body(FavoriteType::Combo, "[]"), "gone").unwrap();
    delete_favorite(&ctx, FavoriteType::Combo, &id_of(&Value::from(combo))).unwrap();
    import_favorites(
        &ctx,
        FavoriteType::KeyOverride,
        &[FavoriteImport {
            label: JsString::from("Imported"),
            saved_at: JsString::from("2026-02-03T04:05:06.007Z"),
            body: JsString::from(body(FavoriteType::KeyOverride, r#"{"imported":true}"#)),
        }],
    )
    .unwrap();

    // Key labels: QWERTY from the first list, two imported files (one with
    // the Hub download's snake-case fields), a rename, a Hub link, a
    // reorder and a delete.
    list_key_labels(&ctx, false).unwrap();
    let label_files = out.join("key-label-files");
    let colemak = label_files.join("colemak.json");
    write(
        &colemak,
        r#"{"name":"Colemak","map":{"KC_E":"F"},"composite_labels":{"KC_A":"Å"},"keymap_applicable":true}"#,
    );
    let french = label_files.join("french.json");
    write(&french, r#"{"name":"French 😀","map":{"KC_Q":"A"}}"#);
    let imported = import_key_label_files(&ctx, &[colemak, french]);
    let imported_ids: Vec<JsString> = match imported.get("imported") {
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| JsString::from(id_of(item.as_object().unwrap().get("meta").unwrap())))
            .collect(),
        other => panic!("{other:?}"),
    };
    rename_key_label(&ctx, &imported_ids[1], &JsString::from("Français")).unwrap();
    set_key_label_hub_post_id(&ctx, &imported_ids[0], Some(&JsString::from("hub-colemak")), None, None)
        .unwrap();
    reorder_key_labels(&ctx, &[imported_ids[1].clone(), JsString::from("qwerty")]).unwrap();
    let gone = save_key_label(
        &ctx,
        &KeyLabelSave {
            id: None,
            name: JsString::from("Gone"),
            uploader_name: None,
            map: Value::Object(Object::new()),
            composite_labels: None,
            keymap_applicable: false,
            hub_post_id: None,
            hub_updated_at: None,
            keep_current_name: false,
        },
    )
    .unwrap();
    delete_key_label(&ctx, &gone.id().unwrap().clone()).unwrap();

    // Typing test texts: a kana file, a file named like it held and
    // confirmed over it, a catalog save with its source, a rename and a
    // delete.
    let texts = TypingTextStore::default();
    let text_files = out.join("typing-text-files");
    let kana = text_files.join("かな.txt");
    write(&kana, "\u{feff}こんにちは せかい\r\nありがとう");
    let kana_id = texts.import_file(&ctx, &kana).unwrap().id().unwrap().clone();
    write(&kana, "  indented   words\n\nnext line");
    assert!(texts.import_file(&ctx, &kana).is_err());
    texts.confirm_import(&ctx).unwrap();
    let aozora = TypingTextSave {
        id: None,
        name: JsString::from("作品（作者）"),
        text: JsString::from("ひらがな カタカナ"),
        source: Some(TypingTextSource {
            provider: JsString::from("aozora"),
            work_id: JsString::from("001257/files/59898_ruby_70679.zip"),
        }),
        keep_current_name: false,
    };
    let aozora_id = texts.save(&ctx, &aozora).unwrap().id().unwrap().clone();
    texts.rename(&ctx, &aozora_id, &JsString::from("作品 😀")).unwrap();
    let gone = texts
        .save(
            &ctx,
            &TypingTextSave {
                id: None,
                name: JsString::from("Gone"),
                text: JsString::from("bye"),
                source: None,
                keep_current_name: false,
            },
        )
        .unwrap();
    texts.delete(&ctx, gone.id().unwrap()).unwrap();
    assert_ne!(kana_id, aozora_id);

    // What the stores answer on the finished tree. The stored-keyboard list
    // goes last: it may record names.
    let mut answers = Object::new();
    let mut snapshots = Object::new();
    for uid in [KEYBOARD, SECOND_KEYBOARD] {
        let entries = list_snapshots(&ctx, uid).unwrap();
        let mut loads = Object::new();
        for entry in &entries {
            let id = id_of(&Value::from(entry.clone()));
            let data = load_snapshot(&ctx, uid, &id).map(|data| field("data", data));
            loads.insert(id, response_json(data).into());
        }
        let mut answer = Object::new();
        answer.insert("list", entries_answer(entries).into());
        answer.insert("loads", Value::Object(loads));
        snapshots.insert(uid, Value::Object(answer));
    }
    answers.insert("snapshots", Value::Object(snapshots));

    let mut favorites = Object::new();
    for ty in FavoriteType::ALL {
        let entries = list_favorites(&ctx, ty).unwrap();
        let mut loads = Object::new();
        for entry in &entries {
            let id = id_of(&Value::from(entry.clone()));
            let data = load_favorite(&ctx, ty, &id).map(|data| field("data", data));
            loads.insert(id, response_json(data).into());
        }
        let mut answer = Object::new();
        answer.insert("list", entries_answer(entries).into());
        answer.insert("loads", Value::Object(loads));
        favorites.insert(ty.name(), Value::Object(answer));
    }
    answers.insert("favorites", Value::Object(favorites));

    let live = list_key_labels(&ctx, false).unwrap();
    let mut gets = Object::new();
    for entry in &live {
        let id = id_of(&Value::from(entry.clone()));
        let record =
            get_key_label(&ctx, &JsString::from(id.as_str())).map(|record| Some(Value::Object(record)));
        gets.insert(id, key_label_response(record).into());
    }
    let mut key_labels = Object::new();
    key_labels.insert(
        "list",
        key_label_response(Ok(Some(Value::Array(live.into_iter().map(Value::from).collect())))).into(),
    );
    let all = list_key_labels(&ctx, true).unwrap();
    key_labels.insert(
        "listAll",
        key_label_response(Ok(Some(Value::Array(all.into_iter().map(Value::from).collect())))).into(),
    );
    key_labels.insert("gets", Value::Object(gets));
    answers.insert("keyLabels", Value::Object(key_labels));

    // A new store, as the TypeScript handlers start with no cached
    // romajiCapable.
    let texts = TypingTextStore::default();
    let live = texts.list(&ctx, false).unwrap();
    let mut gets = Object::new();
    for entry in &live {
        let id = id_of(&Value::from(entry.clone()));
        let record = texts.get(&ctx, &JsString::from(id.as_str())).map(|record| Some(Value::Object(record)));
        gets.insert(id, typing_text_response(record).into());
    }
    let mut typing_texts = Object::new();
    typing_texts.insert(
        "list",
        typing_text_response(Ok(Some(Value::Array(live.into_iter().map(Value::from).collect())))).into(),
    );
    typing_texts.insert("gets", Value::Object(gets));
    answers.insert("typingTexts", Value::Object(typing_texts));

    let mut settings_files = Object::new();
    for (uid, _) in &settings {
        let file = read_pipette_settings(&ctx, uid).unwrap();
        let mut read = Object::new();
        read.insert("content", file.content.map_or(Value::Null, Value::from));
        read.insert("etag", file.etag.into());
        settings_files.insert(*uid, Value::Object(read));
    }
    answers.insert("settings", Value::Object(settings_files));
    answers.insert(
        "settingsReadAll",
        keyboard_settings_files_json(&read_all_pipette_settings(&ctx).unwrap()).into(),
    );
    answers.insert("storedKeyboards", stored_keyboards_json(&list_stored_keyboards(&ctx).unwrap()).into());

    pending.persist_now();
    let mut units: Vec<String> = Vec::new();
    for unit in notified.lock().unwrap().iter() {
        if !units.contains(unit) {
            units.push(unit.clone());
        }
    }
    answers.insert("pendingUnits", Value::Array(units.into_iter().map(Value::from).collect()));
    write(&out.join("answers.json"), &pipette_js_json::stringify(&Value::Object(answers)));
}
