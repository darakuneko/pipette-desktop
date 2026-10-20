// SPDX-License-Identifier: GPL-2.0-or-later
//! The AppKit calls of the active window lookup, made as
//! `@paymoapp/active-window` makes them: the localized name of
//! `NSWorkspace`'s frontmost application, and no lookup when there is none.
//!
//! The title is always empty. The binding reads it with
//! `CGWindowListCopyWindowInfo` only after its `requestPermissions` has found
//! the screen recording permission granted, and the 0.4 build never called
//! `requestPermissions`, so its titles on macOS were empty too.
//!
//! `NSWorkspace` and `NSRunningApplication` are safe to read from any
//! thread, but the frontmost application only changes while the main run
//! loop runs: while it does not (during the quit sequence, for one), the
//! answer may be stale. The lookup must not hop to the main thread for a
//! fresher one, since the main thread may be waiting on the lookup's caller.

use objc2::rc::autoreleasepool;
use objc2_app_kit::{NSRunningApplication, NSWorkspace};

use crate::ActiveWindowInfo;

pub(crate) fn active_window() -> Option<ActiveWindowInfo> {
    autoreleasepool(|_| {
        let application = NSWorkspace::sharedWorkspace().frontmostApplication()?;
        Some(ActiveWindowInfo { application: localized_name(&application), title: Vec::new() })
    })
}

/// The application's localized name, empty when it has none.
fn localized_name(application: &NSRunningApplication) -> Vec<u16> {
    application.localizedName().map(|name| name.to_string().encode_utf16().collect()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_name_is_the_localized_name_or_empty_without_one() {
        // An unbundled executable, like this test, may have no localized name.
        autoreleasepool(|_| {
            let application = NSRunningApplication::currentApplication();
            let expected = application.localizedName().map(|name| name.to_string()).unwrap_or_default();
            assert_eq!(localized_name(&application), expected.encode_utf16().collect::<Vec<u16>>());
        });
    }

    #[test]
    fn the_lookup_runs_off_the_main_thread_and_has_no_title() {
        let info = std::thread::spawn(active_window).join().expect("the lookup");
        if let Some(info) = info {
            assert!(info.title.is_empty());
        }
    }
}
