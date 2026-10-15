// SPDX-License-Identifier: GPL-2.0-or-later
//! The error every command returns. It crosses the IPC boundary as its
//! message alone, a JSON string, and `call` in src/tauri-shim/ipc.ts rejects
//! with `new Error(message)`: the shape an `ipcRenderer.invoke` rejection has
//! for the renderer.

use std::fmt;

use pipette_hid::HidError;
use serde::{Serialize, Serializer};

#[derive(Debug, PartialEq, Eq)]
pub struct CommandError(String);

impl CommandError {
    /// The app commands fail only with the errors converted below; the
    /// development tools write their own messages.
    #[cfg(any(test, feature = "dev-tools"))]
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for CommandError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl Serialize for CommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.0)
    }
}

impl From<HidError> for CommandError {
    fn from(err: HidError) -> Self {
        Self(err.to_string())
    }
}

/// A blocking task that panicked or was cancelled.
impl From<tauri::Error> for CommandError {
    fn from(err: tauri::Error) -> Self {
        Self(err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_its_message() {
        assert_eq!(
            serde_json::to_value(CommandError::new("HID read timeout")).unwrap(),
            serde_json::json!("HID read timeout")
        );
    }

    #[test]
    fn keeps_the_message_of_the_error_it_wraps() {
        assert_eq!(CommandError::from(HidError::ReadTimeout), CommandError::new("HID read timeout"));
        assert_eq!(
            CommandError::from(HidError::DataTooLong { max: 32 }),
            CommandError::new("HID data exceeds maximum length of 32")
        );
    }
}
