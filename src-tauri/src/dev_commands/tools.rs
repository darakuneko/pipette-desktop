// SPDX-License-Identifier: GPL-2.0-or-later
//! Development tools, compiled only with the dev-tools feature (never in the
//! release profile, see build.rs): the virtual keyboard controller
//! (the Electron build exposes the same operations to its E2E tests as
//! `globalThis.__pipetteVirtualDevice`), a log sink, window
//! screenshots (Linux), and a script hook that runs a local file in the
//! window once the first page has loaded, so the UI can be driven without a
//! WebDriver, and a queue of answers for the file dialogs, so the e2e tests
//! can save and open files without the native dialog.
//!
//! `install` is the only entry point, called through
//! `dev_commands::install_or_passthrough`. The permissions of these commands are
//! generated and granted only in these builds (see build.rs and
//! capabilities/dev/).

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use pipette_hid::ControllerState;
use serde::Serialize;
use tauri::ipc::Invoke;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Builder, Manager, State, Webview, Wry};
use ts_rs::TS;

use crate::command_error::CommandError;
use crate::dialog::{DialogProvider, DialogRequest, Dialogs, SystemDialogs};
use crate::hid_commands::Hid;

include!("../dev_command_names.rs");

/// Path of a JavaScript file evaluated in the window after the first page
/// load.
const DEV_SCRIPT_ENV: &str = "PIPETTE_DEV_SCRIPT";

/// Directory the screenshots are written to.
#[cfg(target_os = "linux")]
const DEV_SHOT_DIR_ENV: &str = "PIPETTE_DEV_SHOT_DIR";

/// Same shape as `VirtualDeviceControllerState` in
/// src/main/virtual-device/index.ts.
#[derive(Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, rename = "VirtualDeviceControllerState")]
pub struct ControllerStateDto {
    open: bool,
    unlocked: bool,
    unlock_in_progress: bool,
    unlock_counter: i32,
}

impl From<ControllerState> for ControllerStateDto {
    fn from(s: ControllerState) -> Self {
        Self {
            open: s.open,
            unlocked: s.unlocked,
            unlock_in_progress: s.unlock_in_progress,
            unlock_counter: s.unlock_counter,
        }
    }
}

/// The unlock countdown length must be a non-negative `i32`: the virtual
/// device decrements the counter from this value, and a negative start
/// could underflow it.
fn unlock_counter_max(n: i64) -> Result<i32, CommandError> {
    i32::try_from(n)
        .ok()
        .filter(|n| *n >= 0)
        .ok_or_else(|| CommandError::new(format!("unlock counter max must be in 0..={}, got {n}", i32::MAX)))
}

#[tauri::command]
pub fn virtual_device_press_key(hid: State<'_, Hid>, row: i32, col: i32) {
    hid.0.virtual_device().press_key(row, col);
}

#[tauri::command]
pub fn virtual_device_release_key(hid: State<'_, Hid>, row: i32, col: i32) {
    hid.0.virtual_device().release_key(row, col);
}

#[tauri::command]
pub fn virtual_device_release_all(hid: State<'_, Hid>) {
    hid.0.virtual_device().release_all();
}

#[tauri::command]
pub fn virtual_device_hold_keys(hid: State<'_, Hid>, pairs: Vec<(i32, i32)>) {
    hid.0.virtual_device().hold_keys(&pairs);
}

#[tauri::command]
pub fn virtual_device_set_unlock_counter_max(hid: State<'_, Hid>, n: i64) -> Result<(), CommandError> {
    hid.0.virtual_device().set_unlock_counter_max(unlock_counter_max(n)?);
    Ok(())
}

#[tauri::command]
pub fn virtual_device_get_state(hid: State<'_, Hid>) -> ControllerStateDto {
    hid.0.virtual_device().get_state().into()
}

#[tauri::command]
pub fn virtual_device_reset(hid: State<'_, Hid>) {
    hid.0.virtual_device().reset();
}

/// Logs a line from the WebView (the log also goes to stderr); WebKitGTK
/// does not forward the console of the page to the terminal.
#[tauri::command]
pub fn dev_log(message: String) {
    log::info!("[webview] {message}");
}

/// Answers for the next file dialogs, in order: the path the user would
/// choose, or `None` for a dialog the user cancels. Each answer is used
/// once.
#[derive(Default)]
pub struct DialogQueue(Mutex<VecDeque<Option<PathBuf>>>);

impl DialogQueue {
    fn push(&self, answer: Option<PathBuf>) {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).push_back(answer);
    }

    fn pop(&self) -> Option<Option<PathBuf>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).pop_front()
    }
}

/// The queue's next answer, or `fallback`'s dialog when the queue is empty,
/// so a build with these tools still shows the native dialogs when nothing
/// is queued.
struct QueuedDialogs<F> {
    queue: Arc<DialogQueue>,
    fallback: F,
}

impl<F: DialogProvider> DialogProvider for QueuedDialogs<F> {
    fn show(&self, request: DialogRequest) -> Option<PathBuf> {
        match self.queue.pop() {
            Some(answer) => {
                log::info!("[dev] answered the file dialog {:?} from the queue: {answer:?}", request.title);
                answer
            }
            None => self.fallback.show(request),
        }
    }
}

/// Manages the file dialogs as the queue of `dev_dialog_respond` in front of
/// the system's.
pub fn manage_queued_dialogs(app: &AppHandle<Wry>, system: SystemDialogs) {
    let queue = Arc::new(DialogQueue::default());
    app.manage(Dialogs::new(QueuedDialogs { queue: Arc::clone(&queue), fallback: system }));
    app.manage(queue);
}

/// Queues the answer of the next file dialog: `path`, or a cancel for null.
#[tauri::command]
pub fn dev_dialog_respond(queue: State<'_, Arc<DialogQueue>>, path: Option<PathBuf>) {
    queue.push(path);
}

/// `<PIPETTE_DEV_SHOT_DIR>/<name>.png`. The name is limited to lowercase
/// letters, digits and dashes so it cannot leave the directory.
#[cfg(target_os = "linux")]
fn shot_path(name: &str) -> Result<std::path::PathBuf, CommandError> {
    let valid = !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !valid {
        return Err(CommandError::new(format!("invalid screenshot name: {name:?}")));
    }
    let dir = std::env::var_os(DEV_SHOT_DIR_ENV)
        .ok_or_else(|| CommandError::new(format!("{DEV_SHOT_DIR_ENV} is not set")))?;
    Ok(std::path::PathBuf::from(dir).join(format!("{name}.png")))
}

#[cfg(target_os = "linux")]
fn write_png(
    snapshot: Result<cairo::Surface, webkit2gtk::Error>,
    path: &std::path::Path,
) -> Result<(), CommandError> {
    let surface = snapshot?;
    let image = cairo::ImageSurface::try_from(surface)
        .map_err(|_| CommandError::new("snapshot is not an image surface"))?;
    let mut file = std::fs::File::create(path)?;
    Ok(image.write_to_png(&mut file)?)
}

/// Saves the visible part of the page as rendered by WebKit. Capturing the
/// window from outside (an X11 grab on Xwayland, for one) can come back
/// blank, so the snapshot is taken from WebKit itself.
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn dev_screenshot(window: tauri::WebviewWindow, name: String) -> Result<(), CommandError> {
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    let path = shot_path(&name)?;
    let (done, result) = std::sync::mpsc::channel();
    window.with_webview(move |platform| {
        platform.inner().snapshot(
            SnapshotRegion::Visible,
            SnapshotOptions::NONE,
            None::<&webkit2gtk::gio::Cancellable>,
            move |snapshot| {
                // The receiver only goes away if the command was dropped.
                let _ = done.send(write_png(snapshot, &path));
            },
        );
    })?;
    tauri::async_runtime::spawn_blocking(move || result.recv())
        .await?
        .map_err(|_| CommandError::new("the snapshot was cancelled"))?
}

/// Defines the global that tells the shim (src/tauri-shim/context-menu.ts)
/// it runs in a build with these tools, which keeps the webview's own
/// context menu and its Inspect Element.
const DEV_TOOLS_MARK_SCRIPT: &str =
    "Object.defineProperty(window, '__PIPETTE_DEV_TOOLS__', { value: true });";

/// Adds the development tools to `builder`: the mark of
/// `DEV_TOOLS_MARK_SCRIPT`, a page load hook that runs `on_page_load`, the
/// app's, and then the script hook, and an invoke handler that routes the
/// development commands to their handler and everything else to `app`, the
/// handler of the app commands.
pub fn install<F, P>(builder: Builder<Wry>, app: F, on_page_load: P) -> Builder<Wry>
where
    F: Fn(Invoke<Wry>) -> bool + Send + Sync + 'static,
    P: Fn(&Webview<Wry>, &PageLoadPayload<'_>) + Send + Sync + 'static,
{
    let dev = dev_commands();
    let mark =
        tauri::plugin::Builder::<Wry>::new("pipette-dev-tools").js_init_script(DEV_TOOLS_MARK_SCRIPT).build();
    builder
        .plugin(mark)
        .on_page_load(move |webview, payload| {
            on_page_load(webview, payload);
            run_dev_script(webview, payload);
        })
        .invoke_handler(
            move |invoke: Invoke<Wry>| {
                if is_dev_command(invoke.message.command()) { dev(invoke) } else { app(invoke) }
            },
        )
}

fn dev_commands() -> impl Fn(Invoke<Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        virtual_device_press_key,
        virtual_device_release_key,
        virtual_device_release_all,
        virtual_device_hold_keys,
        virtual_device_set_unlock_counter_max,
        virtual_device_get_state,
        virtual_device_reset,
        dev_log,
        dev_dialog_respond,
        #[cfg(target_os = "linux")]
        dev_screenshot,
    ]
}

fn is_dev_command(command: &str) -> bool {
    DEV_COMMANDS.contains(&command) || (cfg!(target_os = "linux") && LINUX_DEV_COMMANDS.contains(&command))
}

/// Whether the dev script has been evaluated in this process.
static DEV_SCRIPT_RAN: AtomicBool = AtomicBool::new(false);

/// Evaluates the file named by `PIPETTE_DEV_SCRIPT`, if set, once the first
/// page has loaded, and only that once: a reload does not run it again. The
/// script runs as the page itself and reaches the commands above through
/// `window.__TAURI_INTERNALS__.invoke`.
fn run_dev_script(webview: &Webview<Wry>, payload: &PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let Some(path) = std::env::var_os(DEV_SCRIPT_ENV) else {
        return;
    };
    if DEV_SCRIPT_RAN.swap(true, Ordering::SeqCst) {
        return;
    }
    let path = path.to_string_lossy();
    log::warn!("[dev] {DEV_SCRIPT_ENV} is set; evaluating {path} in the window");
    match std::fs::read_to_string(&*path) {
        Ok(script) => {
            if let Err(err) = webview.eval(script) {
                log::error!("[dev] failed to evaluate {path}: {err}");
            }
        }
        Err(err) => log::error!("[dev] failed to read {path}: {err}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    include!("../app_command_names.rs");

    #[test]
    fn unlock_counter_max_accepts_non_negative_i32_values() {
        assert_eq!(unlock_counter_max(0), Ok(0));
        assert_eq!(unlock_counter_max(3), Ok(3));
        assert_eq!(unlock_counter_max(i64::from(i32::MAX)), Ok(i32::MAX));
    }

    #[test]
    fn unlock_counter_max_rejects_negative_and_out_of_range_values() {
        for bad in [-1, i64::from(i32::MIN), i64::from(i32::MAX) + 1] {
            assert!(unlock_counter_max(bad).is_err(), "{bad} was accepted");
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn shot_names_stay_inside_the_directory() {
        for bad in ["", "../x", "a/b", "A", "x.png", "a b"] {
            let err = super::shot_path(bad).unwrap_err();
            assert!(err.to_string().starts_with("invalid screenshot name"), "{bad}: {err}");
        }
    }

    #[test]
    fn routes_exactly_the_development_commands_to_their_handler() {
        for command in DEV_COMMANDS {
            assert!(is_dev_command(command), "{command}");
        }
        assert_eq!(is_dev_command("dev_screenshot"), cfg!(target_os = "linux"));
        for command in APP_COMMANDS.iter().chain(&["unknown"]) {
            assert!(!is_dev_command(command), "{command}");
        }
    }

    #[test]
    fn queued_answers_go_to_the_next_dialogs_in_order_then_the_fallback_answers() {
        let queue = Arc::new(DialogQueue::default());
        let fallback_titles = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&fallback_titles);
        let dialogs = QueuedDialogs {
            queue: Arc::clone(&queue),
            fallback: move |request: DialogRequest| {
                record.lock().unwrap().push(request.title);
                Some(PathBuf::from("/from/the/fallback"))
            },
        };
        let request = |title: &str| DialogRequest {
            kind: crate::dialog::DialogKind::OpenFile,
            title: title.to_owned(),
            filters: Vec::new(),
        };
        queue.push(Some(PathBuf::from("/tmp/a.vil")));
        queue.push(None);

        assert_eq!(dialogs.show(request("first")), Some(PathBuf::from("/tmp/a.vil")));
        assert_eq!(dialogs.show(request("second")), None);
        assert_eq!(dialogs.show(request("third")), Some(PathBuf::from("/from/the/fallback")));
        assert_eq!(*fallback_titles.lock().unwrap(), ["third"]);
    }

    #[test]
    fn controller_state_serializes_in_the_e2e_shape() {
        let state =
            ControllerState { open: true, unlocked: false, unlock_in_progress: true, unlock_counter: 3 };
        assert_eq!(
            serde_json::to_value(ControllerStateDto::from(state)).unwrap(),
            serde_json::json!({ "open": true, "unlocked": false, "unlockInProgress": true, "unlockCounter": 3 })
        );
    }
}
