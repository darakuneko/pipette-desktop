// SPDX-License-Identifier: GPL-2.0-or-later
//! The Win32 calls on a real window: a hidden top-level window of the
//! system's STATIC class with a frame, created and destroyed by each test
//! on its own thread.
#![cfg(windows)]
#![allow(unsafe_code)]

use std::num::NonZeroIsize;
use std::ptr;

use pipette_native::{Error, set_content_aspect_ratio, set_opacity};
use raw_window_handle::{HandleError, HasWindowHandle, RawWindowHandle, Win32WindowHandle, WindowHandle};
use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GWL_EXSTYLE, GetClientRect, GetLayeredWindowAttributes, GetWindowLongW,
    GetWindowRect, LWA_ALPHA, SendMessageW, SetWindowLongW, WM_SIZING, WMSZ_BOTTOM, WMSZ_RIGHT,
    WS_EX_LAYERED, WS_OVERLAPPEDWINDOW,
};

/// A hidden framed window, destroyed on drop.
struct TestWindow(HWND);

impl TestWindow {
    fn new() -> Self {
        // SAFETY: the STATIC class is registered by the system; every
        // pointer argument is a valid string or null.
        let hwnd = unsafe {
            CreateWindowExW(
                0,
                windows_sys::core::w!("STATIC"),
                ptr::null(),
                WS_OVERLAPPEDWINDOW,
                0,
                0,
                640,
                480,
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null_mut(),
                ptr::null(),
            )
        };
        assert!(!hwnd.is_null(), "CreateWindowExW failed");
        Self(hwnd)
    }

    fn ex_style(&self) -> u32 {
        // SAFETY: the window is alive and belongs to this thread.
        unsafe { GetWindowLongW(self.0, GWL_EXSTYLE) as u32 }
    }

    fn alpha(&self) -> u8 {
        let mut alpha = 0u8;
        let mut flags = 0u32;
        // SAFETY: the out pointers are to locals; a null color key pointer
        // asks for no color key.
        let ok = unsafe { GetLayeredWindowAttributes(self.0, ptr::null_mut(), &mut alpha, &mut flags) };
        assert_ne!(ok, 0, "GetLayeredWindowAttributes failed");
        assert_eq!(flags & LWA_ALPHA, LWA_ALPHA);
        alpha
    }

    /// The frame: window minus client size.
    fn frame(&self) -> (i32, i32) {
        let mut window = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let mut client = window;
        // SAFETY: the out pointers are to locals; the window is alive.
        unsafe {
            assert_ne!(GetWindowRect(self.0, &mut window), 0);
            assert_ne!(GetClientRect(self.0, &mut client), 0);
        }
        (
            (window.right - window.left) - (client.right - client.left),
            (window.bottom - window.top) - (client.bottom - client.top),
        )
    }

    /// The rectangle the window's procedures leave of `rect` dragged at
    /// `edge`.
    fn sizing(&self, edge: u32, rect: RECT) -> RECT {
        let mut rect = rect;
        // SAFETY: WM_SIZING takes a pointer to a RECT, a local that lives
        // for the whole synchronous call.
        unsafe { SendMessageW(self.0, WM_SIZING, edge as usize, &mut rect as *mut RECT as LPARAM) };
        rect
    }
}

impl Drop for TestWindow {
    fn drop(&mut self) {
        // SAFETY: the window belongs to this thread and is destroyed once.
        unsafe { DestroyWindow(self.0) };
    }
}

impl HasWindowHandle for TestWindow {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let hwnd = NonZeroIsize::new(self.0 as isize).ok_or(HandleError::Unavailable)?;
        // SAFETY: the window lives until `self` drops, after every use of
        // the borrowed handle.
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(hwnd))) })
    }
}

fn rect(width: i32, height: i32) -> RECT {
    RECT { left: 10, top: 20, right: 10 + width, bottom: 20 + height }
}

#[test]
fn the_opacity_makes_the_window_layered_and_it_stays_layered() {
    let window = TestWindow::new();
    assert_eq!(window.ex_style() & WS_EX_LAYERED, 0);
    set_opacity(&window, 0.5).unwrap();
    assert_ne!(window.ex_style() & WS_EX_LAYERED, 0);
    assert_eq!(window.alpha(), 127);

    // A new extended style without the bit, as tao writes one when a flag
    // of the window changes, keeps it.
    // SAFETY: the window is alive and belongs to this thread.
    unsafe { SetWindowLongW(window.0, GWL_EXSTYLE, (window.ex_style() & !WS_EX_LAYERED) as i32) };
    assert_ne!(window.ex_style() & WS_EX_LAYERED, 0);
    assert_eq!(window.alpha(), 127);

    set_opacity(&window, 1.0).unwrap();
    assert_eq!(window.alpha(), 255);
    set_opacity(&window, 0.9).unwrap();
    assert_eq!(window.alpha(), 229);
}

#[test]
fn a_window_layered_before_stays_layered_once_its_opacity_is_set() {
    let window = TestWindow::new();
    // SAFETY: the window is alive and belongs to this thread.
    unsafe { SetWindowLongW(window.0, GWL_EXSTYLE, (window.ex_style() | WS_EX_LAYERED) as i32) };
    set_opacity(&window, 0.5).unwrap();
    // SAFETY: as above.
    unsafe { SetWindowLongW(window.0, GWL_EXSTYLE, (window.ex_style() & !WS_EX_LAYERED) as i32) };
    assert_ne!(window.ex_style() & WS_EX_LAYERED, 0);
    assert_eq!(window.alpha(), 127);
}

#[test]
fn an_opaque_window_stays_a_plain_one() {
    let window = TestWindow::new();
    set_opacity(&window, 1.0).unwrap();
    set_opacity(&window, f64::NAN).unwrap();
    assert_eq!(window.ex_style() & WS_EX_LAYERED, 0);
}

#[test]
fn the_aspect_ratio_fits_the_content_of_the_dragged_rectangle() {
    let window = TestWindow::new();
    let (frame_width, frame_height) = window.frame();
    assert!(frame_width > 0 && frame_height > 0, "the window has a frame");

    set_content_aspect_ratio(&window, Some(2.0)).unwrap();
    let right = window.sizing(WMSZ_RIGHT, rect(800 + frame_width, 100));
    assert_eq!(right.left, 10);
    assert_eq!(right.top, 20);
    assert_eq!(right.right - right.left, 800 + frame_width);
    assert_eq!(right.bottom - right.top, 400 + frame_height);

    set_content_aspect_ratio(&window, Some(2.5)).unwrap();
    let bottom = window.sizing(WMSZ_BOTTOM, rect(100, 200 + frame_height));
    assert_eq!(bottom.right - bottom.left, 500 + frame_width);
    assert_eq!(bottom.bottom - bottom.top, 200 + frame_height);

    for released in [None, Some(0.0), Some(-1.0), Some(f64::INFINITY)] {
        set_content_aspect_ratio(&window, Some(2.0)).unwrap();
        set_content_aspect_ratio(&window, released).unwrap();
        let unchanged = rect(300, 300);
        let after = window.sizing(WMSZ_RIGHT, unchanged);
        assert_eq!((after.left, after.top, after.right, after.bottom), (10, 20, 310, 320), "{released:?}");
    }
}

#[test]
fn another_thread_gets_wrong_thread() {
    let window = TestWindow::new();
    let hwnd = window.0 as isize;
    let result = std::thread::spawn(move || {
        let other = Borrowed(hwnd);
        (set_opacity(&other, 0.5), set_content_aspect_ratio(&other, Some(2.0)))
    })
    .join()
    .unwrap();
    assert_eq!(result, (Err(Error::WrongThread), Err(Error::WrongThread)));
    assert_eq!(window.ex_style() & WS_EX_LAYERED, 0);
}

/// Another thread's view of a window that outlives it.
struct Borrowed(isize);

impl HasWindowHandle for Borrowed {
    fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
        let hwnd = NonZeroIsize::new(self.0).ok_or(HandleError::Unavailable)?;
        // SAFETY: the window outlives the thread that borrows it here.
        Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::Win32(Win32WindowHandle::new(hwnd))) })
    }
}
