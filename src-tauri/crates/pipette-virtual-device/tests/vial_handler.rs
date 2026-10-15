// SPDX-License-Identifier: GPL-2.0-or-later

mod common;

use common::req;

use pipette_virtual_device::byte_utils::{read_le16, write_le16, write_le32};
use pipette_virtual_device::dataset::{VIAL_PROTOCOL, VIRTUAL_DEVICE_UID_BYTES, VIRTUAL_DEVICE_UNLOCK_COMBO};
use pipette_virtual_device::dynamic_entries::{
    AltRepeatKeyEntry, ComboEntry, DYNAMIC_ENTRY_FEATURE_FLAGS, DynamicEntry, KeyOverrideEntry, TapDanceEntry,
};
use pipette_virtual_device::protocol::{MSG_LEN, Report};
use pipette_virtual_device::qmk_settings::SUPPORTED_QSIDS;
use pipette_virtual_device::state::VirtualDeviceState;
use pipette_virtual_device::vial_handler::handle_vial_report;

fn fake_compressed() -> Vec<u8> {
    (0..70u32).map(|i| ((i * 3 + 7) % 256) as u8).collect()
}

fn handle(state: &mut VirtualDeviceState, r: &Report) -> Report {
    handle_vial_report(state, r, &fake_compressed(), 0)
}

#[test]
fn keyboard_id_le32_protocol_uid_bytes_vialrgb_flag() {
    let mut state = VirtualDeviceState::new();
    let resp = handle(&mut state, &req(&[0xfe, 0x00]));
    let protocol = u32::from_le_bytes([resp[0], resp[1], resp[2], resp[3]]);
    assert_eq!(protocol, VIAL_PROTOCOL);
    assert_eq!(resp[4..12], VIRTUAL_DEVICE_UID_BYTES);
    assert_eq!(resp[12], 1);
}

#[test]
fn definition_size_and_block_reassembly_equals_the_compressed_buffer() {
    let mut state = VirtualDeviceState::new();
    let compressed = fake_compressed();
    let size_resp = handle(&mut state, &req(&[0xfe, 0x01]));
    let size = u32::from_le_bytes([size_resp[0], size_resp[1], size_resp[2], size_resp[3]]) as usize;
    assert_eq!(size, compressed.len());

    let blocks = size.div_ceil(MSG_LEN);
    let mut reassembled = vec![0u8; size];
    for block in 0..blocks {
        let mut block_req = [0u8; MSG_LEN];
        block_req[0] = 0xfe;
        block_req[1] = 0x02;
        write_le32(&mut block_req, 2, block as u32);
        let resp = handle(&mut state, &block_req);
        let copy_len = MSG_LEN.min(size - block * MSG_LEN);
        reassembled[block * MSG_LEN..block * MSG_LEN + copy_len].copy_from_slice(&resp[..copy_len]);
    }
    assert_eq!(reassembled, compressed);
}

#[test]
fn unlock_status_0xff_filled_with_unlocked_in_progress_bytes_and_combo_pairs() {
    let mut state = VirtualDeviceState::new();
    let resp = handle(&mut state, &req(&[0xfe, 0x05]));
    assert_eq!(resp[0], 0); // locked
    assert_eq!(resp[1], 0); // not in progress
    for (i, &(row, col)) in VIRTUAL_DEVICE_UNLOCK_COMBO.iter().enumerate() {
        assert_eq!(resp[2 + i * 2], row);
        assert_eq!(resp[3 + i * 2], col);
    }
    // Remaining slots are 0xFF sentinel pairs.
    let used = VIRTUAL_DEVICE_UNLOCK_COMBO.len();
    assert_eq!(resp[2 + used * 2], 0xff);
    assert_eq!(resp[3 + used * 2], 0xff);
}

#[test]
fn unlock_start_and_poll_sequence_progresses_the_counter_and_eventually_unlocks() {
    let mut state = VirtualDeviceState::new();
    state.unlock_counter_max = 2;
    state.press_key(0, 0);
    state.press_key(0, 1);

    handle_vial_report(&mut state, &req(&[0xfe, 0x06]), &fake_compressed(), 0);
    assert!(state.unlock_in_progress);

    let resp = handle_vial_report(&mut state, &req(&[0xfe, 0x07]), &fake_compressed(), 200);
    assert_eq!(resp[0], 0);
    assert_eq!(resp[2], 1);

    let resp = handle_vial_report(&mut state, &req(&[0xfe, 0x07]), &fake_compressed(), 400);
    assert_eq!(resp[0], 1);
    assert_eq!(resp[2], 0);
    assert!(state.unlocked);
}

#[test]
fn lock_resets_unlocked_to_false() {
    let mut state = VirtualDeviceState::new();
    state.unlocked = true;
    handle(&mut state, &req(&[0xfe, 0x08]));
    assert!(!state.unlocked);
}

#[test]
fn qmk_settings_query_returns_the_full_first_page_of_supported_qsids_0xffff_padded() {
    let mut state = VirtualDeviceState::new();
    let resp = handle(&mut state, &req(&[0xfe, 0x09, 0x00, 0x00]));
    let first_page = &SUPPORTED_QSIDS[..16];
    for (i, qsid) in first_page.iter().enumerate() {
        assert_eq!(read_le16(&resp, i * 2), *qsid);
    }
    for i in first_page.len()..16 {
        assert_eq!(read_le16(&resp, i * 2), 0xffff);
    }
}

#[test]
fn qmk_settings_query_second_page_starts_past_the_last_qsid_seen_and_ends_in_0xffff_padding() {
    let mut state = VirtualDeviceState::new();
    let last = SUPPORTED_QSIDS[15];
    let resp = handle(&mut state, &req(&[0xfe, 0x09, (last & 0xff) as u8, (last >> 8) as u8]));
    let second_page = &SUPPORTED_QSIDS[16..];
    for (i, qsid) in second_page.iter().enumerate() {
        assert_eq!(read_le16(&resp, i * 2), *qsid);
    }
    assert_eq!(read_le16(&resp, second_page.len() * 2), 0xffff);
}

#[test]
fn qmk_settings_get_set_round_trips_qsid_7_and_rejects_an_unsupported_one() {
    let mut state = VirtualDeviceState::new();
    let get_pkt = req(&[0xfe, 0x0a, 0x07, 0x00]);
    let before = handle(&mut state, &get_pkt);
    assert_eq!(before[0], 0);
    assert_eq!(read_le16(&before, 1), 200); // TAPPING_TERM default

    let mut set_pkt = [0u8; MSG_LEN];
    set_pkt[0] = 0xfe;
    set_pkt[1] = 0x0b;
    write_le16(&mut set_pkt, 2, 7);
    write_le16(&mut set_pkt, 4, 150);
    assert_eq!(handle(&mut state, &set_pkt)[0], 0);

    let after = handle(&mut state, &get_pkt);
    assert_eq!(read_le16(&after, 1), 150);

    // qsid 8 has no slot in this vial-qmk version's protos[] table.
    let unsupported = handle(&mut state, &req(&[0xfe, 0x0a, 0x08, 0x00]));
    assert_eq!(unsupported[0], 0xff);
}

#[test]
fn qmk_settings_reset_restores_defaults_and_echoes_the_request() {
    let mut state = VirtualDeviceState::new();
    let mut set_pkt = [0u8; MSG_LEN];
    set_pkt[0] = 0xfe;
    set_pkt[1] = 0x0b;
    write_le16(&mut set_pkt, 2, 7);
    write_le16(&mut set_pkt, 4, 999);
    handle(&mut state, &set_pkt);

    let reset_pkt = req(&[0xfe, 0x0c]);
    assert_eq!(handle(&mut state, &reset_pkt), reset_pkt);

    let after = handle(&mut state, &req(&[0xfe, 0x0a, 0x07, 0x00]));
    assert_eq!(read_le16(&after, 1), 200);
}

#[test]
fn dynamic_entry_counts_report_the_32_entry_tier_and_feature_flags() {
    let mut state = VirtualDeviceState::new();
    let resp = handle(&mut state, &req(&[0xfe, 0x0d, 0x00]));
    assert_eq!(usize::from(resp[0]), TapDanceEntry::COUNT);
    assert_eq!(usize::from(resp[1]), ComboEntry::COUNT);
    assert_eq!(usize::from(resp[2]), KeyOverrideEntry::COUNT);
    assert_eq!(usize::from(resp[3]), AltRepeatKeyEntry::COUNT);
    assert_eq!(resp[MSG_LEN - 1], DYNAMIC_ENTRY_FEATURE_FLAGS);
}

#[test]
fn tap_dance_get_returns_the_seeded_sample_at_index_0_and_a_zero_entry_out_of_range() {
    let mut state = VirtualDeviceState::new();
    let resp = handle(&mut state, &req(&[0xfe, 0x0d, 0x01, 0x00]));
    assert_eq!(resp[0], 0);
    assert_ne!(read_le16(&resp, 1), 0); // onTap = KC_A

    let out_of_range = handle(&mut state, &req(&[0xfe, 0x0d, 0x01, 32]));
    assert_eq!(out_of_range[0], 0xff);
    assert_eq!(out_of_range[1..11], [0u8; 10]);
}

fn tap_dance_set_pkt(index: u8, on_tap: u16) -> Report {
    let mut pkt = [0u8; MSG_LEN];
    pkt[0] = 0xfe;
    pkt[1] = 0x0d;
    pkt[2] = 0x02;
    pkt[3] = index;
    write_le16(&mut pkt, 4, on_tap);
    write_le16(&mut pkt, 12, 200);
    pkt
}

#[test]
fn tap_dance_set_stores_an_entry_and_blocks_qk_boot_while_locked() {
    let mut state = VirtualDeviceState::new();
    assert!(!state.unlocked);
    let set_resp = handle(&mut state, &tap_dance_set_pkt(5, 0x7c00)); // QK_BOOT (protocol v6)
    assert_eq!(set_resp[0], 0);

    let get_resp = handle(&mut state, &req(&[0xfe, 0x0d, 0x01, 5]));
    assert_eq!(read_le16(&get_resp, 1), 0); // QK_BOOT replaced with KC_NO while locked
}

#[test]
fn tap_dance_set_stores_qk_boot_unchanged_once_unlocked() {
    let mut state = VirtualDeviceState::new();
    state.unlocked = true;
    let set_resp = handle(&mut state, &tap_dance_set_pkt(6, 0x7c00));
    assert_eq!(set_resp[0], 0);

    let get_resp = handle(&mut state, &req(&[0xfe, 0x0d, 0x01, 6]));
    assert_eq!(read_le16(&get_resp, 1), 0x7c00);
}

fn combo_set_pkt(index: u8, key1: u16, key2: u16, output: u16) -> Report {
    let mut pkt = [0u8; MSG_LEN];
    pkt[0] = 0xfe;
    pkt[1] = 0x0d;
    pkt[2] = 0x04;
    pkt[3] = index;
    write_le16(&mut pkt, 4, key1);
    write_le16(&mut pkt, 6, key2);
    write_le16(&mut pkt, 12, output);
    pkt
}

#[test]
fn combo_set_get_round_trips_and_out_of_range_index_is_rejected() {
    let mut state = VirtualDeviceState::new();
    let set_pkt = combo_set_pkt(1, 1, 2, 41);
    assert_eq!(handle(&mut state, &set_pkt)[0], 0);

    let get_resp = handle(&mut state, &req(&[0xfe, 0x0d, 0x03, 1]));
    assert_eq!(read_le16(&get_resp, 1), 1);
    assert_eq!(read_le16(&get_resp, 9), 41);

    let mut bad_idx = set_pkt;
    bad_idx[3] = 32;
    assert_eq!(handle(&mut state, &bad_idx)[0], 0xff);
}

#[test]
fn combo_set_blocks_qk_boot_in_output_while_locked_condition_keys_untouched() {
    let mut state = VirtualDeviceState::new();
    assert!(!state.unlocked);
    assert_eq!(handle(&mut state, &combo_set_pkt(2, 1, 2, 0x7c00))[0], 0);

    let get_resp = handle(&mut state, &req(&[0xfe, 0x0d, 0x03, 2]));
    assert_eq!(read_le16(&get_resp, 9), 0); // output replaced with KC_NO while locked
    assert_eq!(read_le16(&get_resp, 1), 1); // condition keycodes are not gated by vial.c's firewall
}

#[test]
fn key_override_get_exposes_the_seeded_sample_enabled_bit_and_combined_options_byte() {
    let mut state = VirtualDeviceState::new();
    let resp = handle(&mut state, &req(&[0xfe, 0x0d, 0x05, 0x00]));
    assert_eq!(resp[0], 0);
    let options_byte = resp[10];
    assert_ne!(options_byte & 0x80, 0); // enabled
    assert_eq!(options_byte & 0x7f, 0x07);
}

#[test]
fn key_override_set_blocks_qk_boot_in_replacement_while_locked_trigger_key_untouched() {
    let mut state = VirtualDeviceState::new();
    assert!(!state.unlocked);
    let mut set_pkt = [0u8; MSG_LEN];
    set_pkt[0] = 0xfe;
    set_pkt[1] = 0x0d;
    set_pkt[2] = 0x06;
    set_pkt[3] = 1;
    write_le16(&mut set_pkt, 4, 4); // triggerKey
    write_le16(&mut set_pkt, 6, 0x7c00); // replacementKey = QK_BOOT
    write_le16(&mut set_pkt, 8, 0); // layers
    set_pkt[13] = 0x80; // enabled bit only
    assert_eq!(handle(&mut state, &set_pkt)[0], 0);

    let get_resp = handle(&mut state, &req(&[0xfe, 0x0d, 0x05, 1]));
    assert_eq!(read_le16(&get_resp, 3), 0); // replacement replaced with KC_NO while locked
    assert_eq!(read_le16(&get_resp, 1), 4); // trigger key is not gated by vial.c's firewall
}

fn alt_repeat_set_pkt(index: u8, last_key: u16, alt_key: u16) -> Report {
    let mut pkt = [0u8; MSG_LEN];
    pkt[0] = 0xfe;
    pkt[1] = 0x0d;
    pkt[2] = 0x08;
    pkt[3] = index;
    write_le16(&mut pkt, 4, last_key);
    write_le16(&mut pkt, 6, alt_key);
    pkt[9] = 0x08; // enabled bit only
    pkt
}

#[test]
fn alt_repeat_key_set_get_round_trips_through_the_6_byte_wire_entry() {
    let mut state = VirtualDeviceState::new();
    assert_eq!(handle(&mut state, &alt_repeat_set_pkt(2, 4, 5))[0], 0);

    let get_resp = handle(&mut state, &req(&[0xfe, 0x0d, 0x07, 2]));
    assert_eq!(read_le16(&get_resp, 1), 4);
    assert_eq!(read_le16(&get_resp, 3), 5);
    assert_ne!(get_resp[6] & 0x08, 0);
}

#[test]
fn alt_repeat_key_set_blocks_qk_boot_in_both_keycodes_while_locked() {
    let mut state = VirtualDeviceState::new();
    assert!(!state.unlocked);
    assert_eq!(handle(&mut state, &alt_repeat_set_pkt(3, 0x7c00, 0x7c00))[0], 0);

    let get_resp = handle(&mut state, &req(&[0xfe, 0x0d, 0x07, 3]));
    assert_eq!(read_le16(&get_resp, 1), 0); // lastKey replaced with KC_NO while locked
    assert_eq!(read_le16(&get_resp, 3), 0); // altKey replaced with KC_NO while locked
}

#[test]
fn encoder_get_sub_0x03_is_a_pure_echo() {
    let mut state = VirtualDeviceState::new();
    let r = req(&[0xfe, 0x03, 0, 1]);
    let resp = handle(&mut state, &r);
    assert_eq!(resp[..4], r[..4]);
}
