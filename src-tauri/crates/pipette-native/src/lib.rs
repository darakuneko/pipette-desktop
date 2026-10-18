// SPDX-License-Identifier: GPL-2.0-or-later
//! The window calls Tauri and tao do not make on Windows and macOS, made as
//! Electron's `BrowserWindow` makes them there:
//!
//! - [`set_opacity`]: `setOpacity`. Windows: the window becomes a layered
//!   window (`WS_EX_LAYERED`) with `SetLayeredWindowAttributes`' alpha;
//!   macOS: `NSWindow.alphaValue`.
//! - [`set_outer_frame`] (macOS): `setBounds`, the frame set at once.
//! - [`set_content_aspect_ratio`]: `setAspectRatio(ratio, extraSize)` with
//!   the frame (outer minus content size) as `extraSize`, so the content
//!   keeps the ratio while the user resizes the window; the app's own
//!   resizes are not bent to it. Windows: a subclass procedure fits each
//!   `WM_SIZING` rectangle (aspect.rs); macOS: `NSWindow.contentAspectRatio`.
//!
//! This is the one crate of the workspace with unsafe code, and only its
//! system modules (windows.rs, macos.rs) have any. Every function here is
//! safe to call: each takes the window's native handle from a borrowed
//! window, checks that it runs on the thread the window belongs to (the
//! main thread), and on other systems does nothing but answer
//! [`Error::Unsupported`].

// Only the Windows subclass procedure resizes by it; the tests run everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
mod aspect;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod macos;
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows;

use raw_window_handle::HasWindowHandle;

/// Why a window call did nothing.
#[derive(Debug, PartialEq, thiserror::Error)]
pub enum Error {
    #[error("this system has no native window call here")]
    Unsupported,
    #[error("the window has no native handle: {0}")]
    NoHandle(String),
    #[error("the window's handle is not a {0} handle")]
    WrongHandle(&'static str),
    #[error("the window belongs to another thread")]
    WrongThread,
    #[error("{call} failed with error {code}")]
    Os { call: &'static str, code: u32 },
}

/// Sets the opacity of `window` to `opacity`, clamped to 0..=1 as Electron
/// clamps it (anything but a number is 1). Must run on the window's thread.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(unused_variables))]
pub fn set_opacity(window: &impl HasWindowHandle, opacity: f64) -> Result<(), Error> {
    let opacity = clamp_opacity(opacity);
    #[cfg(windows)]
    return windows::set_opacity(window, opacity);
    #[cfg(target_os = "macos")]
    return macos::set_opacity(window, opacity);
    #[cfg(not(any(windows, target_os = "macos")))]
    Err(Error::Unsupported)
}

/// Keeps the content of `window` at `ratio` (width / height) while the user
/// resizes it, or releases the ratio for None or a ratio that is not a
/// positive finite number. Must run on the window's thread.
#[cfg_attr(not(any(windows, target_os = "macos")), allow(unused_variables))]
pub fn set_content_aspect_ratio(window: &impl HasWindowHandle, ratio: Option<f64>) -> Result<(), Error> {
    let ratio = ratio.filter(|ratio| ratio.is_finite() && *ratio > 0.0);
    #[cfg(windows)]
    return windows::set_content_aspect_ratio(window, ratio);
    #[cfg(target_os = "macos")]
    return macos::set_content_aspect_ratio(window, ratio);
    #[cfg(not(any(windows, target_os = "macos")))]
    Err(Error::Unsupported)
}

/// A window's outer rectangle, frame included, in points: the position of
/// its top-left corner from the top-left corner of the first screen, y
/// growing downwards (the coordinates Tauri's positions have on macOS).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OuterFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Moves and resizes `window` to `frame` in one step, on macOS only (where
/// setting the position and then the content size moves the top-left
/// corner); [`Error::Unsupported`] elsewhere. Must run on the main thread.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn set_outer_frame(window: &impl HasWindowHandle, frame: OuterFrame) -> Result<(), Error> {
    #[cfg(target_os = "macos")]
    return macos::set_outer_frame(window, frame);
    #[cfg(not(target_os = "macos"))]
    Err(Error::Unsupported)
}

/// `std::clamp(opacity, 0.0, 1.0)`, and 1 for NaN.
fn clamp_opacity(opacity: f64) -> f64 {
    if opacity.is_nan() { 1.0 } else { opacity.clamp(0.0, 1.0) }
}

/// The alpha byte of a layered window at `opacity` (0..=1): Electron passes
/// `opacity * 255` to the `BYTE` parameter of `SetLayeredWindowAttributes`,
/// a conversion that drops the fraction.
#[cfg_attr(not(windows), allow(dead_code))]
fn alpha_byte(opacity: f64) -> u8 {
    (opacity * 255.0) as u8
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_opacity_is_clamped_to_the_unit_range() {
        for (opacity, clamped) in [(-1.0, 0.0), (0.0, 0.0), (0.5, 0.5), (1.0, 1.0), (7.0, 1.0)] {
            assert_eq!(clamp_opacity(opacity), clamped, "{opacity}");
        }
        assert_eq!(clamp_opacity(f64::NAN), 1.0);
        assert_eq!(clamp_opacity(f64::INFINITY), 1.0);
        assert_eq!(clamp_opacity(f64::NEG_INFINITY), 0.0);
    }

    #[test]
    fn the_alpha_byte_drops_the_fraction() {
        for (opacity, alpha) in [(0.0, 0), (0.5, 127), (0.75, 191), (0.9, 229), (0.999, 254), (1.0, 255)] {
            assert_eq!(alpha_byte(opacity), alpha, "{opacity}");
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn other_systems_answer_unsupported() {
        struct NoWindow;
        impl HasWindowHandle for NoWindow {
            fn window_handle(
                &self,
            ) -> Result<raw_window_handle::WindowHandle<'_>, raw_window_handle::HandleError> {
                Err(raw_window_handle::HandleError::Unavailable)
            }
        }
        assert_eq!(set_opacity(&NoWindow, 0.5), Err(Error::Unsupported));
        assert_eq!(set_content_aspect_ratio(&NoWindow, Some(2.0)), Err(Error::Unsupported));
        let frame = OuterFrame { x: 0.0, y: 0.0, width: 1.0, height: 1.0 };
        assert_eq!(set_outer_frame(&NoWindow, frame), Err(Error::Unsupported));
    }
}
