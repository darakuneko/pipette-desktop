// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  splitMacroBuffer,
  deserializeMacro,
  deserializeAllMacros,
  serializeMacro,
  serializeAllMacros,
  macroActionsToJson,
  jsonToMacroActions,
  isValidMacroText,
  type MacroAction,
} from '../macro'
import {
  SS_QMK_PREFIX,
  SS_TAP_CODE,
  SS_DOWN_CODE,
  SS_UP_CODE,
  SS_DELAY_CODE,
  VIAL_MACRO_EXT_TAP,
  VIAL_MACRO_EXT_DOWN,
  VIAL_MACRO_EXT_UP,
  VIAL_PROTOCOL_ADVANCED_MACROS,
} from '../../shared/constants/protocol'

// Convenience: v1 protocol version (below VIAL_PROTOCOL_ADVANCED_MACROS)
const V1 = VIAL_PROTOCOL_ADVANCED_MACROS - 1
// Convenience: v2 protocol version (at or above VIAL_PROTOCOL_ADVANCED_MACROS)
const V2 = VIAL_PROTOCOL_ADVANCED_MACROS

describe('macro', () => {
  // ----------------------------------------------------------------
  // isValidMacroText
  // ----------------------------------------------------------------
  describe('isValidMacroText', () => {
    it('returns true for printable ASCII string', () => {
      expect(isValidMacroText('Hello World!')).toBe(true)
    })

    it('returns true for empty string', () => {
      expect(isValidMacroText('')).toBe(true)
    })

    it('returns true for all printable ASCII characters', () => {
      // Space (0x20) through tilde (0x7E)
      let all = ''
      for (let i = 0x20; i <= 0x7e; i++) {
        all += String.fromCharCode(i)
      }
      expect(isValidMacroText(all)).toBe(true)
    })

    it('returns false for Japanese characters', () => {
      expect(isValidMacroText('こんにちは')).toBe(false)
    })

    it('returns false for mixed ASCII and non-ASCII', () => {
      expect(isValidMacroText('Hello こんにちは')).toBe(false)
    })

    it('returns false for control characters', () => {
      expect(isValidMacroText('\t')).toBe(false)
      expect(isValidMacroText('\n')).toBe(false)
      expect(isValidMacroText('\x00')).toBe(false)
    })

    it('returns false for DEL character (0x7F)', () => {
      expect(isValidMacroText('\x7f')).toBe(false)
    })

    it('returns false for emoji', () => {
      expect(isValidMacroText('Hello 🎹')).toBe(false)
    })
  })

  // ----------------------------------------------------------------
  // splitMacroBuffer
  // ----------------------------------------------------------------
  describe('splitMacroBuffer', () => {
    it('splits NUL-delimited buffer into individual macro byte arrays', () => {
      // Two macros: [0x41, 0x42] and [0x43, 0x44]
      const buffer = [0x41, 0x42, 0x00, 0x43, 0x44, 0x00]
      const result = splitMacroBuffer(buffer, 2)
      expect(result).toEqual([[0x41, 0x42], [0x43, 0x44]])
    })

    it('respects macroCount limit and stops after N macros', () => {
      const buffer = [0x41, 0x00, 0x42, 0x00, 0x43, 0x00]
      const result = splitMacroBuffer(buffer, 2)
      expect(result).toEqual([[0x41], [0x42]])
      // Third macro is ignored
      expect(result).toHaveLength(2)
    })

    it('ignores trailing padding bytes after macroCount macros', () => {
      const buffer = [0x41, 0x00, 0x42, 0x00, 0xff, 0xff, 0xff]
      const result = splitMacroBuffer(buffer, 2)
      expect(result).toEqual([[0x41], [0x42]])
    })

    it('returns empty array for empty buffer', () => {
      expect(splitMacroBuffer([], 3)).toEqual([])
    })

    it('handles buffer with content but no NUL terminators', () => {
      // No NUL bytes means the entire buffer is one incomplete macro
      const buffer = [0x41, 0x42, 0x43]
      const result = splitMacroBuffer(buffer, 3)
      // The content is pushed as a single macro since no NUL was found
      expect(result).toEqual([[0x41, 0x42, 0x43]])
    })

    it('handles empty macros between NUL terminators', () => {
      // Two NULs in a row yield an empty macro in the middle
      const buffer = [0x41, 0x00, 0x00, 0x42, 0x00]
      const result = splitMacroBuffer(buffer, 3)
      expect(result).toEqual([[0x41], [], [0x42]])
    })

    it('includes trailing empty macros when macroCount not reached', () => {
      // Buffer ends with NUL, creating an empty macro before macroCount is reached
      const buffer = [0x41, 0x00, 0x00]
      const result = splitMacroBuffer(buffer, 3)
      // First NUL terminates [0x41], second NUL terminates [] → 2 macros found, stops at macroCount
      expect(result).toEqual([[0x41], []])
    })
  })

  // ----------------------------------------------------------------
  // deserializeMacro — v1 (vialProtocol < VIAL_PROTOCOL_ADVANCED_MACROS)
  // ----------------------------------------------------------------
  describe('deserializeMacro (v1)', () => {
    it('deserializes text-only macro from character codes', () => {
      // "Hi" = [0x48, 0x69]
      const data = [0x48, 0x69]
      const actions = deserializeMacro(data, V1)
      expect(actions).toEqual([{ type: 'text', text: 'Hi' }])
    })

    it('deserializes tap action with single keycode', () => {
      // SS_TAP_CODE, keycode 0x04
      const data = [SS_TAP_CODE, 0x04]
      const actions = deserializeMacro(data, V1)
      expect(actions).toEqual([{ type: 'tap', keycodes: [0x04] }])
    })

    it('deserializes down action', () => {
      const data = [SS_DOWN_CODE, 0x10]
      const actions = deserializeMacro(data, V1)
      expect(actions).toEqual([{ type: 'down', keycodes: [0x10] }])
    })

    it('deserializes up action', () => {
      const data = [SS_UP_CODE, 0x20]
      const actions = deserializeMacro(data, V1)
      expect(actions).toEqual([{ type: 'up', keycodes: [0x20] }])
    })

    it('deserializes mixed text and tap actions', () => {
      // "A" then tap(0x04) then "B"
      const data = [0x41, SS_TAP_CODE, 0x04, 0x42]
      const actions = deserializeMacro(data, V1)
      expect(actions).toEqual([
        { type: 'text', text: 'A' },
        { type: 'tap', keycodes: [0x04] },
        { type: 'text', text: 'B' },
      ])
    })

    it('merges consecutive same-type keycode actions into one action', () => {
      // Two consecutive taps: SS_TAP_CODE, kc1, SS_TAP_CODE, kc2
      const data = [SS_TAP_CODE, 0x04, SS_TAP_CODE, 0x05]
      const actions = deserializeMacro(data, V1)
      expect(actions).toEqual([{ type: 'tap', keycodes: [0x04, 0x05] }])
    })

    it('does not merge different action types', () => {
      // tap then down
      const data = [SS_TAP_CODE, 0x04, SS_DOWN_CODE, 0x05]
      const actions = deserializeMacro(data, V1)
      expect(actions).toEqual([
        { type: 'tap', keycodes: [0x04] },
        { type: 'down', keycodes: [0x05] },
      ])
    })

    it('returns empty actions for empty data', () => {
      expect(deserializeMacro([], V1)).toEqual([])
    })

    it('handles truncated action code (tap code without keycode)', () => {
      // SS_TAP_CODE at end of data with no following keycode
      const data = [SS_TAP_CODE]
      const actions = deserializeMacro(data, V1)
      // v1 loops: sees SS_TAP_CODE, increments i past it, i >= data.length so no keycode pushed
      // Emits tap with empty keycodes array
      expect(actions).toEqual([{ type: 'tap', keycodes: [] }])
    })
  })

  // ----------------------------------------------------------------
  // deserializeMacro — v2 (vialProtocol >= VIAL_PROTOCOL_ADVANCED_MACROS)
  // ----------------------------------------------------------------
  describe('deserializeMacro (v2)', () => {
    it('deserializes 1-byte keycode tap', () => {
      // SS_QMK_PREFIX, SS_TAP_CODE, keycode
      const data = [SS_QMK_PREFIX, SS_TAP_CODE, 0x04]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'tap', keycodes: [0x04] }])
    })

    it('deserializes 1-byte keycode down', () => {
      const data = [SS_QMK_PREFIX, SS_DOWN_CODE, 0x10]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'down', keycodes: [0x10] }])
    })

    it('deserializes 1-byte keycode up', () => {
      const data = [SS_QMK_PREFIX, SS_UP_CODE, 0x20]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'up', keycodes: [0x20] }])
    })

    it('deserializes 2-byte keycode tap (ext tap)', () => {
      // SS_QMK_PREFIX, VIAL_MACRO_EXT_TAP, lo, hi -> kc = lo | (hi << 8)
      const data = [SS_QMK_PREFIX, VIAL_MACRO_EXT_TAP, 0x04, 0x51]
      const actions = deserializeMacro(data, V2)
      // kc = 0x04 | (0x51 << 8) = 0x5104
      expect(actions).toEqual([{ type: 'tap', keycodes: [0x5104] }])
    })

    it('deserializes 2-byte keycode down (ext down)', () => {
      const data = [SS_QMK_PREFIX, VIAL_MACRO_EXT_DOWN, 0x10, 0x60]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'down', keycodes: [0x6010] }])
    })

    it('deserializes 2-byte keycode up (ext up)', () => {
      const data = [SS_QMK_PREFIX, VIAL_MACRO_EXT_UP, 0x20, 0x70]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'up', keycodes: [0x7020] }])
    })

    it('reverses 0xFFxx encoding for keycodes with zero lower byte', () => {
      // Encoding: 0xFF00 | upper_byte. E.g., keycode 0x0500 is encoded as 0xFF05
      // Stored as little-endian: [0x05, 0xFF]
      // Decoded: kc = 0x05 | (0xFF << 8) = 0xFF05, which >= 0xFF00
      // Reversed: (0xFF05 & 0xFF) << 8 = 0x0500
      const data = [SS_QMK_PREFIX, VIAL_MACRO_EXT_TAP, 0x05, 0xff]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'tap', keycodes: [0x0500] }])
    })

    it('deserializes delay action', () => {
      // SS_QMK_PREFIX, SS_DELAY_CODE, d1, d2
      // delay = (d1 - 1) + (d2 - 1) * 255
      const data = [SS_QMK_PREFIX, SS_DELAY_CODE, 0x65, 0x01]
      const actions = deserializeMacro(data, V2)
      // delay = (0x65 - 1) + (0x01 - 1) * 255 = 100 + 0 = 100
      expect(actions).toEqual([{ type: 'delay', delay: 100 }])
    })

    it('deserializes larger delay values correctly', () => {
      // delay = 500 -> d1 = (500 % 255) + 1 = 246, d2 = floor(500/255) + 1 = 2
      // verify reverse: (246-1) + (2-1)*255 = 245 + 255 = 500
      const data = [SS_QMK_PREFIX, SS_DELAY_CODE, 246, 2]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'delay', delay: 500 }])
    })

    it('deserializes text characters (no SS_QMK_PREFIX prefix)', () => {
      // Characters without the 0x01 prefix are plain text
      const data = [0x48, 0x65, 0x6c, 0x6c, 0x6f] // "Hello"
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'text', text: 'Hello' }])
    })

    it('deserializes mixed text and keycode actions', () => {
      // "A" then tap(0x04) then "B"
      const data = [0x41, SS_QMK_PREFIX, SS_TAP_CODE, 0x04, 0x42]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([
        { type: 'text', text: 'A' },
        { type: 'tap', keycodes: [0x04] },
        { type: 'text', text: 'B' },
      ])
    })

    it('returns empty actions for empty data', () => {
      expect(deserializeMacro([], V2)).toEqual([])
    })

    it('handles truncated v2 action (prefix + tap code but no keycode byte)', () => {
      // SS_QMK_PREFIX + SS_TAP_CODE at end with no keycode following
      const data = [SS_QMK_PREFIX, SS_TAP_CODE]
      const actions = deserializeMacro(data, V2)
      // v2: i+2 = 2, i >= data.length, so no action emitted (dropped)
      expect(actions).toEqual([])
    })

    it('handles truncated v2 2-byte keycode (only 1 byte present) — breaks', () => {
      // SS_QMK_PREFIX + VIAL_MACRO_EXT_TAP + only 1 byte instead of 2
      const data = [SS_QMK_PREFIX, VIAL_MACRO_EXT_TAP, 0x04]
      const actions = deserializeMacro(data, V2)
      // v2: 2-byte keycode needs 2 data bytes but only 1 present → break (Python compat)
      expect(actions).toEqual([])
    })

    it('breaks on truncated delay (only 1 byte present)', () => {
      const data = [SS_QMK_PREFIX, SS_DELAY_CODE, 0x65]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([])
    })

    it('preserves text before truncated ext keycode', () => {
      const data = [0x41, SS_QMK_PREFIX, VIAL_MACRO_EXT_TAP, 0x04]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'text', text: 'A' }])
    })

    it('preserves text before truncated delay', () => {
      const data = [0x41, SS_QMK_PREFIX, SS_DELAY_CODE, 0x65]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'text', text: 'A' }])
    })

    it('does not decode 0xFF00 — treats it as literal keycode (Python compat)', () => {
      // 0xFF00 stored as little-endian: [0x00, 0xFF]
      // kc = 0x00 | (0xFF << 8) = 0xFF00 — exactly 0xFF00, not > 0xFF00
      // Python uses strict '>' so 0xFF00 is NOT decoded
      const data = [SS_QMK_PREFIX, VIAL_MACRO_EXT_TAP, 0x00, 0xff]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'tap', keycodes: [0xff00] }])
    })

    it('skips unknown prefix action codes without corrupting text', () => {
      // "A" + unknown prefix action (0xFF) + "B"
      const unknownCode = 0xff
      const data = [0x41, SS_QMK_PREFIX, unknownCode, 0x42]
      const actions = deserializeMacro(data, V2)
      // Unknown prefix: skip 2 bytes (prefix + action code), then "B" is parsed as text
      expect(actions).toEqual([
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
      ])
    })

    it('handles lone SS_QMK_PREFIX at end of data', () => {
      // SS_QMK_PREFIX without action code — trailing prefix is skipped
      const data = [0x41, SS_QMK_PREFIX]
      const actions = deserializeMacro(data, V2)
      // "A" is parsed as text, lone trailing prefix is skipped
      expect(actions).toEqual([{ type: 'text', text: 'A' }])
    })

    it('merges consecutive same-type 1-byte keycode actions', () => {
      // Two consecutive tap actions: should merge into one
      const data = [
        SS_QMK_PREFIX, SS_TAP_CODE, 0x04,
        SS_QMK_PREFIX, SS_TAP_CODE, 0x05,
        SS_QMK_PREFIX, SS_TAP_CODE, 0x06,
      ]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'tap', keycodes: [0x04, 0x05, 0x06] }])
    })

    it('does not merge different action types', () => {
      const data = [
        SS_QMK_PREFIX, SS_TAP_CODE, 0x04,
        SS_QMK_PREFIX, SS_DOWN_CODE, 0x05,
      ]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([
        { type: 'tap', keycodes: [0x04] },
        { type: 'down', keycodes: [0x05] },
      ])
    })

    it('merges mixed 1-byte and 2-byte keycodes of the same type', () => {
      // 1-byte tap then 2-byte tap (ext) — same type, should merge
      const data = [
        SS_QMK_PREFIX, SS_TAP_CODE, 0x04,
        SS_QMK_PREFIX, VIAL_MACRO_EXT_TAP, 0x04, 0x51,
      ]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([{ type: 'tap', keycodes: [0x04, 0x5104] }])
    })

    it('does not merge keycodes across text or delay boundaries', () => {
      const data = [
        SS_QMK_PREFIX, SS_TAP_CODE, 0x04,
        0x41, // text "A"
        SS_QMK_PREFIX, SS_TAP_CODE, 0x05,
      ]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([
        { type: 'tap', keycodes: [0x04] },
        { type: 'text', text: 'A' },
        { type: 'tap', keycodes: [0x05] },
      ])
    })

    it('does not merge keycodes across delay boundaries', () => {
      const data = [
        SS_QMK_PREFIX, SS_TAP_CODE, 0x04,
        SS_QMK_PREFIX, SS_DELAY_CODE, 101, 1, // delay 100ms
        SS_QMK_PREFIX, SS_TAP_CODE, 0x05,
      ]
      const actions = deserializeMacro(data, V2)
      expect(actions).toEqual([
        { type: 'tap', keycodes: [0x04] },
        { type: 'delay', delay: 100 },
        { type: 'tap', keycodes: [0x05] },
      ])
    })
  })

  // ----------------------------------------------------------------
  // serializeMacro
  // ----------------------------------------------------------------
  describe('serializeMacro', () => {
    describe('v1', () => {
      it('serializes text action as character codes', () => {
        const actions: MacroAction[] = [{ type: 'text', text: 'Hi' }]
        const bytes = serializeMacro(actions, V1)
        expect(bytes).toEqual([0x48, 0x69])
      })

      it('serializes tap action with SS_TAP_CODE per keycode', () => {
        const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x04, 0x05] }]
        const bytes = serializeMacro(actions, V1)
        expect(bytes).toEqual([SS_TAP_CODE, 0x04, SS_TAP_CODE, 0x05])
      })

      it('serializes down action', () => {
        const actions: MacroAction[] = [{ type: 'down', keycodes: [0x10] }]
        const bytes = serializeMacro(actions, V1)
        expect(bytes).toEqual([SS_DOWN_CODE, 0x10])
      })

      it('serializes up action', () => {
        const actions: MacroAction[] = [{ type: 'up', keycodes: [0x20] }]
        const bytes = serializeMacro(actions, V1)
        expect(bytes).toEqual([SS_UP_CODE, 0x20])
      })

      it('returns empty array for delay action (not supported in v1)', () => {
        const actions: MacroAction[] = [{ type: 'delay', delay: 100 }]
        const bytes = serializeMacro(actions, V1)
        expect(bytes).toEqual([])
      })

      it('truncates 2-byte keycodes to 1 byte', () => {
        // v1 cannot represent keycodes > 255, so only the lower byte is kept
        const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x5104] }]
        const bytes = serializeMacro(actions, V1)
        expect(bytes).toEqual([SS_TAP_CODE, 0x04])
      })
    })

    describe('v2', () => {
      it('serializes text action as character codes (no prefix)', () => {
        const actions: MacroAction[] = [{ type: 'text', text: 'Hi' }]
        const bytes = serializeMacro(actions, V2)
        expect(bytes).toEqual([0x48, 0x69])
      })

      it('serializes tap with 1-byte keycode', () => {
        const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x04] }]
        const bytes = serializeMacro(actions, V2)
        expect(bytes).toEqual([SS_QMK_PREFIX, SS_TAP_CODE, 0x04])
      })

      it('serializes tap with 2-byte keycode', () => {
        const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x5104] }]
        const bytes = serializeMacro(actions, V2)
        // kc = 0x5104, lo = 0x04, hi = 0x51
        expect(bytes).toEqual([SS_QMK_PREFIX, VIAL_MACRO_EXT_TAP, 0x04, 0x51])
      })

      it('serializes down with 2-byte keycode', () => {
        const actions: MacroAction[] = [{ type: 'down', keycodes: [0x6010] }]
        const bytes = serializeMacro(actions, V2)
        expect(bytes).toEqual([SS_QMK_PREFIX, VIAL_MACRO_EXT_DOWN, 0x10, 0x60])
      })

      it('serializes up with 2-byte keycode', () => {
        const actions: MacroAction[] = [{ type: 'up', keycodes: [0x7020] }]
        const bytes = serializeMacro(actions, V2)
        expect(bytes).toEqual([SS_QMK_PREFIX, VIAL_MACRO_EXT_UP, 0x20, 0x70])
      })

      it('encodes 2-byte keycode with zero lower byte using 0xFF00 prefix', () => {
        // Keycode 0x0500 has lower byte 0x00, so encode as 0xFF00 | (0x0500 >> 8) = 0xFF05
        // Stored little-endian: [0x05, 0xFF]
        const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x0500] }]
        const bytes = serializeMacro(actions, V2)
        expect(bytes).toEqual([SS_QMK_PREFIX, VIAL_MACRO_EXT_TAP, 0x05, 0xff])
      })

      it('serializes delay action', () => {
        // delay = 100
        // d1 = (100 % 255) + 1 = 101, d2 = floor(100/255) + 1 = 1
        const actions: MacroAction[] = [{ type: 'delay', delay: 100 }]
        const bytes = serializeMacro(actions, V2)
        expect(bytes).toEqual([SS_QMK_PREFIX, SS_DELAY_CODE, 101, 1])
      })

      it('serializes larger delay values correctly', () => {
        // delay = 500
        // d1 = (500 % 255) + 1 = 246, d2 = floor(500/255) + 1 = 2
        const actions: MacroAction[] = [{ type: 'delay', delay: 500 }]
        const bytes = serializeMacro(actions, V2)
        expect(bytes).toEqual([SS_QMK_PREFIX, SS_DELAY_CODE, 246, 2])
      })

      it('serializes multiple keycodes within a single tap action', () => {
        const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x04, 0x05] }]
        const bytes = serializeMacro(actions, V2)
        // Each keycode gets its own SS_QMK_PREFIX + SS_TAP_CODE pair
        expect(bytes).toEqual([
          SS_QMK_PREFIX, SS_TAP_CODE, 0x04,
          SS_QMK_PREFIX, SS_TAP_CODE, 0x05,
        ])
      })
    })
  })

  // ----------------------------------------------------------------
  // Round-trip tests
  // ----------------------------------------------------------------
  describe('round-trip', () => {
    it('v1: text round-trips correctly', () => {
      const actions: MacroAction[] = [{ type: 'text', text: 'Hello World' }]
      const bytes = serializeMacro(actions, V1)
      const result = deserializeMacro(bytes, V1)
      expect(result).toEqual(actions)
    })

    it('v1: tap with 1-byte keycodes round-trips correctly', () => {
      const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x04, 0x05, 0x06] }]
      const bytes = serializeMacro(actions, V1)
      const result = deserializeMacro(bytes, V1)
      expect(result).toEqual(actions)
    })

    it('v2: text round-trips correctly', () => {
      const actions: MacroAction[] = [{ type: 'text', text: 'Hello World' }]
      const bytes = serializeMacro(actions, V2)
      const result = deserializeMacro(bytes, V2)
      expect(result).toEqual(actions)
    })

    it('v2: tap with 1-byte keycode round-trips correctly', () => {
      const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x04] }]
      const bytes = serializeMacro(actions, V2)
      const result = deserializeMacro(bytes, V2)
      expect(result).toEqual(actions)
    })

    it('v2: tap with 2-byte keycode round-trips correctly', () => {
      const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x5104] }]
      const bytes = serializeMacro(actions, V2)
      const result = deserializeMacro(bytes, V2)
      expect(result).toEqual(actions)
    })

    it('v2: 2-byte keycode with zero lower byte round-trips correctly', () => {
      const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x0500] }]
      const bytes = serializeMacro(actions, V2)
      const result = deserializeMacro(bytes, V2)
      expect(result).toEqual(actions)
    })

    it('v2: delay round-trips correctly', () => {
      const actions: MacroAction[] = [{ type: 'delay', delay: 500 }]
      const bytes = serializeMacro(actions, V2)
      const result = deserializeMacro(bytes, V2)
      expect(result).toEqual(actions)
    })

    it('v2: multi-keycode tap merges back into single action on round-trip', () => {
      const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x04, 0x05] }]
      const bytes = serializeMacro(actions, V2)
      const result = deserializeMacro(bytes, V2)
      expect(result).toEqual([{ type: 'tap', keycodes: [0x04, 0x05] }])
    })

    it('v2: JSON round-trip preserves action grouping without binary', () => {
      // M keycodes (M0-M15) require keyboard init, so use LSFT(KC_A) as stand-in
      const input = '[["text","aaa"],["tap","KC_3"],["tap","LCTL_T(KC_3)","KC_BSLASH","KC_Y","KC_X"],["down","KC_TAB","KC_6"],["up","KC_LCTRL","TD(3)","LSFT(KC_A)"]]'
      const actions = jsonToMacroActions(input)!
      expect(actions).not.toBeNull()
      const output = macroActionsToJson(actions)
      expect(output).toBe(input)
    })

    it('v2: binary round-trip merges consecutive same-type keycodes (matches Python)', () => {
      // Binary format merges consecutive same-type keycodes on deserialization,
      // matching Python vial-gui behavior.
      const input = '[["text","aaa"],["tap","KC_3"],["tap","LCTL_T(KC_3)","KC_BSLASH","KC_Y","KC_X"],["down","KC_TAB","KC_6"],["up","KC_LCTRL","TD(3)","LSFT(KC_A)"]]'
      const actions = jsonToMacroActions(input)!
      const bytes = serializeMacro(actions, V2)
      const result = deserializeMacro(bytes, V2)
      const output = macroActionsToJson(result)
      // KC_3 merges with LCTL_T group (same logical type through binary)
      expect(output).toBe(
        '[["text","aaa"],["tap","KC_3","LCTL_T(KC_3)","KC_BSLASH","KC_Y","KC_X"],["down","KC_TAB","KC_6"],["up","KC_LCTRL","TD(3)","LSFT(KC_A)"]]',
      )
    })

    it('v2: complex macro with mixed actions round-trips correctly', () => {
      const actions: MacroAction[] = [
        { type: 'text', text: 'abc' },
        { type: 'tap', keycodes: [0x04] },
        { type: 'delay', delay: 200 },
        { type: 'down', keycodes: [0x5104] },
        { type: 'text', text: 'xyz' },
        { type: 'up', keycodes: [0x5104] },
      ]
      const bytes = serializeMacro(actions, V2)
      const result = deserializeMacro(bytes, V2)
      expect(result).toEqual(actions)
    })
  })

  // ----------------------------------------------------------------
  // serializeAllMacros / deserializeAllMacros
  // ----------------------------------------------------------------
  describe('serializeAllMacros / deserializeAllMacros', () => {
    it('joins multiple macros with NUL separator', () => {
      const macros: MacroAction[][] = [
        [{ type: 'text', text: 'A' }],
        [{ type: 'text', text: 'B' }],
      ]
      const buffer = serializeAllMacros(macros, V2)
      // "A" = 0x41, NUL, "B" = 0x42, NUL
      expect(buffer).toEqual([0x41, 0x00, 0x42, 0x00])
    })

    it('round-trips multiple macros through serialize/deserialize', () => {
      const macros: MacroAction[][] = [
        [
          { type: 'text', text: 'Hello' },
          { type: 'tap', keycodes: [0x04] },
        ],
        [
          { type: 'delay', delay: 300 },
          { type: 'down', keycodes: [0x5104] },
        ],
        [{ type: 'text', text: 'World' }],
      ]
      const buffer = serializeAllMacros(macros, V2)
      const result = deserializeAllMacros(buffer, V2, 3)
      expect(result).toEqual(macros)
    })

    it('handles empty macros in the list', () => {
      const macros: MacroAction[][] = [
        [{ type: 'text', text: 'A' }],
        [], // empty macro
        [{ type: 'text', text: 'C' }],
      ]
      const buffer = serializeAllMacros(macros, V2)
      const result = deserializeAllMacros(buffer, V2, 3)
      expect(result).toEqual(macros)
    })
  })

  // ----------------------------------------------------------------
  // macroActionsToJson / jsonToMacroActions
  // ----------------------------------------------------------------
  describe('macroActionsToJson', () => {
    it('serializes text action', () => {
      const actions: MacroAction[] = [{ type: 'text', text: 'Hello' }]
      const json = macroActionsToJson(actions)
      const parsed = JSON.parse(json)
      expect(parsed).toEqual([['text', 'Hello']])
    })

    it('serializes tap action with keycodes', () => {
      const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x04, 0x05] }]
      const json = macroActionsToJson(actions)
      const parsed = JSON.parse(json)
      // Each keycode is serialized via serialize()
      expect(parsed[0][0]).toBe('tap')
      expect(parsed[0].length).toBe(3) // ['tap', kc1, kc2]
    })

    it('serializes delay action', () => {
      const actions: MacroAction[] = [{ type: 'delay', delay: 500 }]
      const json = macroActionsToJson(actions)
      const parsed = JSON.parse(json)
      expect(parsed).toEqual([['delay', 500]])
    })

    it('serializes empty actions', () => {
      const json = macroActionsToJson([])
      expect(JSON.parse(json)).toEqual([])
    })
  })

  describe('jsonToMacroActions', () => {
    it('parses valid text action', () => {
      const result = jsonToMacroActions('[["text","Hello"]]')
      expect(result).toEqual([{ type: 'text', text: 'Hello' }])
    })

    it('parses valid delay action', () => {
      const result = jsonToMacroActions('[["delay",500]]')
      expect(result).toEqual([{ type: 'delay', delay: 500 }])
    })

    it('parses valid tap action', () => {
      const result = jsonToMacroActions('[["tap","KC_A","KC_B"]]')
      expect(result).not.toBeNull()
      expect(result![0].type).toBe('tap')
      if (result![0].type === 'tap') {
        expect(result![0].keycodes).toHaveLength(2)
      }
    })

    it('parses valid down/up actions', () => {
      const result = jsonToMacroActions('[["down","KC_LCTL"],["up","KC_LCTL"]]')
      expect(result).not.toBeNull()
      expect(result).toHaveLength(2)
      expect(result![0].type).toBe('down')
      expect(result![1].type).toBe('up')
    })

    it('returns null for invalid JSON', () => {
      expect(jsonToMacroActions('not json')).toBeNull()
    })

    it('returns null for non-array JSON', () => {
      expect(jsonToMacroActions('{"type":"text"}')).toBeNull()
    })

    it('returns null for unknown tag', () => {
      expect(jsonToMacroActions('[["unknown","data"]]')).toBeNull()
    })

    it('returns null for text action with wrong arg count', () => {
      expect(jsonToMacroActions('[["text"]]')).toBeNull()
      expect(jsonToMacroActions('[["text","a","b"]]')).toBeNull()
    })

    it('returns null for delay with non-number', () => {
      expect(jsonToMacroActions('[["delay","500"]]')).toBeNull()
    })

    it('returns null for tap with no keycodes', () => {
      expect(jsonToMacroActions('[["tap"]]')).toBeNull()
    })

    it('returns null for tap with non-string keycode', () => {
      expect(jsonToMacroActions('[["tap",123]]')).toBeNull()
    })

    it('parses empty array', () => {
      expect(jsonToMacroActions('[]')).toEqual([])
    })

    it('returns null for negative delay', () => {
      expect(jsonToMacroActions('[["delay",-10]]')).toBeNull()
    })

    it('returns null for non-integer delay', () => {
      expect(jsonToMacroActions('[["delay",1.5]]')).toBeNull()
    })

    it('returns null for text containing non-ASCII characters', () => {
      expect(jsonToMacroActions('[["text","こんにちは"]]')).toBeNull()
    })

    it('returns null for text containing mixed ASCII and non-ASCII', () => {
      expect(jsonToMacroActions('[["text","Hello こんにちは"]]')).toBeNull()
    })

    it('returns null for non-array item in top-level list', () => {
      expect(jsonToMacroActions('[["text","x"],"oops"]')).toBeNull()
    })
  })

  describe('macroActionsToJson (down/up)', () => {
    it('serializes down action', () => {
      const actions: MacroAction[] = [{ type: 'down', keycodes: [0x04] }]
      const json = macroActionsToJson(actions)
      const parsed = JSON.parse(json)
      expect(parsed[0][0]).toBe('down')
      expect(parsed[0].length).toBe(2)
    })

    it('serializes up action', () => {
      const actions: MacroAction[] = [{ type: 'up', keycodes: [0x04] }]
      const json = macroActionsToJson(actions)
      const parsed = JSON.parse(json)
      expect(parsed[0][0]).toBe('up')
      expect(parsed[0].length).toBe(2)
    })
  })

  describe('JSON round-trip', () => {
    it('text action round-trips through JSON', () => {
      const actions: MacroAction[] = [{ type: 'text', text: 'Hello World' }]
      const json = macroActionsToJson(actions)
      const result = jsonToMacroActions(json)
      expect(result).toEqual(actions)
    })

    it('delay action round-trips through JSON', () => {
      const actions: MacroAction[] = [{ type: 'delay', delay: 250 }]
      const json = macroActionsToJson(actions)
      const result = jsonToMacroActions(json)
      expect(result).toEqual(actions)
    })

    it('tap action with 1-byte keycode round-trips through JSON', () => {
      const actions: MacroAction[] = [{ type: 'tap', keycodes: [0x04] }]
      const json = macroActionsToJson(actions)
      const result = jsonToMacroActions(json)
      expect(result).not.toBeNull()
      expect(result![0].type).toBe('tap')
      if (result![0].type === 'tap') {
        expect(result![0].keycodes).toEqual([0x04])
      }
    })

    it('down/up actions round-trip through JSON', () => {
      const actions: MacroAction[] = [
        { type: 'down', keycodes: [0x04] },
        { type: 'up', keycodes: [0x04] },
      ]
      const json = macroActionsToJson(actions)
      const result = jsonToMacroActions(json)
      expect(result).not.toBeNull()
      expect(result).toHaveLength(2)
      expect(result![0].type).toBe('down')
      expect(result![1].type).toBe('up')
      if (result![0].type === 'down' && result![1].type === 'up') {
        expect(result![0].keycodes).toEqual([0x04])
        expect(result![1].keycodes).toEqual([0x04])
      }
    })

    it('mixed actions round-trip through JSON', () => {
      const actions: MacroAction[] = [
        { type: 'text', text: 'abc' },
        { type: 'tap', keycodes: [0x04] },
        { type: 'delay', delay: 200 },
      ]
      const json = macroActionsToJson(actions)
      const result = jsonToMacroActions(json)
      expect(result).not.toBeNull()
      expect(result!.length).toBe(3)
      expect(result![0]).toEqual({ type: 'text', text: 'abc' })
      expect(result![2]).toEqual({ type: 'delay', delay: 200 })
    })
  })
})
