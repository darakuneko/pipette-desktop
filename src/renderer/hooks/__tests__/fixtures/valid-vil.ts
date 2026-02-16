// SPDX-License-Identifier: GPL-2.0-or-later
// Test fixture: valid TS-format VilFile based on numnum bento max keyboard

import type { VilFile } from '../../../../shared/types/protocol'

/** Minimal valid VilFile for testing */
export const VALID_VIL: VilFile = {
  uid: '0xFBF3B07838D7076A',
  keymap: {
    '0,0,0': 0x4f, // KC_RIGHT
    '0,0,1': 0x52, // KC_UP
    '0,0,2': 0x50, // KC_LEFT
    '0,0,3': 0x51, // KC_DOWN
    '0,1,5': 0x1e, // KC_1
    '0,1,6': 0x1f, // KC_2
    '0,1,7': 0x20, // KC_3
    '0,1,8': 0x21, // KC_4
    '0,1,9': 0x22, // KC_5
  },
  encoderLayout: {
    '0,0,0': 0x81, // KC_VOLD
    '0,0,1': 0x80, // KC_VOLU
  },
  macros: [0],
  layoutOptions: 0,
  tapDance: [
    { onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 150 },
  ],
  combo: [{ key1: 0, key2: 0, key3: 0, key4: 0, output: 0 }],
  keyOverride: [
    {
      triggerKey: 0,
      replacementKey: 0,
      layers: 0xffff,
      triggerMods: 0,
      negativeMods: 0,
      suppressedMods: 0,
      options: 7,
      enabled: true,
    },
  ],
  altRepeatKey: [{ lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: true }],
  qmkSettings: { '1': [0], '2': [50] },
}

/** Same VilFile as JSON string (for IPC mock responses) */
export const VALID_VIL_JSON = JSON.stringify(VALID_VIL)

/** VilFile JSON with a different UID (for mismatch tests) */
export const MISMATCHED_UID_VIL_JSON = JSON.stringify({
  ...VALID_VIL,
  uid: '0xDEADBEEF12345678',
})

/** Modified VilFile with changed keycodes (for save/load roundtrip) */
export const MODIFIED_VIL: VilFile = {
  ...VALID_VIL,
  keymap: {
    ...VALID_VIL.keymap,
    '0,0,0': 0x04, // Changed from KC_RIGHT to KC_A
    '0,0,1': 0x05, // Changed from KC_UP to KC_B
  },
}
