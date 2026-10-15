// SPDX-License-Identifier: GPL-2.0-or-later
// In-memory HID backend for the service tests.

#![allow(dead_code, clippy::unwrap_used)]

use std::collections::VecDeque;
use std::ffi::CString;
use std::sync::atomic::{AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use pipette_hid::{
    HID_USAGE, HID_USAGE_PAGE, HidBackend, HidError, HidHandle, HidService, RawDeviceInfo, VirtualDeviceMode,
};

pub fn raw_device(path: &str) -> RawDeviceInfo {
    RawDeviceInfo {
        path: CString::new(path).unwrap(),
        vendor_id: 0x1234,
        product_id: 0x5678,
        usage_page: HID_USAGE_PAGE,
        usage: HID_USAGE,
        serial_number: Some("vial:f64c2b3c".into()),
        product: Some("Real Test Keyboard".into()),
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
    pub devices: Mutex<Vec<RawDeviceInfo>>,
    pub handle: Arc<MockHandle>,
    pub enumerate_calls: AtomicUsize,
    pub open_calls: AtomicUsize,
    /// open_path fails this many times before succeeding.
    pub open_failures: AtomicUsize,
}

/// Shares one `MockBackend` between the service and the test.
pub struct SharedBackend(pub Arc<MockBackend>);

impl HidBackend for SharedBackend {
    fn enumerate(&self) -> Result<Vec<RawDeviceInfo>, HidError> {
        self.0.enumerate_calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.0.devices.lock().unwrap().clone())
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

/// Mode switch the test can flip while the service is running.
#[derive(Clone, Default)]
pub struct ModeSwitch(Arc<AtomicU8>);

impl ModeSwitch {
    pub fn set(&self, mode: VirtualDeviceMode) {
        let v = match mode {
            VirtualDeviceMode::Off => 0,
            VirtualDeviceMode::Append => 1,
            VirtualDeviceMode::Only => 2,
        };
        self.0.store(v, Ordering::SeqCst);
    }

    pub fn get(&self) -> VirtualDeviceMode {
        match self.0.load(Ordering::SeqCst) {
            1 => VirtualDeviceMode::Append,
            2 => VirtualDeviceMode::Only,
            _ => VirtualDeviceMode::Off,
        }
    }
}

pub struct Fixture {
    pub service: HidService,
    pub backend: Arc<MockBackend>,
    pub mode: ModeSwitch,
    pub sleeps: Arc<AtomicUsize>,
}

/// A service on the mock backend with retry delays skipped (and counted).
pub fn fixture(mode: VirtualDeviceMode) -> Fixture {
    let backend = Arc::new(MockBackend::default());
    let switch = ModeSwitch::default();
    switch.set(mode);
    let sleeps = Arc::new(AtomicUsize::new(0));
    let mode_reader = switch.clone();
    let sleep_counter = sleeps.clone();
    let service = HidService::with_backend(Box::new(SharedBackend(backend.clone())))
        .with_mode_source(move || mode_reader.get())
        .with_clock(|| 0)
        .with_sleeper(move |_| {
            sleep_counter.fetch_add(1, Ordering::SeqCst);
        });
    Fixture { service, backend, mode: switch, sleeps }
}

/// Enumerate one real (mock) keyboard and open it.
pub fn open_real(f: &Fixture) {
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw0"));
    assert!(f.service.open_device(0x1234, 0x5678).unwrap());
}
