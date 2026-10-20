// SPDX-License-Identifier: GPL-2.0-or-later
// The virtual keyboard reached through HidService (open / send_receive /
// close on the backend seam) answers exactly like the device itself: the
// recorded golden transcript replays byte for byte, with no retry delay along the way.

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

use common::{MockBackend, SharedBackend, fixture};
use pipette_hid::{HidService, MSG_LEN, Timing, VirtualDeviceMode};
use pipette_virtual_device::dataset::{VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_VID};
use serde::Deserialize;

const TRANSCRIPT: &str = include_str!("../../pipette-virtual-device/tests/fixtures/transcript.json");

#[derive(Deserialize)]
struct Transcript {
    events: Vec<Event>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedState {
    open: bool,
    unlocked: bool,
    unlock_in_progress: bool,
    unlock_counter: i32,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Event {
    Open,
    Close,
    Reset,
    PressKey { row: i32, col: i32 },
    ReleaseKey { row: i32, col: i32 },
    ReleaseAll,
    HoldKeys { pairs: Vec<(i32, i32)> },
    SetUnlockCounterMax { value: i32 },
    State { expected: ExpectedState },
    Report { now: u64, request: String, response: String },
}

#[test]
fn replays_the_recorded_transcript_through_the_service_byte_for_byte() {
    let transcript: Transcript = serde_json::from_str(TRANSCRIPT).unwrap();
    let clock = Arc::new(AtomicU64::new(0));
    let sleeps = Arc::new(AtomicUsize::new(0));
    let backend = Arc::new(MockBackend::default());
    let timing = {
        let clock = clock.clone();
        let sleeps = sleeps.clone();
        Timing::new(
            move || clock.load(Ordering::SeqCst),
            move |_| {
                sleeps.fetch_add(1, Ordering::SeqCst);
            },
        )
    };
    let service =
        HidService::with_backend(Box::new(SharedBackend(backend.clone())), VirtualDeviceMode::Only, timing);
    let controller = service.virtual_device();
    let mut reports = 0;

    for (i, event) in transcript.events.iter().enumerate() {
        match event {
            Event::Open => assert!(service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap()),
            Event::Close => service.close_device(),
            Event::Reset => controller.reset(),
            Event::PressKey { row, col } => controller.press_key(*row, *col),
            Event::ReleaseKey { row, col } => controller.release_key(*row, *col),
            Event::ReleaseAll => controller.release_all(),
            Event::HoldKeys { pairs } => controller.hold_keys(pairs),
            Event::SetUnlockCounterMax { value } => controller.set_unlock_counter_max(*value),
            Event::State { expected } => {
                let actual = controller.get_state();
                assert_eq!(
                    (actual.open, actual.unlocked, actual.unlock_in_progress, actual.unlock_counter),
                    (expected.open, expected.unlocked, expected.unlock_in_progress, expected.unlock_counter),
                    "controller state mismatch at event {i}"
                );
            }
            Event::Report { now, request, response } => {
                let request = hex::decode(request).unwrap();
                assert_eq!(request.len(), MSG_LEN, "request length at event {i}");
                clock.store(*now, Ordering::SeqCst);
                let actual = service.send_receive(&request).unwrap();
                assert_eq!(hex::encode(actual), *response, "response mismatch at event {i}");
                reports += 1;
            }
        }
    }

    assert!(reports > 100, "transcript unexpectedly short: {reports} reports");
    assert_eq!(sleeps.load(Ordering::SeqCst), 0, "a virtual exchange went through the retry delay");
    assert_eq!(backend.enumerate_calls.load(Ordering::SeqCst), 0);
    assert_eq!(backend.open_calls.load(Ordering::SeqCst), 0);
}

#[test]
fn send_reaches_the_virtual_device_without_a_read() {
    let f = fixture(VirtualDeviceMode::Append);
    assert!(f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap());
    f.service.send(&[0x05, 1, 2, 3, 0x00, 0x29]).unwrap();
    let resp = f.service.send_receive(&[0x04, 1, 2, 3]).unwrap();
    assert_eq!(resp[4..6], [0x00, 0x29]);
    assert_eq!(f.sleeps.load(Ordering::SeqCst), 0);
}

#[test]
fn the_open_virtual_device_never_enumerates_hardware() {
    let f = fixture(VirtualDeviceMode::Append);
    assert!(f.service.open_device(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID).unwrap());
    assert!(f.service.is_device_open().unwrap());
    assert_eq!(f.backend.enumerate_calls.load(Ordering::SeqCst), 0);
}
