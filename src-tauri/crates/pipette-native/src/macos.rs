// SPDX-License-Identifier: GPL-2.0-or-later
//! The AppKit calls, on the main thread only (AppKit's windows are main
//! thread objects). The opacity is the window's `alphaValue`; the aspect
//! ratio is the `contentAspectRatio` of a window with a frame, which AppKit
//! keeps while the user resizes the window, and is released with
//! `resizeIncrements` of 1 × 1. AppKit keeps the
//! window's and the content's ratio apart (the latest of `contentAspectRatio`
//! and `contentResizeIncrements` wins, and so for `aspectRatio` and
//! `resizeIncrements`), so the release here also sets the content's
//! increments, which is what lets go of a content ratio.
//!
//! A window's frame size is its `frame` less its `contentLayoutRect`, the
//! area the title bar leaves to the content (the content view's frame,
//! or less of it when the content view extends under the title bar), and
//! never the webview's frame.
//!
//! A window's frame is set in one `setFrame:display:`: Tauri's setters set
//! the position and the content size apart, and `setContentSize:` keeps the
//! bottom edge where it is, so a resize after a move shifts the top-left
//! corner by the change of height.

use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2_app_kit::{NSScreen, NSView, NSWindow};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use raw_window_handle::{HasWindowHandle, RawWindowHandle};

use crate::{Error, FrameSize, OuterFrame, frame_between};

/// The NSWindow of `window`; `_main_thread` proves this runs on the main
/// thread.
fn ns_window(
    window: &impl HasWindowHandle,
    _main_thread: MainThreadMarker,
) -> Result<Retained<NSWindow>, Error> {
    let handle = window.window_handle().map_err(|err| Error::NoHandle(err.to_string()))?;
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return Err(Error::WrongHandle("AppKit"));
    };
    // SAFETY: an AppKit window handle's `ns_view` is a valid NSView for as
    // long as the handle borrows the window (raw-window-handle's contract
    // for a borrowed WindowHandle), and the reference does not outlive
    // `handle`. AppKit objects may be used here: the marker shows this is
    // the main thread.
    let view: &NSView = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    view.window().ok_or_else(|| Error::NoHandle("the view is in no window".into()))
}

fn main_thread() -> Result<MainThreadMarker, Error> {
    MainThreadMarker::new().ok_or(Error::WrongThread)
}

pub(crate) fn set_opacity(window: &impl HasWindowHandle, opacity: f64) -> Result<(), Error> {
    ns_window(window, main_thread()?)?.setAlphaValue(opacity);
    Ok(())
}

pub(crate) fn set_content_aspect_ratio(
    window: &impl HasWindowHandle,
    ratio: Option<f64>,
) -> Result<(), Error> {
    let ns_window = ns_window(window, main_thread()?)?;
    match ratio {
        Some(ratio) => ns_window.setContentAspectRatio(NSSize::new(ratio, 1.0)),
        None => {
            let one = NSSize::new(1.0, 1.0);
            ns_window.setResizeIncrements(one);
            ns_window.setContentResizeIncrements(one);
        }
    }
    Ok(())
}

pub(crate) fn frame_size(window: &impl HasWindowHandle) -> Result<FrameSize, Error> {
    let ns_window = ns_window(window, main_thread()?)?;
    let outer = ns_window.frame().size;
    let content = ns_window.contentLayoutRect().size;
    Ok(frame_between((outer.width, outer.height), (content.width, content.height)))
}

pub(crate) fn set_outer_frame(window: &impl HasWindowHandle, frame: OuterFrame) -> Result<(), Error> {
    let main_thread = main_thread()?;
    let ns_window = ns_window(window, main_thread)?;
    // AppKit's screen coordinates start at the bottom-left corner of the
    // first screen (the one with the menu bar) and grow upwards; the frame
    // given starts at the top-left corner of that screen and grows
    // downwards, as Tauri's positions on macOS do.
    let first_screen = NSScreen::screens(main_thread)
        .firstObject()
        .ok_or_else(|| Error::NoHandle("there is no screen".into()))?;
    let origin_y = first_screen.frame().size.height - frame.y - frame.height;
    let rect = NSRect::new(NSPoint::new(frame.x, origin_y), NSSize::new(frame.width, frame.height));
    ns_window.setFrame_display(rect, true);
    Ok(())
}
