// SPDX-License-Identifier: GPL-2.0-or-later
//! A mock app for the pack commands' tests: the stores on a temp userData
//! directory, and file dialogs that answer what the test gives and record
//! every request.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pipette_keyboard_stores::StoreContext;
use tauri::ipc::{InvokeResponseBody, IpcResponse, Response};
use tauri::test::MockRuntime;
use tauri::{Manager, State};

use crate::command_error::CommandError;
use crate::dialog::{DialogRequest, Dialogs};

pub(crate) struct TestApp {
    pub app: tauri::App<MockRuntime>,
    requests: Arc<Mutex<Vec<DialogRequest>>>,
}

/// A mock app with the stores on `user_data`, and dialogs that answer
/// `answer` and record every request.
pub(crate) fn test_app(user_data: &Path, answer: Vec<PathBuf>) -> TestApp {
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
    pub fn stores(&self) -> State<'_, StoreContext> {
        self.app.state::<StoreContext>()
    }

    pub fn dialogs(&self) -> State<'_, Dialogs> {
        self.app.state::<Dialogs>()
    }

    pub fn requests(&self) -> Vec<DialogRequest> {
        self.requests.lock().unwrap().clone()
    }
}

/// The JSON text a command answered.
pub(crate) fn text(response: Result<Response, CommandError>) -> String {
    match response.unwrap().body().unwrap() {
        InvokeResponseBody::Json(text) => text,
        InvokeResponseBody::Raw(_) => panic!("not JSON"),
    }
}
