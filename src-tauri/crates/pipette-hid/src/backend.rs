// SPDX-License-Identifier: GPL-2.0-or-later
//! The seam between the service and the device sources (hidapi, the virtual
//! keyboard), so the service can be tested without hardware.

use std::ffi::CString;
use std::sync::Arc;

use crate::error::HidError;

/// One enumerated Vial raw-HID interface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawDeviceInfo {
    pub path: CString,
    pub vendor_id: u16,
    pub product_id: u16,
    pub serial_number: Option<String>,
    pub product: Option<String>,
}

pub trait HidBackend: Send + Sync {
    /// Vial interfaces only (usage page 0xFF60, usage 0x61).
    fn enumerate(&self) -> Result<Vec<RawDeviceInfo>, HidError>;
    fn open_path(&self, path: &CString) -> Result<Arc<dyn HidHandle>, HidError>;

    /// The first interface with this VID/PID.
    fn find(&self, vendor_id: u16, product_id: u16) -> Result<Option<RawDeviceInfo>, HidError> {
        Ok(self.enumerate()?.into_iter().find(|d| d.vendor_id == vendor_id && d.product_id == product_id))
    }

    /// True while `path` is still enumerated.
    fn is_present(&self, path: &CString) -> Result<bool, HidError> {
        Ok(self.enumerate()?.iter().any(|d| d.path == *path))
    }
}

/// An open device. Dropping the last reference releases it.
pub trait HidHandle: Send + Sync {
    fn write(&self, data: &[u8]) -> Result<usize, HidError>;
    /// Returns the number of bytes read; 0 means the timeout passed.
    fn read_timeout(&self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, HidError>;
    /// Called once when the service closes the device, even while an
    /// exchange still holds a reference to the handle.
    fn close(&self) {}
}
