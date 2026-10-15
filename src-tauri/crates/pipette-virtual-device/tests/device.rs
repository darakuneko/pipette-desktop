// SPDX-License-Identifier: GPL-2.0-or-later

use pipette_virtual_device::dataset::{
    VIRTUAL_DEVICE_NAME, VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_SERIAL, VIRTUAL_DEVICE_VID,
};
use pipette_virtual_device::device::matches_virtual_device;
use pipette_virtual_device::{
    MSG_LEN, NotOpenError, VirtualDevice, VirtualDeviceController, VirtualDeviceMode,
};
use std::sync::{Arc, Mutex};

/// An open device and a controller on it.
fn open_device() -> (Arc<Mutex<VirtualDevice>>, VirtualDeviceController) {
    let mut device = VirtualDevice::new();
    device.open();
    let device = Arc::new(Mutex::new(device));
    let controller = VirtualDeviceController::new(device.clone());
    (device, controller)
}

#[test]
fn mode_follows_the_env_value() {
    assert_eq!(VirtualDeviceMode::from_env_value(Some("1")), VirtualDeviceMode::Append);
    assert_eq!(VirtualDeviceMode::from_env_value(Some("0")), VirtualDeviceMode::Off);
    assert_eq!(VirtualDeviceMode::from_env_value(None), VirtualDeviceMode::Off);
    assert_eq!(VirtualDeviceMode::from_env_value(Some("only")), VirtualDeviceMode::Only);
}

#[test]
fn reports_the_virtual_device_identity() {
    assert_eq!(VIRTUAL_DEVICE_VID, 0x7a79);
    assert_eq!(VIRTUAL_DEVICE_PID, 0xf063);
    assert_eq!(VIRTUAL_DEVICE_NAME, "Virtual Keyboard");
    assert!(VIRTUAL_DEVICE_SERIAL.starts_with("vial:f64c2b3c"));
}

#[test]
fn matches_only_the_virtual_vid_pid_pair() {
    assert!(matches_virtual_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID));
    assert!(!matches_virtual_device(0x1234, 0x5678));
}

#[test]
fn is_closed_until_opened() {
    let mut device = VirtualDevice::new();
    assert!(!device.is_open());
    device.open();
    assert!(device.is_open());
    device.close();
    assert!(!device.is_open());
}

#[test]
fn handle_report_fails_when_not_open() {
    let mut device = VirtualDevice::new();
    let err = device.handle_report(&[0x01], 0).unwrap_err();
    assert_eq!(err, NotOpenError);
    assert!(err.to_string().contains("not open"));
}

#[test]
fn handle_report_answers_a_protocol_version_request_once_open() {
    let mut device = VirtualDevice::new();
    device.open();
    let resp = device.handle_report(&[0x01], 0).unwrap();
    assert_eq!(resp.len(), MSG_LEN);
    assert_eq!(u16::from_be_bytes([resp[1], resp[2]]), 9);
}

#[test]
fn controller_press_and_hold_keys_leave_the_device_locked_until_polled() {
    let (device, controller) = open_device();
    controller.reset();
    controller.set_unlock_counter_max(2);
    controller.hold_keys(&[(0, 0), (0, 1)]);

    let status = controller.get_state();
    assert!(status.open);
    assert!(!status.unlocked);
    assert!(device.lock().unwrap().state().is_holding_unlock_combo());

    controller.release_all();
    assert!(!device.lock().unwrap().state().is_holding_unlock_combo());
}

#[test]
fn set_unlock_counter_max_clamps_a_countdown_already_in_progress() {
    let (device, controller) = open_device();
    controller.reset();

    // Unlock start (0xFE 0x06) arms the countdown at the default max of 50.
    device.lock().unwrap().handle_report(&[0xfe, 0x06], 0).unwrap();
    assert_eq!(controller.get_state().unlock_counter, 50);

    controller.set_unlock_counter_max(3);
    assert_eq!(controller.get_state().unlock_counter, 3);
}

#[test]
fn reset_restores_factory_defaults() {
    let (device, controller) = open_device();
    controller.press_key(0, 0);
    device.lock().unwrap().state_mut().unlocked = true;
    controller.reset();
    let status = controller.get_state();
    assert!(!status.unlocked);
    assert!(!status.unlock_in_progress);
    assert!(status.open);
    assert!(!device.lock().unwrap().state().matrix[0][0]);
}
