// SPDX-License-Identifier: GPL-2.0-or-later
// Routing between real hardware and the virtual device inside HidService.

mod common;

use std::sync::atomic::Ordering;

use common::{fixture, raw_device};
use pipette_hid::{DeviceType, HidError, MSG_LEN, VirtualDeviceMode};
use pipette_virtual_device::dataset::{VIRTUAL_DEVICE_NAME, VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_VID};

// --- virtual device disabled ---

#[test]
fn list_devices_does_not_include_the_virtual_device() {
    let f = fixture(VirtualDeviceMode::Off);
    let result = f.service.list_devices().unwrap();
    assert!(result.iter().all(|d| d.product_name != VIRTUAL_DEVICE_NAME));
}

#[test]
fn opening_the_virtual_vid_pid_falls_through_to_real_device_lookup_and_fails() {
    let f = fixture(VirtualDeviceMode::Off);
    assert!(!f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap());
}

// --- virtual device enabled ---

#[test]
fn list_devices_appends_the_virtual_device_even_with_zero_real_devices() {
    let f = fixture(VirtualDeviceMode::Append);
    let result = f.service.list_devices().unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].product_name, VIRTUAL_DEVICE_NAME);
    assert_eq!(result[0].vendor_id, VIRTUAL_DEVICE_VID);
    assert_eq!(result[0].product_id, VIRTUAL_DEVICE_PID);
    assert_eq!(result[0].device_type, DeviceType::Vial);
}

#[test]
fn list_devices_appends_the_virtual_device_after_real_devices() {
    let f = fixture(VirtualDeviceMode::Append);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw0"));
    let result = f.service.list_devices().unwrap();
    assert_eq!(result.len(), 2);
    assert_eq!(result[0].product_name, "Real Test Keyboard");
    assert_eq!(result[1].product_name, VIRTUAL_DEVICE_NAME);
}

#[test]
fn opens_the_virtual_device_without_any_hid_calls() {
    let f = fixture(VirtualDeviceMode::Append);
    assert!(f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap());
    assert_eq!(f.backend.open_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn send_receive_answers_a_protocol_version_request_with_no_hid_calls() {
    let f = fixture(VirtualDeviceMode::Append);
    f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    let resp = f.service.send_receive(&[0x01]).unwrap();
    assert_eq!(resp.len(), MSG_LEN);
    assert_eq!(u16::from_be_bytes([resp[1], resp[2]]), 9);
    assert!(f.backend.handle.writes.lock().unwrap().is_empty());
    assert_eq!(f.backend.handle.read_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn is_device_open_is_true_while_the_virtual_device_is_open() {
    let f = fixture(VirtualDeviceMode::Append);
    f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    assert!(f.service.is_device_open().unwrap());
}

#[test]
fn opening_a_real_device_closes_the_virtual_device() {
    let f = fixture(VirtualDeviceMode::Append);
    f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    assert!(f.service.is_device_open().unwrap());

    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw0"));
    assert!(f.service.open_device(0x1234, 0x5678).unwrap());

    // send_receive now goes through the real (mock) device, not the virtual one.
    *f.backend.handle.default_read.lock().unwrap() = vec![0u8; MSG_LEN];
    f.service.send_receive(&[0x01]).unwrap();
    assert_eq!(f.backend.handle.writes.lock().unwrap().len(), 1);
}

#[test]
fn exclusive_mode_lists_exactly_the_virtual_device_even_with_real_devices_present() {
    let f = fixture(VirtualDeviceMode::Only);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw0"));
    let result = f.service.list_devices().unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].product_name, VIRTUAL_DEVICE_NAME);
    assert_eq!(f.backend.enumerate_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn exclusive_mode_still_opens_the_virtual_device() {
    let f = fixture(VirtualDeviceMode::Only);
    assert!(f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap());
    assert_eq!(f.backend.open_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn close_device_closes_the_virtual_device() {
    let f = fixture(VirtualDeviceMode::Append);
    f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    assert!(f.service.virtual_device().get_state().open);

    f.service.close_device();

    assert!(!f.service.virtual_device().get_state().open);
    assert!(!f.service.is_device_open().unwrap());
    assert!(matches!(f.service.send_receive(&[0x01]), Err(HidError::NotOpen)));
}
