// SPDX-License-Identifier: GPL-2.0-or-later
//! Window and app behavior: the tray icon, closing the window into the tray,
//! and the quit sequence every exit path goes through (src/shutdown.rs).
//!
//! Exit paths and how each reaches the quit sequence:
//! - the tray's Quit item and SIGTERM / SIGINT call `AppHandle::exit`, which
//!   raises `RunEvent::ExitRequested` with a code;
//! - closing the last window when the tray is not active raises
//!   `RunEvent::ExitRequested` without one.
//!
//! The first request is stopped and starts the sequence, requests while it
//! runs are stopped too, and the exit the sequence requests when it ends
//! goes through. The Electron before-quit handler lets a second quit through
//! while its phases run; here only the deadline ends the wait early.
//!
//! SIGKILL cannot be caught, and on Linux this build has no menu, so no
//! keyboard shortcut quits it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager, RunEvent, Window, WindowEvent, Wry};

use crate::shutdown::{ExitDecision, QUIT_DEADLINE, QuitGuard, QuitPhase, run_phases, run_quit_sequence};

/// Whether the app keeps running in the tray when the window is closed.
/// The Electron build reads this from `AppConfig.trayResident`, whose
/// default (`DEFAULT_APP_CONFIG` in src/main/app-config.ts) is off; this
/// build has no app config yet, so the default applies.
const TRAY_RESIDENT_DEFAULT: bool = false;

/// Builds with debug assertions: `1` turns tray residency on.
#[cfg(debug_assertions)]
const DEV_TRAY_RESIDENT_ENV: &str = "PIPETTE_DEV_TRAY_RESIDENT";

/// Builds with debug assertions: how long each stub phase of the quit
/// sequence takes, as `name=ms` pairs separated by commas (for example
/// `flushPending=35000`). A phase not listed takes no time.
#[cfg(debug_assertions)]
const DEV_QUIT_PHASE_MS_ENV: &str = "PIPETTE_DEV_QUIT_PHASE_MS";

/// The phases of the before-quit handler in src/main/sync/sync-flush.ts, in
/// its order. Each one is a stub that waits for its configured time until
/// the subsystem behind it is ported.
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

/// The tray item ids.
const TRAY_SHOW: &str = "show";
const TRAY_QUIT: &str = "quit";

/// Creates the tray when tray residency is on and starts listening for the
/// termination signals. Called from the app's setup hook.
pub fn setup(app: &mut App<Wry>) {
    let lifecycle = Arc::new(Lifecycle::default());
    app.manage(Arc::clone(&lifecycle));
    if tray_resident() {
        match build_tray(app) {
            Ok(()) => lifecycle.tray_active.store(true, Ordering::Release),
            Err(err) => eprintln!("failed to create the tray icon: {err}"),
        }
    }
    #[cfg(unix)]
    listen_for_termination(app.handle().clone());
}

fn tray_resident() -> bool {
    #[cfg(debug_assertions)]
    if let Some(value) = std::env::var_os(DEV_TRAY_RESIDENT_ENV) {
        return value == "1";
    }
    TRAY_RESIDENT_DEFAULT
}

/// The tray menu: Show, a separator, Quit. The labels are the fixed English
/// ones of the Electron tray (src/main/app-behavior.ts), which cannot be
/// localized either: the translations live in the renderer.
fn build_tray(app: &App<Wry>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, TRAY_SHOW, "Show", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;
    let mut tray = TrayIconBuilder::new().menu(&menu).tooltip("Pipette").on_menu_event(|app, event| {
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
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let result = window.unminimize().and_then(|()| window.show()).and_then(|()| window.set_focus());
    if let Err(err) = result {
        eprintln!("failed to show the main window: {err}");
    }
}

/// Hides the window instead of closing it while the tray is active and no
/// exit has been requested.
pub fn on_window_event(window: &Window<Wry>, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else {
        return;
    };
    let lifecycle = window.state::<Arc<Lifecycle>>();
    if lifecycle.tray_active.load(Ordering::Acquire) && !lifecycle.quit.is_quitting() {
        api.prevent_close();
        if let Err(err) = window.hide() {
            eprintln!("failed to hide the main window: {err}");
        }
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
                    eprintln!("[quit] exit requested (code {code:?}); starting the quit sequence");
                    start_quit_sequence(app.clone(), lifecycle);
                }
                ExitDecision::Wait => {
                    api.prevent_exit();
                    eprintln!("[quit] exit requested (code {code:?}) while quitting; waiting");
                }
                ExitDecision::Exit => eprintln!("[quit] exiting (code {code:?})"),
            }
        }
        RunEvent::Exit => eprintln!("[quit] event loop ended"),
        _ => {}
    }
}

fn start_quit_sequence(app: AppHandle<Wry>, lifecycle: Arc<Lifecycle>) {
    let data_dir = match app.path().app_data_dir() {
        Ok(dir) => Some(dir),
        Err(err) => {
            eprintln!("[quit] no app data directory for the pending marker: {err}");
            None
        }
    };
    let durations = phase_durations();
    tauri::async_runtime::spawn(async move {
        let phases = stub_phases(durations);
        let outcome = match data_dir {
            Some(dir) => run_quit_sequence(phases, QUIT_DEADLINE, &dir).await,
            None => run_phases(phases, QUIT_DEADLINE).await,
        };
        eprintln!("[quit] sequence ended: {outcome:?}");
        lifecycle.quit.finish();
        app.exit(0);
    });
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
    #[cfg(debug_assertions)]
    if let Some(spec) = std::env::var_os(DEV_QUIT_PHASE_MS_ENV) {
        match parse_phase_durations(&spec.to_string_lossy()) {
            Ok(durations) => return durations,
            Err(err) => eprintln!("[quit] ignoring {DEV_QUIT_PHASE_MS_ENV}: {err}"),
        }
    }
    [Duration::ZERO; QUIT_PHASES.len()]
}

/// Parses `name=ms,name=ms` into a duration per entry of [`QUIT_PHASES`].
#[cfg(debug_assertions)]
fn parse_phase_durations(spec: &str) -> Result<[Duration; QUIT_PHASES.len()], String> {
    let mut durations = [Duration::ZERO; QUIT_PHASES.len()];
    for pair in spec.split(',').map(str::trim).filter(|p| !p.is_empty()) {
        let (name, ms) = pair.split_once('=').ok_or_else(|| format!("{pair:?} is not name=ms"))?;
        let index = QUIT_PHASES
            .iter()
            .position(|&phase| phase == name.trim())
            .ok_or_else(|| format!("unknown phase {name:?}"))?;
        let ms: u64 = ms.trim().parse().map_err(|_| format!("{ms:?} is not a number of milliseconds"))?;
        durations[index] = Duration::from_millis(ms);
    }
    Ok(durations)
}

/// Turns SIGTERM and SIGINT into an exit request, so they run the quit
/// sequence instead of killing the process. A signal while quitting is
/// stopped like any other exit request; the deadline bounds the wait.
#[cfg(unix)]
fn listen_for_termination(app: AppHandle<Wry>) {
    use tokio::signal::unix::{SignalKind, signal};
    for (kind, name) in [(SignalKind::terminate(), "SIGTERM"), (SignalKind::interrupt(), "SIGINT")] {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut stream = match signal(kind) {
                Ok(stream) => stream,
                Err(err) => {
                    eprintln!("failed to listen for {name}: {err}");
                    return;
                }
            };
            while stream.recv().await.is_some() {
                eprintln!("[quit] {name} received");
                app.exit(0);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_stub_phases_wait_one_after_another() {
        let durations = [100, 200, 300, 400, 500].map(Duration::from_millis);
        let outcome = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .start_paused(true)
            .build()
            .unwrap()
            .block_on(run_phases(stub_phases(durations), QUIT_DEADLINE));
        assert_eq!(outcome, crate::shutdown::QuitOutcome::Completed { elapsed: Duration::from_millis(1500) });
    }

    #[cfg(debug_assertions)]
    #[test]
    fn parses_the_listed_phases_and_leaves_the_others_at_zero() {
        let durations = parse_phase_durations("flushPending=35000, passwordChange = 200").unwrap();
        assert_eq!(
            durations,
            [
                Duration::from_millis(200),
                Duration::ZERO,
                Duration::ZERO,
                Duration::from_millis(35_000),
                Duration::ZERO
            ]
        );
    }

    #[cfg(debug_assertions)]
    #[test]
    fn an_empty_spec_means_no_delay() {
        assert_eq!(parse_phase_durations("").unwrap(), [Duration::ZERO; 5]);
    }

    #[cfg(debug_assertions)]
    #[test]
    fn rejects_unknown_phases_and_bad_numbers() {
        assert!(parse_phase_durations("nope=1").is_err());
        assert!(parse_phase_durations("flushPending=-1").is_err());
        assert!(parse_phase_durations("flushPending").is_err());
    }
}
