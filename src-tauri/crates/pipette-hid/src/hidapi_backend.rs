// SPDX-License-Identifier: GPL-2.0-or-later
//! [`HidBackend`] on the `hidapi` crate (hidraw on Linux).

use std::ffi::CString;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use hidapi::{HidApi, HidDevice};

use crate::backend::{HidBackend, HidHandle, RawDeviceInfo};
use crate::constants::{HID_USAGE, HID_USAGE_PAGE};
use crate::error::HidError;
use crate::hid_thread::OwnerThread;

/// The Vial raw-HID interface: usage page 0xFF60, usage 0x61.
pub fn is_vial_interface(usage_page: u16, usage: u16) -> bool {
    usage_page == HID_USAGE_PAGE && usage == HID_USAGE
}

/// The thread every call that touches hidapi's global state runs on (see
/// `hid_thread.rs` for why). hidapi's C context is per process, so the
/// thread is too: a static is never dropped, so the thread never exits,
/// whichever backend initialised the library first.
static HIDAPI_THREAD: OwnerThread<Option<HidApi>> = OwnerThread::new("pipette-hidapi");

/// The hidapi context is created on first use and kept for the life of the
/// process. Initialising, enumerating and opening run on [`HIDAPI_THREAD`].
/// Writes, reads and closes stay on the caller's thread: on macOS
/// `hid_open_path` gives each device its own read thread and run loop,
/// `hid_write` / `hid_read_timeout` do not touch the global manager, and
/// `hid_close` reschedules the device on the main run loop; on Linux and
/// Windows a device handle has no thread affinity. This keeps a probe's
/// exchanges and the main connection's from queueing behind each other or
/// behind an enumeration.
#[derive(Default)]
pub struct HidapiBackend;

impl HidapiBackend {
    pub fn new() -> Self {
        Self
    }

    /// Runs `call` with the hidapi context on [`HIDAPI_THREAD`].
    fn with_api<R, F>(&self, call: F) -> Result<R, HidError>
    where
        R: Send + 'static,
        F: FnOnce(&mut HidApi) -> Result<R, HidError> + Send + 'static,
    {
        HIDAPI_THREAD.run(|api| {
            if api.is_none() {
                *api = Some(HidApi::new()?);
            }
            let api = api.as_mut().ok_or(HidError::Backend("hidapi is not initialized".into()))?;
            call(api)
        })?
    }
}

impl HidBackend for HidapiBackend {
    fn enumerate(&self) -> Result<Vec<RawDeviceInfo>, HidError> {
        self.with_api(|api| {
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
        })
    }

    fn open_path(&self, path: &CString) -> Result<Arc<dyn HidHandle>, HidError> {
        let path = path.clone();
        let device = self.with_api(move |api| Ok(api.open_path(&path)?))?;
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

    #[test]
    fn a_failed_open_is_a_backend_error_from_hidapi() {
        let path = CString::new("/nonexistent/pipette-hid-test").unwrap_or_default();
        let err = HidapiBackend::new().open_path(&path).err();
        assert!(matches!(err, Some(HidError::Backend(_))), "{err:?}");
    }

    /// The macOS crash, with real hidapi: the context is initialised from a
    /// short-lived thread (as an idle blocking-pool thread is), that thread
    /// exits, and later enumerations come from other threads with no device
    /// plugged or unplugged in between. Each `hid_enumerate` re-applies the
    /// manager's matching to every attached device, scheduling it on the run
    /// loop hidapi stored at init; with the run loop of an exited thread that
    /// crashes. Here every hidapi call runs on the backend's own thread, so
    /// the stored run loop stays alive. On a machine with no HID device the
    /// re-scheduling has nothing to do, but the threading contract (one
    /// thread, outliving every caller) is still checked.
    #[test]
    fn enumerating_after_the_initialising_thread_exits_runs_on_one_thread() {
        #![allow(clippy::unwrap_used)]
        use std::thread;

        let on_owner = || HIDAPI_THREAD.run(|_| thread::current().id()).unwrap();

        // A backend that initialises hidapi on a thread that then exits,
        // and is dropped with it.
        let caller = thread::spawn(|| {
            HidapiBackend::new().enumerate().unwrap();
            thread::current().id()
        })
        .join()
        .unwrap();
        let owner = on_owner();
        assert_ne!(owner, caller);

        let backend = Arc::new(HidapiBackend::new());
        for _ in 0..3 {
            let next = Arc::clone(&backend);
            thread::spawn(move || {
                for _ in 0..5 {
                    next.enumerate().unwrap();
                }
            })
            .join()
            .unwrap();
            assert_eq!(on_owner(), owner);
        }
    }
}
