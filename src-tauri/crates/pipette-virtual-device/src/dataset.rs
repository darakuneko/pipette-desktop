// SPDX-License-Identifier: GPL-2.0-or-later
//! Identity, geometry and default contents of the virtual keyboard.
//!
//! The keymap layers, sample macros and sample dynamic entries mirror the
//! firmware source of the GPK60-63R (keymaps/vial/keymap.c, vial.json). Their
//! keycode values and the device identity (VID/PID, name, serial, UID) come
//! from `data/default_dataset.rs`, which is generated from the TypeScript
//! sources
//! (`scripts/virtual-device-fixtures/record-virtual-device-fixtures.test.ts`),
//! so this crate never resolves keycode names itself.

use crate::dynamic_entries::{AltRepeatKeyEntry, ComboEntry, KeyOverrideEntry, TapDanceEntry};

include!("../data/default_dataset.rs");

/// (row, col) pairs — hold both to unlock, matching the firmware's vial unlock combo.
pub const VIRTUAL_DEVICE_UNLOCK_COMBO: [(u8, u8); 2] = [(0, 0), (0, 1)];

pub const VIAL_PROTOCOL: u32 = 6;
pub const VIA_PROTOCOL: u16 = 9;
pub const LAYERS: usize = 4;
pub const ROWS: usize = 5;
pub const COLS: usize = 14;
pub const KEYMAP_LEN: usize = LAYERS * ROWS * COLS;
pub const MACRO_COUNT: u8 = 16;
pub const MACRO_BUFFER_SIZE: usize = 900;

/// Ascending VialRGB effect IDs reported as supported. Effect 0 (OFF) is
/// first; effect 1 (DIRECT) is left out, as vial-qmk keyboards commonly hide
/// it. The other IDs are a representative spread — only ascending order and
/// GET_SUPPORTED pagination depend on them.
pub const VIALRGB_SUPPORTED_EFFECTS: [u16; 26] =
    [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26];

/// The keyboard definition JSON, LZMA-alone compressed exactly as the
/// TypeScript device serves it.
pub const COMPRESSED_DEFINITION: &[u8] = include_bytes!("../data/definition.lzma");

/// True for the QK_BOOT keycode. vial-qmk's vial_keycode_firewall() refuses to
/// store it in any dynamic store (keymap, tap dance, combo, key override,
/// alt-repeat key) while the board is locked.
pub fn is_boot_keycode(keycode: u16) -> bool {
    keycode == keycodes::QK_BOOT
}

/// The flat keymap (layer-major, row-major, column order).
pub fn build_default_keymap() -> [u16; KEYMAP_LEN] {
    DEFAULT_KEYMAP
}

/// Macro 0 is the text macro "Hello", macro 1 taps KC_A; the remaining
/// slots are empty and the buffer is zero-padded to MACRO_BUFFER_SIZE.
pub fn build_default_macro_buffer() -> [u8; MACRO_BUFFER_SIZE] {
    let mut buffer = [0u8; MACRO_BUFFER_SIZE];
    buffer[..DEFAULT_MACRO_BUFFER_HEAD.len()].copy_from_slice(&DEFAULT_MACRO_BUFFER_HEAD);
    buffer
}
