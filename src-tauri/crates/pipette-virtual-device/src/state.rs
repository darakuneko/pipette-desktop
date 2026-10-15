// SPDX-License-Identifier: GPL-2.0-or-later
//! Device state: stores, switch matrix and the unlock state machine.
//!
//! The unlock sequence mirrors vial-qmk's vial.c vial_unlock_poll(): the
//! keyboard unlocks only after the combo has been held continuously for
//! `unlock_counter_max` poll ticks spaced at least 100 ms apart.

use crate::dataset::{
    COLS, KEYMAP_LEN, LAYERS, MACRO_BUFFER_SIZE, ROWS, SAMPLE_ALT_REPEAT_KEY, SAMPLE_COMBO,
    SAMPLE_KEY_OVERRIDE, SAMPLE_TAP_DANCE, VIALRGB_SUPPORTED_EFFECTS, VIRTUAL_DEVICE_UNLOCK_COMBO,
    build_default_keymap, build_default_macro_buffer,
};
use crate::dynamic_entries::{
    AltRepeatKeyEntry, ComboEntry, KeyOverrideEntry, TapDanceEntry, create_default_alt_repeat_key_entries,
    create_default_combo_entries, create_default_key_override_entries, create_default_tap_dance_entries,
};
use crate::qmk_settings::QmkSettingsStore;

pub const UNLOCK_COUNTER_MAX_DEFAULT: i32 = 50;
const UNLOCK_POLL_MIN_INTERVAL_MS: u64 = 100;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VialRgbState {
    pub mode: u16,
    pub speed: u8,
    pub hue: u8,
    pub sat: u8,
    pub val: u8,
}

#[derive(Clone, Debug)]
pub struct VirtualDeviceState {
    pub keymap: [u16; KEYMAP_LEN],
    pub macro_buffer: [u8; MACRO_BUFFER_SIZE],
    pub layout_options: u32,
    /// `matrix[row][col]` — true while the switch is held down.
    pub matrix: [[bool; COLS]; ROWS],
    pub unlocked: bool,
    pub unlock_in_progress: bool,
    /// Signed: a controller may set any maximum, and the firmware logic
    /// compares with `<= 0`.
    pub unlock_counter: i32,
    pub unlock_counter_max: i32,
    /// Time (ms) of the last unlock poll tick that made progress.
    pub unlock_timer: u64,
    pub rgb: VialRgbState,
    pub tap_dance_entries: Vec<TapDanceEntry>,
    pub combo_entries: Vec<ComboEntry>,
    pub key_override_entries: Vec<KeyOverrideEntry>,
    pub alt_repeat_key_entries: Vec<AltRepeatKeyEntry>,
    pub qmk_settings: QmkSettingsStore,
}

impl Default for VirtualDeviceState {
    fn default() -> Self {
        Self::new()
    }
}

impl VirtualDeviceState {
    /// Factory state. Index 0 of every dynamic-entry store holds a sample
    /// entry (and the macro buffer holds sample macros) so a fresh device —
    /// and the doc screenshots — show configured tiles. A real factory reset
    /// leaves them all empty.
    pub fn new() -> Self {
        let mut tap_dance_entries = create_default_tap_dance_entries();
        let mut combo_entries = create_default_combo_entries();
        let mut key_override_entries = create_default_key_override_entries();
        let mut alt_repeat_key_entries = create_default_alt_repeat_key_entries();
        tap_dance_entries[0] = SAMPLE_TAP_DANCE;
        combo_entries[0] = SAMPLE_COMBO;
        key_override_entries[0] = SAMPLE_KEY_OVERRIDE;
        alt_repeat_key_entries[0] = SAMPLE_ALT_REPEAT_KEY;

        Self {
            keymap: build_default_keymap(),
            macro_buffer: build_default_macro_buffer(),
            layout_options: 0,
            matrix: [[false; COLS]; ROWS],
            unlocked: false,
            unlock_in_progress: false,
            unlock_counter: UNLOCK_COUNTER_MAX_DEFAULT,
            unlock_counter_max: UNLOCK_COUNTER_MAX_DEFAULT,
            unlock_timer: 0,
            rgb: VialRgbState {
                mode: VIALRGB_SUPPORTED_EFFECTS[1],
                speed: 128,
                hue: 128,
                sat: 255,
                val: 128,
            },
            tap_dance_entries,
            combo_entries,
            key_override_entries,
            alt_repeat_key_entries,
            qmk_settings: QmkSettingsStore::default(),
        }
    }

    fn matrix_slot(&mut self, row: i32, col: i32) -> Option<&mut bool> {
        let row = usize::try_from(row).ok()?;
        let col = usize::try_from(col).ok()?;
        self.matrix.get_mut(row)?.get_mut(col)
    }

    /// Out-of-range positions are ignored.
    pub fn press_key(&mut self, row: i32, col: i32) {
        if let Some(slot) = self.matrix_slot(row, col) {
            *slot = true;
        }
    }

    /// Out-of-range positions are ignored.
    pub fn release_key(&mut self, row: i32, col: i32) {
        if let Some(slot) = self.matrix_slot(row, col) {
            *slot = false;
        }
    }

    pub fn release_all(&mut self) {
        self.matrix = [[false; COLS]; ROWS];
    }

    /// True only while every key of the unlock combo is held.
    pub fn is_holding_unlock_combo(&self) -> bool {
        VIRTUAL_DEVICE_UNLOCK_COMBO.iter().all(|&(row, col)| {
            self.matrix.get(usize::from(row)).and_then(|r| r.get(usize::from(col))).copied().unwrap_or(false)
        })
    }

    /// Advance the unlock state machine by one poll tick at time `now` (ms).
    ///
    /// vial_unlock_poll() is a single if/else: the counter decrements only
    /// when the combo is held AND at least 100 ms have passed since the last
    /// decrementing tick; every other poll — combo not held, or polled too
    /// soon — resets the counter to its maximum. That enforces a continuous
    /// hold: a poll that does not land on a held-and-elapsed tick throws away
    /// all progress. Reaching 0 unlocks the keyboard.
    pub fn unlock_poll_tick(&mut self, now: u64) {
        if !self.unlock_in_progress {
            return;
        }
        let elapsed = now.checked_sub(self.unlock_timer).is_some_and(|d| d >= UNLOCK_POLL_MIN_INTERVAL_MS);
        if self.is_holding_unlock_combo() && elapsed {
            self.unlock_timer = now;
            self.unlock_counter -= 1;
            if self.unlock_counter <= 0 {
                self.unlock_counter = 0;
                self.unlocked = true;
                self.unlock_in_progress = false;
            }
        } else {
            self.unlock_counter = self.unlock_counter_max;
        }
    }

    /// The VIA switch-matrix-state layout: 2 bytes per row, big-endian.
    pub fn pack_matrix_state(&self) -> [u8; ROWS * 2] {
        let mut bytes = [0u8; ROWS * 2];
        for (row, cols) in self.matrix.iter().enumerate() {
            let bits = cols
                .iter()
                .enumerate()
                .filter(|(_, pressed)| **pressed)
                .fold(0u16, |acc, (col, _)| acc | (1 << col));
            bytes[row * 2..row * 2 + 2].copy_from_slice(&bits.to_be_bytes());
        }
        bytes
    }
}

pub fn keymap_index(layer: usize, row: usize, col: usize) -> usize {
    (layer * ROWS + row) * COLS + col
}

/// Unused or out-of-range keymap positions read as KC_NO (0).
pub fn is_valid_keymap_position(layer: usize, row: usize, col: usize) -> bool {
    layer < LAYERS && row < ROWS && col < COLS
}
