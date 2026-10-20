// SPDX-License-Identifier: GPL-2.0-or-later
// Recorded values of src/shared/constants/protocol.ts. Included by
// src/lib.rs.

/// Every HID report (request and response) is exactly this many bytes.
pub const MSG_LEN: usize = 32;
/// Largest payload of one keymap/macro buffer chunk (MSG_LEN minus the 4-byte header).
pub const BUFFER_FETCH_CHUNK: usize = 28;
/// Vial raw-HID interface usage page.
pub const HID_USAGE_PAGE: u16 = 0xff60;
/// Vial raw-HID interface usage.
pub const HID_USAGE: u16 = 0x0061;
/// Vial devices use unnumbered reports; writes carry report ID 0 up front.
pub const HID_REPORT_ID: u8 = 0x00;
pub const BOOTLOADER_SERIAL_MAGIC: &str = "vibl:d4f8159c";
pub const HID_TIMEOUT_MS: i32 = 500;
/// Attempts per send/receive. Only an empty read (timeout) is retried.
pub const HID_RETRY_COUNT: u32 = 20;
pub const HID_RETRY_DELAY_MS: u64 = 500;
pub const HID_OPEN_RETRY_COUNT: u32 = 10;
pub const HID_OPEN_RETRY_DELAY_MS: u64 = 1000;
pub const CMD_VIA_GET_PROTOCOL_VERSION: u8 = 0x01;
pub const CMD_VIA_GET_KEYBOARD_VALUE: u8 = 0x02;
pub const CMD_VIA_SET_KEYBOARD_VALUE: u8 = 0x03;
pub const CMD_VIA_GET_KEYCODE: u8 = 0x04;
pub const CMD_VIA_SET_KEYCODE: u8 = 0x05;
pub const CMD_VIA_LIGHTING_SET_VALUE: u8 = 0x07;
pub const CMD_VIA_LIGHTING_GET_VALUE: u8 = 0x08;
pub const CMD_VIA_LIGHTING_SAVE: u8 = 0x09;
pub const CMD_VIA_MACRO_GET_COUNT: u8 = 0x0c;
pub const CMD_VIA_MACRO_GET_BUFFER_SIZE: u8 = 0x0d;
pub const CMD_VIA_MACRO_GET_BUFFER: u8 = 0x0e;
pub const CMD_VIA_MACRO_SET_BUFFER: u8 = 0x0f;
pub const CMD_VIA_GET_LAYER_COUNT: u8 = 0x11;
pub const CMD_VIA_KEYMAP_GET_BUFFER: u8 = 0x12;
pub const CMD_VIA_VIAL_PREFIX: u8 = 0xfe;
pub const VIA_LAYOUT_OPTIONS: u8 = 0x02;
pub const VIA_SWITCH_MATRIX_STATE: u8 = 0x03;
pub const VIALRGB_GET_INFO: u8 = 0x40;
pub const VIALRGB_GET_MODE: u8 = 0x41;
pub const VIALRGB_GET_SUPPORTED: u8 = 0x42;
pub const VIALRGB_SET_MODE: u8 = 0x41;
pub const CMD_VIAL_GET_KEYBOARD_ID: u8 = 0x00;
pub const CMD_VIAL_GET_SIZE: u8 = 0x01;
pub const CMD_VIAL_GET_DEFINITION: u8 = 0x02;
pub const CMD_VIAL_GET_ENCODER: u8 = 0x03;
pub const CMD_VIAL_SET_ENCODER: u8 = 0x04;
pub const CMD_VIAL_GET_UNLOCK_STATUS: u8 = 0x05;
pub const CMD_VIAL_UNLOCK_START: u8 = 0x06;
pub const CMD_VIAL_UNLOCK_POLL: u8 = 0x07;
pub const CMD_VIAL_LOCK: u8 = 0x08;
pub const CMD_VIAL_QMK_SETTINGS_QUERY: u8 = 0x09;
pub const CMD_VIAL_QMK_SETTINGS_GET: u8 = 0x0a;
pub const CMD_VIAL_QMK_SETTINGS_SET: u8 = 0x0b;
pub const CMD_VIAL_QMK_SETTINGS_RESET: u8 = 0x0c;
pub const CMD_VIAL_DYNAMIC_ENTRY_OP: u8 = 0x0d;
pub const DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES: u8 = 0x00;
pub const DYNAMIC_VIAL_TAP_DANCE_GET: u8 = 0x01;
pub const DYNAMIC_VIAL_TAP_DANCE_SET: u8 = 0x02;
pub const DYNAMIC_VIAL_COMBO_GET: u8 = 0x03;
pub const DYNAMIC_VIAL_COMBO_SET: u8 = 0x04;
pub const DYNAMIC_VIAL_KEY_OVERRIDE_GET: u8 = 0x05;
pub const DYNAMIC_VIAL_KEY_OVERRIDE_SET: u8 = 0x06;
pub const DYNAMIC_VIAL_ALT_REPEAT_KEY_GET: u8 = 0x07;
pub const DYNAMIC_VIAL_ALT_REPEAT_KEY_SET: u8 = 0x08;
