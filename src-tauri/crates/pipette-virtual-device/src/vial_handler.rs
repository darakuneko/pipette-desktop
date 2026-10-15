// SPDX-License-Identifier: GPL-2.0-or-later
//! Vial commands (byte 0 == 0xFE, byte 1 selects the sub-command).
//! Supported commands build their response from a zeroed buffer; unsupported
//! ones echo the request so the app's echo detection reports the feature as
//! absent.

use crate::byte_utils::{read_le16, read_le32, write_le32};
use crate::dataset::{VIAL_PROTOCOL, VIRTUAL_DEVICE_UID_BYTES, VIRTUAL_DEVICE_UNLOCK_COMBO, is_boot_keycode};
use crate::dynamic_entries::{
    ALT_REPEAT_KEY_ENTRY_COUNT, AltRepeatKeyEntry, COMBO_ENTRY_COUNT, ComboEntry,
    DYNAMIC_ENTRY_FEATURE_FLAGS, KEY_OVERRIDE_ENTRY_COUNT, KeyOverrideEntry, TAP_DANCE_ENTRY_COUNT,
    TapDanceEntry, lookup_entry, store_entry,
};
use crate::protocol::{
    CMD_VIAL_DYNAMIC_ENTRY_OP, CMD_VIAL_GET_DEFINITION, CMD_VIAL_GET_KEYBOARD_ID, CMD_VIAL_GET_SIZE,
    CMD_VIAL_GET_UNLOCK_STATUS, CMD_VIAL_LOCK, CMD_VIAL_QMK_SETTINGS_GET, CMD_VIAL_QMK_SETTINGS_QUERY,
    CMD_VIAL_QMK_SETTINGS_RESET, CMD_VIAL_QMK_SETTINGS_SET, CMD_VIAL_UNLOCK_POLL, CMD_VIAL_UNLOCK_START,
    DYNAMIC_VIAL_ALT_REPEAT_KEY_GET, DYNAMIC_VIAL_ALT_REPEAT_KEY_SET, DYNAMIC_VIAL_COMBO_GET,
    DYNAMIC_VIAL_COMBO_SET, DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES, DYNAMIC_VIAL_KEY_OVERRIDE_GET,
    DYNAMIC_VIAL_KEY_OVERRIDE_SET, DYNAMIC_VIAL_TAP_DANCE_GET, DYNAMIC_VIAL_TAP_DANCE_SET, MSG_LEN, Report,
};
use crate::qmk_settings::{qmk_settings_get, qmk_settings_query, qmk_settings_set};
use crate::state::VirtualDeviceState;

/// VialRGB support flag in the keyboard-id response (byte 12).
const VIALRGB_FLAG: u8 = 1;
const UNLOCK_COMBO_SLOTS: usize = 15;

fn handle_keyboard_id() -> Report {
    let mut resp = [0u8; MSG_LEN];
    write_le32(&mut resp, 0, VIAL_PROTOCOL);
    resp[4..12].copy_from_slice(&VIRTUAL_DEVICE_UID_BYTES);
    resp[12] = VIALRGB_FLAG;
    resp
}

fn handle_definition_size(compressed_len: usize) -> Report {
    let mut resp = [0u8; MSG_LEN];
    write_le32(&mut resp, 0, u32::try_from(compressed_len).unwrap_or(u32::MAX));
    resp
}

/// Block `n` is bytes `[n * 32, n * 32 + 32)`; anything past the end is zero.
fn handle_definition_block(req: &Report, compressed: &[u8]) -> Report {
    let mut resp = [0u8; MSG_LEN];
    let start = u64::from(read_le32(req, 2)) * MSG_LEN as u64;
    if let Some(block) = usize::try_from(start).ok().and_then(|s| compressed.get(s..)) {
        let len = block.len().min(MSG_LEN);
        resp[..len].copy_from_slice(&block[..len]);
    }
    resp
}

fn handle_unlock_status(state: &VirtualDeviceState) -> Report {
    // Unused combo slots keep the 0xff sentinel, as on the firmware.
    let mut resp = [0xffu8; MSG_LEN];
    resp[0] = u8::from(state.unlocked);
    resp[1] = u8::from(state.unlock_in_progress);
    for (i, &(row, col)) in VIRTUAL_DEVICE_UNLOCK_COMBO.iter().take(UNLOCK_COMBO_SLOTS).enumerate() {
        resp[2 + i * 2] = row;
        resp[3 + i * 2] = col;
    }
    resp
}

fn handle_unlock_poll(state: &mut VirtualDeviceState, now: u64) -> Report {
    state.unlock_poll_tick(now);
    let mut resp = [0xffu8; MSG_LEN];
    resp[0] = u8::from(state.unlocked);
    resp[1] = u8::from(state.unlock_in_progress);
    // The counter is written as a byte: negative clamps to 0, larger values
    // keep their low 8 bits.
    resp[2] = (state.unlock_counter.max(0) & 0xff) as u8;
    resp
}

/// vial_keycode_firewall(): QK_BOOT becomes KC_NO while locked.
fn gate_boot_keycode(state: &VirtualDeviceState, keycode: u16) -> u16 {
    if !state.unlocked && is_boot_keycode(keycode) { 0 } else { keycode }
}

fn handle_get_number_of_entries() -> Report {
    let mut resp = [0u8; MSG_LEN];
    resp[0] = TAP_DANCE_ENTRY_COUNT as u8;
    resp[1] = COMBO_ENTRY_COUNT as u8;
    resp[2] = KEY_OVERRIDE_ENTRY_COUNT as u8;
    resp[3] = ALT_REPEAT_KEY_ENTRY_COUNT as u8;
    resp[MSG_LEN - 1] = DYNAMIC_ENTRY_FEATURE_FLAGS;
    resp
}

/// Every dynamic-entry GET: echo the request, look the entry up by req[3],
/// status at offset 0, wire entry from offset 1.
fn handle_entry_get<T: Copy + Default>(
    req: &Report,
    entries: &[T],
    write: impl Fn(&T, &mut [u8], usize),
) -> Report {
    let mut resp = *req;
    let (status, entry) = lookup_entry(entries, usize::from(req[3]));
    resp[0] = status;
    write(&entry, &mut resp, 1);
    resp
}

/// Every dynamic-entry SET: echo the request with the status at offset 0.
/// Each kind gates a different subset of its fields against QK_BOOT, so the
/// caller passes the entry already firewalled.
fn entry_set_response<T>(req: &Report, entries: &mut [T], entry: T) -> Report {
    let mut resp = *req;
    resp[0] = store_entry(entries, usize::from(req[3]), entry);
    resp
}

fn handle_dynamic_entry_op(state: &mut VirtualDeviceState, req: &Report) -> Report {
    match req[2] {
        DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES => handle_get_number_of_entries(),
        DYNAMIC_VIAL_TAP_DANCE_GET => handle_entry_get(req, &state.tap_dance_entries, TapDanceEntry::write),
        DYNAMIC_VIAL_TAP_DANCE_SET => {
            let raw = TapDanceEntry::read(req, 4);
            let entry = TapDanceEntry {
                on_tap: gate_boot_keycode(state, raw.on_tap),
                on_hold: gate_boot_keycode(state, raw.on_hold),
                on_double_tap: gate_boot_keycode(state, raw.on_double_tap),
                on_tap_hold: gate_boot_keycode(state, raw.on_tap_hold),
                tapping_term: raw.tapping_term,
            };
            entry_set_response(req, &mut state.tap_dance_entries, entry)
        }
        DYNAMIC_VIAL_COMBO_GET => handle_entry_get(req, &state.combo_entries, ComboEntry::write),
        DYNAMIC_VIAL_COMBO_SET => {
            let raw = ComboEntry::read(req, 4);
            let entry = ComboEntry { output: gate_boot_keycode(state, raw.output), ..raw };
            entry_set_response(req, &mut state.combo_entries, entry)
        }
        DYNAMIC_VIAL_KEY_OVERRIDE_GET => {
            handle_entry_get(req, &state.key_override_entries, KeyOverrideEntry::write)
        }
        DYNAMIC_VIAL_KEY_OVERRIDE_SET => {
            let raw = KeyOverrideEntry::read(req, 4);
            let entry =
                KeyOverrideEntry { replacement_key: gate_boot_keycode(state, raw.replacement_key), ..raw };
            entry_set_response(req, &mut state.key_override_entries, entry)
        }
        DYNAMIC_VIAL_ALT_REPEAT_KEY_GET => {
            handle_entry_get(req, &state.alt_repeat_key_entries, AltRepeatKeyEntry::write)
        }
        DYNAMIC_VIAL_ALT_REPEAT_KEY_SET => {
            let raw = AltRepeatKeyEntry::read(req, 4);
            let entry = AltRepeatKeyEntry {
                last_key: gate_boot_keycode(state, raw.last_key),
                alt_key: gate_boot_keycode(state, raw.alt_key),
                ..raw
            };
            entry_set_response(req, &mut state.alt_repeat_key_entries, entry)
        }
        // Unknown dynamic-entry sub-op: unsupported, echo.
        _ => *req,
    }
}

pub fn handle_vial_report(
    state: &mut VirtualDeviceState,
    req: &Report,
    compressed_definition: &[u8],
    now: u64,
) -> Report {
    match req[1] {
        CMD_VIAL_GET_KEYBOARD_ID => handle_keyboard_id(),
        CMD_VIAL_GET_SIZE => handle_definition_size(compressed_definition.len()),
        CMD_VIAL_GET_DEFINITION => handle_definition_block(req, compressed_definition),
        CMD_VIAL_GET_UNLOCK_STATUS => handle_unlock_status(state),
        CMD_VIAL_UNLOCK_START => {
            state.unlock_in_progress = true;
            state.unlock_counter = state.unlock_counter_max;
            state.unlock_timer = now;
            *req
        }
        CMD_VIAL_UNLOCK_POLL => handle_unlock_poll(state, now),
        CMD_VIAL_LOCK => {
            state.unlocked = false;
            *req
        }
        CMD_VIAL_QMK_SETTINGS_QUERY => {
            let mut resp = [0u8; MSG_LEN];
            qmk_settings_query(read_le16(req, 2), &mut resp);
            resp
        }
        CMD_VIAL_QMK_SETTINGS_GET => {
            let mut resp = *req;
            resp[0] = qmk_settings_get(&state.qmk_settings, read_le16(req, 2), &mut resp, 1);
            resp
        }
        CMD_VIAL_QMK_SETTINGS_SET => {
            let mut resp = *req;
            resp[0] = qmk_settings_set(&mut state.qmk_settings, read_le16(req, 2), req, 4);
            resp
        }
        CMD_VIAL_QMK_SETTINGS_RESET => {
            state.qmk_settings.reset();
            // vial.c's reset case never touches msg: the request is echoed.
            *req
        }
        CMD_VIAL_DYNAMIC_ENTRY_OP => handle_dynamic_entry_op(state, req),
        // Encoders (0x03/0x04) and anything else: unsupported, echo.
        _ => *req,
    }
}
