// SPDX-License-Identifier: GPL-2.0-or-later
//! The virtual keyboard behind the [`HidBackend`] seam, and the backend the
//! service talks to: hardware and the virtual keyboard combined according to
//! [`VirtualDeviceMode`].

use std::ffi::{CStr, CString};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use pipette_protocol::{MSG_LEN, Report};
use pipette_virtual_device::dataset::{
    VIRTUAL_DEVICE_NAME, VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_SERIAL, VIRTUAL_DEVICE_VID,
};
use pipette_virtual_device::device::matches_virtual_device;
use pipette_virtual_device::{VirtualDevice, VirtualDeviceMode};

use crate::backend::{HidBackend, HidHandle, RawDeviceInfo};
use crate::error::HidError;
use crate::timing::Timing;

/// Path of the virtual keyboard. Never a hidraw path, so it cannot collide
/// with real hardware.
const VIRTUAL_DEVICE_PATH: &CStr = c"pipette:virtual-device";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// One virtual keyboard, shared with its controller. Its state lives as long
/// as the backend, across close and re-open.
pub(crate) struct VirtualBackend {
    device: Arc<Mutex<VirtualDevice>>,
    timing: Timing,
}

impl VirtualBackend {
    pub(crate) fn new(device: Arc<Mutex<VirtualDevice>>, timing: Timing) -> Self {
        Self { device, timing }
    }

    fn info() -> RawDeviceInfo {
        RawDeviceInfo {
            path: VIRTUAL_DEVICE_PATH.to_owned(),
            vendor_id: VIRTUAL_DEVICE_VID,
            product_id: VIRTUAL_DEVICE_PID,
            serial_number: Some(VIRTUAL_DEVICE_SERIAL.to_owned()),
            product: Some(VIRTUAL_DEVICE_NAME.to_owned()),
        }
    }
}

impl HidBackend for VirtualBackend {
    fn enumerate(&self) -> Result<Vec<RawDeviceInfo>, HidError> {
        Ok(vec![Self::info()])
    }

    fn open_path(&self, path: &CString) -> Result<Arc<dyn HidHandle>, HidError> {
        if path.as_c_str() != VIRTUAL_DEVICE_PATH {
            return Err(HidError::Backend(format!("No virtual device at {path:?}")));
        }
        lock(&self.device).open();
        Ok(Arc::new(VirtualHandle {
            device: Arc::clone(&self.device),
            timing: self.timing.clone(),
            response: Mutex::new(None),
        }))
    }
}

/// Each write is answered at once; the following read returns that answer.
struct VirtualHandle {
    device: Arc<Mutex<VirtualDevice>>,
    timing: Timing,
    response: Mutex<Option<Report>>,
}

impl HidHandle for VirtualHandle {
    /// `data` is a packet: report ID, then the report.
    fn write(&self, data: &[u8]) -> Result<usize, HidError> {
        let report = data.get(1..).unwrap_or_default();
        let response = lock(&self.device).handle_report(report, (self.timing.now_ms)())?;
        *lock(&self.response) = Some(response);
        Ok(data.len())
    }

    /// The answer to the last write, without a report ID. Never empty after
    /// a write, so the service's timeout retry never fires for it.
    fn read_timeout(&self, buf: &mut [u8], _timeout_ms: i32) -> Result<usize, HidError> {
        let Some(response) = lock(&self.response).take() else {
            return Ok(0);
        };
        let len = buf.len().min(MSG_LEN);
        buf[..len].copy_from_slice(&response[..len]);
        Ok(len)
    }

    fn close(&self) {
        lock(&self.device).close();
    }
}

/// Hardware plus the virtual keyboard. The mode only decides the device
/// list (`Only` hides hardware); opening and presence checks reach both
/// sources whenever the virtual keyboard exists, and its VID/PID always
/// resolves to it first, without enumerating hardware.
pub(crate) struct DeviceBackends {
    hardware: Box<dyn HidBackend>,
    virtual_device: VirtualBackend,
    mode: VirtualDeviceMode,
}

impl DeviceBackends {
    pub(crate) fn new(
        hardware: Box<dyn HidBackend>,
        virtual_device: VirtualBackend,
        mode: VirtualDeviceMode,
    ) -> Self {
        Self { hardware, virtual_device, mode }
    }

    /// Real hardware alone, whatever the mode.
    pub(crate) fn hardware(&self) -> &dyn HidBackend {
        self.hardware.as_ref()
    }

    fn is_virtual(&self, path: &CString) -> bool {
        self.mode != VirtualDeviceMode::Off && path.as_c_str() == VIRTUAL_DEVICE_PATH
    }
}

impl HidBackend for DeviceBackends {
    fn enumerate(&self) -> Result<Vec<RawDeviceInfo>, HidError> {
        match self.mode {
            VirtualDeviceMode::Off => self.hardware.enumerate(),
            VirtualDeviceMode::Append => {
                let mut devices = self.hardware.enumerate()?;
                devices.push(VirtualBackend::info());
                Ok(devices)
            }
            VirtualDeviceMode::Only => self.virtual_device.enumerate(),
        }
    }

    fn open_path(&self, path: &CString) -> Result<Arc<dyn HidHandle>, HidError> {
        if self.is_virtual(path) {
            self.virtual_device.open_path(path)
        } else {
            self.hardware.open_path(path)
        }
    }

    fn find(&self, vendor_id: u16, product_id: u16) -> Result<Option<RawDeviceInfo>, HidError> {
        if self.mode != VirtualDeviceMode::Off && matches_virtual_device(vendor_id, product_id) {
            return Ok(Some(VirtualBackend::info()));
        }
        self.hardware.find(vendor_id, product_id)
    }

    fn is_present(&self, path: &CString) -> Result<bool, HidError> {
        if self.is_virtual(path) { Ok(true) } else { self.hardware.is_present(path) }
    }
}
