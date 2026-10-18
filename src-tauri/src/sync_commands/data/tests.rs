// SPDX-License-Identifier: GPL-2.0-or-later
//! The Local Data commands on a mock app with scripted dialogs, replaying
//! the handlers' recording (crates/pipette-sync/tests/fixtures/
//! ts_local_data.json): the dialogs asked, the file written, the answer
//! and the units reported for sync. The engine's outcomes and trees are
//! checked by crates/pipette-sync/tests/ts_local_data.rs.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pipette_entry_store::{FixedClock, WriteLocks};
use pipette_js_json::{Value, parse, stringify};
use pipette_sync_pending::PendingStore;
use tauri::Manager;
use tauri::async_runtime::block_on;
use tauri::test::MockRuntime;
use tempfile::TempDir;

use super::*;

fn fixture() -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("crates/pipette-sync/tests/fixtures/ts_local_data.json");
    parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn get<'a>(value: &'a Value, key: &str) -> &'a Value {
    value.as_object().and_then(|o| o.get(key)).unwrap_or_else(|| panic!("no {key}"))
}

fn list(value: &Value) -> &[Value] {
    match value {
        Value::Array(items) => items,
        _ => panic!("not a list"),
    }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap()
}

fn write_tree(root: &Path, tree: &Value) {
    for (path, content) in tree.as_object().unwrap().iter() {
        let target = root.join(path.to_string_lossy().trim_end_matches('/'));
        match content.as_str() {
            None => std::fs::create_dir_all(&target).unwrap(),
            Some(content) => {
                std::fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::fs::write(&target, content).unwrap();
            }
        }
    }
}

/// A mock app with the stores on `user_data` at the fixture's time, and
/// dialogs that answer `answer` and record every request.
struct TestApp {
    app: tauri::App<MockRuntime>,
    requests: Arc<Mutex<Vec<DialogRequest>>>,
}

fn test_app(user_data: &Path, now: i64, answer: Option<PathBuf>) -> TestApp {
    let app = tauri::test::mock_app();
    crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data);
    let pending = app.state::<PendingStore>().inner().clone();
    app.manage(StoreContext::new(
        user_data,
        Arc::new(FixedClock::new(now)),
        Arc::new(WriteLocks::new()),
        Arc::new(move |unit: &str| pending.notify_change(unit)),
    ));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&requests);
    app.manage(Dialogs::new(move |request| {
        record.lock().unwrap().push(request);
        answer.clone()
    }));
    TestApp { app, requests }
}

impl TestApp {
    fn requests(&self) -> Vec<DialogRequest> {
        self.requests.lock().unwrap().clone()
    }

    fn pending(&self) -> Vec<String> {
        let pending = self.app.state::<PendingStore>();
        pending.snapshot_generations().keys().map(|unit| unit.to_string_lossy().into_owned()).collect()
    }
}

fn now(fixture: &Value) -> i64 {
    match get(fixture, "now") {
        #[allow(clippy::cast_possible_truncation)]
        Value::Number(n) => *n as i64,
        _ => panic!("no time"),
    }
}

fn json_only() -> Vec<FileFilter> {
    vec![FileFilter::new("JSON", &["json"])]
}

#[test]
fn exports_as_the_handler_does() {
    let fixture = fixture();
    let now = now(&fixture);
    for scenario in list(get(&fixture, "exports")) {
        let name = text(get(scenario, "name"));
        let user_data = TempDir::new().unwrap();
        write_tree(user_data.path(), get(scenario, "tree"));
        let out = user_data.path().join("exported.json");
        let cancel = get(scenario, "cancel") == &Value::Bool(true);
        let t = test_app(user_data.path(), now, (!cancel).then(|| out.clone()));
        let result = block_on(export_local_data(t.app.state(), t.app.state())).unwrap();
        assert_eq!(serde_json::to_value(result).unwrap(), serde_json::json!({ "success": true }), "{name}");
        let dialog = get(scenario, "dialog");
        assert_eq!(
            t.requests(),
            [DialogRequest {
                kind: DialogKind::SaveFile { default_name: text(get(dialog, "defaultPath")).to_owned() },
                title: String::new(),
                filters: json_only(),
            }],
            "{name}"
        );
        assert_eq!(stringify(get(dialog, "filters")), r#"[{"name":"JSON","extensions":["json"]}]"#);
        let written = std::fs::read_to_string(&out).ok();
        assert_eq!(written.as_deref(), get(scenario, "written").as_str(), "{name}: file");
        assert!(t.pending().is_empty(), "{name}: an export changes no unit");
    }
}

#[test]
fn imports_as_the_handler_does() {
    let fixture = fixture();
    let now = now(&fixture);
    for scenario in list(get(&fixture, "imports")) {
        let name = text(get(scenario, "name"));
        // The read-only directories are the engine test's (Unix permissions).
        if !list(get(scenario, "readOnly")).is_empty() {
            continue;
        }
        let user_data = TempDir::new().unwrap();
        write_tree(user_data.path(), get(scenario, "tree"));
        let picked = user_data.path().join("picked.json");
        let file_text = get(scenario, "text").as_str();
        if let Some(file_text) = file_text {
            std::fs::write(&picked, file_text).unwrap();
        }
        let t = test_app(user_data.path(), now, file_text.map(|_| picked.clone()));
        let result =
            serde_json::to_value(block_on(import_local_data(t.app.state(), t.app.state())).unwrap()).unwrap();
        assert_eq!(
            t.requests(),
            [DialogRequest { kind: DialogKind::OpenFile, title: String::new(), filters: json_only() }],
            "{name}"
        );
        let expected = get(scenario, "result");
        assert_eq!(
            result["success"],
            serde_json::json!(get(expected, "success") == &Value::Bool(true)),
            "{name}"
        );
        if result["success"] == serde_json::json!(true) {
            let expected: serde_json::Value = serde_json::from_str(&stringify(expected)).unwrap();
            assert_eq!(result, expected, "{name}: answer");
        } else {
            let error = get(expected, "error");
            assert!(result["error"].is_string(), "{name}: {result}");
            if !matches!(text(get(error, "kind")), "os" | "syntax" | "rollback") {
                let message = result["error"]
                    .as_str()
                    .unwrap()
                    .replace(&user_data.path().display().to_string(), "<userData>")
                    // Windows joins the path with `\`, the recording on Linux with `/`.
                    .replace(std::path::MAIN_SEPARATOR_STR, "/");
                assert_eq!(message, text(get(error, "message")), "{name}: message");
            }
        }
        let notified: Vec<String> =
            list(get(scenario, "notified")).iter().map(|u| text(u).to_owned()).collect();
        assert_eq!(t.pending(), notified, "{name}: units reported for sync");
    }
}
