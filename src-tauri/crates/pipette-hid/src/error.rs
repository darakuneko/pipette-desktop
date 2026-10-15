// SPDX-License-Identifier: GPL-2.0-or-later

use pipette_virtual_device::NotOpenError;

#[derive(Debug, thiserror::Error)]
pub enum HidError {
    #[error("No HID device is open")]
    NotOpen,
    /// The read window passed with no report. The only retryable failure:
    /// write errors, disconnects and I/O errors fail at once.
    #[error("HID read timeout")]
    ReadTimeout,
    #[error("HID data exceeds maximum length of {max}")]
    DataTooLong { max: usize },
    /// Any failure reported by the HID library (enumeration, open, write, read).
    #[error("{0}")]
    Backend(String),
    #[error(transparent)]
    Virtual(#[from] NotOpenError),
}

impl From<hidapi::HidError> for HidError {
    fn from(err: hidapi::HidError) -> Self {
        Self::Backend(err.to_string())
    }
}
