// SPDX-License-Identifier: GPL-2.0-or-later
// The probe handle of HidService against the in-memory backend: which
// interface it opens, the single-read exchange, and the one-handle limit.

mod common;

use std::sync::atomic::Ordering;

use common::{fixture, open_real, raw_device};
use pipette_hid::{HID_TIMEOUT_MS, HidError, MSG_LEN, VirtualDeviceMode};
use pipette_virtual_device::dataset::{VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_VID};

fn device_with_serial(path: &str, serial: Option<&str>) -> common::MockDevice {
    let mut device = raw_device(path);
    device.info.serial_number = serial.map(str::to_owned);
    device
}

fn opened_paths(f: &common::Fixture) -> Vec<String> {
    let paths = f.backend.opened_paths.lock().expect("not poisoned");
    paths.iter().map(|p| p.to_string_lossy().into_owned()).collect()
}

#[test]
fn opens_the_matching_interface_and_exchanges_one_report() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw3"));
    let handle = f.backend.handle_for("/dev/hidraw3");
    handle.reads.lock().unwrap().push_back(Ok(vec![0x11, 0x04]));

    let id = f.service.probe_open(0x1234, 0x5678, None).unwrap();
    let response = f.service.probe_send_receive(id, &[0x11]).unwrap();

    let mut expected = [0u8; MSG_LEN];
    expected[..2].copy_from_slice(&[0x11, 0x04]);
    assert_eq!(response, expected);
    let mut packet = vec![0x00, 0x11];
    packet.resize(MSG_LEN + 1, 0);
    assert_eq!(*handle.writes.lock().unwrap(), [packet]);
    assert_eq!(*handle.read_timeouts.lock().unwrap(), [HID_TIMEOUT_MS]);
    assert_eq!(opened_paths(&f), ["/dev/hidraw3"]);
}

#[test]
fn strips_a_leading_report_id_from_the_response() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw3"));
    let mut with_id = vec![0x00, 0xaa];
    with_id.resize(MSG_LEN + 1, 0xbb);
    f.backend.handle_for("/dev/hidraw3").reads.lock().unwrap().push_back(Ok(with_id));

    let id = f.service.probe_open(0x1234, 0x5678, None).unwrap();
    let response = f.service.probe_send_receive(id, &[0x01]).unwrap();
    assert_eq!(response[0], 0xaa);
    assert_eq!(response[MSG_LEN - 1], 0xbb);
}

#[test]
fn skips_the_interface_of_the_main_connection() {
    let f = fixture(VirtualDeviceMode::Off);
    open_real(&f);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw1"));

    f.service.probe_open(0x1234, 0x5678, None).unwrap();
    assert_eq!(opened_paths(&f), ["/dev/hidraw0", "/dev/hidraw1"]);
}

#[test]
fn finds_nothing_when_only_the_main_connection_matches() {
    let f = fixture(VirtualDeviceMode::Off);
    open_real(&f);
    assert!(matches!(f.service.probe_open(0x1234, 0x5678, None), Err(HidError::ProbeTargetNotFound)));
    assert_eq!(
        f.service.probe_open(0x1234, 0x5678, None).unwrap_err().to_string(),
        "Probe target device not found"
    );
}

#[test]
fn matches_the_serial_number_exactly_when_one_is_given() {
    let f = fixture(VirtualDeviceMode::Off);
    *f.backend.devices.lock().unwrap() = vec![
        device_with_serial("/dev/hidraw0", None),
        device_with_serial("/dev/hidraw1", Some("vial:f64c2b3c:a")),
        device_with_serial("/dev/hidraw2", Some("vial:f64c2b3c:b")),
    ];

    f.service.probe_open(0x1234, 0x5678, Some("vial:f64c2b3c:b")).unwrap();
    assert_eq!(opened_paths(&f), ["/dev/hidraw2"]);
    assert!(matches!(
        f.service.probe_open(0x1234, 0x5678, Some("vial:f64c2b3c")),
        Err(HidError::ProbeTargetNotFound)
    ));
}

#[test]
fn an_empty_serial_number_matches_any_interface() {
    let f = fixture(VirtualDeviceMode::Off);
    *f.backend.devices.lock().unwrap() =
        vec![device_with_serial("/dev/hidraw0", None), device_with_serial("/dev/hidraw1", Some("x"))];

    f.service.probe_open(0x1234, 0x5678, Some("")).unwrap();
    assert_eq!(opened_paths(&f), ["/dev/hidraw0"]);
}

#[test]
fn an_empty_read_fails_at_once_without_retrying() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw3"));
    let handle = f.backend.handle_for("/dev/hidraw3");

    let id = f.service.probe_open(0x1234, 0x5678, None).unwrap();
    let err = f.service.probe_send_receive(id, &[0x01]).unwrap_err();

    assert!(matches!(err, HidError::ProbeReadTimeout));
    assert_eq!(err.to_string(), "HID read timeout during probe");
    assert_eq!(handle.read_calls.load(Ordering::SeqCst), 1);
    assert_eq!(handle.writes.lock().unwrap().len(), 1);
    assert_eq!(f.sleeps.load(Ordering::SeqCst), 0);
}

#[test]
fn read_and_write_errors_pass_through() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw3"));
    let handle = f.backend.handle_for("/dev/hidraw3");
    let id = f.service.probe_open(0x1234, 0x5678, None).unwrap();

    handle.reads.lock().unwrap().push_back(Err("read failed".into()));
    assert_eq!(f.service.probe_send_receive(id, &[0x01]).unwrap_err().to_string(), "read failed");

    *handle.write_error.lock().unwrap() = Some("Cannot write to hid device".into());
    assert_eq!(
        f.service.probe_send_receive(id, &[0x01]).unwrap_err().to_string(),
        "Cannot write to hid device"
    );
    assert_eq!(handle.read_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn an_open_failure_is_returned_without_retrying() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw3"));
    f.backend.open_failures.store(1, Ordering::SeqCst);

    assert_eq!(f.service.probe_open(0x1234, 0x5678, None).unwrap_err().to_string(), "open failed");
    assert_eq!(f.backend.open_calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.sleeps.load(Ordering::SeqCst), 0);
}

#[test]
fn rejects_data_longer_than_one_report() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw3"));
    let id = f.service.probe_open(0x1234, 0x5678, None).unwrap();
    assert!(matches!(
        f.service.probe_send_receive(id, &[0u8; MSG_LEN + 1]),
        Err(HidError::DataTooLong { max: MSG_LEN })
    ));
    assert!(f.backend.handle_for("/dev/hidraw3").writes.lock().unwrap().is_empty());
}

#[test]
fn opening_a_probe_closes_the_previous_one() {
    let f = fixture(VirtualDeviceMode::Off);
    *f.backend.devices.lock().unwrap() =
        vec![device_with_serial("/dev/hidraw1", Some("a")), device_with_serial("/dev/hidraw2", Some("b"))];
    let first_handle = f.backend.handle_for("/dev/hidraw1");
    let second_handle = f.backend.handle_for("/dev/hidraw2");
    second_handle.default_read.lock().unwrap().push(0x01);

    let first = f.service.probe_open(0x1234, 0x5678, Some("a")).unwrap();
    let second = f.service.probe_open(0x1234, 0x5678, Some("b")).unwrap();

    assert_ne!(first, second);
    assert_eq!(first_handle.close_calls.load(Ordering::SeqCst), 1);
    assert!(matches!(f.service.probe_send_receive(first, &[0x01]), Err(HidError::ProbeNotOpen)));
    assert!(f.service.probe_send_receive(second, &[0x01]).is_ok());
    assert_eq!(second_handle.close_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn a_failed_open_still_closes_the_previous_probe() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw1"));
    let handle = f.backend.handle_for("/dev/hidraw1");
    let id = f.service.probe_open(0x1234, 0x5678, None).unwrap();

    assert!(f.service.probe_open(0x1234, 0x5678, Some("missing")).is_err());
    assert_eq!(handle.close_calls.load(Ordering::SeqCst), 1);
    assert!(matches!(f.service.probe_send_receive(id, &[0x01]), Err(HidError::ProbeNotOpen)));
}

#[test]
fn close_closes_only_the_probe_with_that_id() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw1"));
    let handle = f.backend.handle_for("/dev/hidraw1");
    let stale = f.service.probe_open(0x1234, 0x5678, None).unwrap();
    let current = f.service.probe_open(0x1234, 0x5678, None).unwrap();
    assert_eq!(handle.close_calls.load(Ordering::SeqCst), 1);

    f.service.probe_close(stale);
    assert_eq!(handle.close_calls.load(Ordering::SeqCst), 1);

    f.service.probe_close(current);
    assert_eq!(handle.close_calls.load(Ordering::SeqCst), 2);
    assert!(matches!(f.service.probe_send_receive(current, &[0x01]), Err(HidError::ProbeNotOpen)));
    f.service.probe_close(current);
    assert_eq!(handle.close_calls.load(Ordering::SeqCst), 2);
}

#[test]
fn close_probe_closes_whatever_probe_is_open() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw1"));
    let handle = f.backend.handle_for("/dev/hidraw1");
    let id = f.service.probe_open(0x1234, 0x5678, None).unwrap();

    f.service.close_probe();
    assert_eq!(handle.close_calls.load(Ordering::SeqCst), 1);
    assert!(matches!(f.service.probe_send_receive(id, &[0x01]), Err(HidError::ProbeNotOpen)));
    f.service.close_probe();
    assert_eq!(handle.close_calls.load(Ordering::SeqCst), 1);
}

#[test]
fn an_unknown_id_is_not_open() {
    let f = fixture(VirtualDeviceMode::Off);
    let err = f.service.probe_send_receive(7, &[0x01]).unwrap_err();
    assert!(matches!(err, HidError::ProbeNotOpen));
    assert_eq!(err.to_string(), "No probe device is open");
}

#[test]
fn the_probe_leaves_the_main_connection_alone() {
    let f = fixture(VirtualDeviceMode::Off);
    open_real(&f);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw1"));
    *f.backend.handle.default_read.lock().unwrap() = vec![0xaa; MSG_LEN];
    let probe_handle = f.backend.handle_for("/dev/hidraw1");
    *probe_handle.default_read.lock().unwrap() = vec![0xbb; MSG_LEN];

    let id = f.service.probe_open(0x1234, 0x5678, None).unwrap();
    assert_eq!(f.service.probe_send_receive(id, &[0x01]).unwrap(), [0xbb; MSG_LEN]);
    assert_eq!(f.service.send_receive(&[0x01]).unwrap(), [0xaa; MSG_LEN]);
    f.service.probe_close(id);

    assert_eq!(f.backend.handle.close_calls.load(Ordering::SeqCst), 0);
    assert!(f.service.is_device_open().unwrap());
}

#[test]
fn the_virtual_keyboard_cannot_be_probed() {
    for mode in [VirtualDeviceMode::Append, VirtualDeviceMode::Only] {
        let f = fixture(mode);
        assert!(matches!(
            f.service.probe_open(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID, None),
            Err(HidError::ProbeTargetNotFound)
        ));
    }
}

#[test]
fn hardware_is_probed_even_when_the_device_list_shows_only_the_virtual_keyboard() {
    let f = fixture(VirtualDeviceMode::Only);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw1"));
    f.service.probe_open(0x1234, 0x5678, None).unwrap();
    assert_eq!(opened_paths(&f), ["/dev/hidraw1"]);
}

#[test]
fn opening_the_main_connection_closes_a_probe_on_the_same_interface() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw1"));
    let handle = f.backend.handle_for("/dev/hidraw1");
    let id = f.service.probe_open(0x1234, 0x5678, None).unwrap();

    assert!(f.service.open_device(0x1234, 0x5678).unwrap());

    assert_eq!(handle.close_calls.load(Ordering::SeqCst), 1);
    assert!(matches!(f.service.probe_send_receive(id, &[0x01]), Err(HidError::ProbeNotOpen)));
    handle.default_read.lock().unwrap().push(0x01);
    assert!(f.service.send_receive(&[0x01]).is_ok());
}

#[test]
fn opening_the_main_connection_keeps_a_probe_on_another_interface() {
    let f = fixture(VirtualDeviceMode::Off);
    *f.backend.devices.lock().unwrap() =
        vec![device_with_serial("/dev/hidraw0", Some("a")), device_with_serial("/dev/hidraw1", Some("b"))];
    let probe_handle = f.backend.handle_for("/dev/hidraw1");
    probe_handle.default_read.lock().unwrap().push(0x01);
    let id = f.service.probe_open(0x1234, 0x5678, Some("b")).unwrap();

    assert!(f.service.open_device(0x1234, 0x5678).unwrap());

    assert_eq!(probe_handle.close_calls.load(Ordering::SeqCst), 0);
    assert!(f.service.probe_send_receive(id, &[0x01]).is_ok());
}
