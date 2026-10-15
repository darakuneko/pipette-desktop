// SPDX-License-Identifier: GPL-2.0-or-later
//! Vial commands (byte 0 == 0xFE, byte 1 selects the sub-command).
//! Supported commands build their response from a zeroed buffer; unsupported
//! ones echo the request so the app's echo detection reports the feature as
//! absent.

use crate::byte_utils::{read_le16, read_le32, write_le32};
use crate::dataset::{VIAL_PROTOCOL, VIRTUAL_DEVICE_UID_BYTES, VIRTUAL_DEVICE_UNLOCK_COMBO, is_boot_keycode};
use crate::dynamic_entries::{
    AltRepeatKeyEntry, ComboEntry, DYNAMIC_ENTRY_FEATURE_FLAGS, DynamicEntry, KeyOverrideEntry,
    TapDanceEntry, lookup_entry, store_entry,
};
use crate::protocol::{
    CMD_VIAL_DYNAMIC_ENTRY_OP, CMD_VIAL_GET_DEFINITION, CMD_VIAL_GET_KEYBOARD_ID, CMD_VIAL_GET_SIZE,
    CMD_VIAL_GET_UNLOCK_STATUS, CMD_VIAL_LOCK, CMD_VIAL_QMK_SETTINGS_GET, CMD_VIAL_QMK_SETTINGS_QUERY,
    CMD_VIAL_QMK_SETTINGS_RESET, CMD_VIAL_QMK_SETTINGS_SET, CMD_VIAL_UNLOCK_POLL, CMD_VIAL_UNLOCK_START,
    DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES, MSG_LEN, Report,
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

fn handle_get_number_of_entries() -> Report {
    let mut resp = [0u8; MSG_LEN];
    resp[0] = TapDanceEntry::COUNT as u8;
    resp[1] = ComboEntry::COUNT as u8;
    resp[2] = KeyOverrideEntry::COUNT as u8;
    resp[3] = AltRepeatKeyEntry::COUNT as u8;
    resp[MSG_LEN - 1] = DYNAMIC_ENTRY_FEATURE_FLAGS;
    resp
}

/// The GET or SET of kind `T`, or `None` when `req[2]` is neither. Both echo
/// the request with the status at offset 0 and use req[3] as the index. GET
/// writes the entry from offset 1; SET reads it from offset 4 and stores it
/// after vial_keycode_firewall(), which turns QK_BOOT into KC_NO while locked.
fn handle_entry_op<T: DynamicEntry>(state: &mut VirtualDeviceState, req: &Report) -> Option<Report> {
    let mut resp = *req;
    let index = usize::from(req[3]);
    if req[2] == T::GET {
        let (status, entry) = lookup_entry(T::store(state), index);
        resp[0] = status;
        entry.write(&mut resp, 1);
    } else if req[2] == T::SET {
        let unlocked = state.unlocked;
        let entry = T::read(req, 4).firewall(|kc| if !unlocked && is_boot_keycode(kc) { 0 } else { kc });
        resp[0] = store_entry(T::store_mut(state), index, entry);
    } else {
        return None;
    }
    Some(resp)
}

fn handle_dynamic_entry_op(state: &mut VirtualDeviceState, req: &Report) -> Report {
    if req[2] == DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES {
        return handle_get_number_of_entries();
    }
    handle_entry_op::<TapDanceEntry>(state, req)
        .or_else(|| handle_entry_op::<ComboEntry>(state, req))
        .or_else(|| handle_entry_op::<KeyOverrideEntry>(state, req))
        .or_else(|| handle_entry_op::<AltRepeatKeyEntry>(state, req))
        // Unknown dynamic-entry sub-op: unsupported, echo.
        .unwrap_or(*req)
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
