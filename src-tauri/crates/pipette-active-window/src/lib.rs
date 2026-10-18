// SPDX-License-Identifier: GPL-2.0-or-later
//! The name of the active application that typing analytics tags each
//! minute with, read the way the Electron build reads it (the
//! `@paymoapp/active-window` binding, then the GNOME Shell query), so the
//! two builds on one machine record the same application under the same
//! name.
//!
//! The order of [`ActiveWindow::app_name`]: the normalized application name
//! of the native lookup; if it is empty, the normalized window title; if that
//! is empty too, or the lookup is missing, fails or finds no window, the
//! GNOME Shell query ([`GnomeFocusedWindow`], Linux only); otherwise `None`.
//!
//! The native lookup is opened at the first [`ActiveWindow::app_name`], as
//! app-monitor.ts loads the binding, and only once: when it cannot be opened
//! there is no native lookup for the app's lifetime.
//!
//! Linux has the X11 lookup ([`X11Backend`]), checked against the binding on
//! a private X server. Windows and macOS have no native lookup here yet, so
//! their name is `None`.
//!
//! Callers check the Monitor App setting (`typingMonitorAppEnabled`) before
//! asking, once per analytics flush; the crate keeps no timer.

mod gnome;
mod normalize;
#[cfg(target_os = "linux")]
mod x11;

pub use gnome::{
    CommandRunner, GDBUS_COMMAND, GDBUS_TIMEOUT, GnomeFocusedWindow, SystemCommandRunner,
    parse_focused_window_reply,
};
pub use normalize::{MAX_NAME_LENGTH, normalize};
use pipette_js_json::JsString;
#[cfg(target_os = "linux")]
pub use x11::{NO_ACTIVE_WINDOW, X11Backend};

/// The active window as a native lookup reports it, either part possibly
/// empty.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowInfo {
    pub application: JsString,
    pub title: JsString,
}

pub type NativeError = Box<dyn std::error::Error + Send + Sync>;

/// An OS's own lookup of the active window. `Ok(None)` when there is no
/// active window.
pub trait NativeBackend: Send {
    fn active_window(&mut self) -> Result<Option<WindowInfo>, NativeError>;
}

/// Opens a native lookup.
pub type NativeLoader = Box<dyn FnOnce() -> Result<Box<dyn NativeBackend>, NativeError> + Send>;

enum Native {
    NotLoaded(NativeLoader),
    Loaded(Option<Box<dyn NativeBackend>>),
}

/// The lookup with its fallbacks, in the order of the module documentation.
pub struct ActiveWindow {
    native: Native,
    focused_window: Option<GnomeFocusedWindow>,
    warned: bool,
}

impl ActiveWindow {
    /// `native` is `None` when the OS has no native lookup or it failed to
    /// start; `focused_window` is the GNOME Shell query, given on Linux only.
    /// On Linux a failing native lookup is expected (Wayland keeps window
    /// focus from other clients) and only logged elsewhere, once.
    pub fn new(native: Option<Box<dyn NativeBackend>>, focused_window: Option<GnomeFocusedWindow>) -> Self {
        Self { native: Native::Loaded(native), focused_window, warned: false }
    }

    /// The lookup whose native part `load` opens at the first
    /// [`ActiveWindow::app_name`]. When it fails, that is logged once and
    /// there is no native lookup from then on.
    pub fn with_loader(load: NativeLoader, focused_window: Option<GnomeFocusedWindow>) -> Self {
        Self { native: Native::NotLoaded(load), focused_window, warned: false }
    }

    /// The lookup for the OS this runs on.
    #[cfg(target_os = "linux")]
    pub fn for_current_os() -> Self {
        let load: NativeLoader =
            Box::new(|| X11Backend::from_env().map(|backend| Box::new(backend) as Box<dyn NativeBackend>));
        Self::with_loader(load, Some(GnomeFocusedWindow::system()))
    }

    /// The lookup for the OS this runs on.
    #[cfg(not(target_os = "linux"))]
    pub fn for_current_os() -> Self {
        Self::new(None, None)
    }

    fn warn_once(&mut self, what: &str, err: &NativeError) {
        if !self.warned {
            self.warned = true;
            log::warn!("[app-monitor] {what}: {err}");
        }
    }

    fn native(&mut self) -> Option<&mut Box<dyn NativeBackend>> {
        self.native = match std::mem::replace(&mut self.native, Native::Loaded(None)) {
            Native::NotLoaded(load) => match load() {
                Ok(native) => Native::Loaded(Some(native)),
                Err(err) => {
                    self.warn_once("failed to load active-window", &err);
                    Native::Loaded(None)
                }
            },
            loaded => loaded,
        };
        match &mut self.native {
            Native::Loaded(native) => native.as_mut(),
            Native::NotLoaded(_) => None,
        }
    }

    /// The normalized name of the active application. Blocks for up to
    /// [`GDBUS_TIMEOUT`] when it runs the GNOME Shell query.
    pub fn app_name(&mut self) -> Option<JsString> {
        match self.native().map(|native| native.active_window()) {
            Some(Ok(Some(info))) => {
                let name = normalize(&info.application.utf16_units())
                    .or_else(|| normalize(&info.title.utf16_units()));
                if name.is_some() {
                    return name;
                }
            }
            Some(Err(err)) if self.focused_window.is_none() => self.warn_once("getActiveWindow threw", &err),
            _ => {}
        }
        self.focused_window.as_ref()?.app_name()
    }
}

#[cfg(test)]
mod golden_tests;
#[cfg(test)]
mod tests;
