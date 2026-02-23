// SPDX-License-Identifier: GPL-2.0-or-later

// Key dimensions (ported from Python constants.py)
// In Python: size = scale * (KEY_SIZE_RATIO + KEY_SPACING_RATIO) = scale * 3.4
//            spacing = scale * KEY_SPACING_RATIO = scale * 0.2
// KEY_UNIT corresponds to Python's `size` (the full grid cell for 1u).
// KEY_SPACING corresponds to Python's `spacing` = KEY_UNIT / 3.4 * 0.2.
export const KEY_SIZE_RATIO = 3.2
export const KEY_SPACING_RATIO = 0.2
export const KEY_ROUNDNESS = 0.08
export const KEY_UNIT = 54 // pixels per 1u grid cell
export const KEY_SPACING =
  KEY_UNIT * KEY_SPACING_RATIO / (KEY_SIZE_RATIO + KEY_SPACING_RATIO)

// Visual face inset: Python's 3D shadow (SHADOW_SIDE_PADDING=0.1) creates a
// gap between the visible key face and the grid cell edge.  We apply the same
// inset uniformly to match Vial-GUI's visual key density.
// Pixels = SHADOW_SIDE_PADDING * scale = 0.1 * (KEY_UNIT / 3.4)
const SHADOW_SIDE_PADDING = 0.1
export const KEY_FACE_INSET =
  KEY_UNIT * SHADOW_SIDE_PADDING / (KEY_SIZE_RATIO + KEY_SPACING_RATIO)

// Widget padding
export const KEYBOARD_PADDING = 5

// Colors — use CSS custom properties for theme-aware rendering
export const KEY_BG_COLOR = 'var(--key-bg)'
export const KEY_BORDER_COLOR = 'var(--key-border)'
export const KEY_SELECTED_COLOR = 'var(--key-bg-active)'
export const KEY_MULTI_SELECTED_COLOR = 'var(--key-bg-multi-selected)'
export const KEY_PRESSED_COLOR = 'var(--success)'
export const KEY_EVER_PRESSED_COLOR = '#ccffcc'
export const KEY_HIGHLIGHT_COLOR = 'var(--accent-alt)'
export const KEY_TEXT_COLOR = 'var(--key-label)'
export const KEY_REMAP_COLOR = 'var(--key-label-remap)'
export const KEY_MASK_RECT_COLOR = 'var(--key-mask-bg)'
