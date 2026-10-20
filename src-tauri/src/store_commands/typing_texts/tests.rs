// SPDX-License-Identifier: GPL-2.0-or-later
//! The typing test text commands on a mock app with scripted dialogs and a
//! temp userData directory.

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

    fn texts(&self) -> State<'_, TypingTextStore> {
        self.app.state::<TypingTextStore>()
    }

    fn import(&self) -> String {
        text(block_on(typing_test_text_store_import(
            self.stores(),
            self.texts(),
            self.app.state::<Dialogs>(),
        )))
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

#[test]
fn arguments_of_the_wrong_type_answer_as_the_handlers_do() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), None);
    let invalid_id = r#"{"success":false,"errorCode":"NOT_FOUND","error":"Invalid id"}"#;
    assert_eq!(text(block_on(typing_test_text_store_get(t.stores(), t.texts(), Some(json!(5))))), invalid_id);
    assert_eq!(text(block_on(typing_test_text_store_delete(t.stores(), t.texts(), None))), invalid_id);
    assert_eq!(
        text(block_on(typing_test_text_store_rename(
            t.stores(),
            t.texts(),
            Some(json!(1)),
            Some(json!("x"))
        ))),
        invalid_id
    );
    assert_eq!(
        text(block_on(typing_test_text_store_rename(
            t.stores(),
            t.texts(),
            Some(json!("a")),
            Some(json!(1))
        ))),
        r#"{"success":false,"errorCode":"INVALID_NAME","error":"Invalid name"}"#
    );
}

#[test]
fn an_import_picks_one_file_of_any_name_and_marks_the_texts_as_pending() {
    let user_data = TempDir::new().unwrap();
    let file = user_data.path().join("notes");
    std::fs::write(&file, "かな かな").unwrap();
    let t = test_app(user_data.path(), Some(file));
    assert!(t.import().starts_with(r#"{"success":true,"data":{"id":"#));
    assert_eq!(
        t.requests(),
        [DialogRequest {
            kind: DialogKind::OpenFile,
            title: "Import UTF-8 Text".to_owned(),
            filters: vec![FileFilter::new("UTF-8 text", &["*"])],
        }]
    );
    assert_ne!(t.app.state::<PendingStore>().pending_generation_of("typing-test-texts"), 0);
    let listed = text(block_on(typing_test_text_store_list(t.stores(), t.texts())));
    assert!(
        listed.contains(r#""name":"notes""#) && listed.ends_with(r#""romajiCapable":true}]}"#),
        "{listed}"
    );
}

#[test]
fn a_same_named_import_is_held_until_confirmed() {
    let user_data = TempDir::new().unwrap();
    let file = user_data.path().join("doc.txt");
    std::fs::write(&file, "one two").unwrap();
    let t = test_app(user_data.path(), Some(file));
    t.import();
    assert_eq!(t.import(), r#"{"success":false,"errorCode":"DUPLICATE_NAME","error":"doc"}"#);
    let confirmed = text(block_on(typing_test_text_store_import_confirm(t.stores(), t.texts())));
    assert!(confirmed.contains(r#""name":"doc""#), "{confirmed}");
    assert_eq!(
        text(block_on(typing_test_text_store_import_confirm(t.stores(), t.texts()))),
        r#"{"success":false,"errorCode":"NOT_FOUND","error":"No pending import to confirm"}"#
    );
}

#[test]
fn a_cancelled_dialog_answers_cancelled() {
    let user_data = TempDir::new().unwrap();
    let t = test_app(user_data.path(), None);
    assert_eq!(t.import(), r#"{"success":false,"errorCode":"IO_ERROR","error":"cancelled"}"#);
}
