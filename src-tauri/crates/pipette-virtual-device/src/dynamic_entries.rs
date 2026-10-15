// SPDX-License-Identifier: GPL-2.0-or-later
//! Tap dance / combo / key override / alt-repeat-key stores and their wire
//! codecs.
//!
//! Entry counts follow vial-qmk's quantum/vial.h tiering, which picks
//! 32/16/8/4 entries per kind from TOTAL_EEPROM_BYTE_COUNT. This board
//! emulates EEPROM with wear-leveling on internal flash (STM32L4):
//! builddefs/common_features.mk selects EEPROM_WEAR_LEVELING with
//! WEAR_LEVELING_DRIVER=embedded_flash, and wear_leveling_efl_config.h
//! defaults WEAR_LEVELING_BACKING_SIZE to 8192 (logical size 4096); the
//! keyboard overrides none of it. 4096 > 4000 puts every kind in the
//! 32-entry tier.
//!
//! Alt-repeat-key entries need VIAL_ALT_REPEAT_KEY_ENABLE, which vial.h
//! defines when REPEAT_KEY_ENABLE is set and NO_ALT_REPEAT_KEY is not;
//! builddefs/build_vial.mk defaults REPEAT_KEY_ENABLE to yes and the keyboard
//! does not override it.

use crate::byte_utils::{read_le16, write_le16};

pub const TAP_DANCE_ENTRY_COUNT: usize = 32;
pub const COMBO_ENTRY_COUNT: usize = 32;
pub const KEY_OVERRIDE_ENTRY_COUNT: usize = 32;
pub const ALT_REPEAT_KEY_ENTRY_COUNT: usize = 32;

/// Feature flags byte of dynamic_vial_get_number_of_entries (bit 0 = Caps
/// Word, bit 1 = Layer Lock). Both default to yes in build_vial.mk and the
/// keyboard overrides neither.
pub const DYNAMIC_ENTRY_FEATURE_FLAGS: u8 = 0x03;

/// quantum/action_tapping.h TAPPING_TERM, used by dynamic_keymap_reset().
const TAPPING_TERM_DEFAULT: u16 = 200;

/// Key override options set by dynamic_keymap_reset(): trigger-down +
/// required-mod-down + negative-mod-up activation. The enabled bit stays
/// clear — a reset entry exists but is disabled until configured.
const KEY_OVERRIDE_DEFAULT_OPTIONS: u8 = 0x07;

/// Status byte for a successful get/set.
pub const STATUS_OK: u8 = 0;
/// Status byte for an out-of-range index (nvm_dynamic_keymap.c returns -1).
pub const STATUS_ERROR: u8 = 0xff;

/// `Default` is the all-zero entry, which is what an out-of-range get
/// returns (see [`lookup_entry`]); the factory-reset value is
/// [`TapDanceEntry::reset_value`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TapDanceEntry {
    pub on_tap: u16,
    pub on_hold: u16,
    pub on_double_tap: u16,
    pub on_tap_hold: u16,
    pub tapping_term: u16,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ComboEntry {
    pub key1: u16,
    pub key2: u16,
    pub key3: u16,
    pub key4: u16,
    pub output: u16,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct KeyOverrideEntry {
    pub trigger_key: u16,
    pub replacement_key: u16,
    pub layers: u16,
    pub trigger_mods: u8,
    pub negative_mods: u8,
    pub suppressed_mods: u8,
    pub options: u8,
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AltRepeatKeyEntry {
    pub last_key: u16,
    pub alt_key: u16,
    pub allowed_mods: u8,
    pub options: u8,
    pub enabled: bool,
}

impl TapDanceEntry {
    /// dynamic_keymap_reset(): all KC_NO with the default tapping term.
    pub fn reset_value() -> Self {
        Self { tapping_term: TAPPING_TERM_DEFAULT, ..Self::default() }
    }

    pub fn write(&self, buf: &mut [u8], offset: usize) {
        write_le16(buf, offset, self.on_tap);
        write_le16(buf, offset + 2, self.on_hold);
        write_le16(buf, offset + 4, self.on_double_tap);
        write_le16(buf, offset + 6, self.on_tap_hold);
        write_le16(buf, offset + 8, self.tapping_term);
    }

    pub fn read(buf: &[u8], offset: usize) -> Self {
        Self {
            on_tap: read_le16(buf, offset),
            on_hold: read_le16(buf, offset + 2),
            on_double_tap: read_le16(buf, offset + 4),
            on_tap_hold: read_le16(buf, offset + 6),
            tapping_term: read_le16(buf, offset + 8),
        }
    }
}

impl ComboEntry {
    /// dynamic_keymap_reset(): all zero.
    pub fn reset_value() -> Self {
        Self::default()
    }

    pub fn write(&self, buf: &mut [u8], offset: usize) {
        write_le16(buf, offset, self.key1);
        write_le16(buf, offset + 2, self.key2);
        write_le16(buf, offset + 4, self.key3);
        write_le16(buf, offset + 6, self.key4);
        write_le16(buf, offset + 8, self.output);
    }

    pub fn read(buf: &[u8], offset: usize) -> Self {
        Self {
            key1: read_le16(buf, offset),
            key2: read_le16(buf, offset + 2),
            key3: read_le16(buf, offset + 4),
            key4: read_le16(buf, offset + 6),
            output: read_le16(buf, offset + 8),
        }
    }
}

impl KeyOverrideEntry {
    /// dynamic_keymap_reset(): every layer, activation options set, disabled.
    pub fn reset_value() -> Self {
        Self { layers: 0xffff, options: KEY_OVERRIDE_DEFAULT_OPTIONS, ..Self::default() }
    }

    /// The enabled flag shares a byte with the options (bit 7).
    pub fn write(&self, buf: &mut [u8], offset: usize) {
        write_le16(buf, offset, self.trigger_key);
        write_le16(buf, offset + 2, self.replacement_key);
        write_le16(buf, offset + 4, self.layers);
        buf[offset + 6] = self.trigger_mods;
        buf[offset + 7] = self.negative_mods;
        buf[offset + 8] = self.suppressed_mods;
        buf[offset + 9] = (self.options & 0x7f) | if self.enabled { 0x80 } else { 0 };
    }

    pub fn read(buf: &[u8], offset: usize) -> Self {
        let options_byte = buf[offset + 9];
        Self {
            trigger_key: read_le16(buf, offset),
            replacement_key: read_le16(buf, offset + 2),
            layers: read_le16(buf, offset + 4),
            trigger_mods: buf[offset + 6],
            negative_mods: buf[offset + 7],
            suppressed_mods: buf[offset + 8],
            options: options_byte & 0x7f,
            enabled: options_byte & 0x80 != 0,
        }
    }
}

impl AltRepeatKeyEntry {
    /// dynamic_keymap_reset(): all zero, disabled.
    pub fn reset_value() -> Self {
        Self::default()
    }

    /// The enabled flag shares a byte with the options (bit 3).
    pub fn write(&self, buf: &mut [u8], offset: usize) {
        write_le16(buf, offset, self.last_key);
        write_le16(buf, offset + 2, self.alt_key);
        buf[offset + 4] = self.allowed_mods;
        buf[offset + 5] = (self.options & 0x07) | if self.enabled { 0x08 } else { 0 };
    }

    pub fn read(buf: &[u8], offset: usize) -> Self {
        let options_byte = buf[offset + 5];
        Self {
            last_key: read_le16(buf, offset),
            alt_key: read_le16(buf, offset + 2),
            allowed_mods: buf[offset + 4],
            options: options_byte & 0x07,
            enabled: options_byte & 0x08 != 0,
        }
    }
}

pub fn create_default_tap_dance_entries() -> Vec<TapDanceEntry> {
    vec![TapDanceEntry::reset_value(); TAP_DANCE_ENTRY_COUNT]
}

pub fn create_default_combo_entries() -> Vec<ComboEntry> {
    vec![ComboEntry::reset_value(); COMBO_ENTRY_COUNT]
}

pub fn create_default_key_override_entries() -> Vec<KeyOverrideEntry> {
    vec![KeyOverrideEntry::reset_value(); KEY_OVERRIDE_ENTRY_COUNT]
}

pub fn create_default_alt_repeat_key_entries() -> Vec<AltRepeatKeyEntry> {
    vec![AltRepeatKeyEntry::reset_value(); ALT_REPEAT_KEY_ENTRY_COUNT]
}

/// Bounds-checked get, mirroring nvm_dynamic_keymap.c's `index >= COUNT -> -1`
/// guard. An out-of-range index still yields an entry — the all-zero one —
/// because the firmware's get handlers copy their zero-initialized local
/// struct into the response whatever the status byte says.
pub fn lookup_entry<T: Copy + Default>(entries: &[T], index: usize) -> (u8, T) {
    match entries.get(index) {
        Some(entry) => (STATUS_OK, *entry),
        None => (STATUS_ERROR, T::default()),
    }
}

/// Bounds-checked set: writes only when the index is in range.
pub fn store_entry<T>(entries: &mut [T], index: usize, entry: T) -> u8 {
    match entries.get_mut(index) {
        Some(slot) => {
            *slot = entry;
            STATUS_OK
        }
        None => STATUS_ERROR,
    }
}
