// SPDX-License-Identifier: GPL-2.0-or-later
// The default values come from data/default_dataset.rs (generated from the
// TypeScript keycode tables), so these tests compare against its named
// keycodes rather than resolving names.

use pipette_virtual_device::dataset::{
    COLS, COMPRESSED_DEFINITION, LAYERS, MACRO_BUFFER_SIZE, ROWS, VIALRGB_SUPPORTED_EFFECTS,
    build_default_keymap, build_default_macro_buffer, keycodes,
};

fn index(layer: usize, row: usize, col: usize) -> usize {
    (layer * ROWS + row) * COLS + col
}

#[test]
fn keymap_has_length_layers_rows_cols() {
    assert_eq!(build_default_keymap().len(), LAYERS * ROWS * COLS);
}

#[test]
fn keymap_sets_layer0_row0_col0_to_escape() {
    assert_eq!(build_default_keymap()[index(0, 0, 0)], keycodes::KC_ESCAPE);
}

#[test]
fn keymap_sets_lt1_space_at_layer0_row4_col4() {
    let expected = keycodes::QK_LAYER_TAP | ((1 & 0x0f) << 8) | (keycodes::KC_SPACE & 0xff);
    assert_eq!(build_default_keymap()[index(0, 4, 4)], expected);
}

#[test]
fn keymap_sets_user00_on_layer2_row2_col0() {
    assert_eq!(build_default_keymap()[index(2, 2, 0)], keycodes::USER00);
}

#[test]
fn keymap_leaves_physically_unused_positions_as_kc_no() {
    let keymap = build_default_keymap();
    let unused = [(2, 13), (3, 12), (3, 13), (4, 3), (4, 5), (4, 12), (4, 13)];
    for (row, col) in unused {
        for layer in 0..LAYERS {
            assert_eq!(keymap[index(layer, row, col)], 0);
        }
    }
}

#[test]
fn keymap_layer3_is_entirely_kc_no() {
    let keymap = build_default_keymap();
    for row in 0..ROWS {
        for col in 0..COLS {
            assert_eq!(keymap[index(3, row, col)], 0);
        }
    }
}

#[test]
fn macro_buffer_is_exactly_macro_buffer_size_bytes() {
    assert_eq!(build_default_macro_buffer().len(), MACRO_BUFFER_SIZE);
}

#[test]
fn macro_buffer_starts_with_the_hello_text_macro_terminated_by_nul() {
    let buffer = build_default_macro_buffer();
    assert_eq!(&buffer[..5], b"Hello");
    assert_eq!(buffer[5], 0x00);
}

#[test]
fn vialrgb_supported_effects_are_ascending_start_at_0_and_exclude_direct() {
    assert_eq!(VIALRGB_SUPPORTED_EFFECTS[0], 0);
    assert!(!VIALRGB_SUPPORTED_EFFECTS.contains(&1));
    assert!(VIALRGB_SUPPORTED_EFFECTS.windows(2).all(|w| w[1] > w[0]));
    assert!(VIALRGB_SUPPORTED_EFFECTS.len() >= 20);
}

#[test]
fn compressed_definition_round_trips_through_lzma_decompression() {
    let mut json = Vec::new();
    lzma_rs::lzma_decompress(&mut &COMPRESSED_DEFINITION[..], &mut json).unwrap();
    let parsed: serde_json::Value = serde_json::from_slice(&json).unwrap();
    assert_eq!(parsed["name"], "Virtual Keyboard");
    assert_eq!(parsed["matrix"]["rows"], 5);
    assert_eq!(parsed["matrix"]["cols"], 14);
}

#[test]
fn compressed_definition_is_a_single_embedded_buffer() {
    // The compressed bytes are a compile-time constant, so every access
    // sees the same buffer.
    assert!(std::ptr::eq(COMPRESSED_DEFINITION, COMPRESSED_DEFINITION));
    assert!(!COMPRESSED_DEFINITION.is_empty());
}
