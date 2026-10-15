// SPDX-License-Identifier: GPL-2.0-or-later
//! DEBUG logs of every report sent and received, when `VIAL_DEBUG_HID` is
//! set to a non-empty value, in the format of `logHidPacket` in
//! src/main/logger.ts: `HID TX: fe 00 0a …` (the 32-byte report, without the
//! report ID).

use std::fmt::Write;

/// The environment variable that turns the packet logs on.
pub const DEBUG_HID_ENV: &str = "VIAL_DEBUG_HID";

/// Which way a packet went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    Tx,
    Rx,
}

/// Whether the environment turns the packet logs on.
pub fn packet_logging_from_env() -> bool {
    std::env::var_os(DEBUG_HID_ENV).is_some_and(|value| !value.is_empty())
}

/// `HID <TX|RX>: <bytes as two lowercase hex digits, space separated>`.
pub fn packet_log_message(direction: Direction, data: &[u8]) -> String {
    let name = match direction {
        Direction::Tx => "TX",
        Direction::Rx => "RX",
    };
    let mut message = format!("HID {name}:");
    for byte in data {
        let _ = write!(message, " {byte:02x}");
    }
    message
}

pub(crate) fn log_packet(enabled: bool, direction: Direction, data: &[u8]) {
    if enabled {
        log::debug!("{}", packet_log_message(direction, data));
    }
}
