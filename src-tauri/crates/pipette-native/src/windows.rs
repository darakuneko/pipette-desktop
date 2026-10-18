// SPDX-License-Identifier: GPL-2.0-or-later
//! The Win32 calls. Electron's `setOpacity` makes the window a layered
//! window once and sets its alpha; its `setAspectRatio` fits the rectangle
//! of every `WM_SIZING` (the user's drags only) to the ratio. Both live in
//! subclass procedures here (comctl32's `SetWindowSubclass`), installed on
//! the window's own thread and removed when the window goes
//! (`WM_NCDESTROY`):
//!
//! - the layered one adds `WS_EX_LAYERED` back to every new extended style:
//!   tao rewrites the extended style from its own flags whenever one of them
//!   changes (always on top, minimized, visible ...), which would drop the
//!   bit and with it the alpha;
//! - the aspect one carries the ratio in its reference data (the bits of an
//!   `f32`, the precision Chromium keeps the ratio in), so it needs no
//!   allocation; it reads the frame and the minimum size of the window at
//!   each `WM_SIZING`.

use std::ptr;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use windows_sys::Win32::Foundation::{GetLastError, HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GWL_EXSTYLE, GetClientRect, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId, LWA_ALPHA,
    MINMAXINFO, STYLESTRUCT, SendMessageW, SetLayeredWindowAttributes, SetWindowLongW, WM_GETMINMAXINFO,
    WM_NCDESTROY, WM_SIZING, WM_STYLECHANGING, WS_EX_LAYERED,
};

use crate::Error;
use crate::aspect::{self, Bounds, Edge, Extent};

/// The ids of the two subclass procedures on a window.
const LAYERED_ID: usize = 1;
const ASPECT_ID: usize = 2;

/// The window of `window`, when the calling thread owns it.
fn hwnd(window: &impl HasWindowHandle) -> Result<HWND, Error> {
    let handle = window.window_handle().map_err(|err| Error::NoHandle(err.to_string()))?;
    let RawWindowHandle::Win32(handle) = handle.as_raw() else {
        return Err(Error::WrongHandle("Win32"));
    };
    let hwnd = handle.hwnd.get() as HWND;
    // SAFETY: GetWindowThreadProcessId only reads which thread owns `hwnd`
    // and answers 0 for a handle that is no window; a null process id
    // pointer asks for no process id.
    let owner = unsafe { GetWindowThreadProcessId(hwnd, ptr::null_mut()) };
    // SAFETY: GetCurrentThreadId has no preconditions.
    let current = unsafe { GetCurrentThreadId() };
    if owner == 0 || owner != current {
        return Err(Error::WrongThread);
    }
    Ok(hwnd)
}

fn last_error(call: &'static str) -> Error {
    // SAFETY: GetLastError has no preconditions.
    Error::Os { call, code: unsafe { GetLastError() } }
}

/// The extended style of `hwnd`, a window of this thread.
fn ex_style(hwnd: HWND) -> u32 {
    // SAFETY: reading a window long of a window this thread owns has no
    // other precondition; a failure reads 0.
    unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 }
}

pub(crate) fn set_opacity(window: &impl HasWindowHandle, opacity: f64) -> Result<(), Error> {
    let hwnd = hwnd(window)?;
    let alpha = crate::alpha_byte(opacity);
    let style = ex_style(hwnd);
    if style & WS_EX_LAYERED == 0 {
        // An opaque window that is not layered yet looks the same as
        // Electron's layered one at 255; it stays a plain window.
        if alpha == u8::MAX {
            return Ok(());
        }
        // SAFETY: `hwnd` is a window of this thread (checked above), as
        // SetWindowSubclass requires; `keep_layered` matches SUBCLASSPROC.
        if unsafe { SetWindowSubclass(hwnd, Some(keep_layered), LAYERED_ID, 0) } == 0 {
            return Err(last_error("SetWindowSubclass"));
        }
        // SAFETY: sets only the extended style of a window of this thread;
        // the window's procedures receive WM_STYLECHANGING / WM_STYLECHANGED
        // on this thread before it returns.
        unsafe { SetWindowLongW(hwnd, GWL_EXSTYLE, (style | WS_EX_LAYERED) as i32) };
        if ex_style(hwnd) & WS_EX_LAYERED == 0 {
            return Err(last_error("SetWindowLongW"));
        }
    }
    // SAFETY: `hwnd` is a layered window of this thread; the color key is
    // unused with LWA_ALPHA alone.
    if unsafe { SetLayeredWindowAttributes(hwnd, 0, alpha, LWA_ALPHA) } == 0 {
        return Err(last_error("SetLayeredWindowAttributes"));
    }
    Ok(())
}

pub(crate) fn set_content_aspect_ratio(window: &impl HasWindowHandle, ratio: Option<f64>) -> Result<(), Error> {
    let hwnd = hwnd(window)?;
    match ratio.map(|ratio| ratio as f32).filter(|ratio| ratio.is_finite() && *ratio > 0.0) {
        Some(ratio) => {
            // SAFETY: `hwnd` is a window of this thread (checked above), as
            // SetWindowSubclass requires; installing the procedure again
            // with the same id only replaces its reference data.
            let installed =
                unsafe { SetWindowSubclass(hwnd, Some(fit_to_ratio), ASPECT_ID, ratio.to_bits() as usize) };
            if installed == 0 {
                return Err(last_error("SetWindowSubclass"));
            }
        }
        None => {
            // SAFETY: as above; removing a procedure that is not installed
            // answers FALSE and changes nothing.
            unsafe { RemoveWindowSubclass(hwnd, Some(fit_to_ratio), ASPECT_ID) };
        }
    }
    Ok(())
}

/// Keeps `WS_EX_LAYERED` in every extended style the window is given.
///
/// # Safety
///
/// Only the system calls it, as the subclass procedure of a window, with
/// the arguments of a message of that window.
unsafe extern "system" fn keep_layered(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    _data: usize,
) -> LRESULT {
    if message == WM_STYLECHANGING && wparam as i32 == GWL_EXSTYLE && lparam != 0 {
        // SAFETY: for WM_STYLECHANGING, lParam points to the STYLESTRUCT of
        // the change, which the window procedures may edit for the length
        // of the call.
        let change = unsafe { &mut *(lparam as *mut STYLESTRUCT) };
        change.styleNew |= WS_EX_LAYERED;
    }
    if message == WM_NCDESTROY {
        // SAFETY: removes this procedure from its own window, on the
        // window's thread, as the subclass documentation advises for
        // WM_NCDESTROY.
        unsafe { RemoveWindowSubclass(hwnd, Some(keep_layered), id) };
    }
    // SAFETY: passes the message on, unchanged but for the style above, to
    // the next procedure of the chain, from within a subclass procedure.
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

/// Fits the rectangle of each `WM_SIZING` to the ratio in `data`.
///
/// # Safety
///
/// Only the system calls it, as the subclass procedure of a window, with
/// the arguments of a message of that window.
unsafe extern "system" fn fit_to_ratio(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    id: usize,
    data: usize,
) -> LRESULT {
    if message == WM_SIZING
        && lparam != 0
        && let Some(edge) = Edge::from_wmsz(wparam)
        && let Some((margin, min_size)) = frame_and_min_size(hwnd)
    {
        // SAFETY: for WM_SIZING, lParam points to the window rectangle of
        // the drag, which the window procedures may change for the length
        // of the call.
        let rect = unsafe { &mut *(lparam as *mut RECT) };
        let ratio = f32::from_bits(data as u32);
        let bounds = Bounds { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        let fitted = aspect::fit(edge, ratio, min_size, margin, bounds);
        *rect = RECT { left: fitted.left, top: fitted.top, right: fitted.right, bottom: fitted.bottom };
    }
    if message == WM_NCDESTROY {
        // SAFETY: removes this procedure from its own window, on the
        // window's thread, as the subclass documentation advises for
        // WM_NCDESTROY.
        unsafe { RemoveWindowSubclass(hwnd, Some(fit_to_ratio), id) };
    }
    // SAFETY: passes the message on to the next procedure of the chain,
    // from within a subclass procedure.
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

/// The frame of `hwnd` (window minus client size) and its minimum tracking
/// size as its window procedure answers `WM_GETMINMAXINFO` (zero when it
/// sets none), in physical pixels.
fn frame_and_min_size(hwnd: HWND) -> Option<(Extent, Extent)> {
    let mut window = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    let mut client = window;
    // SAFETY: both pointers are to RECTs on this stack frame, written
    // during the calls only; `hwnd` is the window whose message is being
    // handled, on its own thread.
    let read = unsafe { GetWindowRect(hwnd, &mut window) != 0 && GetClientRect(hwnd, &mut client) != 0 };
    if !read {
        return None;
    }
    let margin = Extent {
        width: (window.right - window.left) - (client.right - client.left),
        height: (window.bottom - window.top) - (client.bottom - client.top),
    };
    let zero = windows_sys::Win32::Foundation::POINT { x: 0, y: 0 };
    let mut info = MINMAXINFO {
        ptReserved: zero,
        ptMaxSize: zero,
        ptMaxPosition: zero,
        ptMinTrackSize: zero,
        ptMaxTrackSize: zero,
    };
    // SAFETY: WM_GETMINMAXINFO takes a pointer to a MINMAXINFO, which
    // lives on this stack frame for the whole synchronous call; the message
    // goes to the window's own procedures on this thread.
    unsafe { SendMessageW(hwnd, WM_GETMINMAXINFO, 0, &mut info as *mut MINMAXINFO as LPARAM) };
    let min_size = Extent { width: info.ptMinTrackSize.x.max(0), height: info.ptMinTrackSize.y.max(0) };
    Some((margin, min_size))
}
