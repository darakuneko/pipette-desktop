// SPDX-License-Identifier: GPL-2.0-or-later

use pipette_virtual_device::dataset::{COLS, LAYERS, MACRO_BUFFER_SIZE, ROWS};
use pipette_virtual_device::dynamic_entries::TapDanceEntry;
use pipette_virtual_device::state::{VirtualDeviceState, keymap_index};

fn matrix_is_empty(state: &VirtualDeviceState) -> bool {
    state.matrix.iter().all(|row| row.iter().all(|v| !v))
}

/// A state with an unlock sequence in progress and the combo held.
fn unlocking(counter_max: i32, counter: i32) -> VirtualDeviceState {
    let mut state = VirtualDeviceState::new();
    state.unlock_counter_max = counter_max;
    state.unlock_counter = counter;
    state.unlock_in_progress = true;
    state.unlock_timer = 0;
    state.press_key(0, 0);
    state.press_key(0, 1);
    state
}

// --- VirtualDeviceState::new ---

#[test]
fn starts_locked_with_a_full_unlock_counter() {
    let state = VirtualDeviceState::new();
    assert!(!state.unlocked);
    assert!(!state.unlock_in_progress);
    assert_eq!(state.unlock_counter, state.unlock_counter_max);
}

#[test]
fn has_a_keymap_of_the_expected_size_and_an_empty_matrix() {
    let state = VirtualDeviceState::new();
    assert_eq!(state.keymap.len(), LAYERS * ROWS * COLS);
    assert_eq!(state.macro_buffer.len(), MACRO_BUFFER_SIZE);
    assert_eq!(state.matrix.len(), ROWS);
    assert_eq!(state.matrix[0].len(), COLS);
    assert!(matrix_is_empty(&state));
}

#[test]
fn seeds_a_sample_entry_at_index_0_of_every_dynamic_entry_store() {
    let state = VirtualDeviceState::new();
    assert_eq!(state.tap_dance_entries.len(), 32);
    assert_ne!(state.tap_dance_entries[0].on_tap, 0);
    assert_eq!(
        state.tap_dance_entries[1],
        TapDanceEntry { on_tap: 0, on_hold: 0, on_double_tap: 0, on_tap_hold: 0, tapping_term: 200 }
    );

    assert_eq!(state.combo_entries.len(), 32);
    assert_ne!(state.combo_entries[0].key1, 0);
    assert_ne!(state.combo_entries[0].output, 0);

    assert_eq!(state.key_override_entries.len(), 32);
    assert!(state.key_override_entries[0].enabled);
    assert_ne!(state.key_override_entries[0].trigger_key, 0);

    assert_eq!(state.alt_repeat_key_entries.len(), 32);
    assert!(state.alt_repeat_key_entries[0].enabled);
    assert_ne!(state.alt_repeat_key_entries[0].last_key, 0);
}

#[test]
fn starts_with_default_qmk_settings() {
    let state = VirtualDeviceState::new();
    assert_eq!(state.qmk_settings.tapping_term, 200);
    assert_eq!(state.qmk_settings.combo_term, 50);
}

// --- press_key / release_key / release_all ---

#[test]
fn tracks_individual_key_state() {
    let mut state = VirtualDeviceState::new();
    state.press_key(2, 3);
    assert!(state.matrix[2][3]);
    state.release_key(2, 3);
    assert!(!state.matrix[2][3]);
}

#[test]
fn ignores_out_of_range_positions() {
    let mut state = VirtualDeviceState::new();
    state.press_key(99, 99);
    state.release_key(-1, -1);
    assert!(matrix_is_empty(&state));
}

#[test]
fn release_all_clears_every_pressed_key() {
    let mut state = VirtualDeviceState::new();
    state.press_key(0, 0);
    state.press_key(4, 11);
    state.release_all();
    assert!(matrix_is_empty(&state));
}

// --- is_holding_unlock_combo ---

#[test]
fn is_true_only_when_both_combo_keys_are_held() {
    let mut state = VirtualDeviceState::new();
    assert!(!state.is_holding_unlock_combo());
    state.press_key(0, 0);
    assert!(!state.is_holding_unlock_combo());
    state.press_key(0, 1);
    assert!(state.is_holding_unlock_combo());
    state.release_key(0, 0);
    assert!(!state.is_holding_unlock_combo());
}

// --- unlock_poll_tick ---

#[test]
fn does_nothing_when_no_unlock_sequence_is_in_progress() {
    let mut state = VirtualDeviceState::new();
    state.press_key(0, 0);
    state.press_key(0, 1);
    state.unlock_poll_tick(1000);
    assert_eq!(state.unlock_counter, state.unlock_counter_max);
    assert!(!state.unlocked);
}

#[test]
fn decrements_the_counter_on_200ms_spaced_polls_while_the_combo_is_held() {
    let mut state = unlocking(3, 3);

    state.unlock_poll_tick(200);
    assert_eq!(state.unlock_counter, 2);
    assert!(!state.unlocked);

    state.unlock_poll_tick(400);
    assert_eq!(state.unlock_counter, 1);
    assert!(!state.unlocked);

    state.unlock_poll_tick(600);
    assert_eq!(state.unlock_counter, 0);
    assert!(state.unlocked);
    assert!(!state.unlock_in_progress);
}

#[test]
fn resets_the_counter_to_max_when_a_held_poll_arrives_less_than_100ms_after_the_last_decrement() {
    // Already decremented from a prior qualifying tick.
    let mut state = unlocking(5, 3);
    // Still holding, but only 50 ms since the last decrementing tick: a
    // non-qualifying poll throws away all progress.
    state.unlock_poll_tick(50);
    assert_eq!(state.unlock_counter, 5);
    assert!(!state.unlocked);
}

#[test]
fn resets_the_counter_to_max_when_a_combo_key_is_released_mid_sequence() {
    let mut state = unlocking(5, 2);
    state.release_key(0, 1);
    state.unlock_poll_tick(200);
    assert_eq!(state.unlock_counter, 5);
    assert!(!state.unlocked);
}

#[test]
fn does_not_carry_progress_from_before_a_release_once_the_combo_is_re_pressed() {
    let mut state = unlocking(5, 5);

    // Held long enough: one qualifying decrement.
    state.unlock_poll_tick(200);
    assert_eq!(state.unlock_counter, 4);

    // Release resets the counter (unlock_timer stays at 200).
    state.release_key(0, 1);
    state.unlock_poll_tick(210);
    assert_eq!(state.unlock_counter, 5);

    // Re-press and poll < 100 ms after the stale timer: no further progress.
    state.press_key(0, 1);
    state.unlock_poll_tick(260);
    assert!(state.unlock_counter >= 4);
    assert!(!state.unlocked);
}

#[test]
fn setting_unlocked_false_relocks_regardless_of_counter() {
    let mut state = VirtualDeviceState::new();
    state.unlocked = true;
    state.unlocked = false;
    assert!(!state.unlocked);
}

// --- pack_matrix_state ---

#[test]
fn packs_pressed_keys_into_be16_per_row_byte_pairs() {
    let mut state = VirtualDeviceState::new();
    state.press_key(0, 0);
    let bytes = state.pack_matrix_state();
    assert_eq!(bytes[0], 0x00);
    assert_eq!(bytes[1], 0x01);
}

#[test]
fn packs_col_13_into_the_high_byte_bit_5() {
    let mut state = VirtualDeviceState::new();
    state.press_key(0, 13);
    let bytes = state.pack_matrix_state();
    assert_eq!(bytes[0], 1 << (13 - 8));
    assert_eq!(bytes[1], 0x00);
}

#[test]
fn packs_col_11_row_4_into_the_high_byte_bit_3() {
    let mut state = VirtualDeviceState::new();
    state.press_key(4, 11);
    let bytes = state.pack_matrix_state();
    assert_eq!(bytes[4 * 2], 1 << (11 - 8));
    assert_eq!(bytes[4 * 2 + 1], 0x00);
}

// --- keymap_index ---

#[test]
fn computes_layer_major_row_major_col_order_flat_index() {
    assert_eq!(keymap_index(0, 0, 0), 0);
    assert_eq!(keymap_index(0, 0, 1), 1);
    assert_eq!(keymap_index(1, 0, 0), ROWS * COLS);
}
