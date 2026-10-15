// SPDX-License-Identifier: GPL-2.0-or-later
// When the service writes the packet logs of VIAL_DEBUG_HID. Their format
// is checked against the TypeScript lines in src/packet_log.rs.

mod common;

use std::cell::RefCell;

use common::fixture;
use log::{Level, LevelFilter, Log, Metadata, Record};
use pipette_hid::VirtualDeviceMode;
use pipette_virtual_device::dataset::{VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_VID};

thread_local! {
    static RECORDS: RefCell<Vec<(Level, String)>> = const { RefCell::new(Vec::new()) };
}

/// Keeps each thread's records apart, so tests running in parallel do not
/// see each other's packets. The service logs on the calling thread.
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
