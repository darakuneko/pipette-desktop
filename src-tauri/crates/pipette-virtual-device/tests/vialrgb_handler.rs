// SPDX-License-Identifier: GPL-2.0-or-later

use pipette_virtual_device::byte_utils::{read_le16, write_le16};
use pipette_virtual_device::dataset::VIALRGB_SUPPORTED_EFFECTS;
use pipette_virtual_device::protocol::{
    MSG_LEN, Report, VIALRGB_GET_INFO, VIALRGB_GET_MODE, VIALRGB_GET_SUPPORTED, VIALRGB_SET_MODE, pad_report,
};
use pipette_virtual_device::state::{VialRgbState, VirtualDeviceState};
use pipette_virtual_device::vialrgb_handler::{get_lighting_value, set_lighting_value};

fn req(bytes: &[u8]) -> Report {
    pad_report(bytes)
}

fn get(state: &VirtualDeviceState, r: &Report) -> Report {
    let mut resp = *r;
    get_lighting_value(state, r, &mut resp);
    resp
}

#[test]
fn get_info_returns_le16_protocol_version_and_max_brightness() {
    let state = VirtualDeviceState::new();
    let resp = get(&state, &req(&[0x08, VIALRGB_GET_INFO]));
    assert_eq!(read_le16(&resp, 2), 1);
    assert_eq!(resp[4], 255);
}

#[test]
fn get_mode_reflects_current_state() {
    let mut state = VirtualDeviceState::new();
    state.rgb = VialRgbState { mode: 7, speed: 100, hue: 50, sat: 200, val: 150 };
    let resp = get(&state, &req(&[0x08, VIALRGB_GET_MODE]));
    assert_eq!(read_le16(&resp, 2), 7);
    assert_eq!(resp[4], 100);
    assert_eq!(resp[5], 50);
    assert_eq!(resp[6], 200);
    assert_eq!(resp[7], 150);
}

#[test]
fn get_supported_pagination_returns_ascending_effects_greater_than_0_excluding_direct() {
    let state = VirtualDeviceState::new();
    let mut r = req(&[0x08, VIALRGB_GET_SUPPORTED]);
    write_le16(&mut r, 2, 0);
    let resp = get(&state, &r);

    let expected: Vec<u16> = VIALRGB_SUPPORTED_EFFECTS.iter().copied().filter(|&e| e > 0).collect();
    for (i, effect) in expected.iter().take(15).enumerate() {
        assert_eq!(read_le16(&resp, 2 + i * 2), *effect);
    }
    assert!(!resp.contains(&1)); // DIRECT excluded

    // Beyond every known effect: entirely 0xFF-padded.
    let mut beyond = req(&[0x08, VIALRGB_GET_SUPPORTED]);
    write_le16(&mut beyond, 2, 9999);
    let beyond_resp = get(&state, &beyond);
    assert!(beyond_resp[2..MSG_LEN].iter().all(|&b| b == 0xff));
}

#[test]
fn set_mode_stores_mode_speed_and_hsv() {
    let mut state = VirtualDeviceState::new();
    let mut r = req(&[0x07, VIALRGB_SET_MODE]);
    write_le16(&mut r, 2, 9);
    r[4] = 111;
    r[5] = 22;
    r[6] = 33;
    r[7] = 44;
    set_lighting_value(&mut state, &r);
    assert_eq!(state.rgb, VialRgbState { mode: 9, speed: 111, hue: 22, sat: 33, val: 44 });
}

#[test]
fn ignores_unrelated_lighting_set_sub_commands() {
    let mut state = VirtualDeviceState::new();
    let before = state.rgb;
    set_lighting_value(&mut state, &req(&[0x07, 0x99]));
    assert_eq!(state.rgb, before);
}
