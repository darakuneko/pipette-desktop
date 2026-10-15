// SPDX-License-Identifier: GPL-2.0-or-later
//! Device enumeration, connection and serialized 32-byte packet I/O.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use pipette_protocol::{MSG_LEN, Report, pad_report};
use pipette_virtual_device::{VirtualDevice, VirtualDeviceController, VirtualDeviceMode};

use crate::backend::{HidBackend, HidHandle, RawDeviceInfo};
use crate::constants::{
    HID_OPEN_RETRY_COUNT, HID_OPEN_RETRY_DELAY_MS, HID_REPORT_ID, HID_RETRY_COUNT, HID_RETRY_DELAY_MS,
    HID_TIMEOUT_MS,
};
use crate::device_info::DeviceInfo;
use crate::error::HidError;
use crate::fifo::FifoLock;
use crate::hidapi_backend::HidapiBackend;
use crate::packet_log::{Direction, log_packet, packet_logging_from_env};
use crate::probe::ProbeSlot;
use crate::timing::Timing;
use crate::virtual_backend::{DeviceBackends, VirtualBackend};

const READ_BUFFER_LEN: usize = 256;

type Packet = [u8; MSG_LEN + 1];

struct OpenDevice {
    handle: Arc<dyn HidHandle>,
    path: std::ffi::CString,
}

/// One per process. Every method takes `&self` and blocks; call it from a
/// worker thread, not an async executor.
pub struct HidService {
    backend: DeviceBackends,
    controller: VirtualDeviceController,
    timing: Timing,
    /// The one open device, real or virtual.
    open_device: Mutex<Option<OpenDevice>>,
    /// Serializes send/send_receive in arrival order.
    io_queue: FifoLock,
    /// Whether every report sent and received is logged (`VIAL_DEBUG_HID`).
    log_packets: bool,
    /// The temporary handle of a probe, next to the main connection.
    probe: ProbeSlot,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
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

/// Logs why a device could not be opened, in the words of `logOpenFailure`
/// in src/main/hid-service.ts, so the cause is not lost behind the message
/// the renderer shows.
fn log_open_failure(vendor_id: u16, product_id: u16, err: &HidError) {
    log::error!("Failed to open HID device 0x{vendor_id:04x}:0x{product_id:04x}: {err}");
}

/// Report ID 0 followed by the zero-padded 32-byte report.
fn packet(data: &[u8]) -> Packet {
    let mut packet = [0u8; MSG_LEN + 1];
    packet[0] = HID_REPORT_ID;
    packet[1..].copy_from_slice(&pad_report(data));
    packet
}

impl HidService {
    /// Real hardware through hidapi, with the virtual keyboard per `mode`
    /// (resolve it once at startup, e.g. with [`VirtualDeviceMode::from_env`]).
    pub fn new(mode: VirtualDeviceMode) -> Self {
        Self::build(Box::new(HidapiBackend::new()), mode, Timing::system())
    }

    /// `hardware` in place of hidapi and `timing` in place of the system
    /// clock and real retry delays.
    #[cfg(any(test, feature = "test-util"))]
    pub fn with_backend(hardware: Box<dyn HidBackend>, mode: VirtualDeviceMode, timing: Timing) -> Self {
        Self::build(hardware, mode, timing)
    }

    fn build(hardware: Box<dyn HidBackend>, mode: VirtualDeviceMode, timing: Timing) -> Self {
        let device = Arc::new(Mutex::new(VirtualDevice::new()));
        let controller = VirtualDeviceController::new(Arc::clone(&device));
        let virtual_device = VirtualBackend::new(device, timing.clone());
        Self {
            backend: DeviceBackends::new(hardware, virtual_device, mode),
            controller,
            timing,
            open_device: Mutex::new(None),
            io_queue: FifoLock::default(),
            log_packets: packet_logging_from_env(),
            probe: ProbeSlot::default(),
        }
    }

    /// Turns the packet logs on or off, whatever `VIAL_DEBUG_HID` says.
    #[cfg(any(test, feature = "test-util"))]
    pub fn with_packet_logging(mut self, enabled: bool) -> Self {
        self.log_packets = enabled;
        self
    }

    /// The controller of the virtual keyboard (key presses, unlock counter,
    /// reset), for tests and development tools.
    pub fn virtual_device(&self) -> VirtualDeviceController {
        self.controller.clone()
    }

    /// Vial interfaces (usage page 0xFF60, usage 0x61). In `Only` mode just
    /// the virtual device, without enumerating hardware; in `Append` mode the
    /// virtual device is appended after the real ones.
    pub fn list_devices(&self) -> Result<Vec<DeviceInfo>, HidError> {
        Ok(self.backend.enumerate()?.into_iter().map(DeviceInfo::from).collect())
    }

    /// Close whatever is open, then open the first Vial interface matching
    /// `vendor_id`/`product_id`. Returns `Ok(false)` when none is present.
    /// Opening is retried (transient failures happen on every platform);
    /// the last error is returned. A failed enumeration and the last failed
    /// attempt are logged.
    pub fn open_device(&self, vendor_id: u16, product_id: u16) -> Result<bool, HidError> {
        self.close_device();

        let found = self.backend.find(vendor_id, product_id).inspect_err(|err| {
            log_open_failure(vendor_id, product_id, err);
        })?;
        let Some(RawDeviceInfo { path, .. }) = found else {
            return Ok(false);
        };

        let mut attempt = 0;
        loop {
            match self.backend.open_path(&path) {
                Ok(handle) => {
                    *lock(&self.open_device) = Some(OpenDevice { handle, path });
                    return Ok(true);
                }
                Err(err) => {
                    attempt += 1;
                    if attempt >= HID_OPEN_RETRY_COUNT {
                        log_open_failure(vendor_id, product_id, &err);
                        return Err(err);
                    }
                    (self.timing.sleep)(Duration::from_millis(HID_OPEN_RETRY_DELAY_MS));
                }
            }
        }
    }

    pub fn close_device(&self) {
        if let Some(device) = lock(&self.open_device).take() {
            device.handle.close();
        }
    }

    /// Send one report (zero-padded to 32 bytes) and wait for the response.
    /// Requests are served one at a time in arrival order. A read that times
    /// out is retried (write included) up to HID_RETRY_COUNT times; any other
    /// error fails at once.
    pub fn send_receive(&self, data: &[u8]) -> Result<Report, HidError> {
        self.exchange(data, |handle, packet| {
            // Larger than any report, so the length read is the report's own
            // length and normalize_response sees what the device sent.
            let mut buf = [0u8; READ_BUFFER_LEN];
            for attempt in 0..HID_RETRY_COUNT {
                handle.write(packet)?;
                let read = handle.read_timeout(&mut buf, HID_TIMEOUT_MS)?;
                if read > 0 {
                    let report = normalize_response(&buf[..read]);
                    log_packet(self.log_packets, Direction::Rx, &report);
                    return Ok(report);
                }
                if attempt + 1 < HID_RETRY_COUNT {
                    (self.timing.sleep)(Duration::from_millis(HID_RETRY_DELAY_MS));
                }
            }
            Err(HidError::ReadTimeout)
        })
    }

    /// Send one report without waiting for a response, in the same queue as
    /// [`HidService::send_receive`].
    pub fn send(&self, data: &[u8]) -> Result<(), HidError> {
        self.exchange(data, |handle, packet| handle.write(packet).map(drop))
    }

    /// True while a device is open and still enumerated. A device that has
    /// disappeared is closed.
    pub fn is_device_open(&self) -> Result<bool, HidError> {
        let Some(path) = lock(&self.open_device).as_ref().map(|d| d.path.clone()) else {
            return Ok(false);
        };
        let present = self.backend.is_present(&path)?;
        if !present {
            self.close_device();
        }
        Ok(present)
    }

    /// Opens the first Vial interface on real hardware with this VID/PID that
    /// is not the main connection — and, when `serial_number` is given and
    /// not empty, whose serial number is exactly that — as the probe handle,
    /// closing any probe handle open before. Returns the new handle's id.
    /// The virtual keyboard is never a candidate, and hardware is searched
    /// even when the device list shows only the virtual keyboard: the
    /// Electron main process probes over node-hid's own enumeration. One
    /// attempt, nothing logged.
    pub fn probe_open(
        &self,
        vendor_id: u16,
        product_id: u16,
        serial_number: Option<&str>,
    ) -> Result<u32, HidError> {
        self.probe.close(None);
        let serial_number = serial_number.filter(|s| !s.is_empty());
        let main_path = lock(&self.open_device).as_ref().map(|d| d.path.clone());
        let hardware = self.backend.hardware();
        let target = hardware
            .enumerate()?
            .into_iter()
            .find(|d| {
                d.vendor_id == vendor_id
                    && d.product_id == product_id
                    && main_path.as_ref() != Some(&d.path)
                    && serial_number.is_none_or(|s| d.serial_number.as_deref().unwrap_or_default() == s)
            })
            .ok_or(HidError::ProbeTargetNotFound)?;
        let handle = hardware.open_path(&target.path)?;
        Ok(self.probe.replace(handle))
    }

    /// Sends one report (zero-padded to 32 bytes) over the probe handle `id`
    /// and reads the response once, waiting HID_TIMEOUT_MS. No retries and
    /// no packet logs; probe requests do not queue behind the main
    /// connection's.
    pub fn probe_send_receive(&self, id: u32, data: &[u8]) -> Result<Report, HidError> {
        if data.len() > MSG_LEN {
            return Err(HidError::DataTooLong { max: MSG_LEN });
        }
        let handle = self.probe.handle(id).ok_or(HidError::ProbeNotOpen)?;
        handle.write(&packet(data))?;
        let mut buf = [0u8; READ_BUFFER_LEN];
        let read = handle.read_timeout(&mut buf, HID_TIMEOUT_MS)?;
        if read == 0 {
            return Err(HidError::ProbeReadTimeout);
        }
        Ok(normalize_response(&buf[..read]))
    }

    /// Closes the probe handle `id`; nothing when it is no longer the open one.
    pub fn probe_close(&self, id: u32) {
        self.probe.close(Some(id));
    }

    /// Closes the probe handle, whichever is open (when the app quits).
    pub fn close_probe(&self) {
        self.probe.close(None);
    }

    /// Length check, then `io` on the open device's handle with the framed
    /// packet, inside the I/O queue, logging the report as sent. The handle
    /// is pinned for the whole exchange, retries included: open and close
    /// replace it outside the queue.
    fn exchange<R>(
        &self,
        data: &[u8],
        io: impl FnOnce(&dyn HidHandle, &Packet) -> Result<R, HidError>,
    ) -> Result<R, HidError> {
        if data.len() > MSG_LEN {
            return Err(HidError::DataTooLong { max: MSG_LEN });
        }
        let _turn = self.io_queue.acquire();
        let handle =
            lock(&self.open_device).as_ref().map(|d| Arc::clone(&d.handle)).ok_or(HidError::NotOpen)?;
        let packet = packet(data);
        // Once per request, retries included, without the report ID.
        log_packet(self.log_packets, Direction::Tx, &packet[1..]);
        io(handle.as_ref(), &packet)
    }
}
