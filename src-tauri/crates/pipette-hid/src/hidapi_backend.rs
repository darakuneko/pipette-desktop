// SPDX-License-Identifier: GPL-2.0-or-later
//! [`HidBackend`] on the `hidapi` crate (hidraw on Linux).

use std::ffi::CString;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use hidapi::{HidApi, HidDevice};

use crate::backend::{HidBackend, HidHandle, RawDeviceInfo};
use crate::constants::{HID_USAGE, HID_USAGE_PAGE};
use crate::error::HidError;

/// The Vial raw-HID interface: usage page 0xFF60, usage 0x61.
pub fn is_vial_interface(usage_page: u16, usage: u16) -> bool {
    usage_page == HID_USAGE_PAGE && usage == HID_USAGE
}

/// The hidapi context is created on first use and kept for the life of the
/// backend.
#[derive(Default)]
pub struct HidapiBackend {
    api: Mutex<Option<HidApi>>,
}

impl HidapiBackend {
    pub fn new() -> Self {
        Self::default()
    }

    fn api(&self) -> Result<MutexGuard<'_, Option<HidApi>>, HidError> {
        let mut guard = self.api.lock().unwrap_or_else(PoisonError::into_inner);
        if guard.is_none() {
            *guard = Some(HidApi::new()?);
        }
        Ok(guard)
    }
}

impl HidBackend for HidapiBackend {
    fn enumerate(&self) -> Result<Vec<RawDeviceInfo>, HidError> {
        let mut guard = self.api()?;
        let api = guard.as_mut().ok_or(HidError::Backend("hidapi is not initialized".into()))?;
        api.refresh_devices()?;
        Ok(api
            .device_list()
            .filter(|d| is_vial_interface(d.usage_page(), d.usage()))
            .map(|d| RawDeviceInfo {
                path: d.path().to_owned(),
                vendor_id: d.vendor_id(),
                product_id: d.product_id(),
                serial_number: d.serial_number().map(str::to_owned),
                product: d.product_string().map(str::to_owned),
            })
            .collect())
    }

    fn open_path(&self, path: &CString) -> Result<Arc<dyn HidHandle>, HidError> {
        let guard = self.api()?;
        let api = guard.as_ref().ok_or(HidError::Backend("hidapi is not initialized".into()))?;
        let device = api.open_path(path)?;
        Ok(Arc::new(HidapiHandle { device: Mutex::new(device) }))
    }
}

/// `HidDevice` is `Send` but not `Sync`; the mutex makes the handle
/// shareable. Each handle has one caller at a time (the main connection's
/// requests are serialized by the service's queue, a probe's by the
/// WebView awaiting each one), so it is not contended.
struct HidapiHandle {
    device: Mutex<HidDevice>,
}

impl HidapiHandle {
    fn device(&self) -> MutexGuard<'_, HidDevice> {
        self.device.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl HidHandle for HidapiHandle {
    fn write(&self, data: &[u8]) -> Result<usize, HidError> {
        Ok(self.device().write(data)?)
    }

    fn read_timeout(&self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, HidError> {
        Ok(self.device().read_timeout(buf, timeout_ms)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_vial_usage_page_and_usage_is_a_vial_interface() {
        assert!(is_vial_interface(0xff60, 0x61));
        assert!(!is_vial_interface(0xff60, 0x62));
        assert!(!is_vial_interface(0xff60, 0x06));
        assert!(!is_vial_interface(0x0001, 0x61));
    }
}
