// SPDX-License-Identifier: GPL-2.0-or-later
//! The favorite commands on a mock app with scripted dialogs and a temp
//! userData directory. The dialog titles and filters are those of
//! src/main/favorite-store.ts.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pipette_sync_pending::PendingStore;
use tauri::Manager;
use tauri::async_runtime::block_on;
use tauri::ipc::{InvokeResponseBody, IpcResponse};
use tauri::test::MockRuntime;
use tempfile::TempDir;

use super::*;

/// A mock app with the stores on `user_data`, and dialogs that answer
/// `answer` and record every request.
struct TestApp {
    app: tauri::App<MockRuntime>,
    requests: Arc<Mutex<Vec<DialogRequest>>>,
}

fn test_app(user_data: &Path, answer: Option<PathBuf>) -> TestApp {
    let app = tauri::test::mock_app();
    crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data);
    crate::store_commands::keyboard_data::manage(app.handle(), user_data);
    let requests = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&requests);
    app.manage(Dialogs::new(move |request| {
        record.lock().unwrap().push(request);
        answer.clone()
    }));
    TestApp { app, requests }
}

impl TestApp {
    fn stores(&self) -> State<'_, StoreContext> {
        self.app.state::<StoreContext>()
    }

    fn dialogs(&self) -> State<'_, Dialogs> {
        self.app.state::<Dialogs>()
    }

    fn requests(&self) -> Vec<DialogRequest> {
        self.requests.lock().unwrap().clone()
    }
}

fn text(response: Result<Response, CommandError>) -> String {
    match response.unwrap().body().unwrap() {
        InvokeResponseBody::Json(text) => text,
        InvokeResponseBody::Raw(_) => panic!("not JSON"),
    }
}

fn ty(name: &str) -> Option<serde_json::Value> {
    Some(serde_json::Value::from(name))
}

fn json_filters_named() -> Vec<FileFilter> {
    vec![FileFilter::new("JSON", &["json"]), FileFilter::new("All Files", &["*"])]
}

#[test]
fn a_favorite_change_marks_its_type_as_pending() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), None);
    pipette_keyboard_stores::save_favorite(&t.stores(), FavoriteType::Combo, "{}", "L").unwrap();
    let pending = t.app.state::<PendingStore>();
    assert_ne!(pending.pending_generation_of("favorites/combo"), 0);
    assert_eq!(pending.pending_generation_of("favorites/macro"), 0);
}

#[test]
fn a_type_that_is_not_a_favorite_type_answers_the_handler_error() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), None);
    let invalid = r#"{"success":false,"error":"Error: Invalid favorite type"}"#;
    for value in [None, Some(serde_json::json!(5)), ty("qmkSettings"), ty("../x")] {
        assert_eq!(text(block_on(favorite_store_list(t.stores(), value))), invalid);
    }
    assert_eq!(
        text(block_on(favorite_store_list(t.stores(), ty("macro")))),
        r#"{"success":true,"entries":[]}"#
    );
}

#[test]
fn an_export_is_saved_under_the_cleaned_default_name() {
    let user_data = TempDir::new().unwrap();
    let target = user_data.path().join("out.json");
    let t = test_app(user_data.path(), Some(target.clone()));
    let saved =
        block_on(favorite_store_save_export(t.dialogs(), "a/b:c.json".into(), "{\n  \"x\": 1\n}".into()));
    assert_eq!(
        serde_json::to_value(saved.unwrap()).unwrap(),
        serde_json::json!({ "success": true, "filePath": target.to_string_lossy() })
    );
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\n  \"x\": 1\n}");
    assert_eq!(
        t.requests(),
        [DialogRequest {
            kind: DialogKind::SaveFile { default_name: "a_b_c.json".into() },
            title: "Export Favorites".into(),
            filters: json_filters_named(),
        }]
    );
}

#[test]
fn a_cancelled_dialog_answers_cancelled() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), None);
    let cancelled = serde_json::json!({ "success": false, "error": "cancelled" });
    let saved = block_on(favorite_store_save_export(t.dialogs(), "f.json".into(), "{}".into())).unwrap();
    assert_eq!(serde_json::to_value(saved).unwrap(), cancelled);
    let opened = block_on(favorite_store_open_import(t.dialogs())).unwrap();
    assert_eq!(serde_json::to_value(opened).unwrap(), cancelled);
}

#[test]
fn an_import_file_is_read_as_text() {
    let user_data = TempDir::new().unwrap();
    let source = user_data.path().join("in.json");
    std::fs::write(&source, b"{\"app\":\"pipette\" \xff}").unwrap();
    let t = test_app(user_data.path(), Some(source.clone()));
    let opened = block_on(favorite_store_open_import(t.dialogs())).unwrap();
    assert_eq!(
        serde_json::to_value(opened).unwrap(),
        serde_json::json!({
            "success": true,
            "data": "{\"app\":\"pipette\" \u{FFFD}}",
            "filePath": source.to_string_lossy(),
        })
    );
    assert_eq!(
        t.requests(),
        [DialogRequest {
            kind: DialogKind::OpenFile,
            title: "Import Favorites".into(),
            filters: json_filters_named()
        }]
    );
}

#[test]
fn an_import_batch_reads_its_entries_as_json_text() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), None);
    let entries =
        r#"[{"label":"\ud800 A","savedAt":"s","body":"{}"},{"label":"\ud800 A","savedAt":"s","body":"{}"}]"#;
    let answered = text(block_on(favorite_store_import_batch(t.stores(), ty("tapDance"), entries.into())));
    assert_eq!(answered, r#"{"success":true,"imported":1,"skipped":1}"#);
    let listed = text(block_on(favorite_store_list(t.stores(), ty("tapDance"))));
    assert!(listed.contains(r#""label":"\ud800 A""#), "{listed}");

    for malformed in
        ["{}", "[1]", r#"[{"label":"a","savedAt":"s"}]"#, r#"[{"label":5,"savedAt":"s","body":""}]"#, "["]
    {
        let result = block_on(favorite_store_import_batch(t.stores(), ty("tapDance"), malformed.into()));
        assert!(result.is_err(), "{malformed}");
    }
    let invalid = text(block_on(favorite_store_import_batch(t.stores(), ty("nope"), "[]".into())));
    assert_eq!(invalid, r#"{"success":false,"error":"Error: Invalid favorite type"}"#);
}

#[test]
fn hub_links_are_read_as_the_handlers_read_them() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), None);
    let saved = text(block_on(favorite_store_save(t.stores(), ty("macro"), "{}".into(), "M".into())));
    let id = pipette_js_json::parse(&saved)
        .unwrap()
        .as_object()
        .unwrap()
        .get("entry")
        .unwrap()
        .as_object()
        .unwrap()
        .get("id")
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned();

    let link = r#"{"url":"/u","id":"p","expiresAt":null}"#;
    let set =
        block_on(favorite_store_set_hub_private(t.stores(), ty("macro"), id.clone(), Some(link.into())));
    assert_eq!(text(set), r#"{"success":true}"#);
    let listed = text(block_on(favorite_store_list(t.stores(), ty("macro"))));
    assert!(listed.contains(&format!(r#""hubPrivate":{link}"#)), "{listed}");

    block_on(favorite_store_set_hub_private(t.stores(), ty("macro"), id.clone(), Some("null".into())))
        .unwrap();
    let listed = text(block_on(favorite_store_list(t.stores(), ty("macro"))));
    assert!(!listed.contains("hubPrivate"), "{listed}");

    let read = text(block_on(favorite_store_read_for_export(t.stores(), ty("macro"), Some(id))));
    assert!(read.starts_with(r#"{"success":true,"entries":[{"label":"M","savedAt":""#), "{read}");
    let missing = text(block_on(favorite_store_read_for_export(t.stores(), ty("macro"), Some("x".into()))));
    assert_eq!(missing, r#"{"success":false,"error":"Entry not found"}"#);
}
