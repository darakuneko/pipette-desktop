// SPDX-License-Identifier: GPL-2.0-or-later

use pipette_virtual_device::byte_utils::{read_le16, read_le32};
use pipette_virtual_device::qmk_settings::{
    QmkSettingsStore, SUPPORTED_QSIDS, qmk_settings_get, qmk_settings_query, qmk_settings_set,
};

#[test]
fn defaults_match_qmk_settings_reset_and_quantum_default_macros() {
    let store = QmkSettingsStore::default();
    assert_eq!(store.combo_term, 50);
    assert_eq!(store.auto_shift_timeout, 175);
    assert_eq!(store.osk_tap_toggle, 5);
    assert_eq!(store.osk_timeout, 5000);
    assert_eq!(store.tapping_term, 200);
    assert_eq!(store.mousekey_delay, 10);
    assert_eq!(store.mousekey_interval, 20);
    assert_eq!(store.mousekey_move_delta, 8);
    assert_eq!(store.mousekey_max_speed, 10);
    assert_eq!(store.mousekey_time_to_max, 30);
    assert_eq!(store.mousekey_wheel_delay, 10);
    assert_eq!(store.mousekey_wheel_interval, 80);
    assert_eq!(store.mousekey_wheel_max_speed, 8);
    assert_eq!(store.mousekey_wheel_time_to_max, 40);
    assert_eq!(store.tap_code_delay, 0);
    assert_eq!(store.tap_hold_caps_delay, 80);
    assert_eq!(store.tapping_toggle, 5);
    assert_eq!(store.quick_tap_term, 200);
    assert_eq!(store.flow_tap_term, 0);
    assert_eq!(store.magic_flags, 0);
    assert_eq!(store.tapping_v2, 0);
}

#[test]
fn supported_qsids_has_26_entries_without_8_and_with_mousekey_9_to_17() {
    assert_eq!(SUPPORTED_QSIDS.len(), 26);
    assert!(!SUPPORTED_QSIDS.contains(&8));
    for qsid in 9..=17 {
        assert!(SUPPORTED_QSIDS.contains(&qsid));
    }
}

#[test]
fn supported_qsids_are_already_ascending() {
    let mut sorted = SUPPORTED_QSIDS;
    sorted.sort_unstable();
    assert_eq!(SUPPORTED_QSIDS, sorted);
}

#[test]
fn query_fills_the_buffer_with_qsids_greater_than_the_cursor() {
    let mut buf = [0u8; 32];
    qmk_settings_query(0, &mut buf);
    for (i, qsid) in SUPPORTED_QSIDS[..16].iter().enumerate() {
        assert_eq!(read_le16(&buf, i * 2), *qsid);
    }
}

#[test]
fn query_with_a_cursor_past_the_last_qsid_yields_an_all_0xffff_buffer() {
    let mut buf = [0u8; 32];
    qmk_settings_query(9999, &mut buf);
    assert_eq!(buf, [0xff; 32]);
}

#[test]
fn round_trips_a_u8_field_qsid_1() {
    let mut store = QmkSettingsStore::default();
    let buf = [0x0f, 0, 0, 0];
    assert_eq!(qmk_settings_set(&mut store, 1, &buf, 0), 0);
    assert_eq!(store.grave_esc_override, 0x0f);
    let mut out = [0u8; 4];
    assert_eq!(qmk_settings_get(&store, 1, &mut out, 0), 0);
    assert_eq!(out[0], 0x0f);
}

#[test]
fn round_trips_a_u16_field_qsid_7_tapping_term() {
    let mut store = QmkSettingsStore::default();
    let buf = [0x2c, 0x01, 0, 0]; // 300 LE16
    assert_eq!(qmk_settings_set(&mut store, 7, &buf, 0), 0);
    assert_eq!(store.tapping_term, 300);
    let mut out = [0u8; 4];
    qmk_settings_get(&store, 7, &mut out, 0);
    assert_eq!(read_le16(&out, 0), 300);
}

#[test]
fn round_trips_the_u32_magic_settings_field_qsid_21() {
    let mut store = QmkSettingsStore::default();
    let buf = [0x81, 0, 0, 0]; // bit0 (swap ctrl/caps) + bit7 (nkro)
    assert_eq!(qmk_settings_set(&mut store, 21, &buf, 0), 0);
    assert_eq!(store.magic_flags, 0x81);
    let mut out = [0u8; 4];
    qmk_settings_get(&store, 21, &mut out, 0);
    assert_eq!(read_le32(&out, 0), 0x81);
}

#[test]
fn tapping_v2_bit_qsids_address_distinct_bits_of_the_same_byte() {
    let mut store = QmkSettingsStore::default();
    qmk_settings_set(&mut store, 22, &[1], 0);
    qmk_settings_set(&mut store, 26, &[1], 0);
    assert_eq!(store.tapping_v2, (1 << 0) | (1 << 3));

    let mut out23 = [0u8; 1];
    qmk_settings_get(&store, 23, &mut out23, 0);
    assert_eq!(out23[0], 0);

    let mut out22 = [0u8; 1];
    qmk_settings_get(&store, 22, &mut out22, 0);
    assert_eq!(out22[0], 1);

    // Clearing bit 22 must not disturb bit 26.
    qmk_settings_set(&mut store, 22, &[0], 0);
    assert_eq!(store.tapping_v2, 1 << 3);
}

#[test]
fn rejects_an_unsupported_qsid_8_without_touching_the_store() {
    let mut store = QmkSettingsStore::default();
    let before = store.clone();
    assert_eq!(qmk_settings_set(&mut store, 8, &[1, 2, 3, 4], 0), 0xff);
    assert_eq!(store, before);
    let mut out = [0u8; 4];
    assert_eq!(qmk_settings_get(&store, 8, &mut out, 0), 0xff);
}

#[test]
fn reset_restores_every_field_to_its_default_after_mutation() {
    let mut store = QmkSettingsStore { tapping_term: 999, tapping_v2: 0x0f, ..QmkSettingsStore::default() };
    store.reset();
    assert_eq!(store, QmkSettingsStore::default());
}
