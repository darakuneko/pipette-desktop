// SPDX-License-Identifier: GPL-2.0-or-later

use pipette_virtual_device::byte_utils::{read_be16, read_be32, write_be16, write_be32};
use pipette_virtual_device::dataset::{COLS, LAYERS, MACRO_BUFFER_SIZE, ROWS, keycodes};
use pipette_virtual_device::protocol::{BUFFER_FETCH_CHUNK, MSG_LEN, Report, pad_report};
use pipette_virtual_device::state::{VirtualDeviceState, keymap_index};
use pipette_virtual_device::via_handler::handle_via_report;

fn req(bytes: &[u8]) -> Report {
    pad_report(bytes)
}

fn chunk_req(cmd: u8, offset: usize, size: usize) -> Report {
    let mut r = [0u8; MSG_LEN];
    r[0] = cmd;
    write_be16(&mut r, 1, offset as u16);
    r[3] = size as u8;
    r
}

#[test]
fn get_protocol_version_returns_be16_9() {
    let mut state = VirtualDeviceState::new();
    let resp = handle_via_report(&mut state, &req(&[0x01]));
    assert_eq!(read_be16(&resp, 1), 9);
}

#[test]
fn get_layer_count_returns_4() {
    let mut state = VirtualDeviceState::new();
    let resp = handle_via_report(&mut state, &req(&[0x11]));
    assert_eq!(usize::from(resp[1]), LAYERS);
}

#[test]
fn layout_options_round_trip_through_set_get() {
    let mut state = VirtualDeviceState::new();
    let mut set_req = req(&[0x03, 0x02]);
    write_be32(&mut set_req, 2, 0xabcd_1234);
    handle_via_report(&mut state, &set_req);
    assert_eq!(state.layout_options, 0xabcd_1234);

    let get_resp = handle_via_report(&mut state, &req(&[0x02, 0x02]));
    assert_eq!(read_be32(&get_resp, 2), 0xabcd_1234);
}

#[test]
fn fetches_the_full_keymap_buffer_in_28_byte_chunks_including_an_odd_offset() {
    let mut state = VirtualDeviceState::new();
    let total_bytes = LAYERS * ROWS * COLS * 2;
    let mut collected = Vec::new();
    for offset in (0..total_bytes).step_by(BUFFER_FETCH_CHUNK) {
        let chunk_size = BUFFER_FETCH_CHUNK.min(total_bytes - offset);
        let resp = handle_via_report(&mut state, &chunk_req(0x12, offset, chunk_size));
        collected.extend_from_slice(&resp[4..4 + chunk_size]);
    }
    assert_eq!(collected.len(), total_bytes);
    for (i, keycode) in state.keymap.iter().enumerate() {
        assert_eq!(read_be16(&collected, i * 2), *keycode);
    }

    // Odd-offset fetch mid-buffer reassembles to the same bytes.
    let odd_offset = 5;
    let odd_resp = handle_via_report(&mut state, &chunk_req(0x12, odd_offset, 10));
    assert_eq!(odd_resp[4..14], collected[odd_offset..odd_offset + 10]);
}

#[test]
fn set_keycode_is_reflected_in_the_keymap_buffer() {
    let mut state = VirtualDeviceState::new();
    let mut set_req = req(&[0x05, 0, 1, 2]);
    write_be16(&mut set_req, 4, 0x1234);
    handle_via_report(&mut state, &set_req);
    assert_eq!(state.keymap[keymap_index(0, 1, 2)], 0x1234);

    let get_resp = handle_via_report(&mut state, &req(&[0x04, 0, 1, 2]));
    assert_eq!(read_be16(&get_resp, 4), 0x1234);
}

#[test]
fn blocks_setting_qk_boot_while_locked_stores_kc_no_instead() {
    let mut state = VirtualDeviceState::new();
    assert!(!state.unlocked);
    let mut set_req = req(&[0x05, 0, 0, 0]);
    write_be16(&mut set_req, 4, keycodes::QK_BOOT);
    handle_via_report(&mut state, &set_req);
    assert_eq!(state.keymap[keymap_index(0, 0, 0)], 0);
}

#[test]
fn allows_setting_qk_boot_once_unlocked() {
    let mut state = VirtualDeviceState::new();
    state.unlocked = true;
    let mut set_req = req(&[0x05, 0, 0, 0]);
    write_be16(&mut set_req, 4, keycodes::QK_BOOT);
    handle_via_report(&mut state, &set_req);
    assert_eq!(state.keymap[keymap_index(0, 0, 0)], keycodes::QK_BOOT);
}

#[test]
fn macro_buffer_round_trips_through_set_get_in_chunks() {
    let mut state = VirtualDeviceState::new();
    let sample: Vec<u8> = (0..MACRO_BUFFER_SIZE).map(|i| (i % 256) as u8).collect();

    for offset in (0..sample.len()).step_by(BUFFER_FETCH_CHUNK) {
        let chunk_size = BUFFER_FETCH_CHUNK.min(sample.len() - offset);
        let mut r = chunk_req(0x0f, offset, chunk_size);
        r[4..4 + chunk_size].copy_from_slice(&sample[offset..offset + chunk_size]);
        handle_via_report(&mut state, &r);
    }
    assert_eq!(state.macro_buffer.to_vec(), sample);

    let mut collected = Vec::new();
    for offset in (0..sample.len()).step_by(BUFFER_FETCH_CHUNK) {
        let chunk_size = BUFFER_FETCH_CHUNK.min(sample.len() - offset);
        let resp = handle_via_report(&mut state, &chunk_req(0x0e, offset, chunk_size));
        collected.extend_from_slice(&resp[4..4 + chunk_size]);
    }
    assert_eq!(collected, sample);
}

#[test]
fn matrix_request_while_locked_returns_the_request_unchanged() {
    let mut state = VirtualDeviceState::new();
    state.press_key(0, 0);
    let r = req(&[0x02, 0x03]);
    assert_eq!(handle_via_report(&mut state, &r), r);
}

#[test]
fn matrix_request_while_unlocked_reflects_pressed_keys() {
    let mut state = VirtualDeviceState::new();
    state.unlocked = true;
    state.press_key(0, 0);
    state.press_key(0, 13);
    state.press_key(4, 11);

    let resp = handle_via_report(&mut state, &req(&[0x02, 0x03]));
    // row 0: bit0 (col0) low byte, bit5 (col13-8) high byte
    assert_eq!(resp[2], 1 << 5);
    assert_eq!(resp[3], 0x01);
    // row 4: bit3 (col11-8) high byte
    assert_eq!(resp[2 + 4 * 2], 1 << 3);
    assert_eq!(resp[2 + 4 * 2 + 1], 0x00);
}
