// SPDX-License-Identifier: GPL-2.0-or-later
// The packet logs of VIAL_DEBUG_HID: their format against the lines
// src/main/logger.ts wrote (the pipette-logger fixture), and when the
// service writes them.

mod common;

use std::cell::RefCell;
use std::path::Path;

use common::fixture;
use log::{Level, LevelFilter, Log, Metadata, Record};
use pipette_hid::{Direction, VirtualDeviceMode, packet_log_message};
use pipette_virtual_device::dataset::{VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_VID};
use serde::Deserialize;

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

#[derive(Deserialize)]
struct Fixture {
    packets: Vec<Packet>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Packet {
    epoch_ms: i64,
    direction: String,
    data: Vec<u8>,
    line: String,
}

#[test]
fn the_packet_lines_are_the_typescript_ones() {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../pipette-logger/tests/fixtures/ts_log_lines.json");
    let fixture: Fixture = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert!(!fixture.packets.is_empty());
    for packet in &fixture.packets {
        let direction = match packet.direction.as_str() {
            "TX" => Direction::Tx,
            "RX" => Direction::Rx,
            other => panic!("unknown direction {other}"),
        };
        let message = packet_log_message(direction, &packet.data);
        assert_eq!(pipette_logger::format_line(packet.epoch_ms, Level::Debug, &message), packet.line);
    }
}

#[test]
fn a_request_logs_the_report_sent_and_the_response() {
    capture();
    let service = fixture(VirtualDeviceMode::Only).service.with_packet_logging(true);
    service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    let response = service.send_receive(&[0xfe, 0x00]).unwrap();
    let mut sent = vec![0xfe, 0x00];
    sent.resize(32, 0);
    assert_eq!(
        records(),
        [
            (Level::Debug, packet_log_message(Direction::Tx, &sent)),
            (Level::Debug, packet_log_message(Direction::Rx, &response)),
        ]
    );
}

#[test]
fn a_send_logs_only_the_report_sent() {
    capture();
    let service = fixture(VirtualDeviceMode::Only).service.with_packet_logging(true);
    service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    service.send(&[0x01]).unwrap();
    let mut sent = vec![0x01];
    sent.resize(32, 0);
    assert_eq!(records(), [(Level::Debug, packet_log_message(Direction::Tx, &sent))]);
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
