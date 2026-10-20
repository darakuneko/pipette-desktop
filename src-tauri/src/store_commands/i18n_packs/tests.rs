// SPDX-License-Identifier: GPL-2.0-or-later
//! The language pack commands on a mock app with scripted dialogs and a
//! temp userData directory.

use pipette_sync_pending::PendingStore;
use serde_json::json;
use tauri::Manager;
use tauri::async_runtime::block_on;
use tempfile::TempDir;

use super::*;
use crate::command_error::CommandError;
use crate::dialog::{DialogKind, DialogRequest, FileFilter};
use crate::store_commands::pack_commands::test_app::{TestApp, test_app, text};

fn json_filters() -> Vec<FileFilter> {
    vec![FileFilter::new("JSON", &["json"]), FileFilter::new("All Files", &["*"])]
}

/// Saves the pack `{name, version: "1"}` and answers its id.
fn import(t: &TestApp, name: &str, options: &str) -> String {
    let raw = json!({ "name": name, "version": "1" }).to_string();
    let saved = text(block_on(i18n_pack_import_apply(t.stores(), Some(raw), Some(options.to_owned()))));
    let saved: serde_json::Value = serde_json::from_str(&saved).unwrap();
    saved["data"]["id"].as_str().unwrap().to_owned()
}

#[test]
fn a_save_marks_the_index_and_the_body_as_pending_but_not_the_english_body() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    text(block_on(i18n_pack_store_list(t.stores())));
    let id = import(&t, "Japanese", "{}");
    let pending = t.app.state::<PendingStore>();
    assert_ne!(pending.pending_generation_of("i18n/index"), 0);
    assert_ne!(pending.pending_generation_of(&format!("i18n/packs/{id}")), 0);
    assert_eq!(pending.pending_generation_of("i18n/packs/builtin-english"), 0);
}

#[test]
fn the_import_options_keep_their_key_order_and_a_lone_surrogate() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let raw = r#"{"version":"1","2":"index key","name":"Lone \ud800","b":1,"a":2}"#;
    let options = r#"{"coverage":{"coveredKeys":1,"totalKeys":2},"uploaderName":"\ud800"}"#;
    let saved = text(block_on(i18n_pack_import_apply(t.stores(), Some(raw.into()), Some(options.into()))));
    assert!(saved.contains(r#""name":"Lone \ud800""#), "{saved}");
    assert!(saved.contains(r#""uploaderName":"\ud800""#), "{saved}");
    assert!(saved.contains(r#""coverage":{"totalKeys":2,"coveredKeys":1}"#), "{saved}");
    // The one body written; its id is random.
    let packs = user_data.path().join("sync/i18n/packs");
    let body =
        std::fs::read_to_string(std::fs::read_dir(packs).unwrap().next().unwrap().unwrap().path()).unwrap();
    assert_eq!(
        body,
        "{\n  \"2\": \"index key\",\n  \"version\": \"1\",\n  \"name\": \"Lone \\ud800\",\n  \"b\": 1,\n  \"a\": 2\n}"
    );
}

#[test]
fn arguments_of_the_wrong_type_answer_the_handler_errors() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let invalid_id = r#"{"success":false,"errorCode":"NOT_FOUND","error":"Invalid id"}"#;
    assert_eq!(text(block_on(i18n_pack_store_get(t.stores(), Some(json!(5))))), invalid_id);
    assert_eq!(text(block_on(i18n_pack_store_delete(t.stores(), None))), invalid_id);
    assert_eq!(
        text(block_on(i18n_pack_store_set_enabled(t.stores(), Some(json!("x")), Some(json!("yes"))))),
        r#"{"success":false,"errorCode":"INVALID_FILE","error":"enabled must be boolean"}"#
    );
    assert_eq!(
        text(block_on(i18n_pack_store_reorder(t.stores(), Some(json!(["a", 5]))))),
        r#"{"success":false,"errorCode":"INVALID_FILE","error":"Invalid order list"}"#
    );
    assert_eq!(
        text(block_on(i18n_pack_store_has_name(t.stores(), None, None))),
        r#"{"success":false,"errorCode":"INVALID_NAME","error":"Invalid name"}"#
    );
}

#[test]
fn the_import_dialog_reads_the_chosen_files() {
    let user_data = TempDir::new().unwrap();
    let file = user_data.path().join("pack.json");
    std::fs::write(&file, "{\"name\":\"A\",\"version\":\"1\"}").unwrap();
    let t = test_app(user_data.path(), vec![file.clone()]);
    let read = block_on(i18n_pack_import(t.dialogs())).unwrap();
    assert_eq!(
        serde_json::to_value(read).unwrap(),
        json!({ "canceled": false, "files": [{ "filePath": file.to_string_lossy(), "text": "{\"name\":\"A\",\"version\":\"1\"}", "fileSizeBytes": 26 }] })
    );
    assert_eq!(t.requests()[0].title, "Import Language Pack");
    assert_eq!(t.requests()[0].kind, DialogKind::OpenMany);
    assert_eq!(t.requests()[0].filters, json_filters());
}

#[test]
fn an_export_writes_the_pack_where_the_user_chooses() {
    let user_data = TempDir::new().unwrap();
    let target = user_data.path().join("out.json");
    let t = test_app(user_data.path(), vec![target.clone()]);
    let id = import(&t, "日本語 / テスト", "{}");
    let exported = text(block_on(i18n_pack_export(t.stores(), t.dialogs(), Some(json!(id)))));
    let path = serde_json::to_string(&target.to_string_lossy()).unwrap();
    assert_eq!(exported, format!(r#"{{"success":true,"data":{{"filePath":{path}}}}}"#));
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "{\n  \"name\": \"日本語 / テスト\",\n  \"version\": \"1\"\n}"
    );
    assert_eq!(
        t.requests(),
        [DialogRequest {
            kind: DialogKind::SaveFile { default_name: "i18n-packs-日本語_テスト.json".to_owned() },
            title: "Export Language Pack".to_owned(),
            filters: json_filters(),
        }]
    );
}

#[test]
fn a_cancelled_export_writes_nothing() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    text(block_on(i18n_pack_store_list(t.stores())));
    let exported = text(block_on(i18n_pack_export(t.stores(), t.dialogs(), Some(json!("builtin-english")))));
    assert_eq!(exported, r#"{"success":false,"errorCode":"IO_ERROR","error":"cancelled"}"#);
}

#[test]
fn an_export_of_a_pack_whose_name_is_not_a_string_fails_the_call() {
    let user_data = TempDir::new().unwrap();
    let index = user_data.path().join("sync/i18n");
    std::fs::create_dir_all(index.join("packs")).unwrap();
    std::fs::write(
        index.join("index.json"),
        r#"{"metas":[{"id":"num","filename":"packs/num.json","name":5,"version":"1","enabled":true,"savedAt":"2026-01-01T00:00:00.000Z","clocks":{"created":"2026-01-01T00:00:00.000Z","body":"2026-01-01T00:00:00.000Z"}}]}"#,
    )
    .unwrap();
    std::fs::write(index.join("packs/num.json"), r#"{"name":"x","version":"1"}"#).unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let failed = block_on(i18n_pack_export(t.stores(), t.dialogs(), Some(json!("num"))));
    let Err(err) = failed else { panic!("the export answered") };
    assert_eq!(err, CommandError::new("TypeError: name.replace is not a function"));
    assert!(t.requests().is_empty());
}
