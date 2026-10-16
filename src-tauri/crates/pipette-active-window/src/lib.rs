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
//! No OS has a native lookup here yet: each is added once its names have been
//! checked against the Electron build for the same window. Until then every
//! lookup goes to the GNOME Shell query, so on Linux the name comes from
//! GNOME Shell with the FocusedWindow extension and is `None` elsewhere
//! (other compositors, X11 sessions without GNOME Shell, Windows, macOS).
//!
//! Callers check the Monitor App setting (`typingMonitorAppEnabled`) before
//! asking, once per analytics flush; the crate keeps no timer.

mod gnome;
mod normalize;

pub use gnome::{
    CommandRunner, GDBUS_COMMAND, GDBUS_TIMEOUT, GnomeFocusedWindow, SystemCommandRunner,
    parse_focused_window_reply,
};
pub use normalize::{MAX_NAME_LENGTH, normalize};
use pipette_js_json::JsString;

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

/// The lookup with its fallbacks, in the order of the module documentation.
pub struct ActiveWindow {
    native: Option<Box<dyn NativeBackend>>,
    focused_window: Option<GnomeFocusedWindow>,
    warned: bool,
}

impl ActiveWindow {
    /// `native` is `None` when the OS has no native lookup or it failed to
    /// start; `focused_window` is the GNOME Shell query, given on Linux only.
    /// On Linux a failing native lookup is expected (Wayland keeps window
    /// focus from other clients) and only logged elsewhere, once.
    pub fn new(native: Option<Box<dyn NativeBackend>>, focused_window: Option<GnomeFocusedWindow>) -> Self {
        Self { native, focused_window, warned: false }
    }

    /// The lookup for the OS this runs on.
    pub fn for_current_os() -> Self {
        Self::new(None, cfg!(target_os = "linux").then(GnomeFocusedWindow::system))
    }

    /// The normalized name of the active application. Blocks for up to
    /// [`GDBUS_TIMEOUT`] when it runs the GNOME Shell query.
    pub fn app_name(&mut self) -> Option<JsString> {
        if let Some(native) = self.native.as_mut() {
            match native.active_window() {
                Ok(Some(info)) => {
                    let name = normalize(&info.application.utf16_units())
                        .or_else(|| normalize(&info.title.utf16_units()));
                    if name.is_some() {
                        return name;
                    }
                }
                Ok(None) => {}
                Err(err) => {
                    if self.focused_window.is_none() && !self.warned {
                        self.warned = true;
                        log::warn!("[app-monitor] getActiveWindow threw: {err}");
                    }
                }
            }
        }
        self.focused_window.as_ref()?.app_name()
    }
}

#[cfg(test)]
mod golden_tests;
#[cfg(test)]
mod tests;
