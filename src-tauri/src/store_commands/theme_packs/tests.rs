// SPDX-License-Identifier: GPL-2.0-or-later
//! The theme pack commands on a mock app with scripted dialogs and a temp
//! userData directory.

use std::sync::{Arc, Mutex};

use pipette_sync_pending::PendingStore;
use serde_json::json;
use tauri::async_runtime::block_on;
use tauri::{Listener, Manager};
use tempfile::TempDir;

use pipette_pack_stores::theme_validate::THEME_COLOR_KEYS;

use super::*;
use crate::dialog::{DialogKind, DialogRequest, FileFilter};
use crate::store_commands::pack_commands::test_app::{TestApp, test_app, text};

fn json_filters() -> Vec<FileFilter> {
    vec![FileFilter::new("JSON", &["json"]), FileFilter::new("All Files", &["*"])]
}

/// The JSON text of a theme pack named `name`, its keys in the order a
/// pack file has them.
fn theme(name: &str) -> String {
    let name = serde_json::to_string(name).unwrap();
    format!(r#"{{"name":{name},"version":"1.0.0","colorScheme":"dark","colors":{}}}"#, colors())
}

/// The JSON text of the colors every pack has.
fn colors() -> String {
    let pairs: Vec<String> = THEME_COLOR_KEYS.iter().map(|key| format!(r##""{key}":"#2e3440""##)).collect();
    format!("{{{}}}", pairs.join(","))
}

fn handle(t: &TestApp) -> AppHandle<tauri::test::MockRuntime> {
    t.app.handle().clone()
}

/// Saves the pack `name` and answers its id.
fn import(t: &TestApp, name: &str) -> String {
    let saved =
        text(block_on(theme_pack_import_apply(handle(t), t.stores(), Some(theme(name)), Some("{}".into()))));
    let saved: serde_json::Value = serde_json::from_str(&saved).unwrap();
    saved["data"]["id"].as_str().unwrap().to_owned()
}

/// Counts the `theme-pack:changed` events the app sends.
fn count_changes(t: &TestApp) -> Arc<Mutex<usize>> {
    let count = Arc::new(Mutex::new(0));
    let counted = Arc::clone(&count);
    t.app.listen_any(THEME_PACK_CHANGED, move |_| *counted.lock().unwrap() += 1);
    count
}

#[test]
fn a_save_marks_the_index_and_the_body_as_pending() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let id = import(&t, "Nord");
    let pending = t.app.state::<PendingStore>();
    assert_ne!(pending.pending_generation_of("themes/index"), 0);
    assert_ne!(pending.pending_generation_of(&format!("themes/packs/{id}")), 0);
}

#[test]
fn each_successful_change_sends_the_event_and_a_failure_or_a_read_does_not() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let count = count_changes(&t);
    let changes = || *count.lock().unwrap();

    let id = import(&t, "Nord");
    assert_eq!(changes(), 1);
    let id = Some(json!(id));
    text(block_on(theme_pack_store_rename(handle(&t), t.stores(), id.clone(), Some(json!("Polar")))));
    text(block_on(theme_pack_store_reorder(handle(&t), t.stores(), Some(json!([])))));
    text(block_on(theme_pack_store_set_hub_post_id(
        handle(&t),
        t.stores(),
        id.clone(),
        Some(json!("p")),
        None,
        None,
    )));
    text(block_on(theme_pack_store_delete(handle(&t), t.stores(), id.clone())));
    assert_eq!(changes(), 5);

    text(block_on(theme_pack_store_list(t.stores())));
    text(block_on(theme_pack_store_get(t.stores(), id.clone())));
    text(block_on(theme_pack_store_has_name(t.stores(), Some(json!("Polar")), None)));
    text(block_on(theme_pack_store_rename(handle(&t), t.stores(), Some(json!("missing")), Some(json!("x")))));
    text(block_on(theme_pack_store_delete(handle(&t), t.stores(), None)));
    text(block_on(theme_pack_store_reorder(handle(&t), t.stores(), Some(json!("nope")))));
    let unnamed = json!({ "version": "1.0.0" }).to_string();
    text(block_on(theme_pack_import_apply(handle(&t), t.stores(), Some(unnamed), None)));
    assert_eq!(changes(), 5);
}

#[test]
fn the_import_options_keep_their_key_order_and_a_lone_surrogate() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let raw = format!(
        r#"{{"version":"1.0.0","2":"index key","name":"Lone \ud800","colorScheme":"dark","colors":{}}}"#,
        colors()
    );
    let options = r#"{"uploaderName":"\ud800","hubPostId":"post"}"#;
    let saved =
        text(block_on(theme_pack_import_apply(handle(&t), t.stores(), Some(raw), Some(options.into()))));
    assert!(saved.contains(r#""name":"Lone \ud800""#), "{saved}");
    assert!(saved.contains(r#""hubPostId":"post","uploaderName":"\ud800""#), "{saved}");
    let packs = user_data.path().join("sync/themes/packs");
    let body =
        std::fs::read_to_string(std::fs::read_dir(packs).unwrap().next().unwrap().unwrap().path()).unwrap();
    assert!(
        body.starts_with(
            "{\n  \"2\": \"index key\",\n  \"version\": \"1.0.0\",\n  \"name\": \"Lone \\ud800\",\n  \
             \"colorScheme\": \"dark\",\n  \"colors\": {\n    \"surface\": \"#2e3440\","
        ),
        "{body}"
    );
}

#[test]
fn arguments_of_the_wrong_type_answer_the_handler_errors() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let invalid_id = r#"{"success":false,"errorCode":"NOT_FOUND","error":"Invalid id"}"#;
    assert_eq!(text(block_on(theme_pack_store_get(t.stores(), Some(json!(5))))), invalid_id);
    assert_eq!(text(block_on(theme_pack_store_delete(handle(&t), t.stores(), None))), invalid_id);
    assert_eq!(
        text(block_on(theme_pack_store_rename(handle(&t), t.stores(), Some(json!("x")), Some(json!(5))))),
        r#"{"success":false,"errorCode":"INVALID_NAME","error":"Invalid name"}"#
    );
    assert_eq!(
        text(block_on(theme_pack_store_reorder(handle(&t), t.stores(), Some(json!(["a", 5]))))),
        r#"{"success":false,"errorCode":"INVALID_FILE","error":"Invalid order list"}"#
    );
    assert_eq!(
        text(block_on(theme_pack_store_has_name(t.stores(), None, None))),
        r#"{"success":false,"errorCode":"INVALID_NAME","error":"Invalid name"}"#
    );
}

#[test]
fn the_import_dialog_reads_the_chosen_files() {
    let user_data = TempDir::new().unwrap();
    let file = user_data.path().join("theme.json");
    std::fs::write(&file, theme("A")).unwrap();
    let t = test_app(user_data.path(), vec![file.clone()]);
    let read = block_on(theme_pack_import(t.dialogs())).unwrap();
    assert_eq!(
        serde_json::to_value(read).unwrap(),
        json!({ "canceled": false, "files": [{ "filePath": file.to_string_lossy(), "text": theme("A"), "fileSizeBytes": theme("A").len() }] })
    );
    assert_eq!(t.requests()[0].title, "Import Theme Pack");
    assert_eq!(t.requests()[0].kind, DialogKind::OpenMany);
    assert_eq!(t.requests()[0].filters, json_filters());
}

#[test]
fn an_export_writes_the_pack_where_the_user_chooses() {
    let user_data = TempDir::new().unwrap();
    let target = user_data.path().join("out.json");
    let t = test_app(user_data.path(), vec![target.clone()]);
    let id = import(&t, "テーマ / テスト");
    let exported = text(block_on(theme_pack_export(t.stores(), t.dialogs(), Some(json!(id)))));
    let path = serde_json::to_string(&target.to_string_lossy()).unwrap();
    assert_eq!(exported, format!(r#"{{"success":true,"data":{{"filePath":{path}}}}}"#));
    let written = std::fs::read_to_string(&target).unwrap();
    assert!(
        written.starts_with(
            "{\n  \"name\": \"テーマ / テスト\",\n  \"version\": \"1.0.0\",\n  \"colorScheme\": \"dark\",\n"
        ),
        "{written}"
    );
    assert_eq!(
        t.requests(),
        [DialogRequest {
            kind: DialogKind::SaveFile { default_name: "theme-packs-テーマ_テスト.json".to_owned() },
            title: "Export Theme Pack".to_owned(),
            filters: json_filters(),
        }]
    );
}

#[test]
fn a_cancelled_export_writes_nothing() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let id = import(&t, "Nord");
    let exported = text(block_on(theme_pack_export(t.stores(), t.dialogs(), Some(json!(id)))));
    assert_eq!(exported, r#"{"success":false,"errorCode":"IO_ERROR","error":"cancelled"}"#);
}

#[test]
fn an_export_of_a_pack_whose_name_is_not_a_string_fails_the_call() {
    let user_data = TempDir::new().unwrap();
    let store = user_data.path().join("sync/themes");
    std::fs::create_dir_all(store.join("packs")).unwrap();
    std::fs::write(
        store.join("index.json"),
        r#"{"metas":[{"id":"num","filename":"packs/num.json","name":5,"version":"1.0.0","savedAt":"2026-01-01T00:00:00.000Z","clocks":{"created":"2026-01-01T00:00:00.000Z","body":"2026-01-01T00:00:00.000Z"}}]}"#,
    )
    .unwrap();
    std::fs::write(store.join("packs/num.json"), theme("x")).unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let failed = block_on(theme_pack_export(t.stores(), t.dialogs(), Some(json!("num"))));
    let Err(err) = failed else { panic!("the export answered") };
    assert_eq!(err, CommandError::new("TypeError: name.replace is not a function"));
    assert!(t.requests().is_empty());
}
