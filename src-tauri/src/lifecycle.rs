// SPDX-License-Identifier: GPL-2.0-or-later
//! Window and app behavior: closing the window into the tray (src/tray.rs),
//! a launch of the app while it runs, and the quit sequence every exit path
//! goes through (src/shutdown.rs).
//!
//! Closing the last window does not end the app on macOS, nor anywhere while
//! the tray is active, as the 'window-all-closed' handler of
//! src/main/index.ts decides; a launch of the app or a click on its Dock icon
//! then opens the window again.
//!
//! Exit paths and how each reaches the quit sequence:
//! - the tray's Quit item and SIGTERM / SIGINT call `AppHandle::exit`, which
//!   raises `RunEvent::ExitRequested` with a code;
//! - closing the last window when the app does not keep running raises
//!   `RunEvent::ExitRequested` without one;
//! - quitting from the macOS Dock, logging out or shutting down on macOS,
//!   and signing out or shutting down on Windows raise no exit request: the
//!   event loop ends (Cocoa's `applicationWillTerminate`, Windows'
//!   `WM_ENDSESSION`), raising `RunEvent::Exit`, and the process ends once
//!   that event is handled. That event counts as an exit request that cannot
//!   be stopped, so the sequence runs there to its end or its deadline,
//!   holding the event loop. The system may end the process before that, so
//!   the pending marker is written first, as an interrupted quit, and the
//!   sequence's own update replaces or removes it when it gets that far.
//!
//! The first request is stopped and starts the sequence. A request while it
//! runs (the tray's Quit again, the window closed, a second signal) ends the
//! app at once: it writes the pending marker naming the running phase,
//! waiting at most `MARKER_TIMEOUT` (src/shutdown.rs), and lets the exit
//! through; the sequence then leaves the marker alone. A request after the
//! sequence has started its own marker update waits for that update instead,
//! at most `MARKER_TIMEOUT`, and writes nothing. The exit the sequence
//! requests when it ends goes through.
//!
//! Every exit that goes through saves the main window's state first, as the
//! Electron window's close handler does when the app quits; closing the
//! window saves it too.
//!
//! SIGKILL cannot be caught, and this build has no menu (the Electron build
//! sets none either), so no keyboard shortcut quits it.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use pipette_hid::HidService;
use pipette_sync_pending::PendingStore;
use pipette_typing_analytics::{Recorder, SyncRuntime};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{App, AppHandle, Manager, RunEvent, Runtime, State, Webview, Window, WindowEvent, Wry};

use crate::UserDataDir;
use crate::analytics_commands;
use crate::app_config::AppConfig;
use crate::hid_commands::Hid;
use crate::main_window::{self, MAIN_WINDOW};
use crate::shutdown::{
    ExitDecision, MARKER_TIMEOUT, QUIT_DEADLINE, QuitGuard, QuitOutcome, QuitPhase, record_interruption,
    run_quit_sequence,
};
use crate::store_commands::sync_pending::persist_after_quit;
use crate::sync_commands::triggers::{SyncTriggers, triggers};
use crate::tray;

/// Builds with debug assertions: how many milliseconds the stub of the
/// [`DEV_DELAYED_PHASE`] phase takes, to run the quit sequence into its
/// deadline. The other phases take no time.
#[cfg(debug_assertions)]
const DEV_QUIT_DELAY_MS_ENV: &str = "PIPETTE_DEV_QUIT_DELAY_MS";

/// The passwordChange phase, which stops a running sync password change.
const PASSWORD_CHANGE_PHASE: usize = 0;

/// The preSyncFinalizers phase, which writes the typing analytics.
const PRE_SYNC_FINALIZERS_PHASE: usize = 1;

/// The inFlightSync phase, which waits for the sync pass holding the lock.
const IN_FLIGHT_SYNC_PHASE: usize = 2;

/// The flushPending phase, which sends the pending sync units.
const FLUSH_PENDING_PHASE: usize = 3;

/// The phase `PIPETTE_DEV_QUIT_DELAY_MS` delays: flushPending.
const DEV_DELAYED_PHASE: usize = FLUSH_PENDING_PHASE;

/// The phases of the before-quit handler in src/main/sync/sync-flush.ts, in
/// its order. extraFinalizers has nothing to run in this build and only
/// waits for its configured time.
const QUIT_PHASES: [&str; 5] =
    ["passwordChange", "preSyncFinalizers", "inFlightSync", "flushPending", "extraFinalizers"];

/// The quit guard, shared by the window and exit handlers and the handling
/// of a second launch.
#[derive(Default)]
pub struct Lifecycle {
    quit: QuitGuard,
    /// Whether an exit request has gone through, having waited for the
    /// sequence's marker update already.
    exit_let_through: AtomicBool,
}

/// The shared lifecycle state; `None` before setup has run.
fn lifecycle_state<R: Runtime, M: Manager<R>>(manager: &M) -> Option<State<'_, Arc<Lifecycle>>> {
    manager.try_state::<Arc<Lifecycle>>()
}

/// Manages the quit guard and starts listening for the termination signals.
/// Called from the app's setup hook.
pub fn setup(app: &mut App<Wry>) {
    app.manage(Arc::new(Lifecycle::default()));
    #[cfg(unix)]
    listen_for_termination(app.handle().clone());
}

/// Restores, shows and focuses the main window.
pub fn show_main_window(app: &AppHandle<Wry>) {
    if let Some(window) = main_window::main_window(app) {
        main_window::reveal(&window);
    }
}

/// Shows the main window, or opens it again when the last window was
/// closed, as `revealApp` of src/main/index.ts does for a launch of the app
/// while it runs and for a click on its Dock icon. The window is opened on
/// the main thread.
fn reveal_app(app: &AppHandle<Wry>) {
    if main_window::main_window(app).is_some() {
        return show_main_window(app);
    }
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        if main_window::main_window(&handle).is_some() {
            return show_main_window(&handle);
        }
        if let Err(err) = main_window::open_main_window(&handle, &handle.state::<AppConfig>()) {
            log::error!("[app] failed to open the main window again: {err}");
        }
    });
    if let Err(err) = result {
        log::error!("[app] failed to hand opening the main window over to the main thread: {err}");
    }
}

/// What a launch of another instance did to this one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SecondLaunch {
    Revealed,
    /// Setup has not run yet: the startup is about to open the window anyway,
    /// as the Electron build ignores a relaunch before 'ready'.
    IgnoredWhileStarting,
    /// The quit sequence has started; showing the window would not stop it.
    IgnoredWhileQuitting,
}

/// Called by the single-instance plugin when the app is launched again while
/// this instance runs: the other process exits with 0, and this one shows
/// its main window, as the 'second-instance' handler of src/main/index.ts
/// does. Runs on the plugin's D-Bus thread on Linux.
pub fn on_second_launch(app: &AppHandle<Wry>) {
    let outcome = respond_to_second_launch(app, reveal_app);
    log::info!("[app] the app was launched again: {outcome:?}");
}

/// A click on the Dock icon of the running app (macOS), handled as a launch
/// of the app is: the 'activate' handler of src/main/index.ts runs the same
/// `revealApp`.
#[cfg(target_os = "macos")]
fn on_reopen(app: &AppHandle<Wry>) {
    let outcome = respond_to_second_launch(app, reveal_app);
    log::info!("[app] the Dock icon was clicked: {outcome:?}");
}

/// Whether an exit request leaves the app running: one raised by the last
/// window closing (no `code`), before any quit, on macOS or while the tray
/// is active. The 'window-all-closed' handler of src/main/index.ts quits
/// only on other systems with no tray.
fn keeps_running_without_windows(code: Option<i32>, quitting: bool, macos: bool, tray_active: bool) -> bool {
    code.is_none() && !quitting && (macos || tray_active)
}

fn respond_to_second_launch<R: Runtime>(
    app: &AppHandle<R>,
    reveal: impl FnOnce(&AppHandle<R>),
) -> SecondLaunch {
    let Some(lifecycle) = lifecycle_state(app) else {
        return SecondLaunch::IgnoredWhileStarting;
    };
    if lifecycle.quit.is_quitting() {
        return SecondLaunch::IgnoredWhileQuitting;
    }
    reveal(app);
    SecondLaunch::Revealed
}

/// Whether the quit sequence has started; false before setup has run.
pub fn is_quitting<R: Runtime>(app: &AppHandle<R>) -> bool {
    lifecycle_state(app).is_some_and(|lifecycle| lifecycle.quit.is_quitting())
}

/// Starts quitting as an exit request does, without the quit sequence.
#[cfg(test)]
pub fn start_quitting_for_tests<R: Runtime>(app: &AppHandle<R>) {
    let lifecycle = Arc::new(Lifecycle::default());
    lifecycle.quit.on_exit_requested();
    app.manage(lifecycle);
}

/// Saves the window state when the window is asked to close, then hides
/// the window instead of closing it while the tray is active and no exit
/// has been requested. The other window events go to
/// `window_ops::on_window_event` (src/window_ops/mod.rs).
pub fn on_window_event(window: &Window<Wry>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        main_window::save_window_state(window, &window.state::<AppConfig>());
        let hide = tray::is_tray_active(window)
            && lifecycle_state(window).is_some_and(|lifecycle| !lifecycle.quit.is_quitting());
        if hide {
            api.prevent_close();
            main_window::conceal(window);
        }
    }
}

/// Closes the HID probe handle when the main window starts loading a page.
/// The renderer closes its probe handle when the probe ends, but a reload or
/// navigation in the middle of a probe drops that step with the old page;
/// the new page has no probe running, so any open handle is left over.
pub fn on_page_load(webview: &Webview<Wry>, payload: &PageLoadPayload<'_>) {
    if let Some(hid) = webview.try_state::<Hid>() {
        close_probe_on_page_load(&hid.0, webview.label(), payload.event());
    }
}

fn close_probe_on_page_load(hid: &HidService, label: &str, event: PageLoadEvent) {
    if label == MAIN_WINDOW && event == PageLoadEvent::Started {
        hid.close_probe();
    }
}

/// Routes every exit request through the quit guard, and a click on the
/// Dock icon to [`reveal_app`].
pub fn on_run_event(app: &AppHandle<Wry>, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { code, api, .. } => {
            let macos = cfg!(target_os = "macos");
            if keeps_running_without_windows(code, is_quitting(app), macos, tray::is_tray_active(app)) {
                api.prevent_exit();
                log::info!("[app] the last window closed; the app keeps running");
                return;
            }
            let lifecycle = Arc::clone(&app.state::<Arc<Lifecycle>>());
            match lifecycle.quit.on_exit_requested() {
                ExitDecision::StartSequence => {
                    api.prevent_exit();
                    log::info!("[quit] exit requested (code {code:?}); starting the quit sequence");
                    start_quit_sequence(app.clone(), lifecycle);
                }
                ExitDecision::ExitNow => {
                    exit_now(app, &lifecycle, code);
                    lifecycle.exit_let_through.store(true, Ordering::Relaxed);
                }
                ExitDecision::Exit => {
                    log::info!("[quit] exiting (code {code:?})");
                    // While the sequence updates the marker, waits for that
                    // update (at most MARKER_TIMEOUT) so the exit does not cut
                    // it short; otherwise returns at once.
                    lifecycle.quit.wait_until_finished(MARKER_TIMEOUT);
                    main_window::save_main_window_state(app);
                    lifecycle.exit_let_through.store(true, Ordering::Relaxed);
                }
            }
        }
        RunEvent::Exit => {
            on_loop_ended(app);
            if let Some(hid) = app.try_state::<Hid>() {
                hid.0.close_probe();
            }
            log::info!("[quit] event loop ended");
        }
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => on_reopen(app),
        _ => {}
    }
}

/// An exit request while the quit sequence runs: records the interruption
/// and lets the exit through. Blocks the event loop for at most
/// MARKER_TIMEOUT.
fn exit_now(app: &AppHandle<Wry>, lifecycle: &Lifecycle, code: Option<i32>) {
    let phase = lifecycle.quit.running_phase();
    log::warn!(
        "[quit] exit requested (code {code:?}) while quitting during {}; exiting now",
        phase.unwrap_or("(between phases)")
    );
    let data_dir = user_data_dir(app);
    tauri::async_runtime::block_on(record_interruption(phase, QUIT_DEADLINE, &data_dir));
    main_window::save_main_window_state(app);
}

/// The event loop has ended. After an exit request that went through there
/// is nothing left to do. With no exit request before it (see the module
/// comment: the macOS Dock's Quit and log out, Windows' sign-out and shut
/// down), the process ends once this returns, so the pending marker is
/// written and the quit sequence runs here, holding the event loop until it
/// ends or its deadline passes; one already running is interrupted as by a
/// second exit request.
fn on_loop_ended(app: &AppHandle<Wry>) {
    let Some(lifecycle) = lifecycle_state(app).map(|state| Arc::clone(&state)) else {
        return;
    };
    match lifecycle.quit.on_exit_requested() {
        ExitDecision::StartSequence => {
            log::info!("[quit] the app is ending without an exit request; running the quit sequence");
            // Written before the phases run, so a system that ends the
            // process within the deadline leaves it for the next launch.
            let data_dir = user_data_dir(app);
            tauri::async_runtime::block_on(record_interruption(None, QUIT_DEADLINE, &data_dir));
            tauri::async_runtime::block_on(quit_sequence(app, lifecycle));
            main_window::save_main_window_state(app);
        }
        ExitDecision::ExitNow => exit_now(app, &lifecycle, None),
        ExitDecision::Exit => {
            if !lifecycle.exit_let_through.load(Ordering::Relaxed) {
                lifecycle.quit.wait_until_finished(MARKER_TIMEOUT);
            }
        }
    }
}

/// The directory of the pending marker: the userData directory.
fn user_data_dir(app: &AppHandle<Wry>) -> PathBuf {
    app.state::<UserDataDir>().0.clone()
}

fn start_quit_sequence(app: AppHandle<Wry>, lifecycle: Arc<Lifecycle>) {
    let sequence = quit_sequence(&app, lifecycle);
    tauri::async_runtime::spawn(async move {
        sequence.await;
        app.exit(0);
    });
}

/// The quit sequence, ending with the guard marked finished. Polling stops
/// and the app counts as quitting when this is called, before the sequence
/// runs.
fn quit_sequence(
    app: &AppHandle<Wry>,
    lifecycle: Arc<Lifecycle>,
) -> impl Future<Output = ()> + Send + 'static {
    let data_dir = user_data_dir(app);
    let durations = phase_durations();
    let pending = app.state::<PendingStore>().inner().clone();
    let recorder = app.state::<Arc<Recorder>>().inner().clone();
    let runtime = app.state::<SyncRuntime>().inner().clone();
    let sync = triggers(app);
    let sync_work = sync.as_ref().is_some_and(|sync| sync.begin_quit());
    let work = sync_work
        || runtime.password_change_running()
        || recorder.has_pending_work()
        || dev_quit_delay().is_some();
    async move {
        // With nothing to wait for, the phases are skipped and only the
        // pending units are written.
        let phases = if work { quit_phases(durations, recorder, runtime, sync) } else { Vec::new() };
        let outcome = quit(phases, QUIT_DEADLINE, &data_dir, &lifecycle.quit, pending).await;
        log::info!("[quit] sequence ended: {outcome:?}");
        lifecycle.quit.finish();
    }
}

/// The phases of the before-quit handler: passwordChange stops the running
/// password change and waits for it, the typing analytics are written, then
/// inFlightSync and flushPending wait for the running pass and flush what is
/// pending (neither when the sync is not managed). extraFinalizers has
/// nothing to run. Each phase other than passwordChange then waits for its
/// configured time.
fn quit_phases(
    durations: [Duration; QUIT_PHASES.len()],
    recorder: Arc<Recorder>,
    runtime: SyncRuntime,
    sync: Option<Arc<SyncTriggers>>,
) -> Vec<QuitPhase> {
    let mut phases = stub_phases(durations);
    phases[PASSWORD_CHANGE_PHASE] =
        crate::sync_commands::password_change::quit_phase(runtime, QUIT_PHASES[PASSWORD_CHANGE_PHASE]);
    phases[PRE_SYNC_FINALIZERS_PHASE] = analytics_commands::record::quit_phase(
        recorder,
        QUIT_PHASES[PRE_SYNC_FINALIZERS_PHASE],
        durations[PRE_SYNC_FINALIZERS_PHASE],
    );
    if let Some(sync) = sync {
        let for_pass = Arc::clone(&sync);
        phases[IN_FLIGHT_SYNC_PHASE] =
            then_wait(IN_FLIGHT_SYNC_PHASE, durations, async move { for_pass.in_flight_pass_ended().await });
        phases[FLUSH_PENDING_PHASE] =
            then_wait(FLUSH_PENDING_PHASE, durations, async move { sync.flush_pending().await });
    }
    phases
}

/// Runs the quit phases within `deadline`, then writes the pending sync
/// units whether the phases completed or not.
async fn quit(
    phases: Vec<QuitPhase>,
    deadline: Duration,
    data_dir: &Path,
    guard: &QuitGuard,
    pending: PendingStore,
) -> QuitOutcome {
    let outcome = run_quit_sequence(phases, deadline, data_dir, guard).await;
    persist_after_quit(pending, MARKER_TIMEOUT).await;
    outcome
}

/// The phase `index` running `run`, then waiting for its duration.
fn then_wait(
    index: usize,
    durations: [Duration; QUIT_PHASES.len()],
    run: impl Future<Output = ()> + Send + 'static,
) -> QuitPhase {
    let then = durations[index];
    QuitPhase::new(QUIT_PHASES[index], async move {
        run.await;
        tokio::time::sleep(then).await;
    })
}

/// The quit phases as stubs that each wait for their duration.
fn stub_phases(durations: [Duration; QUIT_PHASES.len()]) -> Vec<QuitPhase> {
    QUIT_PHASES
        .iter()
        .zip(durations)
        .map(|(&name, duration)| QuitPhase::new(name, async move { tokio::time::sleep(duration).await }))
        .collect()
}

fn phase_durations() -> [Duration; QUIT_PHASES.len()] {
    let mut durations = [Duration::ZERO; QUIT_PHASES.len()];
    if let Some(delay) = dev_quit_delay() {
        durations[DEV_DELAYED_PHASE] = delay;
    }
    durations
}

#[cfg(debug_assertions)]
fn dev_quit_delay() -> Option<Duration> {
    let value = std::env::var_os(DEV_QUIT_DELAY_MS_ENV)?;
    match value.to_string_lossy().trim().parse::<u64>() {
        Ok(ms) => Some(Duration::from_millis(ms)),
        Err(_) => {
            log::warn!("[quit] ignoring {DEV_QUIT_DELAY_MS_ENV}: {value:?} is not a number of milliseconds");
            None
        }
    }
}

#[cfg(not(debug_assertions))]
fn dev_quit_delay() -> Option<Duration> {
    None
}

/// Turns SIGTERM and SIGINT into an exit request, so they run the quit
/// sequence instead of killing the process. A signal while quitting is an
/// exit request like any other and ends the app at once.
///
/// The handlers are installed here, before setup returns, and only the loop
/// that reads them is spawned: a signal that arrives before that task first
/// runs is kept by the stream. A signal before setup takes the default
/// action and ends the process; at that point there is no app handle to
/// route the exit through and nothing the quit phases would flush has
/// started.
#[cfg(unix)]
fn listen_for_termination(app: AppHandle<Wry>) {
    use tokio::signal::unix::{SignalKind, signal};
    let runtime = tauri::async_runtime::handle();
    // `signal` needs the runtime's reactor, which setup does not run in.
    let _context = runtime.inner().enter();
    for (kind, name) in [(SignalKind::terminate(), "SIGTERM"), (SignalKind::interrupt(), "SIGINT")] {
        let mut stream = match signal(kind) {
            Ok(stream) => stream,
            Err(err) => {
                log::error!("failed to listen for {name}: {err}");
                continue;
            }
        };
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            while stream.recv().await.is_some() {
                log::info!("[quit] {name} received");
                app.exit(0);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pending_units_are_written_when_the_deadline_cuts_the_sequence_short() {
        let user_data = tempfile::TempDir::new().unwrap();
        let pending = crate::store_commands::sync_pending::store_without_delayed_writes(user_data.path());
        let unit = "keyboards/0xA1/devices/h/days/2026-04-14";
        let phases = vec![
            QuitPhase::new("preSyncFinalizers", {
                let pending = pending.clone();
                async move { pending.notify_change(unit) }
            }),
            QuitPhase::new("inFlightSync", std::future::pending()),
            QuitPhase::new("flushPending", async {}),
        ];
        let outcome = tokio::runtime::Builder::new_current_thread().enable_time().build().unwrap().block_on(
            quit(phases, Duration::from_millis(20), user_data.path(), &QuitGuard::default(), pending),
        );
        assert_eq!(outcome, QuitOutcome::DeadlineReached { unfinished: Some("inFlightSync") });
        let written =
            std::fs::read_to_string(user_data.path().join("local").join("sync-pending.json")).unwrap();
        assert!(written.contains(unit), "{written}");
    }

    #[test]
    fn the_stub_phases_wait_one_after_another() {
        let durations = [100, 200, 300, 400, 500].map(Duration::from_millis);
        // A completed sequence only removes the marker, so the directory
        // need not exist.
        let dir = std::env::temp_dir().join(format!("pipette-lifecycle-{}", std::process::id()));
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .start_paused(true)
            .build()
            .unwrap()
            .block_on(run_quit_sequence(stub_phases(durations), QUIT_DEADLINE, &dir, &QuitGuard::default()));
        assert_eq!(outcome, QuitOutcome::Completed { elapsed: Duration::from_millis(1500) });
        assert!(!dir.exists());
    }

    #[test]
    fn a_page_load_starting_in_the_main_window_closes_the_probe() {
        let hid = crate::ipc_contract::probe_keyboard_service();
        let (vendor_id, product_id, _) = crate::ipc_contract::PROBE_KEYBOARD;
        let probe = |hid: &HidService| hid.probe_open(vendor_id, product_id, None).unwrap();

        let id = probe(&hid);
        close_probe_on_page_load(&hid, MAIN_WINDOW, PageLoadEvent::Finished);
        close_probe_on_page_load(&hid, "other", PageLoadEvent::Started);
        assert!(hid.probe_send_receive(id, &[0x01]).is_ok());

        close_probe_on_page_load(&hid, MAIN_WINDOW, PageLoadEvent::Started);
        assert_eq!(hid.probe_send_receive(id, &[0x01]).unwrap_err().to_string(), "No probe device is open");
    }

    #[test]
    fn closing_the_last_window_quits_only_off_macos_with_no_tray() {
        let keeps = |code, quitting, macos, tray_active| {
            keeps_running_without_windows(code, quitting, macos, tray_active)
        };
        assert!(!keeps(None, false, false, false));
        assert!(keeps(None, false, true, false));
        assert!(keeps(None, false, false, true));
        assert!(keeps(None, false, true, true));
        // A window closed while quitting ends the app at once.
        assert!(!keeps(None, true, true, true));
        // The exit the tray, a signal or the sequence requests.
        assert!(!keeps(Some(0), false, true, true));
    }

    #[test]
    fn the_delay_applies_to_flush_pending() {
        assert_eq!(QUIT_PHASES[DEV_DELAYED_PHASE], "flushPending");
        assert_eq!(QUIT_PHASES[PASSWORD_CHANGE_PHASE], "passwordChange");
    }

    /// Runs the second instance handling on a mock app, counting the
    /// reveals instead of showing a window.
    fn second_launch(lifecycle: Option<Lifecycle>) -> (SecondLaunch, usize) {
        let app = tauri::test::mock_app();
        if let Some(lifecycle) = lifecycle {
            app.manage(Arc::new(lifecycle));
        }
        let mut reveals = 0;
        let outcome = respond_to_second_launch(app.handle(), |_| reveals += 1);
        (outcome, reveals)
    }

    #[test]
    fn a_second_launch_reveals_the_window_of_the_running_app() {
        assert_eq!(second_launch(Some(Lifecycle::default())), (SecondLaunch::Revealed, 1));
    }

    #[test]
    fn a_second_launch_does_nothing_while_quitting() {
        let lifecycle = Lifecycle::default();
        assert_eq!(lifecycle.quit.on_exit_requested(), ExitDecision::StartSequence);
        assert_eq!(second_launch(Some(lifecycle)), (SecondLaunch::IgnoredWhileQuitting, 0));
    }

    #[test]
    fn a_second_launch_does_nothing_after_the_quit_sequence_ends() {
        let lifecycle = Lifecycle::default();
        lifecycle.quit.on_exit_requested();
        lifecycle.quit.finish();
        assert_eq!(second_launch(Some(lifecycle)), (SecondLaunch::IgnoredWhileQuitting, 0));
    }

    #[test]
    fn a_second_launch_does_nothing_before_setup_has_run() {
        assert_eq!(second_launch(None), (SecondLaunch::IgnoredWhileStarting, 0));
    }
}
