// SPDX-License-Identifier: GPL-2.0-or-later
//! VIA commands (byte 0 != 0xFE). The response starts as an exact copy of
//! the request, so an unhandled command comes back unchanged — which is how
//! the firmware "echoes" commands it does not support, and what the app's
//! echo detection treats as unsupported.

use crate::byte_utils::{read_be16, read_be32, write_be16, write_be32};
use crate::dataset::{KEYMAP_LEN, LAYERS, MACRO_BUFFER_SIZE, MACRO_COUNT, VIA_PROTOCOL, is_boot_keycode};
use crate::protocol::{
    BUFFER_FETCH_CHUNK, CMD_VIA_GET_KEYBOARD_VALUE, CMD_VIA_GET_KEYCODE, CMD_VIA_GET_LAYER_COUNT,
    CMD_VIA_GET_PROTOCOL_VERSION, CMD_VIA_KEYMAP_GET_BUFFER, CMD_VIA_LIGHTING_GET_VALUE,
    CMD_VIA_LIGHTING_SAVE, CMD_VIA_LIGHTING_SET_VALUE, CMD_VIA_MACRO_GET_BUFFER,
    CMD_VIA_MACRO_GET_BUFFER_SIZE, CMD_VIA_MACRO_GET_COUNT, CMD_VIA_MACRO_SET_BUFFER,
    CMD_VIA_SET_KEYBOARD_VALUE, CMD_VIA_SET_KEYCODE, Report, VIA_LAYOUT_OPTIONS, VIA_SWITCH_MATRIX_STATE,
};
use crate::state::{VirtualDeviceState, is_valid_keymap_position, keymap_index};
use crate::vialrgb_handler::{get_lighting_value, set_lighting_value};

/// Chunk header (command, offset BE16, size) → (offset, size capped at one chunk).
fn chunk_range(req: &Report) -> (usize, usize) {
    (usize::from(read_be16(req, 1)), usize::from(req[3]).min(BUFFER_FETCH_CHUNK))
}

fn keymap_bytes(state: &VirtualDeviceState) -> [u8; KEYMAP_LEN * 2] {
    let mut bytes = [0u8; KEYMAP_LEN * 2];
    for (i, keycode) in state.keymap.iter().enumerate() {
        write_be16(&mut bytes, i * 2, *keycode);
    }
    bytes
}

/// Copy `size` bytes of `src` from `offset` into `resp[4..]`; bytes past the
/// end of `src` read as 0.
fn copy_chunk_out(src: &[u8], offset: usize, size: usize, resp: &mut Report) {
    for i in 0..size {
        resp[4 + i] = src.get(offset + i).copied().unwrap_or(0);
    }
}

pub fn handle_via_report(state: &mut VirtualDeviceState, req: &Report) -> Report {
    let mut resp = *req;

    match req[0] {
        CMD_VIA_GET_PROTOCOL_VERSION => write_be16(&mut resp, 1, VIA_PROTOCOL),

        CMD_VIA_GET_KEYBOARD_VALUE => match req[1] {
            VIA_LAYOUT_OPTIONS => write_be32(&mut resp, 2, state.layout_options),
            // Locked: the request comes back unchanged, as on the firmware.
            VIA_SWITCH_MATRIX_STATE if state.unlocked => {
                let packed = state.pack_matrix_state();
                resp[2..2 + packed.len()].copy_from_slice(&packed);
            }
            _ => {}
        },

        CMD_VIA_SET_KEYBOARD_VALUE => {
            if req[1] == VIA_LAYOUT_OPTIONS {
                state.layout_options = read_be32(req, 2);
            }
        }

        CMD_VIA_GET_KEYCODE => {
            let (layer, row, col) = (usize::from(req[1]), usize::from(req[2]), usize::from(req[3]));
            let value = if is_valid_keymap_position(layer, row, col) {
                state.keymap[keymap_index(layer, row, col)]
            } else {
                0
            };
            write_be16(&mut resp, 4, value);
        }

        CMD_VIA_SET_KEYCODE => {
            let (layer, row, col) = (usize::from(req[1]), usize::from(req[2]), usize::from(req[3]));
            let keycode = read_be16(req, 4);
            if is_valid_keymap_position(layer, row, col) {
                let blocked = !state.unlocked && is_boot_keycode(keycode);
                state.keymap[keymap_index(layer, row, col)] = if blocked { 0 } else { keycode };
            }
        }

        CMD_VIA_GET_LAYER_COUNT => resp[1] = LAYERS as u8,

        CMD_VIA_KEYMAP_GET_BUFFER => {
            let (offset, size) = chunk_range(req);
            copy_chunk_out(&keymap_bytes(state), offset, size, &mut resp);
        }

        CMD_VIA_MACRO_GET_COUNT => resp[1] = MACRO_COUNT,

        CMD_VIA_MACRO_GET_BUFFER_SIZE => write_be16(&mut resp, 1, MACRO_BUFFER_SIZE as u16),

        CMD_VIA_MACRO_GET_BUFFER => {
            let (offset, size) = chunk_range(req);
            copy_chunk_out(&state.macro_buffer, offset, size, &mut resp);
        }

        CMD_VIA_MACRO_SET_BUFFER => {
            let (offset, size) = chunk_range(req);
            for i in 0..size {
                if let Some(slot) = state.macro_buffer.get_mut(offset + i) {
                    *slot = req[4 + i];
                }
            }
        }

        CMD_VIA_LIGHTING_GET_VALUE => get_lighting_value(state, req, &mut resp),

        CMD_VIA_LIGHTING_SET_VALUE => set_lighting_value(state, req),

        // No persistent EEPROM to flush: acknowledge only.
        CMD_VIA_LIGHTING_SAVE => {}

        _ => {}
    }

    resp
}
