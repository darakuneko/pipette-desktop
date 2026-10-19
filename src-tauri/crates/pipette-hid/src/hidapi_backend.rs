// SPDX-License-Identifier: GPL-2.0-or-later
//! [`HidBackend`] on the `hidapi` crate (hidraw on Linux).

use std::ffi::CString;
use std::sync::Arc;
use std::time::Duration;

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

/// How long dropping a device handle waits for the device's thread to close
/// it: longer than one read (`HID_TIMEOUT_MS`) or one write (hidapi's
/// Windows write timeout, 1 s) the thread may be finishing, and short
/// enough that a close at quit cannot hold it up for long.
const CLOSE_WAIT: Duration = Duration::from_secs(2);

/// The hidapi context is created on first use and kept for the life of the
/// process. Initialising, enumerating and opening run on [`HIDAPI_THREAD`];
/// each open device then writes, reads and closes on a thread of its own
/// ([`ThreadedHandle`]). A probe's exchanges, the main connection's and
/// enumeration do not queue behind each other.
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
        Ok(Arc::new(ThreadedHandle::new(device)?))
    }
}

/// The calls a [`ThreadedHandle`] makes on its device.
trait DeviceIo: Send + 'static {
    fn write(&mut self, data: &[u8]) -> Result<usize, HidError>;
    fn read_timeout(&mut self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, HidError>;
}

impl DeviceIo for HidDevice {
    fn write(&mut self, data: &[u8]) -> Result<usize, HidError> {
        Ok(HidDevice::write(self, data)?)
    }

    fn read_timeout(&mut self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, HidError> {
        Ok(HidDevice::read_timeout(self, buf, timeout_ms)?)
    }
}

/// An open device whose writes, reads and close (dropping it) all run on
/// one thread that lives as long as the handle (see `hid_thread.rs` for
/// why), so I/O hidapi leaves pending always belongs to a live thread and
/// the close cancels it from the thread that issued it. Each handle has one
/// caller at a time (the main connection's requests are serialized by the
/// service's queue, a probe's by the WebView awaiting each one), so the
/// thread does not add waiting.
struct ThreadedHandle<D: DeviceIo> {
    thread: OwnerThread<Option<D>>,
}

impl<D: DeviceIo> ThreadedHandle<D> {
    /// Moves `device` onto a new thread. If the thread cannot start, the
    /// device is closed here: no I/O has been issued on it yet.
    fn new(device: D) -> Result<Self, HidError> {
        let thread = OwnerThread::new("pipette-hid-device");
        thread.run(move |slot| *slot = Some(device))?;
        Ok(Self { thread })
    }

    fn with_device<R: Send + 'static>(
        &self,
        io: impl FnOnce(&mut D) -> Result<R, HidError> + Send + 'static,
    ) -> Result<R, HidError> {
        self.thread.run(|slot| slot.as_mut().map_or(Err(HidError::NotOpen), io))?
    }
}

impl<D: DeviceIo> HidHandle for ThreadedHandle<D> {
    fn write(&self, data: &[u8]) -> Result<usize, HidError> {
        let data = data.to_vec();
        self.with_device(move |device| device.write(&data))
    }

    fn read_timeout(&self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, HidError> {
        let len = buf.len();
        let read = self.with_device(move |device| {
            let mut read = vec![0u8; len];
            let n = device.read_timeout(&mut read, timeout_ms)?;
            read.truncate(n);
            Ok(read)
        })?;
        buf[..read.len()].copy_from_slice(&read);
        Ok(read.len())
    }
}

/// Closes the device on its thread, waiting up to [`CLOSE_WAIT`]; past
/// that the close still happens on the thread, after the call it is
/// finishing. The thread then ends.
impl<D: DeviceIo> Drop for ThreadedHandle<D> {
    fn drop(&mut self) {
        let closed = self.thread.run_within(|slot| drop(slot.take()), CLOSE_WAIT);
        if let Err(err) = closed {
            log::warn!("Closing a HID device: {err}");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;
    use std::sync::{Mutex, PoisonError};
    use std::thread::{self, ThreadId};
    use std::time::Instant;

    use super::*;

    type Calls = Arc<Mutex<Vec<(&'static str, ThreadId)>>>;

    /// Records the thread of every call.
    struct FakeDevice {
        calls: Calls,
    }

    impl FakeDevice {
        fn new() -> (Self, Calls) {
            let calls = Calls::default();
            (Self { calls: Arc::clone(&calls) }, calls)
        }

        fn record(&self, call: &'static str) {
            self.calls.lock().unwrap_or_else(PoisonError::into_inner).push((call, thread::current().id()));
        }
    }

    impl DeviceIo for FakeDevice {
        fn write(&mut self, data: &[u8]) -> Result<usize, HidError> {
            self.record("write");
            if data.is_empty() {
                return Err(HidError::Backend("empty write".into()));
            }
            Ok(data.len())
        }

        fn read_timeout(&mut self, buf: &mut [u8], timeout_ms: i32) -> Result<usize, HidError> {
            self.record("read");
            if timeout_ms == 0 {
                return Ok(0);
            }
            buf[..3].copy_from_slice(&[1, 2, 3]);
            Ok(3)
        }
    }

    impl Drop for FakeDevice {
        fn drop(&mut self) {
            self.record("close");
        }
    }

    fn calls_of(calls: &Calls) -> Vec<(&'static str, ThreadId)> {
        calls.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// Mirrors the Windows hazard: a read issued from a caller thread that
    /// then exits, more I/O from other callers, and the close from yet
    /// another thread. Every call on the device runs on the handle's one
    /// thread, which no caller is.
    #[test]
    fn writes_reads_and_the_close_run_on_the_handles_own_thread() {
        #![allow(clippy::unwrap_used)]
        let (device, calls) = FakeDevice::new();
        let handle = Arc::new(ThreadedHandle::new(device).unwrap());
        let mut callers = Vec::new();
        for timeout in [0, 500, 500] {
            let handle = Arc::clone(&handle);
            let (read, caller) = thread::spawn(move || {
                assert_eq!(handle.write(&[0, 9]).unwrap(), 2);
                let mut buf = [0u8; 8];
                let n = handle.read_timeout(&mut buf, timeout).unwrap();
                (buf[..n].to_vec(), thread::current().id())
            })
            .join()
            .unwrap();
            assert_eq!(read, if timeout == 0 { vec![] } else { vec![1, 2, 3] });
            callers.push(caller);
        }
        assert!(matches!(handle.write(&[]), Err(HidError::Backend(m)) if m == "empty write"));
        let closer = thread::spawn(move || {
            drop(handle);
            thread::current().id()
        })
        .join()
        .unwrap();
        callers.extend([closer, thread::current().id()]);

        let calls = calls_of(&calls);
        assert_eq!(calls.len(), 8);
        assert_eq!(calls.last().map(|c| c.0), Some("close"));
        let device_thread = calls[0].1;
        assert!(calls.iter().all(|c| c.1 == device_thread));
        assert!(!callers.contains(&device_thread));
    }

    #[test]
    fn each_handle_has_its_own_thread() {
        #![allow(clippy::unwrap_used)]
        let (a, a_calls) = FakeDevice::new();
        let (b, b_calls) = FakeDevice::new();
        let (a, b) = (ThreadedHandle::new(a).unwrap(), ThreadedHandle::new(b).unwrap());
        a.write(&[1]).unwrap();
        b.write(&[1]).unwrap();
        assert_ne!(calls_of(&a_calls)[0].1, calls_of(&b_calls)[0].1);
    }

    /// A close behind a read that does not return waits at most
    /// CLOSE_WAIT, then still happens on the device's thread once the read
    /// is done.
    #[test]
    fn dropping_a_busy_handle_waits_a_bounded_time_and_closes_later() {
        #![allow(clippy::unwrap_used)]
        let (device, calls) = FakeDevice::new();
        let handle = ThreadedHandle::new(device).unwrap();
        let (release, hold) = mpsc::channel::<()>();
        // A call that keeps the device's thread busy until released.
        let busy = handle.thread.run_within(
            move |_| {
                let _ = hold.recv();
            },
            Duration::ZERO,
        );
        assert!(busy.is_err());

        let started = Instant::now();
        drop(handle);
        let waited = started.elapsed();
        assert!(waited >= CLOSE_WAIT && waited < CLOSE_WAIT + Duration::from_secs(5), "{waited:?}");
        assert!(calls_of(&calls).is_empty());
        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while calls_of(&calls).last().map(|c| c.0) != Some("close") {
            assert!(Instant::now() < deadline, "the device was not closed");
            thread::sleep(Duration::from_millis(5));
        }
    }

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
