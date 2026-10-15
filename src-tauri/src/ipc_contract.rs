// SPDX-License-Identifier: GPL-2.0-or-later
//! The Rust half of the IPC contract tests. The invoke fixtures
//! (tests/fixtures/ipc/<domain>.json) record, for a shim member, the command
//! it invokes, the arguments it passes and the response; the shim's tests
//! (src/tauri-shim/__tests__/ipc-fixtures.test.ts) replay them against the
//! shim. Here each entry runs through the app's own command handler
//! (`app_commands` in main.rs) on Tauri's mock runtime, with the virtual
//! keyboard as the only HID device and a browser that records what it is
//! asked to open: the command must be registered, take `invokeArgs` as its
//! arguments, and respond with `response`.
//!
//! The app is built with the app's own context, so every call also passes
//! the access control the build generates from capabilities/: the tests
//! below check that it lets the main window's pages call every app command
//! and nothing else.
//!
//! The command names are also exported for the shim (`CommandName` in
//! src/tauri-shim/ipc.ts).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use pipette_hid::{HidService, VirtualDeviceMode};
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{App, WebviewWindow};

use crate::hid_commands::Hid;
use crate::main_window::{MAIN_WINDOW, main_window_builder};
use crate::shell::ExternalOpener;

include!("app_command_names.rs");

/// One recorded call; `member` and `args` are the shim side's.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Entry {
    member: String,
    #[serde(rename = "args")]
    _args: Vec<Value>,
    command: String,
    invoke_args: Value,
    response: Value,
}

/// The vendor and product ID of the virtual keyboard.
const VIRTUAL_KEYBOARD: (u16, u16) = (0x7a79, 0xf063);

/// Commands that need an open device; their entries run after the virtual
/// keyboard is opened.
const NEED_OPEN_DEVICE: &[&str] = &["send_receive", "send"];

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ipc")
}

fn entries() -> Vec<Entry> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir(fixture_dir())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
        .collect();
    paths.sort();
    paths
        .iter()
        .flat_map(|path| {
            let text = std::fs::read_to_string(path).unwrap();
            serde_json::from_str::<Vec<Entry>>(&text)
                .unwrap_or_else(|err| panic!("{}: {err}", path.display()))
        })
        .collect()
}

/// The page every call comes from unless a test says otherwise.
const APP_PAGE: &str = "tauri://localhost/tauri.html";

/// A fresh app with the app commands, the state they use, `opener` as the
/// browser, and the access control the app's build generates.
fn mock_app(opener: ExternalOpener) -> App<MockRuntime> {
    mock_builder()
        .manage(Hid(Arc::new(HidService::new(VirtualDeviceMode::Only))))
        .manage(opener)
        .invoke_handler(crate::app_commands())
        .build(tauri::generate_context!(test = true))
        .unwrap()
}

/// The main window of `app`, built as the app builds it. The mock runtime
/// does not load pages, so the window's navigation and new-window handlers
/// never run here; navigation.rs tests the rule they apply.
fn main_window(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    main_window_builder(app).unwrap().build().unwrap()
}

/// The main window of a fresh app whose browser opens nothing.
fn app_window() -> WebviewWindow<MockRuntime> {
    main_window(&mock_app(ExternalOpener::new(|_| Ok(()))))
}

/// The command's response, or its error (a deserialization failure for
/// arguments that do not fit, "... not allowed ..." for a command the
/// capabilities do not grant to `page` in this window).
fn invoke_from(
    window: &WebviewWindow<MockRuntime>,
    page: &str,
    command: &str,
    args: &Value,
) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: page.parse().unwrap(),
        body: InvokeBody::Json(args.clone()),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(window, request).map(|body| body.deserialize::<Value>().unwrap())
}

fn invoke(window: &WebviewWindow<MockRuntime>, command: &str, args: &Value) -> Result<Value, Value> {
    invoke_from(window, APP_PAGE, command, args)
}

fn rejected_by_acl(result: &Result<Value, Value>) -> bool {
    matches!(result, Err(Value::String(message)) if message.contains("not allowed"))
}

/// Why `entry` does not match the command, if it does not.
fn mismatch(entry: &Entry) -> Option<String> {
    if !APP_COMMANDS.contains(&entry.command.as_str()) {
        return Some("not in APP_COMMANDS".into());
    }
    let window = app_window();
    if NEED_OPEN_DEVICE.contains(&entry.command.as_str()) {
        let (vendor_id, product_id) = VIRTUAL_KEYBOARD;
        let opened =
            invoke(&window, "open_device", &json!({ "vendorId": vendor_id, "productId": product_id }));
        if opened != Ok(json!(true)) {
            return Some(format!("opening the virtual keyboard: {opened:?}"));
        }
    }
    match invoke(&window, &entry.command, &entry.invoke_args) {
        Ok(response) if response == entry.response => None,
        Ok(response) => Some(format!("responded {response}, the fixture records {}", entry.response)),
        Err(err) => Some(format!("failed: {err}")),
    }
}

#[test]
fn fixtures_match_the_commands() {
    let failures: Vec<String> = entries()
        .iter()
        .filter_map(|entry| mismatch(entry).map(|why| format!("{} ({}): {why}", entry.member, entry.command)))
        .collect();
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

#[test]
fn every_app_command_has_a_fixture() {
    let entries = entries();
    let missing: Vec<&str> = APP_COMMANDS
        .iter()
        .copied()
        .filter(|command| !entries.iter().any(|entry| entry.command == *command))
        .collect();
    assert!(missing.is_empty(), "no fixture for {missing:?}");
}

/// Written next to the ts-rs declarations, so the same freshness check
/// covers it.
#[test]
fn export_app_command_names() {
    let path = Path::new(env!("TS_RS_EXPORT_DIR")).join("app-command-names.ts");
    let text = format!(
        "// This file was generated by the export tests of src-tauri (src-tauri/src/ipc_contract.rs). \
         Do not edit this file manually.\n\n\
         /** APP_COMMANDS of src-tauri/src/app_command_names.rs. */\n\
         export const APP_COMMANDS = {} as const;\n",
        serde_json::to_string(APP_COMMANDS).unwrap()
    );
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, text).unwrap();
}

#[test]
fn the_main_window_may_call_every_app_command() {
    let window = app_window();
    let rejected: Vec<&str> = APP_COMMANDS
        .iter()
        .copied()
        .filter(|command| rejected_by_acl(&invoke(&window, command, &json!({}))))
        .collect();
    assert!(rejected.is_empty(), "rejected: {rejected:?}");
}

#[test]
fn the_main_window_is_the_one_the_capabilities_name() {
    assert_eq!(app_window().label(), MAIN_WINDOW);
}

/// The shim's `subscribe` (src/tauri-shim/ipc.ts) listens through the event
/// plugin.
#[test]
fn the_main_window_may_listen_to_events() {
    let window = app_window();
    let target = json!({ "kind": "Any" });
    let listened =
        invoke(&window, "plugin:event|listen", &json!({ "event": "e", "target": target, "handler": 1 }));
    let Ok(Value::Number(event_id)) = listened else { panic!("listen: {listened:?}") };
    let unlistened = invoke(&window, "plugin:event|unlisten", &json!({ "event": "e", "eventId": event_id }));
    assert_eq!(unlistened, Ok(Value::Null));
}

#[test]
fn commands_the_capabilities_do_not_grant_are_rejected() {
    let window = app_window();
    for (command, args) in [
        ("no_such_command", json!({})),
        ("plugin:opener|open_url", json!({ "url": "https://example.com/" })),
        // Registered by Tauri itself, but not granted.
        ("plugin:event|emit", json!({ "event": "e", "payload": null })),
    ] {
        let result = invoke(&window, command, &args);
        assert!(rejected_by_acl(&result), "{command}: {result:?}");
    }
}

#[test]
fn other_windows_and_remote_pages_are_rejected() {
    let app = mock_app(ExternalOpener::new(|_| Ok(())));
    let main = main_window(&app);
    let other = tauri::WebviewWindowBuilder::new(&app, "other", Default::default()).build().unwrap();
    assert!(rejected_by_acl(&invoke(&other, "list_devices", &json!({}))));
    for page in ["https://example.com/", "http://tauri.localhost.example.com/tauri.html"] {
        let result = invoke_from(&main, page, "list_devices", &json!({}));
        assert!(rejected_by_acl(&result), "{page}: {result:?}");
    }
}

#[test]
fn open_external_hands_only_web_urls_to_the_browser() {
    let opened = Arc::new(Mutex::new(Vec::<String>::new()));
    let record = Arc::clone(&opened);
    let opener = ExternalOpener::new(move |url| {
        record.lock().unwrap().push(url.to_owned());
        Ok(())
    });
    let window = main_window(&mock_app(opener));
    let open = |url: &str| invoke(&window, "open_external", &json!({ "url": url }));

    assert_eq!(open("HTTPS://Example.com"), Ok(Value::Null));
    assert_eq!(open("file:///etc/passwd"), Err(json!("Invalid URL scheme")));
    assert_eq!(open("javascript:alert(1)"), Err(json!("Invalid URL scheme")));
    assert_eq!(open("example.com"), Err(json!("Invalid URL")));
    assert_eq!(*opened.lock().unwrap(), ["https://example.com/"]);
}

#[test]
fn open_external_reports_a_browser_that_fails_to_start() {
    let opener = ExternalOpener::new(|_| Err(std::io::Error::other("no browser").into()));
    let window = main_window(&mock_app(opener));
    assert_eq!(
        invoke(&window, "open_external", &json!({ "url": "https://example.com/" })),
        Err(json!("no browser"))
    );
}
