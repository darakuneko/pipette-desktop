// SPDX-License-Identifier: GPL-2.0-or-later
//! The AppKit calls on a real window, which only the main thread may use:
//! this test runs without the test harness (harness = false in Cargo.toml),
//! so `main` is the process's main thread. Elsewhere it does nothing.
//!
//! It answers the listing cargo-nextest asks every test binary for: with
//! `--list` it names its one test (`--list --format terse` wants
//! `<name>: test` lines; with `--ignored` it has none), and nextest then
//! runs it as `--exact macos_window`. Any other arguments run the test, as
//! `cargo test` does with none.
#![allow(unsafe_code)]

const NAME: &str = "macos_window";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--list") {
        // Nothing is listed where the test does nothing, so it never counts
        // as passed there.
        if cfg!(target_os = "macos") && !args.iter().any(|arg| arg == "--ignored") {
            println!("{NAME}: test");
        }
        return;
    }
    run();
}

#[cfg(target_os = "macos")]
fn run() {
    appkit::run();
    println!("{NAME}: ok");
}

#[cfg(not(target_os = "macos"))]
fn run() {}

#[cfg(target_os = "macos")]
mod appkit {
    use std::ffi::c_void;
    use std::ptr::NonNull;

    use objc2::{MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSApplication, NSBackingStoreType, NSScreen, NSWindow, NSWindowStyleMask};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    use pipette_native::{
        Error, OuterFrame, frame_size, set_content_aspect_ratio, set_opacity, set_outer_frame,
    };
    use raw_window_handle::{
        AppKitWindowHandle, HandleError, HasWindowHandle, RawWindowHandle, WindowHandle,
    };

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

    /// A window whose content view extends under its title bar still has
    /// the title bar as its frame: its content view's frame (and a webview
    /// filling it) is the whole window, which would leave no frame.
    fn assert_title_bar_of_full_size_content(main_thread: MainThreadMarker, title_bar: f64) {
        let style = NSWindowStyleMask::Titled
            | NSWindowStyleMask::Closable
            | NSWindowStyleMask::Resizable
            | NSWindowStyleMask::FullSizeContentView;
        let rect = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(310.0, 308.0));
        // SAFETY: as for the window of `run`.
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(main_thread),
                rect,
                style,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        // SAFETY: as for the window of `run`.
        unsafe { window.setReleasedWhenClosed(false) };
        let content = window.contentView().expect("the window has a content view");
        assert!(close(content.frame().size.height, window.frame().size.height), "{:?}", content.frame());
        let view = View(NonNull::from(&*content).as_ptr() as usize);
        let frame = frame_size(&view).expect("read the frame");
        assert!(
            close(frame.width, 0.0) && close(frame.height, title_bar),
            "{frame:?}, title bar {title_bar}"
        );
        window.close();
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

        // The frame's top-left corner, from the top of the first screen,
        // in AppKit's bottom-up coordinates.
        let screen_height = NSScreen::screens(main_thread)
            .firstObject()
            .expect("the runner has a screen")
            .frame()
            .size
            .height;
        let target = OuterFrame { x: 40.0, y: 60.0, width: 420.0, height: 260.0 };
        set_outer_frame(&view, target).expect("set the frame");
        let frame = window.frame();
        assert!(close(frame.origin.x, 40.0) && close(frame.size.width, 420.0), "{frame:?}");
        assert!(close(frame.size.height, 260.0), "{frame:?}");
        assert!(close(frame.origin.y, screen_height - 60.0 - 260.0), "{frame:?} on {screen_height}");

        // The frame is the title bar: the outer size less the content
        // rectangle of the window's style.
        let titled = frame_size(&view).expect("read the frame");
        let content = window.contentRectForFrameRect(window.frame());
        assert!(titled.height > 0.0 && close(titled.width, 0.0), "{titled:?}");
        assert!(
            close(titled.height, window.frame().size.height - content.size.height),
            "{titled:?} {content:?}"
        );
        assert_title_bar_of_full_size_content(main_thread, titled.height);

        let address = view.0;
        let off_main = std::thread::spawn(move || {
            let view = View(address);
            (
                set_opacity(&view, 0.5),
                set_content_aspect_ratio(&view, Some(2.0)),
                set_outer_frame(&view, OuterFrame { x: 0.0, y: 0.0, width: 1.0, height: 1.0 }),
                frame_size(&view),
            )
        })
        .join()
        .expect("the thread ends");
        assert_eq!(
            off_main,
            (
                Err(Error::WrongThread),
                Err(Error::WrongThread),
                Err(Error::WrongThread),
                Err(Error::WrongThread)
            )
        );
        assert!(close(window.alphaValue(), 1.0));

        window.close();
    }
}
