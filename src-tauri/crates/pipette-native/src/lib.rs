// SPDX-License-Identifier: GPL-2.0-or-later
//! The window calls Tauri and tao do not make on Windows and macOS:
//!
//! - [`set_opacity`]: Windows: the window becomes a layered window
//!   (`WS_EX_LAYERED`) with `SetLayeredWindowAttributes`' alpha; macOS:
//!   `NSWindow.alphaValue`.
//! - [`set_outer_frame`] (macOS): the frame set at once.
//! - [`frame_size`] (macOS): the outer size less the content size.
//! - [`set_content_aspect_ratio`]: an aspect ratio with the frame (outer
//!   minus content size) left out of it, so the content keeps the ratio while
//!   the user resizes the window; the app's own resizes are not bent to it.
//!   Windows: a subclass procedure fits each `WM_SIZING` rectangle (aspect.rs);
//!   macOS: `NSWindow.contentAspectRatio`.
//!
//! And [`active_window`], the application and title of the window in front,
//! as the 0.4 build's `@paymoapp/active-window` read them (Windows:
//! windows_active_window.rs and app_name.rs, macOS: macos_active_window.rs).
//!
//! This is the one crate of the workspace with unsafe code, and only its
//! system modules (windows.rs, windows_active_window.rs, macos.rs) have
//! any. Every function here is safe to call: each window call takes the
//! window's native handle from a borrowed window and checks that it runs on
//! the thread the window belongs to (the main thread); the active window
//! lookup runs on any thread. On other systems they do nothing but answer
//! [`Error::Unsupported`].

// Only the Windows lookup names applications by it; the tests run everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
mod app_name;
// Only the Windows subclass procedure resizes by it; the tests run everywhere.
#[cfg_attr(not(windows), allow(dead_code))]
mod aspect;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)]
mod macos;
#[cfg(target_os = "macos")]
mod macos_active_window;
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows;
#[cfg(windows)]
#[allow(unsafe_code)]
mod windows_active_window;

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

/// Sets the opacity of `window` to `opacity`, clamped to 0..=1 (anything
/// but a number is 1). Must run on the window's thread.
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

/// The size of a window's frame in points: its outer size less the area
/// its content is shown in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameSize {
    pub width: f64,
    pub height: f64,
}

/// The frame of `window` on macOS: its `frame` less its
/// `contentLayoutRect`, the part of the window the title bar does not
/// cover, which is the web content's viewport. Tauri's inner size is the
/// webview's frame instead, which is not that area on every macOS version
/// (it has been seen to be the whole window, title bar included).
/// [`Error::Unsupported`] elsewhere. Must run on the main thread.
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
pub fn frame_size(window: &impl HasWindowHandle) -> Result<FrameSize, Error> {
    #[cfg(target_os = "macos")]
    return macos::frame_size(window);
    #[cfg(not(target_os = "macos"))]
    Err(Error::Unsupported)
}

/// The frame of a window of `outer` size whose content is shown in an area
/// of `content` size, each side at least 0.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn frame_between(outer: (f64, f64), content: (f64, f64)) -> FrameSize {
    FrameSize { width: (outer.0 - content.0).max(0.0), height: (outer.1 - content.1).max(0.0) }
}

/// The window in front as [`active_window`] reads it: the application's
/// name and the window's title, in UTF-16 code units (either possibly
/// empty).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ActiveWindowInfo {
    pub application: Vec<u16>,
    pub title: Vec<u16>,
}

/// The window in front, read the way `@paymoapp/active-window` reads it, or
/// `None` where the binding finds none (it throws "Failed to get active
/// window" there). Windows: the `FileDescription` of the window's
/// executable (its file name when that is empty; for a UWP app, the
/// executable of the app's packaged process) and the window's title. macOS:
/// the frontmost application's localized name, and no title. Runs on any
/// thread and never waits on a window.
pub fn active_window() -> Result<Option<ActiveWindowInfo>, Error> {
    #[cfg(windows)]
    return Ok(windows_active_window::active_window());
    #[cfg(target_os = "macos")]
    return Ok(macos_active_window::active_window());
    #[cfg(not(any(windows, target_os = "macos")))]
    Err(Error::Unsupported)
}

/// `std::clamp(opacity, 0.0, 1.0)`, and 1 for NaN.
fn clamp_opacity(opacity: f64) -> f64 {
    if opacity.is_nan() { 1.0 } else { opacity.clamp(0.0, 1.0) }
}

/// The alpha byte of a layered window at `opacity` (0..=1): `opacity * 255`
/// with the fraction dropped.
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

    #[test]
    fn the_frame_is_the_outer_size_less_the_content_area() {
        assert_eq!(frame_between((310.0, 340.0), (310.0, 308.0)), FrameSize { width: 0.0, height: 32.0 });
        // A content area as large as the window, or larger, leaves no frame.
        assert_eq!(frame_between((310.0, 308.0), (310.0, 308.0)), FrameSize { width: 0.0, height: 0.0 });
        assert_eq!(frame_between((300.0, 100.0), (302.0, 140.0)), FrameSize { width: 0.0, height: 0.0 });
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
        assert_eq!(frame_size(&NoWindow), Err(Error::Unsupported));
        assert_eq!(active_window(), Err(Error::Unsupported));
    }
}
