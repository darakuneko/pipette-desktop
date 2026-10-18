// SPDX-License-Identifier: GPL-2.0-or-later
//! The window on Windows and macOS, where Electron's bounds include the
//! frame the system draws around the content: `getBounds` /
//! `setBounds` / `setMinimumSize` and the saved `windowState` are the outer
//! rectangle there, while Tauri sets the content size and the content's
//! minimum size. The frame (outer minus content size) converts between the
//! two. The opacity and the aspect ratio go through pipette-native, on the
//! main thread.
//!
//! Only the app's runtime has native windows; the runtime of tauri::test
//! takes the sizes as they are, and Linux's bounds have no frame (mod.rs).

use tauri::{LogicalSize, Runtime, Window};

use super::geometry::Hints;
use super::is_app_runtime;
use crate::window_bounds::Size;

/// No frame, as on Linux.
pub const NO_FRAME: Size = Size { width: 0.0, height: 0.0 };

/// Whether `R`'s windows are Windows or macOS windows, with a frame in their
/// bounds and pipette-native's calls.
pub fn is_native<R: Runtime>() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos")) && is_app_runtime::<R>()
}

/// The frame of `window` in DIP: its outer minus its content size, none
/// where the bounds have no frame or the sizes cannot be read.
pub fn frame<R: Runtime>(window: &Window<R>) -> Size {
    if !is_native::<R>() {
        return NO_FRAME;
    }
    let read = || -> tauri::Result<Size> {
        let scale = window.scale_factor()?;
        let outer = window.outer_size()?.to_logical::<f64>(scale);
        let inner = window.inner_size()?.to_logical::<f64>(scale);
        Ok(Size {
            width: (outer.width - inner.width).max(0.0),
            height: (outer.height - inner.height).max(0.0),
        })
    };
    read().unwrap_or_else(|err| {
        log::error!("[window] failed to read the window frame: {err}");
        NO_FRAME
    })
}

/// The content size of a window whose outer size is `size`.
pub fn content_size(size: Size, frame: Size) -> Size {
    Size { width: (size.width - frame.width).max(0.0), height: (size.height - frame.height).max(0.0) }
}

/// Gives a window that opened with `size` and `min_size` as its content's
/// the outer size and minimum size they are on Windows and macOS: Tauri
/// opens a window by its content size, and the frame is known only once the
/// window exists. A window that opened centered is centered again at its
/// new size.
pub fn fit_opening_frame<R: Runtime>(window: &Window<R>, size: Size, min_size: Size, centered: bool) {
    let frame = frame(window);
    if frame == NO_FRAME {
        return;
    }
    let min_size = content_size(min_size, frame);
    let size = content_size(size, frame);
    let result = window
        .set_min_size(Some(LogicalSize::new(min_size.width, min_size.height)))
        .and_then(|()| window.set_size(LogicalSize::new(size.width, size.height)))
        .and_then(|()| if centered { window.center() } else { Ok(()) });
    if let Err(err) = result {
        log::error!("[window] failed to fit the window to its frame: {err}");
    }
}

/// Applies `hints` to a window without GTK: the minimum size (outer, as
/// Electron's) as the content's, and on Windows and macOS the aspect ratio.
/// On the main thread.
pub fn apply_hints<R: Runtime>(window: &Window<R>, hints: Hints) -> Result<(), String> {
    let frame = frame(window);
    let min_size = hints.min_size.map(|(width, height)| {
        let content = content_size(Size { width: width.into(), height: height.into() }, frame);
        LogicalSize::new(content.width, content.height)
    });
    window.set_min_size(min_size).map_err(|err| err.to_string())?;
    if is_native::<R>() {
        pipette_native::set_content_aspect_ratio(window, hints.aspect).map_err(|err| err.to_string())?;
    }
    Ok(())
}

/// Sets the opacity of `window` (0..=1) on the main thread, on Windows and
/// macOS; elsewhere nothing, as Electron's `setOpacity` does nothing on
/// Linux.
pub fn set_opacity<R: Runtime>(window: &Window<R>, opacity: f64) {
    if !is_native::<R>() {
        return;
    }
    let target = window.clone();
    let result = window.run_on_main_thread(move || {
        if let Err(err) = pipette_native::set_opacity(&target, opacity) {
            log::error!("[window] failed to set the window opacity: {err}");
        }
    });
    if let Err(err) = result {
        log::error!("[window] failed to set the window opacity: {err}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_content_size_is_the_outer_size_less_the_frame() {
        let frame = Size { width: 16.0, height: 39.0 };
        assert_eq!(
            content_size(Size { width: 1280.0, height: 1024.0 }, frame),
            Size { width: 1264.0, height: 985.0 }
        );
        assert_eq!(content_size(Size { width: 10.0, height: 10.0 }, frame), Size { width: 0.0, height: 0.0 });
        assert_eq!(
            content_size(Size { width: 300.0, height: 100.0 }, NO_FRAME),
            Size { width: 300.0, height: 100.0 }
        );
    }

    #[test]
    fn only_the_app_runtime_on_windows_and_macos_is_native() {
        assert_eq!(is_native::<tauri::Wry>(), cfg!(any(target_os = "windows", target_os = "macos")));
        assert!(!is_native::<tauri::test::MockRuntime>());
    }
}
