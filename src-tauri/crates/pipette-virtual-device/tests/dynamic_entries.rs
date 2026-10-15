// SPDX-License-Identifier: GPL-2.0-or-later

use pipette_virtual_device::dynamic_entries::{
    AltRepeatKeyEntry, ComboEntry, DynamicEntry, KeyOverrideEntry, TapDanceEntry, default_entries,
    lookup_entry, store_entry,
};

fn sample_key_override() -> KeyOverrideEntry {
    KeyOverrideEntry {
        trigger_key: 0x2a,
        replacement_key: 0x4c,
        layers: 0xffff,
        trigger_mods: 0x02,
        negative_mods: 0,
        suppressed_mods: 0x02,
        options: 0x07,
        enabled: true,
    }
}

fn sample_alt_repeat_key() -> AltRepeatKeyEntry {
    AltRepeatKeyEntry { last_key: 0x06, alt_key: 0x19, allowed_mods: 0, options: 0x03, enabled: true }
}

// --- default entry factories ---

#[test]
fn factories_create_arrays_sized_to_the_32_entry_tier() {
    assert_eq!(default_entries::<TapDanceEntry>().len(), TapDanceEntry::COUNT);
    assert_eq!(default_entries::<ComboEntry>().len(), ComboEntry::COUNT);
    assert_eq!(default_entries::<KeyOverrideEntry>().len(), KeyOverrideEntry::COUNT);
    assert_eq!(default_entries::<AltRepeatKeyEntry>().len(), AltRepeatKeyEntry::COUNT);
    assert_eq!(TapDanceEntry::COUNT, 32);
    assert_eq!(ComboEntry::COUNT, 32);
    assert_eq!(KeyOverrideEntry::COUNT, 32);
    assert_eq!(AltRepeatKeyEntry::COUNT, 32);
}

#[test]
fn tap_dance_defaults_are_all_kc_no_with_tapping_term() {
    for entry in default_entries::<TapDanceEntry>() {
        assert_eq!(
            entry,
            TapDanceEntry { on_tap: 0, on_hold: 0, on_double_tap: 0, on_tap_hold: 0, tapping_term: 200 }
        );
    }
}

#[test]
fn combo_defaults_are_all_zero() {
    for entry in default_entries::<ComboEntry>() {
        assert_eq!(entry, ComboEntry { key1: 0, key2: 0, key3: 0, key4: 0, output: 0 });
    }
}

#[test]
fn key_override_defaults_cover_all_layers_disabled_with_activation_options() {
    for entry in default_entries::<KeyOverrideEntry>() {
        assert_eq!(entry.layers, 0xffff);
        assert_eq!(entry.options, 0x07);
        assert!(!entry.enabled);
    }
}

#[test]
fn alt_repeat_key_defaults_are_all_zero_and_disabled() {
    for entry in default_entries::<AltRepeatKeyEntry>() {
        assert_eq!(
            entry,
            AltRepeatKeyEntry { last_key: 0, alt_key: 0, allowed_mods: 0, options: 0, enabled: false }
        );
    }
}

// --- bounds-checked get/set ---

#[test]
fn tap_dance_get_out_of_range_returns_0xff_and_an_all_zero_entry() {
    let entries = default_entries::<TapDanceEntry>();
    let (status, entry) = lookup_entry(&entries, 32);
    assert_eq!(status, 0xff);
    assert_eq!(
        entry,
        TapDanceEntry { on_tap: 0, on_hold: 0, on_double_tap: 0, on_tap_hold: 0, tapping_term: 0 }
    );
}

#[test]
fn tap_dance_set_out_of_range_does_not_mutate_the_store() {
    let mut entries = default_entries::<TapDanceEntry>();
    let entry = TapDanceEntry { on_tap: 4, on_hold: 0, on_double_tap: 0, on_tap_hold: 0, tapping_term: 1 };
    assert_eq!(store_entry(&mut entries, 32, entry), 0xff);
    assert_eq!(entries[31], TapDanceEntry::reset_value());
}

#[test]
fn tap_dance_in_range_set_get_round_trips() {
    let mut entries = default_entries::<TapDanceEntry>();
    let entry =
        TapDanceEntry { on_tap: 4, on_hold: 224, on_double_tap: 0, on_tap_hold: 0, tapping_term: 175 };
    assert_eq!(store_entry(&mut entries, 3, entry), 0);
    assert_eq!(lookup_entry(&entries, 3), (0, entry));
}

#[test]
fn combo_key_override_alt_repeat_out_of_range_rejected_in_range_round_trips() {
    let mut combos = default_entries::<ComboEntry>();
    assert_eq!(store_entry(&mut combos, usize::MAX, ComboEntry::default()), 0xff);
    let combo = ComboEntry { key1: 0x0d, key2: 0x0e, key3: 0, key4: 0, output: 0x29 };
    assert_eq!(store_entry(&mut combos, 2, combo), 0);
    assert_eq!(lookup_entry(&combos, 2), (0, combo));
    assert_eq!(lookup_entry(&combos, 32).0, 0xff);

    let mut key_overrides = default_entries::<KeyOverrideEntry>();
    let key_override = sample_key_override();
    assert_eq!(store_entry(&mut key_overrides, 999, key_override), 0xff);
    assert_eq!(store_entry(&mut key_overrides, 1, key_override), 0);
    assert_eq!(lookup_entry(&key_overrides, 1), (0, key_override));
    assert_eq!(lookup_entry(&key_overrides, 999).0, 0xff);

    let mut alt_repeat_keys = default_entries::<AltRepeatKeyEntry>();
    let alt_repeat_key = sample_alt_repeat_key();
    assert_eq!(store_entry(&mut alt_repeat_keys, 32, alt_repeat_key), 0xff);
    assert_eq!(store_entry(&mut alt_repeat_keys, 4, alt_repeat_key), 0);
    assert_eq!(lookup_entry(&alt_repeat_keys, 4), (0, alt_repeat_key));
    assert_eq!(lookup_entry(&alt_repeat_keys, 32).0, 0xff);
}

// --- wire codecs ---

#[test]
fn tap_dance_entry_round_trips_through_le16_x5() {
    let mut buf = [0u8; 10];
    let entry = TapDanceEntry {
        on_tap: 0x0004,
        on_hold: 0x00e0,
        on_double_tap: 0x1234,
        on_tap_hold: 0xabcd,
        tapping_term: 200,
    };
    entry.write(&mut buf, 0);
    assert_eq!(TapDanceEntry::read(&buf, 0), entry);
}

#[test]
fn combo_entry_round_trips_through_le16_x5() {
    let mut buf = [0u8; 10];
    let entry = ComboEntry { key1: 0x0d, key2: 0x0e, key3: 0, key4: 0, output: 0x29 };
    entry.write(&mut buf, 0);
    assert_eq!(ComboEntry::read(&buf, 0), entry);
}

#[test]
fn key_override_entry_packs_enabled_into_bit_7_of_the_combined_options_byte() {
    let mut buf = [0u8; 10];
    let entry = sample_key_override();
    entry.write(&mut buf, 0);
    assert_eq!(buf[9], 0x87);
    assert_eq!(KeyOverrideEntry::read(&buf, 0), entry);
}

#[test]
fn alt_repeat_key_entry_packs_enabled_into_bit_3_of_the_combined_options_byte() {
    let mut buf = [0u8; 6];
    let entry = sample_alt_repeat_key();
    entry.write(&mut buf, 0);
    assert_eq!(buf[5], 0x0b);
    assert_eq!(AltRepeatKeyEntry::read(&buf, 0), entry);
}
