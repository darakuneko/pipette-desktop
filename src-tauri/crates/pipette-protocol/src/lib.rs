// SPDX-License-Identifier: GPL-2.0-or-later
//! Vial wire and transport constants plus the 32-byte report type, shared by
//! the HID transport and the virtual keyboard.
//!
//! The constant values are generated from `src/shared/constants/protocol.ts`
//! (`data/constants.rs`, written by
//! `scripts/virtual-device-fixtures/record-virtual-device-fixtures.test.ts`),
//! so the Rust side never carries its own copy of them.

include!("../data/constants.rs");

pub type Report = [u8; MSG_LEN];

/// Copy `data` into a zeroed report, truncating anything past MSG_LEN.
pub fn pad_report(data: &[u8]) -> Report {
    let mut report = [0u8; MSG_LEN];
    let len = data.len().min(MSG_LEN);
    report[..len].copy_from_slice(&data[..len]);
    report
}
