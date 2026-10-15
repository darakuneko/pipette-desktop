// SPDX-License-Identifier: GPL-2.0-or-later
//! Device enumeration, connection and serialized 32-byte packet I/O.

use std::ffi::CString;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use pipette_virtual_device::device::matches_virtual_device;
use pipette_virtual_device::protocol::pad_report;
use pipette_virtual_device::{MSG_LEN, Report, VirtualDevice, VirtualDeviceMode};

use crate::backend::{HidBackend, HidHandle, RawDeviceInfo};
use crate::constants::{
    HID_OPEN_RETRY_COUNT, HID_OPEN_RETRY_DELAY_MS, HID_REPORT_ID, HID_RETRY_COUNT, HID_RETRY_DELAY_MS,
    HID_TIMEOUT_MS, HID_USAGE, HID_USAGE_PAGE,
};
use crate::device_info::{DeviceInfo, classify_device, virtual_device_info};
use crate::error::HidError;
use crate::fifo::FifoLock;
use crate::hidapi_backend::HidapiBackend;

type ModeSource = Box<dyn Fn() -> VirtualDeviceMode + Send + Sync>;
type Clock = Box<dyn Fn() -> u64 + Send + Sync>;
type Sleeper = Box<dyn Fn(Duration) + Send + Sync>;

const READ_BUFFER_LEN: usize = 256;

struct OpenDevice {
    handle: Arc<dyn HidHandle>,
    path: CString,
}

/// One per process. Every method takes `&self` and blocks; call it from a
/// worker thread, not an async executor.
pub struct HidService {
    backend: Box<dyn HidBackend>,
    mode: ModeSource,
    clock: Clock,
    sleep: Sleeper,
    open_device: Mutex<Option<OpenDevice>>,
    /// Lives as long as the service, so its state survives close and re-open.
    virtual_device: Mutex<VirtualDevice>,
    /// Serializes send/send_receive in arrival order.
    io_queue: FifoLock,
}

impl Default for HidService {
    fn default() -> Self {
        Self::new()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn system_clock_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// A read that is exactly one report long plus a leading report ID 0 has the
/// ID stripped (some platforms include it); anything else is zero-padded or
/// truncated to MSG_LEN.
fn normalize_response(buf: &[u8]) -> Report {
    if buf.len() == MSG_LEN + 1 && buf[0] == HID_REPORT_ID {
        return pad_report(&buf[1..]);
    }
    pad_report(buf)
}

fn is_vial_interface(d: &RawDeviceInfo) -> bool {
    d.usage_page == HID_USAGE_PAGE && d.usage == HID_USAGE
}

impl HidService {
    /// Real hardware through hidapi; the virtual device follows
    /// `PIPETTE_VIRTUAL_DEVICE`, read on every call.
    pub fn new() -> Self {
        Self::with_backend(Box::new(HidapiBackend::new()))
    }

    pub fn with_backend(backend: Box<dyn HidBackend>) -> Self {
        Self {
            backend,
            mode: Box::new(VirtualDeviceMode::from_env),
            clock: Box::new(system_clock_ms),
            sleep: Box::new(std::thread::sleep),
            open_device: Mutex::new(None),
            virtual_device: Mutex::new(VirtualDevice::new()),
            io_queue: FifoLock::default(),
        }
    }

    /// Replace the `PIPETTE_VIRTUAL_DEVICE` lookup (tests).
    pub fn with_mode_source(mut self, mode: impl Fn() -> VirtualDeviceMode + Send + Sync + 'static) -> Self {
        self.mode = Box::new(mode);
        self
    }

    /// Replace the wall clock (ms) handed to the virtual device (tests).
    pub fn with_clock(mut self, clock: impl Fn() -> u64 + Send + Sync + 'static) -> Self {
        self.clock = Box::new(clock);
        self
    }

    /// Replace the retry delay (tests).
    pub fn with_sleeper(mut self, sleep: impl Fn(Duration) + Send + Sync + 'static) -> Self {
        self.sleep = Box::new(sleep);
        self
    }

    /// Run `f` against the virtual device — the controller used by tests and
    /// development tools (key presses, unlock counter, reset).
    pub fn with_virtual_device<R>(&self, f: impl FnOnce(&mut VirtualDevice) -> R) -> R {
        f(&mut lock(&self.virtual_device))
    }

    /// Vial interfaces (usage page 0xFF60, usage 0x61). In `only` mode just
    /// the virtual device, without enumerating hardware; in `1` mode the
    /// virtual device is appended after the real ones.
    pub fn list_devices(&self) -> Result<Vec<DeviceInfo>, HidError> {
        let mode = (self.mode)();
        if mode.is_exclusive() {
            return Ok(vec![virtual_device_info()]);
        }

        let mut result: Vec<DeviceInfo> = self
            .backend
            .enumerate()?
            .into_iter()
            .filter(is_vial_interface)
            .map(|d| {
                let serial_number = d.serial_number.unwrap_or_default();
                DeviceInfo {
                    vendor_id: d.vendor_id,
                    product_id: d.product_id,
                    product_name: d.product.unwrap_or_default(),
                    device_type: classify_device(&serial_number),
                    serial_number,
                }
            })
            .collect();

        if mode.is_enabled() {
            result.push(virtual_device_info());
        }
        Ok(result)
    }

    /// Close whatever is open, then open the first Vial interface matching
    /// `vendor_id`/`product_id`. Returns `Ok(false)` when none is present.
    /// Opening is retried (transient failures happen on every platform);
    /// the last error is returned.
    pub fn open_device(&self, vendor_id: u16, product_id: u16) -> Result<bool, HidError> {
        self.close_device();

        if (self.mode)().is_enabled() && matches_virtual_device(vendor_id, product_id) {
            lock(&self.virtual_device).open();
            return Ok(true);
        }

        let devices = self.backend.enumerate()?;
        let Some(target) = devices
            .into_iter()
            .find(|d| d.vendor_id == vendor_id && d.product_id == product_id && is_vial_interface(d))
        else {
            return Ok(false);
        };

        let mut attempt = 0;
        loop {
            match self.backend.open_path(&target.path) {
                Ok(handle) => {
                    *lock(&self.open_device) = Some(OpenDevice { handle, path: target.path });
                    return Ok(true);
                }
                Err(err) => {
                    attempt += 1;
                    if attempt >= HID_OPEN_RETRY_COUNT {
                        return Err(err);
                    }
                    (self.sleep)(Duration::from_millis(HID_OPEN_RETRY_DELAY_MS));
                }
            }
        }
    }

    /// Close the real device (if any) and always clear the virtual open flag:
    /// I/O routes on that flag alone, so a stale flag would keep capturing
    /// reports after the mode changed.
    pub fn close_device(&self) {
        lock(&self.open_device).take();
        lock(&self.virtual_device).close();
    }

    /// Send one report (zero-padded to 32 bytes) and wait for the response.
    /// Requests are served one at a time in arrival order. A read that times
    /// out is retried (write included) up to HID_RETRY_COUNT times; any other
    /// error fails at once.
    pub fn send_receive(&self, data: &[u8]) -> Result<Report, HidError> {
        if data.len() > MSG_LEN {
            return Err(HidError::DataTooLong { max: MSG_LEN });
        }
        let _turn = self.io_queue.acquire();

        if let Some(response) = self.virtual_report(data)? {
            return Ok(response);
        }

        // Pin the handle for the whole exchange, retries included: open and
        // close replace it outside the I/O queue.
        let handle = self.pinned_handle()?;
        let packet = self.packet(data);
        // Larger than any report, so the length read is the report's own
        // length and normalize_response sees what the device sent.
        let mut buf = [0u8; READ_BUFFER_LEN];
        for attempt in 0..HID_RETRY_COUNT {
            handle.write(&packet)?;
            let read = handle.read_timeout(&mut buf, HID_TIMEOUT_MS)?;
            if read > 0 {
                return Ok(normalize_response(&buf[..read]));
            }
            if attempt + 1 < HID_RETRY_COUNT {
                (self.sleep)(Duration::from_millis(HID_RETRY_DELAY_MS));
            }
        }
        Err(HidError::ReadTimeout)
    }

    /// Send one report without waiting for a response, in the same queue as
    /// [`HidService::send_receive`].
    pub fn send(&self, data: &[u8]) -> Result<(), HidError> {
        if data.len() > MSG_LEN {
            return Err(HidError::DataTooLong { max: MSG_LEN });
        }
        let _turn = self.io_queue.acquire();

        if self.virtual_report(data)?.is_some() {
            return Ok(());
        }
        let handle = self.pinned_handle()?;
        handle.write(&self.packet(data))?;
        Ok(())
    }

    /// True while a device is open and still enumerated. A real device that
    /// has disappeared is closed.
    pub fn is_device_open(&self) -> Result<bool, HidError> {
        if lock(&self.virtual_device).is_open() {
            return Ok(true);
        }
        let Some(path) = lock(&self.open_device).as_ref().map(|d| d.path.clone()) else {
            return Ok(false);
        };
        let present = self.backend.enumerate()?.iter().any(|d| d.path == path);
        if !present {
            self.close_device();
        }
        Ok(present)
    }

    /// The virtual device's response when it is the open device.
    fn virtual_report(&self, data: &[u8]) -> Result<Option<Report>, HidError> {
        let mut device = lock(&self.virtual_device);
        if !device.is_open() {
            return Ok(None);
        }
        Ok(Some(device.handle_report(data, (self.clock)())?))
    }

    fn pinned_handle(&self) -> Result<Arc<dyn HidHandle>, HidError> {
        lock(&self.open_device).as_ref().map(|d| Arc::clone(&d.handle)).ok_or(HidError::NotOpen)
    }

    /// Report ID 0 followed by the zero-padded 32-byte report.
    fn packet(&self, data: &[u8]) -> [u8; MSG_LEN + 1] {
        let mut packet = [0u8; MSG_LEN + 1];
        packet[0] = HID_REPORT_ID;
        packet[1..].copy_from_slice(&pad_report(data));
        packet
    }
}
