// SPDX-License-Identifier: GPL-2.0-or-later
//! DEBUG logs of every report sent and received, when `VIAL_DEBUG_HID` is
//! set to a non-empty value, in the format of `logHidPacket` in
//! src/main/logger.ts: `HID TX: fe 00 0a …` (the 32-byte report, without the
//! report ID).

use std::fmt::Write;

/// The environment variable that turns the packet logs on.
const DEBUG_HID_ENV: &str = "VIAL_DEBUG_HID";

/// Which way a packet went.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Direction {
    Tx,
    Rx,
}

/// Whether the environment turns the packet logs on.
pub(crate) fn packet_logging_from_env() -> bool {
    std::env::var_os(DEBUG_HID_ENV).is_some_and(|value| !value.is_empty())
}

/// `HID <TX|RX>: <bytes as two lowercase hex digits, space separated>`.
pub(crate) fn packet_log_message(direction: Direction, data: &[u8]) -> String {
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

#[cfg(test)]
mod tests {
    use std::path::Path;

    use log::Level;
    use serde::Deserialize;

    use super::*;

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

    /// The lines src/main/logger.ts wrote for the same packets (the fixture
    /// of pipette-logger).
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
}
