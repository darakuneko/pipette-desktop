// SPDX-License-Identifier: GPL-2.0-or-later
//! The Rust half of the IPC contract tests. The invoke fixtures
//! (tests/fixtures/ipc/<domain>.json) record, for a shim member, the command
//! it invokes, the arguments it passes and the response; the shim's tests
//! (src/tauri-shim/__tests__/ipc-fixtures.test.ts) replay them against the
//! shim. Here each entry runs through the app's own command handler
//! (`app_commands` in main.rs) on Tauri's mock runtime, with a new app
//! config in a temp directory and a browser that records what it is asked
//! to open: the command must be registered, take `invokeArgs` as its
//! arguments, and respond with `response`.
//!
//! The app is built with the app's own context, so every call also passes
//! the access control the build generates from capabilities/: the tests
//! below check that it lets the main window's pages call every app command
//! and nothing else.
//!
//! Every file dialog is cancelled, so the file commands answer without
//! touching the disk, and every HTTP request fails as offline.
//!
//! The HID service lists only the virtual keyboard. The virtual keyboard
//! cannot be probed, so behind it sits one scripted hardware keyboard
//! ([`PROBE_KEYBOARD`]) for the probe commands: it answers each report with
//! the report itself, and the first probe handle of a fresh app has id 1.
//!
//! The command names are also exported for the shim (`CommandName` in
//! src/tauri-shim/ipc.ts).

use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use pipette_app_config::AppConfigStore;
use pipette_hid::{HidBackend, HidError, HidHandle, HidService, RawDeviceInfo, Timing, VirtualDeviceMode};
use serde_json::{Value, json};
use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::test::{INVOKE_KEY, MockRuntime, get_ipc_response, mock_builder};
use tauri::webview::InvokeRequest;
use tauri::{App, Manager, WebviewWindow};
use tempfile::TempDir;

use crate::dialog::Dialogs;
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

/// The vendor ID, product ID and serial number of the scripted hardware
/// keyboard.
pub(crate) const PROBE_KEYBOARD: (u16, u16, &str) = (0x1234, 0x5678, "vial:f64c2b3c:probe");

/// Commands that need an open probe handle; their entries run after the
/// scripted keyboard is opened for a probe, as handle 1.
const NEED_PROBE: &[&str] = &["hid_probe_send_receive", "hid_probe_close"];

/// The scripted hardware keyboard: always enumerated, never fails to open.
struct ProbeKeyboard;

impl HidBackend for ProbeKeyboard {
    fn enumerate(&self) -> Result<Vec<RawDeviceInfo>, HidError> {
        let (vendor_id, product_id, serial) = PROBE_KEYBOARD;
        Ok(vec![RawDeviceInfo {
            path: CString::from(c"/dev/hidraw-probe"),
            vendor_id,
            product_id,
            serial_number: Some(serial.into()),
            product: Some("Probe Keyboard".into()),
        }])
    }

    fn open_path(&self, _path: &CString) -> Result<Arc<dyn HidHandle>, HidError> {
        Ok(Arc::new(EchoHandle::default()))
    }
}

/// Answers each packet with its report (the packet without the report ID).
#[derive(Default)]
struct EchoHandle {
    last: Mutex<Vec<u8>>,
}

impl HidHandle for EchoHandle {
    fn write(&self, data: &[u8]) -> Result<usize, HidError> {
        *self.last.lock().unwrap_or_else(PoisonError::into_inner) = data[1..].to_vec();
        Ok(data.len())
    }

    fn read_timeout(&self, buf: &mut [u8], _timeout_ms: i32) -> Result<usize, HidError> {
        let report = std::mem::take(&mut *self.last.lock().unwrap_or_else(PoisonError::into_inner));
        buf[..report.len()].copy_from_slice(&report);
        Ok(report.len())
    }
}

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

/// The page every call comes from unless a test says otherwise: the app's
/// own origin, which WebView2 on Windows serves as `http://tauri.localhost`.
const APP_PAGE: &str =
    if cfg!(windows) { "http://tauri.localhost/tauri.html" } else { "tauri://localhost/tauri.html" };

/// A HID service that lists only the virtual keyboard, with
/// [`PROBE_KEYBOARD`] as its hardware.
pub(crate) fn probe_keyboard_service() -> HidService {
    HidService::with_backend(Box::new(ProbeKeyboard), VirtualDeviceMode::Only, Timing::new(|| 0, |_| {}))
}

/// A fresh app with the app commands, the state they use, `opener` as the
/// browser, file dialogs the user always cancels, `user_data` as its
/// userData directory (the pending sync units restored from it, with no
/// delayed writes, and the stores and the typing analytics on it, the
/// latter with a fixed machine id and an up-to-date cache), a Hub that is
/// offline, a notice source that answers with one notice and sends
/// nothing, and the access control the app's build generates.
fn mock_app(opener: ExternalOpener, user_data: &Path) -> App<MockRuntime> {
    let config: crate::app_config::AppConfig = Arc::new(AppConfigStore::open(user_data));
    let app = mock_builder()
        .manage(Hid(Arc::new(probe_keyboard_service())))
        .manage(config)
        .manage(opener)
        .manage(Dialogs::new(|_| None))
        .manage(crate::UserDataDir(user_data.to_path_buf()))
        .invoke_handler(crate::app_commands())
        .build(tauri::generate_context!(test = true))
        .unwrap();
    crate::store_commands::sync_pending::manage_without_delayed_writes(app.handle(), user_data);
    crate::store_commands::keyboard_data::manage(app.handle(), user_data);
    crate::sync_commands::manage_for_tests(app.handle(), user_data);
    app.manage(pipette_net::Http::new(|_: &str| Err(pipette_net::HttpError::Network("offline".into()))));
    crate::typing_dataset_commands::manage(app.handle(), user_data);
    crate::analytics_commands::mark_cache_fresh(user_data, "machine");
    crate::analytics_commands::manage_with_machine_id(app.handle(), user_data, "machine");
    crate::sync_commands::preflight::manage_for_tests(app.handle());
    crate::sync_commands::execute::manage(app.handle());
    crate::sync_commands::password_change::manage_for_tests(app.handle());
    crate::sync_commands::analytics_remote::manage(app.handle());
    crate::sync_commands::reset::manage(app.handle());
    crate::hub_commands::setup::manage_for_tests(app.handle());
    crate::notification_commands::manage_for_tests(app.handle());
    app
}

/// The main window of `app`, built as the app builds it. The mock runtime
/// does not load pages, so the window's navigation and new-window handlers
/// never run here; navigation.rs tests the rule they apply.
fn main_window(app: &App<MockRuntime>) -> WebviewWindow<MockRuntime> {
    main_window_builder(app).unwrap().build().unwrap()
}

/// The main window of a fresh app whose browser opens nothing, and the
/// userData directory of the app, removed when this is dropped.
struct TestWindow {
    window: WebviewWindow<MockRuntime>,
    _user_data: TempDir,
}

impl std::ops::Deref for TestWindow {
    type Target = WebviewWindow<MockRuntime>;

    fn deref(&self) -> &Self::Target {
        &self.window
    }
}

fn app_window() -> TestWindow {
    window_with(ExternalOpener::new(|_| Ok(())))
}

/// The main window of a fresh app with `opener` as its browser.
fn window_with(opener: ExternalOpener) -> TestWindow {
    let user_data = TempDir::new().unwrap();
    let window = main_window(&mock_app(opener, user_data.path()));
    TestWindow { window, _user_data: user_data }
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
    run_entry(entry, &app_window())
}

fn run_entry(entry: &Entry, window: &WebviewWindow<MockRuntime>) -> Option<String> {
    if NEED_OPEN_DEVICE.contains(&entry.command.as_str()) {
        let (vendor_id, product_id) = VIRTUAL_KEYBOARD;
        let opened =
            invoke(window, "open_device", &json!({ "vendorId": vendor_id, "productId": product_id }));
        if opened != Ok(json!(true)) {
            return Some(format!("opening the virtual keyboard: {opened:?}"));
        }
    }
    if NEED_PROBE.contains(&entry.command.as_str()) {
        let (vendor_id, product_id, serial_number) = PROBE_KEYBOARD;
        let opened = invoke(
            window,
            "hid_probe_open",
            &json!({ "vendorId": vendor_id, "productId": product_id, "serialNumber": serial_number }),
        );
        if opened != Ok(json!(1)) {
            return Some(format!("opening the probe handle: {opened:?}"));
        }
    }
    let expected = expected_response(entry, window);
    match invoke(window, &entry.command, &entry.invoke_args) {
        Ok(response) if response == expected => None,
        Ok(response) => Some(format!("responded {response}, expected {expected}")),
        Err(err) => Some(format!("failed: {err}")),
    }
}

/// The response `entry` must get. `is_always_on_top_supported` answers
/// from the session's environment, so it gets this machine's answer; the
/// fixture records the one of an X11 session without Wayland (the e2e
/// tests' xvfb), which the shim's tests use. `app_config_log_dir` answers
/// under the app's temp userData directory, so it gets that path; the
/// fixture records a Linux one.
fn expected_response(entry: &Entry, window: &WebviewWindow<MockRuntime>) -> Value {
    if entry.command == "is_always_on_top_supported" {
        json!(crate::window_ops::always_on_top::is_supported_here())
    } else if entry.command == "app_config_log_dir" {
        let user_data = &window.state::<crate::UserDataDir>().0;
        json!(crate::log_dir(user_data).to_string_lossy())
    } else {
        entry.response.clone()
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
        ("plugin:updater|check", json!({})),
        // Registered by Tauri itself, but not granted.
        ("plugin:event|emit", json!({ "event": "e", "payload": null })),
    ] {
        let result = invoke(&window, command, &args);
        assert!(rejected_by_acl(&result), "{command}: {result:?}");
    }
}

#[test]
fn other_windows_and_remote_pages_are_rejected() {
    let user_data = TempDir::new().unwrap();
    let app = mock_app(ExternalOpener::new(|_| Ok(())), user_data.path());
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
    let window = window_with(opener);
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
    let window = window_with(opener);
    assert_eq!(
        invoke(&window, "open_external", &json!({ "url": "https://example.com/" })),
        Err(json!("no browser"))
    );
}

#[test]
fn a_store_change_arms_the_flush_and_auto_sync_starts_and_stops_polling() {
    use crate::sync_commands::triggers::{on_auto_sync_changed, triggers};
    use pipette_sync::flush::DEBOUNCE;

    let user_data = TempDir::new().unwrap();
    let app = mock_app(ExternalOpener::new(|_| Ok(())), user_data.path());
    let triggers = triggers(app.handle()).unwrap();
    assert_eq!(triggers.flusher().due_in(), None);

    let stores = app.state::<pipette_keyboard_stores::StoreContext>();
    pipette_keyboard_stores::keyboard_meta_name_if_missing(&stores, Some("0xA1"), Some("Board")).unwrap();
    let due = triggers.flusher().due_in().unwrap();
    assert!(due <= DEBOUNCE && due > DEBOUNCE - std::time::Duration::from_secs(5), "{due:?}");

    on_auto_sync_changed(app.handle(), true);
    assert!(triggers.poller().is_polling());
    on_auto_sync_changed(app.handle(), false);
    assert!(!triggers.poller().is_polling());
    // The quit drops the timer, so nothing runs after the test.
    assert!(triggers.begin_quit());
    assert_eq!(triggers.flusher().due_in(), None);
}
