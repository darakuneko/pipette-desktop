// SPDX-License-Identifier: GPL-2.0-or-later
//! The key label commands on a mock app with scripted dialogs and a temp
//! userData directory. The dialog titles and filters are those of
//! src/main/key-label-store.ts.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pipette_sync_pending::PendingStore;
use serde_json::json;
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

fn test_app(user_data: &Path, answer: Vec<PathBuf>) -> TestApp {
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

fn json_filters_named() -> Vec<FileFilter> {
    vec![FileFilter::new("JSON", &["json"]), FileFilter::new("All Files", &["*"])]
}

#[test]
fn a_list_creates_qwerty_and_marks_the_key_labels_as_pending() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let listed = text(block_on(key_label_store_list(t.stores())));
    assert!(
        listed.starts_with(
            r#"{"success":true,"data":[{"id":"qwerty","name":"QWERTY","uploaderName":"pipette""#
        )
    );
    assert_ne!(t.app.state::<PendingStore>().pending_generation_of("key-labels"), 0);
}

#[test]
fn arguments_of_the_wrong_type_answer_as_the_handlers_do() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let invalid_id = r#"{"success":false,"errorCode":"NOT_FOUND","error":"Invalid id"}"#;
    let invalid_name = r#"{"success":false,"errorCode":"INVALID_NAME","error":"Invalid name"}"#;
    assert_eq!(text(block_on(key_label_store_get(t.stores(), Some(json!(5))))), invalid_id);
    assert_eq!(text(block_on(key_label_store_delete(t.stores(), None))), invalid_id);
    assert_eq!(
        text(block_on(key_label_store_rename(t.stores(), Some(json!(1)), Some(json!("x"))))),
        invalid_id
    );
    assert_eq!(
        text(block_on(key_label_store_rename(t.stores(), Some(json!("a")), Some(json!(1))))),
        invalid_name
    );
    assert_eq!(text(block_on(key_label_store_has_name(t.stores(), None, None))), invalid_name);
    assert_eq!(
        text(block_on(key_label_store_reorder(t.stores(), Some(json!(["a", 1]))))),
        r#"{"success":false,"errorCode":"INVALID_FILE","error":"Invalid order list"}"#
    );
    assert_eq!(
        text(block_on(key_label_store_export(t.stores(), t.dialogs(), Some(json!(null))))),
        invalid_id
    );
    assert!(t.requests().is_empty());
}

#[test]
fn an_import_picks_several_json_files() {
    let user_data = TempDir::new().unwrap();
    let a = user_data.path().join("a.json");
    let b = user_data.path().join("b.json");
    std::fs::write(&a, r#"{"name":"A","map":{}}"#).unwrap();
    std::fs::write(&b, "{").unwrap();
    let t = test_app(user_data.path(), vec![a, b]);
    let imported = text(block_on(key_label_store_import(t.stores(), t.dialogs())));
    assert!(imported.contains(r#""imported":[{"fileName":"a.json","meta":{"#), "{imported}");
    assert!(
        imported
            .contains(r#""rejections":[{"fileName":"b.json","errorCode":"IO_ERROR","error":"SyntaxError: "#)
    );
    assert_eq!(
        t.requests(),
        [DialogRequest {
            kind: DialogKind::OpenMany,
            title: "Import Key Label".to_owned(),
            filters: json_filters_named()
        }]
    );
}

#[test]
fn a_cancelled_dialog_answers_cancelled() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), Vec::new());
    let cancelled = r#"{"success":false,"errorCode":"IO_ERROR","error":"cancelled"}"#;
    assert_eq!(text(block_on(key_label_store_import(t.stores(), t.dialogs()))), cancelled);
    block_on(key_label_store_list(t.stores())).unwrap();
    assert_eq!(
        text(block_on(key_label_store_export(t.stores(), t.dialogs(), Some(json!("qwerty"))))),
        cancelled
    );
    assert_eq!(
        t.requests()[1].kind,
        DialogKind::SaveFile { default_name: "key-labels-QWERTY.json".to_owned() }
    );
}

#[test]
fn an_export_writes_where_the_dialog_points() {
    let user_data = TempDir::new().unwrap();
    let target = user_data.path().join("out.json");
    let t = test_app(user_data.path(), vec![target.clone()]);
    block_on(key_label_store_list(t.stores())).unwrap();
    let exported = text(block_on(key_label_store_export(t.stores(), t.dialogs(), Some(json!("qwerty")))));
    assert_eq!(
        exported,
        format!(r#"{{"success":true,"data":{{"filePath":{}}}}}"#, json!(target.to_string_lossy()))
    );
    assert_eq!(
        std::fs::read_to_string(&target).unwrap(),
        "{\n  \"name\": \"QWERTY\",\n  \"map\": {},\n  \"composite_labels\": null,\n  \"keymap_applicable\": false\n}"
    );
    assert_eq!(t.requests()[0].title, "Export Key Label");
    assert_eq!(t.requests()[0].filters, json_filters_named());
}
