// SPDX-License-Identifier: GPL-2.0-or-later
// What the service logs: the packet logs of VIAL_DEBUG_HID (their format is
// checked against the recorded lines in src/packet_log.rs) and the reason
// a device could not be opened, against the recorded messages
// (tests/fixtures/ts_open_failure_logs.json).

mod common;

use std::cell::RefCell;
use std::path::Path;
use std::sync::atomic::Ordering;

use common::{fixture, raw_device};
use log::{Level, LevelFilter, Log, Metadata, Record};
use pipette_hid::{HID_OPEN_RETRY_COUNT, VirtualDeviceMode};
use pipette_virtual_device::dataset::{VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_VID};
use serde::Deserialize;

thread_local! {
    static RECORDS: RefCell<Vec<(Level, String)>> = const { RefCell::new(Vec::new()) };
}

/// Keeps each thread's records apart, so tests running in parallel do not
/// see each other's records. The service logs on the calling thread.
struct Capture;

impl Log for Capture {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }
    fn log(&self, record: &Record<'_>) {
        RECORDS.with(|r| r.borrow_mut().push((record.level(), record.args().to_string())));
    }
    fn flush(&self) {}
}

fn capture() {
    static INSTALL: std::sync::Once = std::sync::Once::new();
    INSTALL.call_once(|| {
        log::set_logger(&Capture).expect("no other logger is installed");
        log::set_max_level(LevelFilter::Trace);
    });
    RECORDS.with(|r| r.borrow_mut().clear());
}

fn records() -> Vec<(Level, String)> {
    RECORDS.with(|r| r.borrow().clone())
}

/// The expected message: `HID <direction>: ` and the bytes in hex.
fn message(direction: &str, data: &[u8]) -> String {
    let hex: Vec<String> = data.iter().map(|b| format!("{b:02x}")).collect();
    format!("HID {direction}: {}", hex.join(" "))
}

#[test]
fn a_request_logs_the_report_sent_and_the_response() {
    capture();
    let service = fixture(VirtualDeviceMode::Only).service.with_packet_logging(true);
    service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    let response = service.send_receive(&[0xfe, 0x00]).unwrap();
    let mut sent = vec![0xfe, 0x00];
    sent.resize(32, 0);
    assert_eq!(records(), [(Level::Debug, message("TX", &sent)), (Level::Debug, message("RX", &response)),]);
}

#[test]
fn a_send_logs_only_the_report_sent() {
    capture();
    let service = fixture(VirtualDeviceMode::Only).service.with_packet_logging(true);
    service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    service.send(&[0x01]).unwrap();
    let mut sent = vec![0x01];
    sent.resize(32, 0);
    assert_eq!(records(), [(Level::Debug, message("TX", &sent))]);
}

#[test]
fn nothing_is_logged_when_the_packet_logs_are_off() {
    capture();
    let service = fixture(VirtualDeviceMode::Only).service.with_packet_logging(false);
    service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    service.send_receive(&[0xfe, 0x00]).unwrap();
    assert_eq!(records(), []);
}

#[test]
fn nothing_is_logged_without_an_open_device() {
    capture();
    let service = fixture(VirtualDeviceMode::Only).service.with_packet_logging(true);
    assert!(service.send(&[0x01]).is_err());
    assert_eq!(records(), []);
}

#[test]
fn a_probe_logs_nothing_even_with_the_packet_logs_on() {
    capture();
    let f = fixture(VirtualDeviceMode::Off);
    let service = f.service.with_packet_logging(true);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw1"));
    f.backend.handle_for("/dev/hidraw1").default_read.lock().unwrap().push(0x01);
    let id = service.probe_open(0x1234, 0x5678, None).unwrap();
    service.probe_send_receive(id, &[0x01]).unwrap();
    assert!(service.probe_send_receive(id + 1, &[0x01]).is_err());
    assert!(service.probe_open(0x1234, 0x5678, Some("missing")).is_err());
    assert_eq!(records(), []);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenFailureLog {
    vendor_id: u16,
    product_id: u16,
    error: String,
    level: String,
    message: String,
}

fn open_failure_logs() -> Vec<OpenFailureLog> {
    #[derive(Deserialize)]
    struct Fixture {
        logs: Vec<OpenFailureLog>,
    }
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ts_open_failure_logs.json");
    let bytes = std::fs::read(path).expect("the fixture is readable");
    let fixture: Fixture = serde_json::from_slice(&bytes).expect("the fixture parses");
    assert!(!fixture.logs.is_empty());
    for log in &fixture.logs {
        assert_eq!(log.level, "error");
    }
    fixture.logs
}

#[test]
fn a_failed_enumeration_logs_the_recorded_message() {
    for log in open_failure_logs() {
        capture();
        let f = fixture(VirtualDeviceMode::Off);
        *f.backend.enumerate_error.lock().unwrap() = Some(log.error.clone());
        assert!(f.service.open_device(log.vendor_id, log.product_id).is_err());
        assert_eq!(records(), [(Level::Error, log.message.clone())]);
    }
}

#[test]
fn only_the_last_failed_open_attempt_logs_the_recorded_message() {
    for log in open_failure_logs() {
        capture();
        let f = fixture(VirtualDeviceMode::Off);
        let mut device = raw_device("/dev/hidraw0");
        device.info.vendor_id = log.vendor_id;
        device.info.product_id = log.product_id;
        f.backend.devices.lock().unwrap().push(device);
        f.backend.open_failures.store(usize::MAX, Ordering::SeqCst);
        *f.backend.open_error.lock().unwrap() = Some(log.error.clone());
        assert!(f.service.open_device(log.vendor_id, log.product_id).is_err());
        assert_eq!(f.backend.open_calls.load(Ordering::SeqCst), HID_OPEN_RETRY_COUNT as usize);
        assert_eq!(records(), [(Level::Error, log.message.clone())]);
    }
}

#[test]
fn an_open_that_succeeds_after_retries_logs_nothing() {
    capture();
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw0"));
    f.backend.open_failures.store(3, Ordering::SeqCst);
    assert!(f.service.open_device(0x1234, 0x5678).unwrap());
    assert_eq!(records(), []);
}
