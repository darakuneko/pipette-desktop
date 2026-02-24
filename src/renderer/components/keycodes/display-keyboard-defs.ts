// SPDX-License-Identifier: GPL-2.0-or-later
// KLE layout JSON strings for display keyboards
// Ported from vial-gui display_keyboard_defs.py

export const ANSI_100: unknown[][] = [["KC_ESCAPE",{"x":1},"KC_F1","KC_F2","KC_F3","KC_F4",{"x":0.5},"KC_F5","KC_F6","KC_F7","KC_F8",{"x":0.5},"KC_F9","KC_F10","KC_F11","KC_F12",{"x":0.25},"KC_PSCREEN","KC_SCROLLLOCK","KC_PAUSE"],[{"y":0.25},"KC_GRAVE","KC_1","KC_2","KC_3","KC_4","KC_5","KC_6","KC_7","KC_8","KC_9","KC_0","KC_MINUS","KC_EQUAL",{"w":2},"KC_BSPACE",{"x":0.25},"KC_INSERT","KC_HOME","KC_PGUP",{"x":0.25},"KC_NUMLOCK","KC_KP_SLASH","KC_KP_ASTERISK","KC_KP_MINUS"],[{"w":1.5},"KC_TAB","KC_Q","KC_W","KC_E","KC_R","KC_T","KC_Y","KC_U","KC_I","KC_O","KC_P","KC_LBRACKET","KC_RBRACKET",{"w":1.5},"KC_BSLASH",{"x":0.25},"KC_DELETE","KC_END","KC_PGDOWN",{"x":0.25},"KC_KP_7","KC_KP_8","KC_KP_9","KC_KP_PLUS"],[{"w":1.75},"KC_CAPSLOCK","KC_A","KC_S","KC_D","KC_F","KC_G","KC_H","KC_J","KC_K","KC_L","KC_SCOLON","KC_QUOTE",{"w":2.25},"KC_ENTER",{"x":3.5},"KC_KP_4","KC_KP_5","KC_KP_6","KC_KP_COMMA"],[{"w":2.25},"KC_LSHIFT","KC_Z","KC_X","KC_C","KC_V","KC_B","KC_N","KC_M","KC_COMMA","KC_DOT","KC_SLASH",{"w":2.75},"KC_RSHIFT",{"x":1.25},"KC_UP",{"x":1.25},"KC_KP_1","KC_KP_2","KC_KP_3","KC_KP_EQUAL"],[{"w":1.25},"KC_LCTRL",{"w":1.25},"KC_LGUI",{"w":1.25},"KC_LALT",{"w":6.25},"KC_SPACE",{"w":1.25},"KC_RALT",{"w":1.25},"KC_RGUI",{"w":1.25},"KC_APPLICATION",{"w":1.25},"KC_RCTRL",{"x":0.25},"KC_LEFT","KC_DOWN","KC_RIGHT",{"x":0.25,"w":2},"KC_KP_0","KC_KP_DOT","KC_KP_ENTER"]]

export const ANSI_80: unknown[][] = [["KC_ESCAPE",{"x":1},"KC_F1","KC_F2","KC_F3","KC_F4",{"x":0.5},"KC_F5","KC_F6","KC_F7","KC_F8",{"x":0.5},"KC_F9","KC_F10","KC_F11","KC_F12",{"x":0.25},"KC_PSCREEN","KC_SCROLLLOCK","KC_PAUSE"],[{"y":0.25},"KC_GRAVE","KC_1","KC_2","KC_3","KC_4","KC_5","KC_6","KC_7","KC_8","KC_9","KC_0","KC_MINUS","KC_EQUAL",{"w":2},"KC_BSPACE",{"x":0.25},"KC_INSERT","KC_HOME","KC_PGUP"],[{"w":1.5},"KC_TAB","KC_Q","KC_W","KC_E","KC_R","KC_T","KC_Y","KC_U","KC_I","KC_O","KC_P","KC_LBRACKET","KC_RBRACKET",{"w":1.5},"KC_BSLASH",{"x":0.25},"KC_DELETE","KC_END","KC_PGDOWN"],[{"w":1.75},"KC_CAPSLOCK","KC_A","KC_S","KC_D","KC_F","KC_G","KC_H","KC_J","KC_K","KC_L","KC_SCOLON","KC_QUOTE",{"w":2.25},"KC_ENTER"],[{"w":2.25},"KC_LSHIFT","KC_Z","KC_X","KC_C","KC_V","KC_B","KC_N","KC_M","KC_COMMA","KC_DOT","KC_SLASH",{"w":2.75},"KC_RSHIFT",{"x":1.25},"KC_UP"],[{"w":1.25},"KC_LCTRL",{"w":1.25},"KC_LGUI",{"w":1.25},"KC_LALT",{"w":6.25},"KC_SPACE",{"w":1.25},"KC_RALT",{"w":1.25},"KC_RGUI",{"w":1.25},"KC_APPLICATION",{"w":1.25},"KC_RCTRL",{"x":0.25},"KC_LEFT","KC_DOWN","KC_RIGHT"]]

export const ANSI_70: unknown[][] = [["KC_ESCAPE",{"x":1},"KC_F1","KC_F2","KC_F3","KC_F4",{"x":0.5},"KC_F5","KC_F6","KC_F7","KC_F8",{"x":0.5},"KC_F9","KC_F10","KC_F11","KC_F12"],[{"y":0.25},"KC_GRAVE","KC_1","KC_2","KC_3","KC_4","KC_5","KC_6","KC_7","KC_8","KC_9","KC_0","KC_MINUS","KC_EQUAL",{"w":2},"KC_BSPACE"],[{"w":1.5},"KC_TAB","KC_Q","KC_W","KC_E","KC_R","KC_T","KC_Y","KC_U","KC_I","KC_O","KC_P","KC_LBRACKET","KC_RBRACKET",{"w":1.5},"KC_BSLASH"],[{"w":1.75},"KC_CAPSLOCK","KC_A","KC_S","KC_D","KC_F","KC_G","KC_H","KC_J","KC_K","KC_L","KC_SCOLON","KC_QUOTE",{"w":2.25},"KC_ENTER"],[{"w":2.25},"KC_LSHIFT","KC_Z","KC_X","KC_C","KC_V","KC_B","KC_N","KC_M","KC_COMMA","KC_DOT","KC_SLASH",{"w":2.75},"KC_RSHIFT"],[{"w":1.25},"KC_LCTRL",{"w":1.25},"KC_LGUI",{"w":1.25},"KC_LALT",{"w":6.25},"KC_SPACE",{"w":1.25},"KC_RALT",{"w":1.25},"KC_RGUI",{"w":1.25},"KC_APPLICATION",{"w":1.25},"KC_RCTRL"]]

export interface DisplayLayoutDef {
  id: string
  kle: unknown[][]
  /** Minimum container width in pixels needed to display this layout */
  minWidth: number
}

/** Layouts ordered from largest to smallest for responsive selection */
export const DISPLAY_LAYOUTS: DisplayLayoutDef[] = [
  { id: 'ansi_100', kle: ANSI_100, minWidth: 990 },
  { id: 'ansi_80', kle: ANSI_80, minWidth: 770 },
  { id: 'ansi_70', kle: ANSI_70, minWidth: 660 },
]
