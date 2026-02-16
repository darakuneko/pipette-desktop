// SPDX-License-Identifier: GPL-2.0-or-later

// Key dimensions (ported from Python constants.py)
export const KEY_SIZE = 54 // pixels per unit (1u)
export const KEY_SPACING_RATIO = 0.2
export const KEY_ROUNDNESS = 0.08
// Effective key spacing
export const KEY_UNIT = KEY_SIZE // 54px per 1u
export const KEY_SPACING = KEY_UNIT * KEY_SPACING_RATIO

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
