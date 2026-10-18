// SPDX-License-Identifier: GPL-2.0-or-later
//! The main window's geometry beyond opening and closing it: the Typing
//! Test's view-only window (compact mode, aspect ratio, always on top,
//! opacity, minimum size; the commands of window_commands.rs) and the window
//! system's changes to it. Every window event but the close request
//! (src/lifecycle.rs) comes here: after a move the window gets the minimum
//! size of the display it is on (`main_window::update_min_size`), and a
//! change of the displays or of the scale factor fits it into its work area
//! (display.rs).
//!
//! The decisions are compact.rs's and geometry.rs's; this module reads the
//! window for them and applies what they decide. The window's bounds here
//! are its outer position and content size in DIP, the rectangle the app
//! saves as `windowState` (main_window.rs), so the window has no frame to
//! add or take off: the size of compact mode and the aspect ratio apply to
//! the content as given. Electron's bounds on Linux have no frame either.

pub mod always_on_top;
pub mod compact;
pub mod display;
pub mod geometry;
pub mod opacity;

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tauri::{LogicalPosition, LogicalSize, Manager, Runtime, Window, WindowEvent};

use crate::main_window::{self, MAIN_WINDOW};
use crate::window_bounds::{Rect, Size};
use crate::window_state::{Display, display_matching};
use compact::{Animation, Controller, STEP_MS, Tick, WindowPort};
use display::DisplayWatch;
use geometry::{ApplyHints, Change, Hints};

/// The frame of the window's bounds: none (see the module comment).
const NO_FRAME: Size = Size { width: 0.0, height: 0.0 };

/// What the handlers keep about the window.
#[derive(Default)]
struct WindowOps(Mutex<Inner>);

#[derive(Default)]
struct Inner {
    /// None until first needed, and again once the window is gone.
    controller: Option<Controller>,
    displays: DisplayWatch,
    always_on_top: bool,
}

/// The handlers' state, managed on first use.
fn lock<R: Runtime>(window: &Window<R>) -> MutexGuard<'_, Inner> {
    if window.try_state::<WindowOps>().is_none() {
        window.manage(WindowOps::default());
    }
    window.state::<WindowOps>().inner().0.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Runs `f` on the controller, which starts from the minimum size the
/// window opened with.
fn with_controller<R: Runtime, T>(window: &Window<R>, f: impl FnOnce(&mut Controller) -> T) -> T {
    let mut inner = lock(window);
    let controller = inner
        .controller
        .get_or_insert_with(|| Controller::new(main_window::opening_min_size(window.app_handle())));
    f(controller)
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
    let port = Port(window.clone());
    with_controller(window, |controller| controller.geometry.apply_min_size_if_changed(&port, min_size))
}

pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    match event {
        WindowEvent::Moved(_) => {
            main_window::update_min_size(window);
            check_displays(window, false);
        }
        WindowEvent::Resized(_) => check_displays(window, false),
        WindowEvent::ScaleFactorChanged { .. } => check_displays(window, true),
        WindowEvent::Destroyed => *lock(window) = Inner::default(),
        _ => {}
    }
}

/// Fits the window into its work area when the displays changed since the
/// last look, or `scale_changed`.
fn check_displays<R: Runtime>(window: &Window<R>, scale_changed: bool) {
    let (displays, primary) = main_window::displays(window.app_handle());
    let changed = lock(window).displays.changed(&displays);
    if !changed && !scale_changed {
        return;
    }
    let Some(bounds) = read_bounds(window) else {
        return;
    };
    let display = pick_display(&displays, primary, bounds);
    let maximized_or_full_screen =
        window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false);
    let port = Port(window.clone());
    with_controller(window, |controller| {
        controller.work_area_changed(&port, bounds, display.as_ref(), maximized_or_full_screen);
    });
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

/// Enters or leaves compact mode (the WINDOW_SET_COMPACT_MODE handler).
/// Entering answers None at once and animates on; leaving answers the size
/// before it, once its animation has ended.
pub async fn set_compact_mode<R: Runtime>(
    window: &Window<R>,
    enabled: bool,
    compact_size: Option<Size>,
) -> Option<WindowSize> {
    let bounds = read_bounds(window)?;
    let port = Port(window.clone());
    if enabled {
        let started = with_controller(window, |controller| {
            let mut animation = controller.enter(&port, bounds, NO_FRAME, compact_size)?;
            Some((controller.tick(&port, &mut animation), animation))
        });
        if let Some((Tick::Continue, animation)) = started {
            tauri::async_runtime::spawn(animate(port, animation));
        }
        return None;
    }
    let (displays, primary) = main_window::displays(window.app_handle());
    let display = pick_display(&displays, primary, bounds);
    let (leave, first) = with_controller(window, |controller| {
        let mut leave = controller.leave(&port, bounds, display.as_ref());
        let first = leave.animation.as_mut().map(|animation| controller.tick(&port, animation));
        (leave, first)
    });
    if let (Some(animation), Some(Tick::Continue)) = (leave.animation, first) {
        animate(port, animation).await;
    }
    Some(leave.size.into())
}

/// The steps of `animation` after its first, one every [`STEP_MS`], until
/// it is done.
async fn animate<R: Runtime>(port: Port<R>, mut animation: Animation) {
    loop {
        tokio::time::sleep(Duration::from_millis(STEP_MS)).await;
        let tick = with_controller(&port.0, |controller| controller.tick(&port, &mut animation));
        if let Tick::Done { .. } = tick {
            return;
        }
    }
}

/// Sets or releases the aspect ratio (the WINDOW_SET_ASPECT_RATIO handler).
pub fn set_aspect_ratio<R: Runtime>(window: &Window<R>, ratio: f64) {
    let port = Port(window.clone());
    with_controller(window, |controller| controller.geometry.set_aspect_ratio(&port, ratio, NO_FRAME));
}

/// The WINDOW_SET_MIN_SIZE handler.
pub fn set_min_size<R: Runtime>(window: &Window<R>, width: f64, height: f64) {
    let port = Port(window.clone());
    with_controller(window, |controller| controller.set_min_size(&port, width, height));
}

pub fn set_always_on_top<R: Runtime>(window: &Window<R>, enabled: bool) {
    match window.set_always_on_top(enabled) {
        Ok(()) => lock(window).always_on_top = enabled,
        Err(err) => log::error!("[window] failed to set always on top: {err}"),
    }
}

/// The window's geometry as this module applied it.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowReport {
    /// The content size.
    pub size: WindowSize,
    pub min_size: Option<WindowSize>,
    pub hints: HintsReport,
    pub always_on_top: bool,
    pub compact: bool,
    pub normal_size: Option<WindowSize>,
}

/// The geometry hints last applied, in whole logical pixels.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HintsReport {
    pub mask: Vec<&'static str>,
    pub min_size: Option<WindowSize>,
    pub aspect: Option<f64>,
}

pub fn report<R: Runtime>(window: &Window<R>) -> Result<WindowReport, String> {
    let size = window
        .scale_factor()
        .and_then(|scale| Ok(window.inner_size()?.to_logical::<f64>(scale)))
        .map_err(|err| err.to_string())?;
    let controller = with_controller(window, |controller| *controller);
    let hints = geometry::hints(&controller.geometry);
    Ok(WindowReport {
        size: WindowSize { width: size.width, height: size.height },
        min_size: controller.geometry.min_size.map(Into::into),
        hints: HintsReport {
            mask: hints.mask(),
            min_size: hints
                .min_size
                .map(|(width, height)| WindowSize { width: width.into(), height: height.into() }),
            aspect: hints.aspect,
        },
        always_on_top: lock(window).always_on_top,
        compact: controller.in_compact_mode(),
        normal_size: controller.normal_size().map(Into::into),
    })
}

/// The window as the decisions see it.
struct Port<R: Runtime>(Window<R>);

/// Whether the window is a GTK one: the runtime of tauri::test has none
/// (its windows panic when asked for one), and takes the changes through
/// Tauri's own calls.
#[cfg(target_os = "linux")]
fn has_gtk_window<R: Runtime>() -> bool {
    std::any::TypeId::of::<R>() == std::any::TypeId::of::<tauri::Wry>()
}

impl<R: Runtime> ApplyHints for Port<R> {
    fn apply_hints(&self, hints: Hints, change: Change) -> Result<(), String> {
        log::debug!("[window] geometry {change:?}: {hints:?}");
        #[cfg(target_os = "linux")]
        if has_gtk_window::<R>() {
            let window = self.0.clone();
            return self
                .0
                .run_on_main_thread(move || gtk_apply_hints(&window, hints))
                .map_err(|err| err.to_string());
        }
        if hints.aspect.is_some() && cfg!(not(target_os = "linux")) {
            log::warn!("[window] this build does not set an aspect ratio on this system");
        }
        let min_size = hints.min_size.map(|(width, height)| LogicalSize::new(width, height));
        self.0.set_min_size(min_size).map_err(|err| err.to_string())
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
        let result = self
            .0
            .set_position(LogicalPosition::new(bounds.x, bounds.y))
            .and_then(|()| self.0.set_size(LogicalSize::new(bounds.width, bounds.height)));
        if let Err(err) = result {
            log::error!("[window] failed to set the window bounds: {err}");
        }
    }

    fn is_destroyed(&self) -> bool {
        self.0.app_handle().get_webview_window(self.0.label()).is_none()
    }
}

/// Applies `hints` as the GTK window's one set of geometry hints. On the
/// main thread, as every GTK call; the window's moves and resizes go the
/// same way, so they keep their order with it.
#[cfg(target_os = "linux")]
fn gtk_apply_hints<R: Runtime>(window: &Window<R>, hints: Hints) {
    use gtk::gdk::{Geometry, Gravity, WindowHints};
    use gtk::prelude::GtkWindowExt;
    let gtk_window = match window.gtk_window() {
        Ok(gtk_window) => gtk_window,
        Err(err) => return log::error!("[window] failed to get the GTK window: {err}"),
    };
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
}

/// Resizes the GTK window to the content size of `bounds`, and moves it to
/// their position where the window system lets an app place its windows
/// (not on Wayland).
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

    #[cfg(target_os = "linux")]
    #[test]
    fn only_the_app_runtime_has_gtk_windows() {
        assert!(has_gtk_window::<tauri::Wry>());
        assert!(!has_gtk_window::<tauri::test::MockRuntime>());
    }
}
