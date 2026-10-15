// SPDX-License-Identifier: GPL-2.0-or-later
//! The seam between the service and the HID library, so the service can be
//! tested without hardware.

use std::ffi::CString;
use std::sync::Arc;

use crate::error::HidError;

/// One enumerated HID interface.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawDeviceInfo {
    pub path: CString,
    pub vendor_id: u16,
    pub product_id: u16,
    pub usage_page: u16,
    pub usage: u16,
    pub serial_number: Option<String>,
    pub product: Option<String>,
}

pub trait HidBackend: Send + Sync {
    fn enumerate(&self) -> Result<Vec<RawDeviceInfo>, HidError>;
    fn open_path(&self, path: &CString) -> Result<Arc<dyn HidHandle>, HidError>;
}

/// An open device. Dropping the last reference closes it.
pub trait HidHandle: Send + Sync {
    fn write(&self, data: &[u8]) -> Result<usize, HidError>;
    /// Returns the number of bytes read; 0 means the timeout passed.
    fn read_timeout(&self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, HidError>;
}
