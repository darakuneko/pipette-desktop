// SPDX-License-Identifier: GPL-2.0-or-later
//! The AppKit calls on a real window, which only the main thread may use:
//! this test runs without the test harness (harness = false in Cargo.toml),
//! so `main` is the process's main thread. Elsewhere it does nothing.
#![allow(unsafe_code)]

#[cfg(target_os = "macos")]
fn main() {
    appkit::run();
    println!("macos_window: ok");
}

#[cfg(not(target_os = "macos"))]
fn main() {}

#[cfg(target_os = "macos")]
mod appkit {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSApplication, NSBackingStoreType, NSWindow, NSWindowStyleMask};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use pipette_native::{Error, set_content_aspect_ratio, set_opacity};
    use raw_window_handle::{AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle};

    /// The content view of a window that outlives every use of the handle.
    struct View(usize);

    impl HasWindowHandle for View {
        fn window_handle(&self) -> Result<WindowHandle<'_>, HandleError> {
            let view = NonNull::new(self.0 as *mut c_void).ok_or(HandleError::Unavailable)?;
            // SAFETY: the view is the content view of the test's window,
            // which lives until the end of `run`, after every handle.
            Ok(unsafe { WindowHandle::borrow_raw(RawWindowHandle::AppKit(AppKitWindowHandle::new(view))) })
        }
    }

    fn close(actual: f64, expected: f64) -> bool {
        (actual - expected).abs() < 1e-9
    }

    pub fn run() {
        let main_thread = MainThreadMarker::new().expect("the test runs on the main thread");
        let _app = NSApplication::sharedApplication(main_thread);
        let style = NSWindowStyleMask::Titled | NSWindowStyleMask::Closable | NSWindowStyleMask::Resizable;
        let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(640.0, 480.0));
        // SAFETY: a freshly allocated NSWindow initialized once, with a
        // valid rectangle, style mask and backing store type, on the main
        // thread.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(main_thread),
                frame,
                style,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        // SAFETY: the window is released by its Retained only, so closing
        // it does not release it a second time.
        unsafe { window.setReleasedWhenClosed(false) };
        let content = window.contentView().expect("the window has a content view");
        let view = View(NonNull::from(&*content).as_ptr() as usize);

        set_opacity(&view, 0.6).expect("set the opacity");
        assert!(close(window.alphaValue(), 0.6), "alphaValue {}", window.alphaValue());
        set_opacity(&view, 7.0).expect("set the opacity");
        assert!(close(window.alphaValue(), 1.0), "alphaValue {}", window.alphaValue());

        set_content_aspect_ratio(&view, Some(2.0)).expect("set the aspect ratio");
        let ratio = window.contentAspectRatio();
        assert!(close(ratio.width, 2.0) && close(ratio.height, 1.0), "contentAspectRatio {ratio:?}");

        set_content_aspect_ratio(&view, None).expect("release the aspect ratio");
        let increments = window.contentResizeIncrements();
        assert!(close(increments.width, 1.0) && close(increments.height, 1.0), "{increments:?}");
        let increments = window.resizeIncrements();
        assert!(close(increments.width, 1.0) && close(increments.height, 1.0), "{increments:?}");

        let address = view.0;
        let off_main = std::thread::spawn(move || {
            let view = View(address);
            (set_opacity(&view, 0.5), set_content_aspect_ratio(&view, Some(2.0)))
        })
        .join()
        .expect("the thread ends");
        assert_eq!(off_main, (Err(Error::WrongThread), Err(Error::WrongThread)));
        assert!(close(window.alphaValue(), 1.0));

        window.close();
    }
}
