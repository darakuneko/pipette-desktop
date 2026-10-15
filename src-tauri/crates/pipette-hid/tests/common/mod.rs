// SPDX-License-Identifier: GPL-2.0-or-later
// In-memory HID backend for the service tests.

#![allow(dead_code, clippy::unwrap_used)]

use std::collections::VecDeque;
use std::ffi::CString;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use pipette_hid::{
    HID_USAGE, HID_USAGE_PAGE, HidBackend, HidError, HidHandle, HidService, RawDeviceInfo, Timing,
    VirtualDeviceMode, is_vial_interface,
};

/// One HID interface as the OS lists it, Vial or not.
#[derive(Clone)]
pub struct MockDevice {
    pub info: RawDeviceInfo,
    pub usage_page: u16,
    pub usage: u16,
}

pub fn raw_device(path: &str) -> MockDevice {
    MockDevice {
        info: RawDeviceInfo {
            path: CString::new(path).unwrap(),
            vendor_id: 0x1234,
            product_id: 0x5678,
            serial_number: Some("vial:f64c2b3c".into()),
            product: Some("Real Test Keyboard".into()),
        },
        usage_page: HID_USAGE_PAGE,
        usage: HID_USAGE,
    }
}

/// One scripted read: bytes (empty = timeout) or an error message.
pub type ReadResult = Result<Vec<u8>, String>;

#[derive(Default)]
pub struct MockHandle {
    pub writes: Mutex<Vec<Vec<u8>>>,
    pub reads: Mutex<VecDeque<ReadResult>>,
    /// Returned when `reads` is empty.
    pub default_read: Mutex<Vec<u8>>,
    pub write_error: Mutex<Option<String>>,
    /// Called inside every read, before it returns (blocking hooks, ordering).
    pub on_read: Mutex<Option<Box<dyn Fn() + Send>>>,
    pub read_calls: AtomicUsize,
}

impl HidHandle for MockHandle {
    fn write(&self, data: &[u8]) -> Result<usize, HidError> {
        if let Some(message) = self.write_error.lock().unwrap().clone() {
            return Err(HidError::Backend(message));
        }
        self.writes.lock().unwrap().push(data.to_vec());
        Ok(data.len())
    }

    fn read_timeout(&self, buf: &mut [u8], _timeout_ms: i32) -> Result<usize, HidError> {
        self.read_calls.fetch_add(1, Ordering::SeqCst);
        if let Some(hook) = self.on_read.lock().unwrap().as_ref() {
            hook();
        }
        let next = self.reads.lock().unwrap().pop_front();
        let bytes = match next {
            Some(Ok(bytes)) => bytes,
            Some(Err(message)) => return Err(HidError::Backend(message)),
            None => self.default_read.lock().unwrap().clone(),
        };
        buf[..bytes.len()].copy_from_slice(&bytes);
        Ok(bytes.len())
    }
}

#[derive(Default)]
pub struct MockBackend {
    pub devices: Mutex<Vec<MockDevice>>,
    pub handle: Arc<MockHandle>,
    pub enumerate_calls: AtomicUsize,
    pub open_calls: AtomicUsize,
    /// open_path fails this many times before succeeding.
    pub open_failures: AtomicUsize,
}

/// Shares one `MockBackend` between the service and the test. Enumeration
/// keeps only Vial interfaces, with the same filter as the hidapi backend.
pub struct SharedBackend(pub Arc<MockBackend>);

impl HidBackend for SharedBackend {
    fn enumerate(&self) -> Result<Vec<RawDeviceInfo>, HidError> {
        self.0.enumerate_calls.fetch_add(1, Ordering::SeqCst);
        let devices = self.0.devices.lock().unwrap();
        Ok(devices
            .iter()
            .filter(|d| is_vial_interface(d.usage_page, d.usage))
            .map(|d| d.info.clone())
            .collect())
    }

    fn open_path(&self, _path: &CString) -> Result<Arc<dyn HidHandle>, HidError> {
        self.0.open_calls.fetch_add(1, Ordering::SeqCst);
        let remaining = self.0.open_failures.load(Ordering::SeqCst);
        if remaining > 0 {
            self.0.open_failures.store(remaining - 1, Ordering::SeqCst);
            return Err(HidError::Backend("open failed".into()));
        }
        Ok(self.0.handle.clone())
    }
}

pub struct Fixture {
    pub service: HidService,
    pub backend: Arc<MockBackend>,
    pub sleeps: Arc<AtomicUsize>,
}

/// A service on the mock backend with the clock fixed at 0 and retry delays
/// skipped (and counted).
pub fn fixture(mode: VirtualDeviceMode) -> Fixture {
    let backend = Arc::new(MockBackend::default());
    let sleeps = Arc::new(AtomicUsize::new(0));
    let sleep_counter = sleeps.clone();
    let timing = Timing::new(
        || 0,
        move |_| {
            sleep_counter.fetch_add(1, Ordering::SeqCst);
        },
    );
    let service = HidService::with_backend(Box::new(SharedBackend(backend.clone())), mode, timing);
    Fixture { service, backend, sleeps }
}

/// Enumerate one real (mock) keyboard and open it.
pub fn open_real(f: &Fixture) {
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw0"));
    assert!(f.service.open_device(0x1234, 0x5678).unwrap());
}
