// SPDX-License-Identifier: GPL-2.0-or-later
// Packet framing, retries, ordering and connection handling of HidService
// against the in-memory backend, plus the virtual device end to end.

mod common;

use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use common::{fixture, open_real, raw_device};
use pipette_hid::{
    BOOTLOADER_SERIAL_MAGIC, DeviceType, HID_OPEN_RETRY_COUNT, HID_RETRY_COUNT, HID_USAGE, HidError, MSG_LEN,
    VirtualDeviceMode, classify_device,
};
use pipette_virtual_device::dataset::{VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_VID};

#[test]
fn classifies_bootloader_by_serial_and_everything_else_as_vial() {
    assert_eq!(classify_device(&format!("{BOOTLOADER_SERIAL_MAGIC}:x")), DeviceType::Bootloader);
    assert_eq!(classify_device("vial:f64c2b3c"), DeviceType::Vial);
    assert_eq!(classify_device(""), DeviceType::Vial);
}

#[test]
fn list_devices_keeps_only_the_vial_usage_page_and_usage() {
    let f = fixture(VirtualDeviceMode::Off);
    let mut other_usage = raw_device("/dev/hidraw1");
    other_usage.usage = HID_USAGE + 1;
    let mut bootloader = raw_device("/dev/hidraw2");
    bootloader.info.serial_number = Some(BOOTLOADER_SERIAL_MAGIC.into());
    let mut no_strings = raw_device("/dev/hidraw3");
    no_strings.info.serial_number = None;
    no_strings.info.product = None;
    *f.backend.devices.lock().unwrap() =
        vec![raw_device("/dev/hidraw0"), other_usage, bootloader, no_strings];

    let result = f.service.list_devices().unwrap();
    assert_eq!(result.len(), 3);
    assert_eq!(result[0].device_type, DeviceType::Vial);
    assert_eq!(result[1].device_type, DeviceType::Bootloader);
    assert_eq!(result[2].product_name, "");
    assert_eq!(result[2].serial_number, "");
}

#[test]
fn open_returns_false_when_no_matching_interface_is_present() {
    let f = fixture(VirtualDeviceMode::Off);
    let mut wrong_usage = raw_device("/dev/hidraw0");
    wrong_usage.usage = 0x06;
    f.backend.devices.lock().unwrap().push(wrong_usage);
    assert!(!f.service.open_device(0x1234, 0x5678).unwrap());
}

#[test]
fn open_retries_transient_failures() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.open_failures.store(3, Ordering::SeqCst);
    open_real(&f);
    assert_eq!(f.backend.open_calls.load(Ordering::SeqCst), 4);
    assert_eq!(f.sleeps.load(Ordering::SeqCst), 3);
}

#[test]
fn open_gives_up_after_the_retry_limit_with_the_last_error() {
    let f = fixture(VirtualDeviceMode::Off);
    f.backend.open_failures.store(100, Ordering::SeqCst);
    f.backend.devices.lock().unwrap().push(raw_device("/dev/hidraw0"));
    assert!(matches!(f.service.open_device(0x1234, 0x5678), Err(HidError::Backend(_))));
    assert_eq!(f.backend.open_calls.load(Ordering::SeqCst), HID_OPEN_RETRY_COUNT as usize);
}

#[test]
fn send_receive_without_an_open_device_fails() {
    let f = fixture(VirtualDeviceMode::Off);
    assert!(matches!(f.service.send_receive(&[0x01]), Err(HidError::NotOpen)));
    assert!(matches!(f.service.send(&[0x01]), Err(HidError::NotOpen)));
}

#[test]
fn rejects_data_longer_than_one_report() {
    let f = fixture(VirtualDeviceMode::Off);
    open_real(&f);
    let too_long = [0u8; MSG_LEN + 1];
    assert!(matches!(f.service.send_receive(&too_long), Err(HidError::DataTooLong { max: MSG_LEN })));
    assert!(matches!(f.service.send(&too_long), Err(HidError::DataTooLong { .. })));
    assert!(f.backend.handle.writes.lock().unwrap().is_empty());
}

#[test]
fn writes_report_id_0_and_the_zero_padded_32_byte_report() {
    let f = fixture(VirtualDeviceMode::Off);
    open_real(&f);
    *f.backend.handle.default_read.lock().unwrap() = vec![0xaa; MSG_LEN];
    f.service.send_receive(&[0x12, 0x00, 0x1c]).unwrap();

    let writes = f.backend.handle.writes.lock().unwrap();
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].len(), MSG_LEN + 1);
    assert_eq!(writes[0][..4], [0x00, 0x12, 0x00, 0x1c]);
    assert!(writes[0][4..].iter().all(|&b| b == 0));
}

#[test]
fn strips_the_report_id_only_from_a_33_byte_read_starting_with_0() {
    let f = fixture(VirtualDeviceMode::Off);
    open_real(&f);
    let mut with_id = vec![0x00];
    with_id.extend(1..=32u8);
    let mut nonzero_first = vec![0x07];
    nonzero_first.extend(1..=32u8);
    f.backend.handle.reads.lock().unwrap().extend([
        Ok(with_id),
        Ok(nonzero_first),
        Ok(vec![9, 8, 7]),
        Ok((0..64u8).collect()),
    ]);

    let expected: Vec<u8> = (1..=32u8).collect();
    assert_eq!(f.service.send_receive(&[0x01]).unwrap().to_vec(), expected);

    let truncated = f.service.send_receive(&[0x01]).unwrap();
    assert_eq!(truncated[0], 0x07);
    assert_eq!(truncated[1..].to_vec(), (1..=31u8).collect::<Vec<_>>());

    let padded = f.service.send_receive(&[0x01]).unwrap();
    assert_eq!(padded[..3], [9, 8, 7]);
    assert!(padded[3..].iter().all(|&b| b == 0));

    let long = f.service.send_receive(&[0x01]).unwrap();
    assert_eq!(long.to_vec(), (0..32u8).collect::<Vec<_>>());
}

#[test]
fn retries_an_empty_read_with_a_rewrite_and_a_delay() {
    let f = fixture(VirtualDeviceMode::Off);
    open_real(&f);
    f.backend.handle.reads.lock().unwrap().extend([Ok(vec![]), Ok(vec![]), Ok(vec![0x42; MSG_LEN])]);
    let resp = f.service.send_receive(&[0x01]).unwrap();
    assert_eq!(resp[0], 0x42);
    assert_eq!(f.backend.handle.writes.lock().unwrap().len(), 3);
    assert_eq!(f.sleeps.load(Ordering::SeqCst), 2);
}

#[test]
fn gives_up_after_hid_retry_count_empty_reads() {
    let f = fixture(VirtualDeviceMode::Off);
    open_real(&f);
    let resp = f.service.send_receive(&[0x01]);
    assert!(matches!(resp, Err(HidError::ReadTimeout)));
    assert_eq!(f.backend.handle.read_calls.load(Ordering::SeqCst), HID_RETRY_COUNT as usize);
    assert_eq!(f.sleeps.load(Ordering::SeqCst), HID_RETRY_COUNT as usize - 1);
}

#[test]
fn read_and_write_errors_fail_without_retrying() {
    let f = fixture(VirtualDeviceMode::Off);
    open_real(&f);
    f.backend.handle.reads.lock().unwrap().push_back(Err("hid_read_timeout: device disconnected".into()));
    assert!(matches!(f.service.send_receive(&[0x01]), Err(HidError::Backend(_))));
    assert_eq!(f.backend.handle.read_calls.load(Ordering::SeqCst), 1);

    *f.backend.handle.write_error.lock().unwrap() = Some("write failed".into());
    assert!(matches!(f.service.send_receive(&[0x01]), Err(HidError::Backend(_))));
    assert_eq!(f.backend.handle.read_calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.sleeps.load(Ordering::SeqCst), 0);
}

#[test]
fn send_writes_without_reading() {
    let f = fixture(VirtualDeviceMode::Off);
    open_real(&f);
    f.service.send(&[0x05, 1, 2, 3]).unwrap();
    assert_eq!(f.backend.handle.writes.lock().unwrap()[0][..5], [0x00, 0x05, 1, 2, 3]);
    assert_eq!(f.backend.handle.read_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn keeps_the_pinned_handle_when_the_device_is_closed_mid_exchange() {
    let f = Arc::new(fixture(VirtualDeviceMode::Off));
    open_real(&f);
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = Mutex::new(release_rx);
    *f.backend.handle.on_read.lock().unwrap() = Some(Box::new(move || {
        let _ = entered_tx.send(());
        let _ = release_rx.lock().unwrap().recv();
    }));
    *f.backend.handle.default_read.lock().unwrap() = vec![0x33; MSG_LEN];

    let worker = {
        let f = f.clone();
        thread::spawn(move || f.service.send_receive(&[0x01]))
    };
    entered_rx.recv().unwrap();
    f.service.close_device();
    release_tx.send(()).unwrap();

    assert_eq!(worker.join().unwrap().unwrap()[0], 0x33);
    assert!(matches!(f.service.send_receive(&[0x01]), Err(HidError::NotOpen)));
}

#[test]
fn serves_concurrent_requests_one_at_a_time_in_arrival_order() {
    let f = Arc::new(fixture(VirtualDeviceMode::Off));
    open_real(&f);
    let (entered_tx, entered_rx) = mpsc::channel::<()>();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let release_rx = Mutex::new(release_rx);
    // Only the first read blocks; later reads pass straight through.
    let first = Mutex::new(true);
    *f.backend.handle.on_read.lock().unwrap() = Some(Box::new(move || {
        let mut first = first.lock().unwrap();
        if *first {
            *first = false;
            let _ = entered_tx.send(());
            let _ = release_rx.lock().unwrap().recv();
        }
    }));
    *f.backend.handle.default_read.lock().unwrap() = vec![0x01; MSG_LEN];

    let spawn = |cmd: u8| {
        let f = f.clone();
        thread::spawn(move || f.service.send_receive(&[cmd]).map(|_| ()))
    };
    let a = spawn(0xa1);
    entered_rx.recv().unwrap();
    // Queue B and C behind A, B first.
    let b = spawn(0xb2);
    thread::sleep(Duration::from_millis(50));
    let c = spawn(0xc3);
    thread::sleep(Duration::from_millis(50));
    // While A is in flight nothing else may have been written.
    assert_eq!(f.backend.handle.writes.lock().unwrap().len(), 1);
    release_tx.send(()).unwrap();

    for worker in [a, b, c] {
        worker.join().unwrap().unwrap();
    }
    let order: Vec<u8> = f.backend.handle.writes.lock().unwrap().iter().map(|w| w[1]).collect();
    assert_eq!(order, [0xa1, 0xb2, 0xc3]);
}

#[test]
fn is_device_open_closes_a_device_that_is_no_longer_enumerated() {
    let f = fixture(VirtualDeviceMode::Off);
    assert!(!f.service.is_device_open().unwrap());
    open_real(&f);
    assert!(f.service.is_device_open().unwrap());

    f.backend.devices.lock().unwrap().clear();
    assert!(!f.service.is_device_open().unwrap());
    assert!(matches!(f.service.send_receive(&[0x01]), Err(HidError::NotOpen)));
}

#[test]
fn virtual_device_unlocks_through_the_service_with_the_injected_clock() {
    let f = fixture(VirtualDeviceMode::Only);
    assert!(f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap());
    let controller = f.service.virtual_device();
    controller.set_unlock_counter_max(2);
    controller.hold_keys(&[(0, 0), (0, 1)]);
    // The fixture clock is fixed at 0, so polls never pass the 100 ms gate.
    f.service.send_receive(&[0xfe, 0x06]).unwrap();
    let poll = f.service.send_receive(&[0xfe, 0x07]).unwrap();
    assert_eq!(poll[0], 0);
    assert_eq!(poll[2], 2);
}

#[test]
fn virtual_device_state_survives_close_and_reopen() {
    let f = fixture(VirtualDeviceMode::Append);
    f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    f.service.send_receive(&[0x05, 1, 2, 3, 0x00, 0x29]).unwrap();
    f.service.close_device();
    assert!(!f.service.is_device_open().unwrap());

    f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap();
    let resp = f.service.send_receive(&[0x04, 1, 2, 3]).unwrap();
    assert_eq!(resp[4..6], [0x00, 0x29]);

    f.service.virtual_device().reset();
    let resp = f.service.send_receive(&[0x04, 1, 2, 3]).unwrap();
    assert_ne!(resp[4..6], [0x00, 0x29]);
}

/// Needs a host with hidraw/udev; run with `cargo test -- --ignored`.
#[test]
#[ignore]
fn real_backend_enumerates_without_error() {
    let service = pipette_hid::HidService::new(VirtualDeviceMode::Off);
    let devices = service.list_devices().unwrap();
    println!("{} Vial interface(s): {devices:?}", devices.len());
}
