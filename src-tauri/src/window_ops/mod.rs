// SPDX-License-Identifier: GPL-2.0-or-later
//! The main window's geometry beyond opening and closing it: the Typing
//! Test's view-only window (compact mode, aspect ratio, always on top,
//! opacity, minimum size; the commands of window_commands.rs) and the window
//! system's changes to it. Every window event but the close request
//! (src/lifecycle.rs) comes here: after a move or a change of the scale
//! factor the window gets the minimum size of the display it is on
//! (`main_window::update_min_size`), and a change of the displays, seen on
//! the window's events and on a slow poll, fits it into its work area
//! (display.rs).
//!
//! The decisions are compact.rs's and geometry.rs's; this module reads the
//! window for them and applies what they decide. The window's bounds here
//! are the rectangle the app saves as `windowState` (main_window.rs), in
//! DIP, as Electron's bounds are on each system: on Linux the outer
//! position and the content size, with no frame to add or take off; on
//! Windows and macOS the outer rectangle, frame included, which native.rs
//! converts to the content size Tauri sets.

pub mod always_on_top;
pub mod compact;
pub mod display;
pub mod geometry;
pub mod native;
pub mod opacity;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tauri::{Manager, Runtime, Window, WindowEvent};

use crate::main_window::{self, MAIN_WINDOW};
use crate::window_bounds::{Rect, Size};
use crate::window_state::{Display, display_matching};
use compact::{Animation, Controller, STEP_MS, Tick, WindowPort};
use display::DisplayWatch;
use geometry::{ApplyHints, Change, Hints};

/// How often the displays are looked at while the window sits still.
/// Electron hears `display-metrics-changed`; Tauri has no such event, and
/// GDK none for a work area that changes.
const DISPLAY_POLL: Duration = Duration::from_secs(2);

/// What the handlers keep about the window.
#[derive(Default)]
struct WindowOps(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    /// None until first needed, and again once the window is gone.
    controller: Option<Controller>,
    displays: DisplayWatch,
    always_on_top: bool,
    /// The hints the window has, as last applied to it.
    applied_hints: Option<Hints>,
    /// The stop flag of the display poll of this window, while one runs.
    /// The poll is tied to the window, not to its label: a window opened
    /// again under the same label gets a poll of its own.
    display_poll: Option<Arc<AtomicBool>>,
}

impl Inner {
    /// The stop flag of a new display poll, or None when one runs.
    fn start_display_poll(&mut self) -> Option<Arc<AtomicBool>> {
        if self.display_poll.is_some() {
            return None;
        }
        let stop = Arc::new(AtomicBool::new(false));
        self.display_poll = Some(Arc::clone(&stop));
        Some(stop)
    }

    /// Forgets the window once it is gone, stopping its display poll.
    fn on_destroyed(&mut self) {
        if let Some(stop) = self.display_poll.take() {
            stop.store(true, Ordering::Relaxed);
        }
        *self = Self::default();
    }
}

/// The handlers' state, managed on first use.
fn lock<R: Runtime>(window: &Window<R>) -> MutexGuard<'_, Inner> {
    if window.try_state::<WindowOps>().is_none() {
        window.manage(WindowOps::default());
    }
    window.state::<WindowOps>().inner().0.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs `f` on the controller, which starts from the minimum size the
/// window opened with, then gives the window the hints the controller now
/// wants.
fn with_controller<R: Runtime, T>(window: &Window<R>, f: impl FnOnce(&mut Controller, &Port<R>) -> T) -> T {
    let port = Port(window.clone());
    let result = {
        let mut inner = lock(window);
        let controller = inner
            .controller
            .get_or_insert_with(|| Controller::new(main_window::opening_min_size(window.app_handle())));
        f(controller, &port)
    };
    sync_hints(window);
    result
}

/// Gives the window the hints of the controller's state at the time they
/// are applied, on the main thread as every GTK, Win32 and AppKit call. A
/// queued sync that runs late reads the newest state, so the last one
/// applied is always the current set.
fn sync_hints<R: Runtime>(window: &Window<R>) {
    if !is_app_runtime::<R>() {
        return apply_current_hints(window);
    }
    let target = window.clone();
    if let Err(err) = window.run_on_main_thread(move || apply_current_hints(&target)) {
        log::error!("[window] failed to set the window's geometry hints: {err}");
    }
}

fn apply_current_hints<R: Runtime>(window: &Window<R>) {
    let mut inner = lock(window);
    let Some(hints) = inner.controller.map(|controller| controller.window_hints()) else {
        return;
    };
    if inner.applied_hints == Some(hints) {
        return;
    }
    log::debug!("[window] geometry hints {hints:?}");
    match apply_native_hints(window, hints) {
        Ok(()) => inner.applied_hints = Some(hints),
        Err(err) => log::error!("[window] failed to set the window's geometry hints: {err}"),
    }
}

fn apply_native_hints<R: Runtime>(window: &Window<R>, hints: Hints) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    if has_gtk_window::<R>() {
        return gtk_apply_hints(window, hints);
    }
    native::apply_hints(window, hints)
}

/// Runs `f` on the main thread and answers what it returns; None when it
/// could not be run there.
async fn on_main<R: Runtime, T: Send + 'static>(
    window: &Window<R>,
    f: impl FnOnce() -> T + Send + 'static,
) -> Option<T> {
    let (sender, mut receiver) = tauri::async_runtime::channel(1);
    if let Err(err) = window.run_on_main_thread(move || {
        let _ = sender.try_send(f());
    }) {
        log::error!("[window] failed to reach the main thread: {err}");
        return None;
    }
    receiver.recv().await
}

/// The size compact mode keeps to go back to, while it is on.
pub fn compact_normal_size<R: Runtime>(window: &Window<R>) -> Option<Size> {
    lock(window).controller.and_then(|controller| controller.normal_size())
}

/// Whether compact mode is on, so the window's minimum size is its own.
pub fn in_compact_mode<R: Runtime>(window: &Window<R>) -> bool {
    compact_normal_size(window).is_some()
}

/// Applies `min_size` unless it is the minimum size applied last.
pub fn apply_min_size<R: Runtime>(window: &Window<R>, min_size: Size) -> Result<(), String> {
    with_controller(window, |controller, port| controller.geometry.apply_min_size_if_changed(port, min_size))
}

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    if let WindowEvent::Destroyed = event {
        lock(window).on_destroyed();
        return;
    }
    start_display_poll(window);
    match event {
        WindowEvent::Moved(_) | WindowEvent::ScaleFactorChanged { .. } => {
            main_window::update_min_size(window);
            check_displays(window);
        }
        WindowEvent::Resized(_) => check_displays(window),
        _ => {}
    }
}

/// Looks at the displays every [`DISPLAY_POLL`] until the window is
/// destroyed, so a still window takes a changed work area too. Only the
/// app's runtime lists monitors.
fn start_display_poll<R: Runtime>(window: &Window<R>) {
    if !is_app_runtime::<R>() {
        return;
    }
    let Some(stop) = lock(window).start_display_poll() else {
        return;
    };
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(DISPLAY_POLL).await;
            if stop.load(Ordering::Relaxed) {
                return;
            }
            let (target, stop) = (window.clone(), Arc::clone(&stop));
            let result = window.run_on_main_thread(move || {
                // The window may have been destroyed since the check above.
                if !stop.load(Ordering::Relaxed) {
                    check_displays(&target);
                }
            });
            if result.is_err() {
                return;
            }
        }
    });
}

/// Fits the window into its work area when the displays changed since the
/// last look.
fn check_displays<R: Runtime>(window: &Window<R>) {
    let (displays, primary) = displays(window);
    let changed = lock(window).displays.changed(&displays);
    if !changed {
        return;
    }
    let Some(bounds) = read_bounds(window) else {
        return;
    };
    let display = display_of(window, &displays, primary, bounds);
    let maximized_or_full_screen =
        window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false);
    with_controller(window, |controller, port| {
        controller.work_area_changed(port, bounds, display.as_ref(), maximized_or_full_screen);
    });
}

/// The monitors in DIP and the primary one; none on the runtime of
/// tauri::test, which cannot list monitors (it panics when asked).
fn displays<R: Runtime>(window: &Window<R>) -> (Vec<Display>, Option<usize>) {
    if is_app_runtime::<R>() { main_window::displays(window.app_handle()) } else { (Vec::new(), None) }
}

/// The display of the window at `bounds`: the one they overlap most, or
/// the window's current monitor where the window cannot read its position
/// (Wayland, where `bounds` start at 0, 0).
fn display_of<R: Runtime>(
    window: &Window<R>,
    displays: &[Display],
    primary: Option<usize>,
    bounds: Rect,
) -> Option<Display> {
    if !position_known(window)
        && let Ok(Some(monitor)) = window.current_monitor()
    {
        return Some(main_window::display(&monitor));
    }
    pick_display(displays, primary, bounds)
}

/// `screen.getDisplayMatching(bounds)`: the display `bounds` overlap most,
/// or the primary one.
fn pick_display(displays: &[Display], primary: Option<usize>, bounds: Rect) -> Option<Display> {
    display_matching(&bounds, displays)
        .or_else(|| primary.and_then(|index| displays.get(index)))
        .or_else(|| displays.first())
        .copied()
}

/// The window's bounds, logged and None when they cannot be read.
fn read_bounds<R: Runtime>(window: &Window<R>) -> Option<Rect> {
    main_window::window_bounds(window)
        .inspect_err(|err| log::error!("[window] failed to read the window bounds: {err}"))
        .ok()
}

/// A size as the renderer receives it.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct WindowSize {
    pub width: f64,
    pub height: f64,
}

impl From<Size> for WindowSize {
    fn from(size: Size) -> Self {
        Self { width: size.width, height: size.height }
    }
}

/// What entering or leaving decided, and the animation to run on.
struct CompactStep {
    answer: Option<WindowSize>,
    animation: Option<Animation>,
}

/// Enters or leaves compact mode (the WINDOW_SET_COMPACT_MODE handler).
/// Entering answers None at once and animates on; leaving answers the size
/// before it, once its animation has ended. Every step runs on the main
/// thread, where the window's close also runs: a close between two steps
/// sees the bounds and the normal size of the same step.
pub async fn set_compact_mode<R: Runtime>(
    window: &Window<R>,
    enabled: bool,
    compact_size: Option<Size>,
) -> Option<WindowSize> {
    let target = window.clone();
    let step = on_main(window, move || compact_step(&target, enabled, compact_size)).await??;
    if let Some(animation) = step.animation {
        if enabled {
            let window = window.clone();
            tauri::async_runtime::spawn(async move { animate(&window, animation).await });
        } else {
            animate(window, animation).await;
        }
    }
    step.answer
}

/// The decision of entering or leaving and the animation's first step.
fn compact_step<R: Runtime>(
    window: &Window<R>,
    enabled: bool,
    compact_size: Option<Size>,
) -> Option<CompactStep> {
    let bounds = read_bounds(window)?;
    let (displays, primary) = displays(window);
    let display = if enabled { None } else { display_of(window, &displays, primary, bounds) };
    Some(with_controller(window, |controller, port| {
        let (answer, animation) = if enabled {
            (None, controller.enter(port, bounds, native::frame(window), compact_size))
        } else {
            let leave = controller.leave(port, bounds, display.as_ref());
            (Some(leave.size.into()), leave.animation)
        };
        let animation = animation.and_then(|mut animation| {
            (controller.tick(port, &mut animation) == Tick::Continue).then_some(animation)
        });
        CompactStep { answer, animation }
    }))
}

/// The steps of `animation` after its first, one every [`STEP_MS`] on the
/// main thread, until it is done.
async fn animate<R: Runtime>(window: &Window<R>, mut animation: Animation) {
    loop {
        tokio::time::sleep(Duration::from_millis(STEP_MS)).await;
        let target = window.clone();
        let step = on_main(window, move || {
            let tick = with_controller(&target, |controller, port| controller.tick(port, &mut animation));
            (tick, animation)
        })
        .await;
        match step {
            Some((Tick::Continue, next)) => animation = next,
            _ => return,
        }
    }
}

/// Sets or releases the aspect ratio (the WINDOW_SET_ASPECT_RATIO handler).
pub fn set_aspect_ratio<R: Runtime>(window: &Window<R>, ratio: f64) {
    let frame = native::frame(window);
    with_controller(window, |controller, port| controller.set_aspect_ratio(port, ratio, frame));
}

/// The WINDOW_SET_MIN_SIZE handler.
pub fn set_min_size<R: Runtime>(window: &Window<R>, width: f64, height: f64) {
    with_controller(window, |controller, port| controller.set_min_size(port, width, height));
}

pub fn set_always_on_top<R: Runtime>(window: &Window<R>, enabled: bool) {
    match window.set_always_on_top(enabled) {
        Ok(()) => lock(window).always_on_top = enabled,
        Err(err) => log::error!("[window] failed to set always on top: {err}"),
    }
}

/// The window's geometry as this module applied it, for the development
/// tools.
#[cfg(feature = "dev-tools")]
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowReport {
    /// The content size.
    pub size: WindowSize,
    pub min_size: Option<WindowSize>,
    /// The aspect ratio asked for, whether the window has it now or not.
    pub aspect_ratio: Option<f64>,
    pub hints: HintsReport,
    pub always_on_top: bool,
    pub compact: bool,
    pub normal_size: Option<WindowSize>,
}

/// The geometry hints the window has, in whole logical pixels.
#[cfg(feature = "dev-tools")]
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HintsReport {
    pub mask: Vec<&'static str>,
    pub min_size: Option<WindowSize>,
    pub aspect: Option<f64>,
}

#[cfg(feature = "dev-tools")]
pub fn report<R: Runtime>(window: &Window<R>) -> Result<WindowReport, String> {
    let size = main_window::content_size(window).map_err(|err| err.to_string())?;
    let controller = with_controller(window, |controller, _| *controller);
    let inner = lock(window);
    let hints = inner.applied_hints.unwrap_or_else(|| controller.window_hints());
    Ok(WindowReport {
        size: WindowSize { width: size.width, height: size.height },
        min_size: controller.geometry.min_size.map(Into::into),
        aspect_ratio: controller.geometry.aspect_ratio,
        hints: HintsReport {
            mask: hints.mask(),
            min_size: hints
                .min_size
                .map(|(width, height)| WindowSize { width: width.into(), height: height.into() }),
            aspect: hints.aspect,
        },
        always_on_top: inner.always_on_top,
        compact: controller.in_compact_mode(),
        normal_size: controller.normal_size().map(Into::into),
    })
}

/// The window as the decisions see it. The hints are not applied through
/// it: [`sync_hints`] applies the controller's current set after each
/// change.
struct Port<R: Runtime>(Window<R>);

/// Whether `R` is the app's runtime. The runtime of tauri::test has no GTK
/// window and cannot list monitors (its windows panic when asked), so it
/// takes the changes through Tauri's own calls.
fn is_app_runtime<R: Runtime>() -> bool {
    std::any::TypeId::of::<R>() == std::any::TypeId::of::<tauri::Wry>()
}

pub fn has_gtk_window<R: Runtime>() -> bool {
    cfg!(target_os = "linux") && is_app_runtime::<R>()
}

/// Whether the window system lets the window read and set its position.
fn position_known<R: Runtime>(window: &Window<R>) -> bool {
    !has_gtk_window::<R>() || main_window::position_known(window)
}

impl<R: Runtime> ApplyHints for Port<R> {
    fn apply_hints(&self, _hints: Hints, _change: Change) -> Result<(), String> {
        Ok(())
    }
}

impl<R: Runtime> WindowPort for Port<R> {
    fn set_bounds(&self, bounds: Rect) {
        #[cfg(target_os = "linux")]
        if has_gtk_window::<R>() {
            let window = self.0.clone();
            if let Err(err) = self.0.run_on_main_thread(move || gtk_set_bounds(&window, bounds)) {
                log::error!("[window] failed to set the window bounds: {err}");
            }
            return;
        }
        if let Err(err) = native::set_outer_bounds(&self.0, bounds) {
            log::error!("[window] failed to set the window bounds: {err}");
        }
    }

    fn is_destroyed(&self) -> bool {
        self.0.app_handle().get_webview_window(self.0.label()).is_none()
    }
}

/// Applies `hints` as the GTK window's one set of geometry hints, on the
/// main thread.
#[cfg(target_os = "linux")]
fn gtk_apply_hints<R: Runtime>(window: &Window<R>, hints: Hints) -> Result<(), String> {
    use gtk::gdk::{Geometry, Gravity, WindowHints};
    use gtk::prelude::GtkWindowExt;
    let gtk_window = window.gtk_window().map_err(|err| err.to_string())?;
    let mut mask = WindowHints::empty();
    if hints.min_size.is_some() {
        mask |= WindowHints::MIN_SIZE;
    }
    if hints.aspect.is_some() {
        mask |= WindowHints::BASE_SIZE | WindowHints::ASPECT;
    }
    let (min_width, min_height) = hints.min_size.unwrap_or((0, 0));
    let aspect = hints.aspect.unwrap_or(0.0);
    // The base size (0 × 0) is the fifth and sixth argument.
    let geometry = Geometry::new(min_width, min_height, 0, 0, 0, 0, 0, 0, aspect, aspect, Gravity::Center);
    gtk_window.set_geometry_hints(None::<&gtk::Window>, Some(&geometry), mask);
    Ok(())
}

/// Resizes the GTK window to the content size of `bounds`, and moves it to
/// their position where the window system lets an app place its windows
/// (not on Wayland). `gtk_window_resize` takes the size
/// `main_window::content_size` reads, so bounds read and set back leave
/// the window as it was.
#[cfg(target_os = "linux")]
fn gtk_set_bounds<R: Runtime>(window: &Window<R>, bounds: Rect) {
    use gtk::prelude::GtkWindowExt;
    let gtk_window = match window.gtk_window() {
        Ok(gtk_window) => gtk_window,
        Err(err) => return log::error!("[window] failed to get the GTK window: {err}"),
    };
    if main_window::position_known(window) {
        gtk_window.move_(bounds.x as i32, bounds.y as i32);
    }
    gtk_window.resize(bounds.width as i32, bounds.height as i32);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destroying_the_window_stops_its_display_poll() {
        let mut inner = Inner::default();
        let first = inner.start_display_poll().unwrap();
        assert!(inner.start_display_poll().is_none());
        assert!(!first.load(Ordering::Relaxed));

        inner.on_destroyed();
        assert!(first.load(Ordering::Relaxed));

        // The window opened again under the same label polls on its own.
        let second = inner.start_display_poll().unwrap();
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed));
    }

    fn display(x: f64, width: f64) -> Display {
        let bounds = Rect { x, y: 0.0, width, height: 1080.0 };
        Display { bounds, work_area: bounds }
    }

    #[test]
    fn the_display_of_bounds_off_every_display_is_the_primary_one() {
        let displays = [display(0.0, 1920.0), display(1920.0, 1280.0)];
        let off = Rect { x: -5000.0, y: 0.0, width: 100.0, height: 100.0 };
        assert_eq!(pick_display(&displays, Some(1), off), Some(displays[1]));
        assert_eq!(pick_display(&displays, None, off), Some(displays[0]));
        let on_second = Rect { x: 2000.0, y: 0.0, width: 100.0, height: 100.0 };
        assert_eq!(pick_display(&displays, Some(0), on_second), Some(displays[1]));
        assert_eq!(pick_display(&[], Some(0), on_second), None);
    }

    /// A GTK window on Wayland as far as sizes go: `gtk_window_resize`
    /// sets the content size and `gtk_window_get_size` reads it, while the
    /// GDK window around it (the size tao's configure events report) is
    /// larger by the client-side decorations, 52 x 89 for a GTK 3.24 window
    /// under mutter.
    struct CsdWindow {
        content: std::cell::Cell<Size>,
    }

    impl CsdWindow {
        fn gtk_window_get_size(&self) -> (i32, i32) {
            let size = self.content.get();
            (size.width as i32, size.height as i32)
        }

        /// The bounds as `main_window::window_bounds` reads them, at 0, 0
        /// as on Wayland.
        fn bounds(&self) -> Rect {
            let size = main_window::gtk_content_size(self.gtk_window_get_size());
            Rect { x: 0.0, y: 0.0, width: size.width, height: size.height }
        }
    }

    impl ApplyHints for CsdWindow {
        fn apply_hints(&self, _hints: Hints, _change: Change) -> Result<(), String> {
            Ok(())
        }
    }

    impl WindowPort for CsdWindow {
        /// `gtk_set_bounds` on Wayland: `gtk_window_resize`, no move.
        fn set_bounds(&self, bounds: Rect) {
            self.content.set(bounds.size());
        }

        fn is_destroyed(&self) -> bool {
            false
        }
    }

    fn run_to_end(window: &CsdWindow, controller: &mut Controller, animation: Option<Animation>) {
        let mut animation = animation.unwrap();
        while controller.tick(window, &mut animation) == Tick::Continue {}
    }

    #[test]
    fn leaving_compact_mode_gives_a_decorated_gtk_window_its_size_back() {
        let normal = Size { width: 1547.0, height: 1024.0 };
        let window = CsdWindow { content: std::cell::Cell::new(normal) };
        let display = Display {
            bounds: Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1200.0 },
            work_area: Rect { x: 0.0, y: 0.0, width: 1920.0, height: 1200.0 },
        };
        let mut controller = Controller::new(Some(crate::window_bounds::MIN_SIZE));
        for _ in 0..2 {
            let compact = Size { width: 400.0, height: 157.0 };
            let enter = controller.enter(&window, window.bounds(), native::NO_FRAME, Some(compact));
            run_to_end(&window, &mut controller, enter);
            assert_eq!(window.content.get(), compact);
            let leave = controller.leave(&window, window.bounds(), Some(&display));
            assert_eq!(leave.size, compact, "the answer is the compact content size");
            run_to_end(&window, &mut controller, leave.animation);
            assert_eq!(window.content.get(), normal);
        }
    }

    #[test]
    fn only_the_app_runtime_lists_monitors_and_has_gtk_windows() {
        assert!(is_app_runtime::<tauri::Wry>());
        assert!(!is_app_runtime::<tauri::test::MockRuntime>());
        assert_eq!(has_gtk_window::<tauri::Wry>(), cfg!(target_os = "linux"));
        assert!(!has_gtk_window::<tauri::test::MockRuntime>());
    }
}
