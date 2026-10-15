// SPDX-License-Identifier: GPL-2.0-or-later
// Replays the golden transcript recorded from the TypeScript virtual device
// (scripts/virtual-device-fixtures/record-virtual-device-fixtures.test.ts):
// every request is fed with its recorded clock, and every response must be
// byte-identical. Controller operations and recorded controller states are
// replayed and checked in the same order.

use pipette_virtual_device::{MSG_LEN, VirtualDevice};
use serde::Deserialize;

const TRANSCRIPT: &str = include_str!("fixtures/transcript.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
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

fn decode_hex(hex: &str) -> Vec<u8> {
    assert_eq!(hex.len() % 2, 0, "odd hex length");
    (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).expect("invalid hex")).collect()
}

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn replays_the_typescript_transcript_byte_for_byte() {
    let transcript: Transcript = serde_json::from_str(TRANSCRIPT).unwrap();
    let mut device = VirtualDevice::new();
    let mut reports = 0;

    for (i, event) in transcript.events.iter().enumerate() {
        match event {
            Event::Open => device.open(),
            Event::Close => device.close(),
            Event::Reset => device.reset(),
            Event::PressKey { row, col } => device.press_key(*row, *col),
            Event::ReleaseKey { row, col } => device.release_key(*row, *col),
            Event::ReleaseAll => device.release_all(),
            Event::HoldKeys { pairs } => device.hold_keys(pairs),
            Event::SetUnlockCounterMax { value } => device.set_unlock_counter_max(*value),
            Event::State { expected } => {
                let actual = device.controller_state();
                assert_eq!(
                    (actual.open, actual.unlocked, actual.unlock_in_progress, actual.unlock_counter),
                    (expected.open, expected.unlocked, expected.unlock_in_progress, expected.unlock_counter),
                    "controller state mismatch at event {i}"
                );
            }
            Event::Report { now, request, response } => {
                let request = decode_hex(request);
                assert_eq!(request.len(), MSG_LEN, "request length at event {i}");
                let actual = device.handle_report(&request, *now).unwrap();
                assert_eq!(
                    encode_hex(&actual),
                    *response,
                    "response mismatch at event {i} for request {}",
                    encode_hex(&request)
                );
                reports += 1;
            }
        }
    }

    assert!(reports > 100, "transcript unexpectedly short: {reports} reports");
}
