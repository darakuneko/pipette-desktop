// SPDX-License-Identifier: GPL-2.0-or-later
//! The native lookup of Windows and macOS, on `pipette_native::active_window`
//! (the calls `@paymoapp/active-window` makes there). Where the binding finds
//! no window it throws "Failed to get active window"; that is an error here
//! too, logged once.

use pipette_js_json::JsString;

use crate::{NativeBackend, NativeError, WindowInfo};

/// The binding's message when it finds no window.
const NO_WINDOW: &str = "Failed to get active window";

/// The lookup of Windows and macOS. Elsewhere every lookup fails.
pub struct SystemBackend;

impl NativeBackend for SystemBackend {
    fn active_window(&mut self) -> Result<Option<WindowInfo>, NativeError> {
        window_info(pipette_native::active_window())
    }
}

fn window_info(
    found: Result<Option<pipette_native::ActiveWindowInfo>, pipette_native::Error>,
) -> Result<Option<WindowInfo>, NativeError> {
    match found? {
        Some(info) => Ok(Some(WindowInfo {
            application: JsString::from_utf16(info.application),
            title: JsString::from_utf16(info.title),
        })),
        None => Err(NO_WINDOW.into()),
    }
}

#[cfg(test)]
mod tests {
    use pipette_native::{ActiveWindowInfo, Error};

    use super::*;

    #[test]
    fn the_units_are_kept_as_they_are() {
        let lone_surrogate = vec![0x41, 0xd800];
        let info =
            ActiveWindowInfo { application: lone_surrogate.clone(), title: "t".encode_utf16().collect() };
        let window = window_info(Ok(Some(info))).ok().flatten().expect("a window");
        assert_eq!(window.application.utf16_units(), lone_surrogate);
        assert_eq!(window.title, JsString::from("t"));
    }

    #[test]
    fn no_window_and_no_lookup_are_errors() {
        let none = window_info(Ok(None)).err().map(|err| err.to_string());
        assert_eq!(none.as_deref(), Some(NO_WINDOW));
        let unsupported = window_info(Err(Error::Unsupported)).err().map(|err| err.to_string());
        assert_eq!(unsupported, Some(Error::Unsupported.to_string()));
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn other_systems_have_no_lookup() {
        assert!(SystemBackend.active_window().is_err());
    }
}
