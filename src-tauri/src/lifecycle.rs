// SPDX-License-Identifier: GPL-2.0-or-later
//! Window and app behavior: the tray icon, closing the window into the tray,
//! a launch of the app while it runs, and the quit sequence every exit path
//! goes through (src/shutdown.rs).
//!
//! Exit paths and how each reaches the quit sequence:
//! - the tray's Quit item and SIGTERM / SIGINT call `AppHandle::exit`, which
//!   raises `RunEvent::ExitRequested` with a code;
//! - closing the last window when the tray is not active raises
//!   `RunEvent::ExitRequested` without one.
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
//! SIGKILL cannot be caught, and on Linux this build has no menu, so no
//! keyboard shortcut quits it.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use pipette_hid::HidService;
use pipette_sync_pending::PendingStore;
use pipette_typing_analytics::Recorder;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
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

/// Builds with debug assertions: how many milliseconds the stub of the
/// [`DEV_DELAYED_PHASE`] phase takes, to run the quit sequence into its
/// deadline. The other phases take no time.
#[cfg(debug_assertions)]
const DEV_QUIT_DELAY_MS_ENV: &str = "PIPETTE_DEV_QUIT_DELAY_MS";

/// The passwordChange phase, which waits for a running password change.
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

/// Shared by the window, tray and exit handlers.
#[derive(Default)]
pub struct Lifecycle {
    quit: QuitGuard,
    /// Set once the tray icon exists. Closing hides the window only then:
    /// a hidden window with no tray icon to restore it would be unreachable.
    tray_active: AtomicBool,
}

impl Lifecycle {
    fn is_tray_active(&self) -> bool {
        self.tray_active.load(Ordering::Acquire)
    }
}

/// The shared lifecycle state; `None` before setup has run.
fn lifecycle_state<R: Runtime, M: Manager<R>>(manager: &M) -> Option<State<'_, Arc<Lifecycle>>> {
    manager.try_state::<Arc<Lifecycle>>()
}

/// The tray icon's id.
const TRAY_ID: &str = "main";
/// The tray item ids.
const TRAY_SHOW: &str = "show";
const TRAY_QUIT: &str = "quit";

/// Creates the tray when the config's `trayResident` is on (`Boolean()` of
/// it, as the Electron build reads it) and starts listening for the
/// termination signals. Called from the app's setup hook.
pub fn setup(app: &mut App<Wry>) {
    app.manage(Arc::new(Lifecycle::default()));
    let tray_resident = app.state::<AppConfig>().get("trayResident").unwrap_or_else(|err| {
        log::error!("failed to read trayResident: {err}");
        None
    });
    if tray_resident.as_ref().is_some_and(pipette_app_config::Value::is_truthy) {
        add_tray(app.handle());
    }
    #[cfg(unix)]
    listen_for_termination(app.handle().clone());
}

/// Adds the tray (`on`) or removes it, on the main thread, as `setupTray` /
/// `destroyTray` of src/main/app-behavior.ts do when the renderer changes
/// `trayResident`; nothing happens when the tray already is that way. Called
/// off the main thread, it queues the change there and returns without
/// waiting for it.
pub fn set_tray_resident(app: &AppHandle<Wry>, on: bool) {
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        if on {
            add_tray(&handle);
        } else {
            remove_tray(&handle);
        }
    });
    if let Err(err) = result {
        log::error!("failed to update the tray icon: {err}");
    }
}

fn add_tray(app: &AppHandle<Wry>) {
    let lifecycle = app.state::<Arc<Lifecycle>>();
    if lifecycle.is_tray_active() {
        return;
    }
    match build_tray(app) {
        Ok(()) => lifecycle.tray_active.store(true, Ordering::Release),
        Err(err) => log::error!("failed to create the tray icon: {err}"),
    }
}

fn remove_tray(app: &AppHandle<Wry>) {
    let lifecycle = app.state::<Arc<Lifecycle>>();
    lifecycle.tray_active.store(false, Ordering::Release);
    // The icon goes away with the last handle to it, this one.
    drop(app.remove_tray_by_id(TRAY_ID));
}

/// The tray menu: Show, a separator, Quit. The labels are the fixed English
/// ones of the Electron tray (src/main/app-behavior.ts), which cannot be
/// localized either: the translations live in the renderer.
fn build_tray(app: &AppHandle<Wry>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW, "Show", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;
    let mut tray =
        TrayIconBuilder::with_id(TRAY_ID).menu(&menu).tooltip("Pipette").on_menu_event(|app, event| {
            match event.id().as_ref() {
                TRAY_SHOW => show_main_window(app),
                TRAY_QUIT => app.exit(0),
                _ => {}
            }
        });
    // A left click shows the window too, as in the Electron tray. Linux
    // (AppIndicator) reports no clicks; the menu is the only way there.
    tray = tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left, button_state: MouseButtonState::Up, ..
        } = event
        {
            show_main_window(tray.app_handle());
        }
    });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Restores, shows and focuses the main window.
fn show_main_window(app: &AppHandle<Wry>) {
    if let Some(window) = main_window::main_window(app) {
        main_window::reveal(&window);
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
    let outcome = respond_to_second_launch(app, show_main_window);
    log::info!("[app] the app was launched again: {outcome:?}");
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

/// Whether the tray icon exists, so a hidden window can be shown again.
pub fn is_tray_active<R: Runtime>(app: &AppHandle<R>) -> bool {
    lifecycle_state(app).is_some_and(|lifecycle| lifecycle.is_tray_active())
}

/// Saves the window state when the window is asked to close, then hides
/// the window instead of closing it while the tray is active and no exit
/// has been requested. After a move, applies the minimum size of the
/// display the window is on.
pub fn on_window_event(window: &Window<Wry>, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            main_window::save_window_state(window, &window.state::<AppConfig>());
            let hide = lifecycle_state(window)
                .is_some_and(|lifecycle| lifecycle.is_tray_active() && !lifecycle.quit.is_quitting());
            if hide {
                api.prevent_close();
                main_window::conceal(window);
            }
        }
        WindowEvent::Moved(_) => main_window::update_min_size(window),
        _ => {}
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

/// Routes every exit request through the quit guard.
pub fn on_run_event(app: &AppHandle<Wry>, event: RunEvent) {
    match event {
        RunEvent::ExitRequested { code, api, .. } => {
            let lifecycle = Arc::clone(&app.state::<Arc<Lifecycle>>());
            match lifecycle.quit.on_exit_requested() {
                ExitDecision::StartSequence => {
                    api.prevent_exit();
                    log::info!("[quit] exit requested (code {code:?}); starting the quit sequence");
                    start_quit_sequence(app.clone(), lifecycle);
                }
                ExitDecision::ExitNow => {
                    let phase = lifecycle.quit.running_phase();
                    log::warn!(
                        "[quit] exit requested (code {code:?}) while quitting during {}; exiting now",
                        phase.unwrap_or("(between phases)")
                    );
                    // Blocks the event loop for at most MARKER_TIMEOUT; the
                    // exit goes through when this returns.
                    let data_dir = user_data_dir(app);
                    tauri::async_runtime::block_on(record_interruption(phase, QUIT_DEADLINE, &data_dir));
                    main_window::save_main_window_state(app);
                }
                ExitDecision::Exit => {
                    log::info!("[quit] exiting (code {code:?})");
                    // While the sequence updates the marker, waits for that
                    // update (at most MARKER_TIMEOUT) so the exit does not cut
                    // it short; otherwise returns at once.
                    lifecycle.quit.wait_until_finished(MARKER_TIMEOUT);
                    main_window::save_main_window_state(app);
                }
            }
        }
        RunEvent::Exit => {
            if let Some(hid) = app.try_state::<Hid>() {
                hid.0.close_probe();
            }
            log::info!("[quit] event loop ended");
        }
        _ => {}
    }
}

/// The directory of the pending marker: the userData directory.
fn user_data_dir(app: &AppHandle<Wry>) -> PathBuf {
    app.state::<UserDataDir>().0.clone()
}

fn start_quit_sequence(app: AppHandle<Wry>, lifecycle: Arc<Lifecycle>) {
    let data_dir = user_data_dir(&app);
    let durations = phase_durations();
    let pending = app.state::<PendingStore>().inner().clone();
    let recorder = app.state::<Arc<Recorder>>().inner().clone();
    let sync = triggers(&app);
    // Polling stops and the app counts as quitting before anything else.
    let sync_work = sync.as_ref().is_some_and(|sync| sync.begin_quit());
    let work = sync_work || recorder.has_pending_work() || dev_quit_delay().is_some();
    tauri::async_runtime::spawn(async move {
        // With nothing to wait for, the phases are skipped and only the
        // pending units are written.
        let phases = if work { quit_phases(durations, recorder, sync) } else { Vec::new() };
        let outcome = quit(phases, QUIT_DEADLINE, &data_dir, &lifecycle.quit, pending).await;
        log::info!("[quit] sequence ended: {outcome:?}");
        lifecycle.quit.finish();
        app.exit(0);
    });
}

/// The phases of the before-quit handler: the typing analytics are written
/// before the sync, whose passwordChange, inFlightSync and flushPending
/// phases wait for the running password change, then the running pass,
/// then flush what is pending (none of them when the sync is not managed).
/// extraFinalizers has nothing to run. Each phase then waits for its
/// configured time.
fn quit_phases(
    durations: [Duration; QUIT_PHASES.len()],
    recorder: Arc<Recorder>,
    sync: Option<Arc<SyncTriggers>>,
) -> Vec<QuitPhase> {
    let mut phases = stub_phases(durations);
    phases[PRE_SYNC_FINALIZERS_PHASE] = analytics_commands::record::quit_phase(
        recorder,
        QUIT_PHASES[PRE_SYNC_FINALIZERS_PHASE],
        durations[PRE_SYNC_FINALIZERS_PHASE],
    );
    if let Some(sync) = sync {
        let (a, b, c) = (Arc::clone(&sync), Arc::clone(&sync), sync);
        phases[PASSWORD_CHANGE_PHASE] =
            then_wait(PASSWORD_CHANGE_PHASE, durations, async move { a.password_change_ended().await });
        phases[IN_FLIGHT_SYNC_PHASE] =
            then_wait(IN_FLIGHT_SYNC_PHASE, durations, async move { b.in_flight_pass_ended().await });
        phases[FLUSH_PENDING_PHASE] =
            then_wait(FLUSH_PENDING_PHASE, durations, async move { c.flush_pending().await });
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
    fn the_delay_applies_to_flush_pending() {
        assert_eq!(QUIT_PHASES[DEV_DELAYED_PHASE], "flushPending");
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
