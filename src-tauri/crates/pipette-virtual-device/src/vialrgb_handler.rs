// SPDX-License-Identifier: GPL-2.0-or-later
//! VialRGB sub-commands, reached through CMD_VIA_LIGHTING_GET_VALUE /
//! CMD_VIA_LIGHTING_SET_VALUE (byte 1 selects the sub-command).

use crate::byte_utils::{read_le16, write_le16};
use crate::dataset::VIALRGB_SUPPORTED_EFFECTS;
use crate::protocol::{
    MSG_LEN, Report, VIALRGB_GET_INFO, VIALRGB_GET_MODE, VIALRGB_GET_SUPPORTED, VIALRGB_SET_MODE,
};
use crate::state::VirtualDeviceState;

const VIALRGB_PROTOCOL_VERSION: u16 = 1;
const VIALRGB_MAX_BRIGHTNESS: u8 = 255;
/// Effect-ID slots after the 2-byte response header.
const SUPPORTED_ENTRIES_PER_PAGE: usize = (MSG_LEN - 2) / 2;

/// Handle a CMD_VIA_LIGHTING_GET_VALUE sub-command. `resp` starts as a copy
/// of the request; unknown sub-commands leave it unchanged.
pub fn get_lighting_value(state: &VirtualDeviceState, req: &Report, resp: &mut Report) {
    match req[1] {
        VIALRGB_GET_INFO => {
            write_le16(resp, 2, VIALRGB_PROTOCOL_VERSION);
            resp[4] = VIALRGB_MAX_BRIGHTNESS;
        }
        VIALRGB_GET_MODE => {
            write_le16(resp, 2, state.rgb.mode);
            resp[4] = state.rgb.speed;
            resp[5] = state.rgb.hue;
            resp[6] = state.rgb.sat;
            resp[7] = state.rgb.val;
        }
        VIALRGB_GET_SUPPORTED => {
            let greater_than = read_le16(req, 2);
            resp[2..].fill(0xff);
            let candidates = VIALRGB_SUPPORTED_EFFECTS.iter().filter(|&&effect| effect > greater_than);
            for (i, &effect) in candidates.take(SUPPORTED_ENTRIES_PER_PAGE).enumerate() {
                write_le16(resp, 2 + i * 2, effect);
            }
        }
        _ => {}
    }
}

/// Handle a CMD_VIA_LIGHTING_SET_VALUE sub-command (the caller echoes the request).
pub fn set_lighting_value(state: &mut VirtualDeviceState, req: &Report) {
    if req[1] != VIALRGB_SET_MODE {
        return;
    }
    state.rgb.mode = read_le16(req, 2);
    state.rgb.speed = req[4];
    state.rgb.hue = req[5];
    state.rgb.sat = req[6];
    state.rgb.val = req[7];
}
