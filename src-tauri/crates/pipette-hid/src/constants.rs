// SPDX-License-Identifier: GPL-2.0-or-later
//! Transport constants. Values match `src/shared/constants/protocol.ts`.

/// Vial raw-HID interface: usage page and usage.
pub const HID_USAGE_PAGE: u16 = 0xff60;
pub const HID_USAGE: u16 = 0x61;
/// Vial devices use unnumbered reports; writes carry report ID 0 up front.
pub const HID_REPORT_ID: u8 = 0x00;

pub const HID_TIMEOUT_MS: i32 = 500;
/// Attempts per send/receive. Only an empty read (timeout) is retried.
pub const HID_RETRY_COUNT: u32 = 20;
pub const HID_RETRY_DELAY_MS: u64 = 500;
pub const HID_OPEN_RETRY_COUNT: u32 = 10;
pub const HID_OPEN_RETRY_DELAY_MS: u64 = 1000;

pub const VIAL_SERIAL_MAGIC: &str = "vial:f64c2b3c";
pub const BOOTLOADER_SERIAL_MAGIC: &str = "vibl:d4f8159c";
