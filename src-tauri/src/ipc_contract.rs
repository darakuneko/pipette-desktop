// SPDX-License-Identifier: GPL-2.0-or-later
//! The Rust half of the IPC contract tests. The invoke fixtures
//! (tests/fixtures/ipc/<domain>.json) record, for a shim member, the command
//! it invokes, the arguments it passes and the response; the shim's tests
//! (src/tauri-shim/__tests__/ipc-fixtures.test.ts) replay them against the
//! shim. Here each entry runs through the app's own command handler
//! (`app_commands` in main.rs) on Tauri's mock runtime, with the virtual
//! keyboard as the only HID device: the command must be registered, take
//! `invokeArgs` as its arguments, and respond with `response`.
//!
//! The command names are also exported for the shim (`CommandName` in
//! src/tauri-shim/ipc.ts).

use std::path::{Path, PathBuf};
use std::sync::Arc;

use pipette_hid::{HidService, VirtualDeviceMode};
use serde_json::{Value, json};
use tauri::WebviewWindow;
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder, mock_context, noop_assets};
use tauri::webview::InvokeRequest;

use crate::hid_commands::Hid;

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

/// A fresh app with the app commands and the state they use, and its window.
fn app_window() -> WebviewWindow<MockRuntime> {
    let app = mock_builder()
        .manage(Hid(Arc::new(HidService::new(VirtualDeviceMode::Only))))
        .invoke_handler(crate::app_commands())
        .build(mock_context(noop_assets()))
        .unwrap();
    tauri::WebviewWindowBuilder::new(&app, "main", Default::default()).build().unwrap()
}

/// The command's response, or its error (a deserialization failure for
/// arguments that do not fit, "command ... not found" for one that is not
/// registered).
fn invoke(window: &WebviewWindow<MockRuntime>, command: &str, args: &Value) -> Result<Value, Value> {
    let request = InvokeRequest {
        cmd: command.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "tauri://localhost".parse().unwrap(),
        body: InvokeBody::Json(args.clone()),
        headers: Default::default(),
        invoke_key: INVOKE_KEY.to_string(),
    };
    get_ipc_response(window, request).map(|body| body.deserialize::<Value>().unwrap())
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
