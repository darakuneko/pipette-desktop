/**
 * Macro serialization/deserialization.
 * Supports v1 (simple) and v2 (advanced with delays and 2-byte keycodes).
 *
 * Binary format: NUL-separated sequences of actions in device memory.
 * Each macro is terminated by 0x00.
 */

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
} from '../shared/constants/protocol'
import { serialize, deserialize } from '../shared/keycodes/keycodes'

// --- Validation ---

/** Check if text contains only printable ASCII characters (0x20-0x7E). */
export function isValidMacroText(text: string): boolean {
  return /^[\x20-\x7e]*$/.test(text)
}

// --- Action types ---

export type MacroAction =
  | { type: 'text'; text: string }
  | { type: 'tap'; keycodes: number[] }
  | { type: 'down'; keycodes: number[] }
  | { type: 'up'; keycodes: number[] }
  | { type: 'delay'; delay: number }

// --- Deserialization ---

/** Split NUL-separated macro buffer into individual macro byte arrays.
 *  Respects macroCount to avoid trailing padding being interpreted as empty macros. */
export function splitMacroBuffer(buffer: number[], macroCount: number): number[][] {
  const macros: number[][] = []
  let current: number[] = []
  for (const byte of buffer) {
    if (byte === 0) {
      macros.push(current)
      current = []
      if (macros.length >= macroCount) break
    } else {
      current.push(byte)
    }
  }
  // If buffer didn't end with NUL and we haven't reached macroCount, add remaining
  if (current.length > 0 && macros.length < macroCount) {
    macros.push(current)
  }
  return macros
}

/** Deserialize a single macro from bytes (v1 format). */
function deserializeV1(data: number[]): MacroAction[] {
  const actions: MacroAction[] = []
  let i = 0

  while (i < data.length) {
    const byte = data[i]

    if (byte === SS_TAP_CODE || byte === SS_DOWN_CODE || byte === SS_UP_CODE) {
      const type = actionTypeFromCode(SS_TAP_CODE, SS_DOWN_CODE, byte)
      const keycodes: number[] = []
      while (i < data.length && data[i] === byte) {
        i++
        if (i < data.length) {
          keycodes.push(data[i])
          i++
        }
      }
      actions.push({ type, keycodes })
    } else {
      // Text character
      let text = ''
      while (i < data.length && data[i] !== SS_TAP_CODE && data[i] !== SS_DOWN_CODE && data[i] !== SS_UP_CODE) {
        text += String.fromCharCode(data[i])
        i++
      }
      if (text) actions.push({ type: 'text', text })
    }
  }

  return actions
}

function actionTypeFromCode(
  tapCode: number,
  downCode: number,
  code: number,
): 'tap' | 'down' | 'up' {
  if (code === tapCode) return 'tap'
  if (code === downCode) return 'down'
  return 'up'
}

/** Append a keycode to the last action if it has the same type, otherwise create a new action. */
function pushOrMergeKeycode(actions: MacroAction[], type: 'tap' | 'down' | 'up', kc: number): void {
  const last = actions[actions.length - 1]
  if (last && last.type === type) {
    last.keycodes.push(kc)
  } else {
    actions.push({ type, keycodes: [kc] })
  }
}

/** Deserialize a single macro from bytes (v2 format). */
function deserializeV2(data: number[]): MacroAction[] {
  const actions: MacroAction[] = []
  let i = 0

  while (i < data.length) {
    if (data[i] === SS_QMK_PREFIX) {
      if (i + 1 >= data.length) {
        // Lone prefix at end of data — skip it
        i++
        continue
      }
      const actionCode = data[i + 1]

      if (actionCode === SS_TAP_CODE || actionCode === SS_DOWN_CODE || actionCode === SS_UP_CODE) {
        // 1-byte keycode action
        const type = actionTypeFromCode(SS_TAP_CODE, SS_DOWN_CODE, actionCode)
        i += 2
        if (i < data.length) {
          pushOrMergeKeycode(actions, type, data[i])
          i++
        }
      } else if (actionCode === VIAL_MACRO_EXT_TAP || actionCode === VIAL_MACRO_EXT_DOWN || actionCode === VIAL_MACRO_EXT_UP) {
        // 2-byte keycode action (little-endian)
        const type = actionTypeFromCode(VIAL_MACRO_EXT_TAP, VIAL_MACRO_EXT_DOWN, actionCode)
        i += 2
        if (i + 1 >= data.length) break
        let kc = data[i] | (data[i + 1] << 8)
        // Reverse QMK encoding: 0xFFxx → (xx << 8)
        if (kc > 0xff00) {
          kc = (kc & 0xff) << 8
        }
        pushOrMergeKeycode(actions, type, kc)
        i += 2
      } else if (actionCode === SS_DELAY_CODE) {
        // Delay
        i += 2
        if (i + 1 >= data.length) break
        const delay = (data[i] - 1) + (data[i + 1] - 1) * 255
        actions.push({ type: 'delay', delay })
        i += 2
      } else {
        // Unknown prefix action, skip prefix + action code
        i += 2
      }
    } else {
      // Text character
      let text = ''
      while (i < data.length && data[i] !== SS_QMK_PREFIX) {
        text += String.fromCharCode(data[i])
        i++
      }
      if (text) actions.push({ type: 'text', text })
    }
  }

  return actions
}

/** Deserialize a macro from bytes, selecting format by protocol version. */
export function deserializeMacro(data: number[], vialProtocol: number): MacroAction[] {
  if (vialProtocol >= VIAL_PROTOCOL_ADVANCED_MACROS) {
    return deserializeV2(data)
  }
  return deserializeV1(data)
}

/** Deserialize all macros from the device buffer. */
export function deserializeAllMacros(buffer: number[], vialProtocol: number, macroCount: number): MacroAction[][] {
  return splitMacroBuffer(buffer, macroCount).map((m) => deserializeMacro(m, vialProtocol))
}

// --- Serialization ---

/** Serialize a single macro action to bytes. */
function serializeAction(action: MacroAction, vialProtocol: number): number[] {
  const v2 = vialProtocol >= VIAL_PROTOCOL_ADVANCED_MACROS

  switch (action.type) {
    case 'text':
      if (!isValidMacroText(action.text)) return []
      return Array.from(new TextEncoder().encode(action.text))

    case 'tap':
    case 'down':
    case 'up': {
      const bytes: number[] = []
      const codeMap = { tap: SS_TAP_CODE, down: SS_DOWN_CODE, up: SS_UP_CODE }
      const extMap = { tap: VIAL_MACRO_EXT_TAP, down: VIAL_MACRO_EXT_DOWN, up: VIAL_MACRO_EXT_UP }
      for (const kc of action.keycodes) {
        if (v2) bytes.push(SS_QMK_PREFIX)
        if (kc < 256) {
          bytes.push(codeMap[action.type], kc)
        } else {
          // 2-byte keycode
          // QMK encoding: if lower byte is 0, encode as 0xFF00 | upper_byte
          let encoded = kc
          if ((encoded & 0xff) === 0) {
            encoded = 0xff00 | (encoded >> 8)
          }
          if (v2) {
            bytes.push(extMap[action.type], encoded & 0xff, (encoded >> 8) & 0xff)
          } else {
            // v1 can't handle 2-byte keycodes, truncate to 1 byte
            bytes.push(codeMap[action.type], kc & 0xff)
          }
        }
      }
      return bytes
    }

    case 'delay':
      if (!v2) return [] // Delays not supported in v1
      return [
        SS_QMK_PREFIX,
        SS_DELAY_CODE,
        (action.delay % 255) + 1,
        Math.floor(action.delay / 255) + 1,
      ]
  }
}

/** Serialize a list of actions into a single macro byte array. */
export function serializeMacro(actions: MacroAction[], vialProtocol: number): number[] {
  const bytes: number[] = []
  for (const action of actions) {
    bytes.push(...serializeAction(action, vialProtocol))
  }
  return bytes
}

/** Serialize all macros into a NUL-separated buffer. */
export function serializeAllMacros(macros: MacroAction[][], vialProtocol: number): number[] {
  const buffer: number[] = []
  for (const macro of macros) {
    buffer.push(...serializeMacro(macro, vialProtocol))
    buffer.push(0) // NUL terminator
  }
  return buffer
}

// --- JSON serialization (Python-compatible) ---

/** Convert macro actions to Python-compatible JSON string.
 *  Format: [["text","Hello"],["tap","KC_A","KC_B"],["down","KC_LCTRL"],["delay",500]] */
export function macroActionsToJson(actions: MacroAction[]): string {
  const items = actions.map((action): unknown[] => {
    switch (action.type) {
      case 'text':
        return ['text', action.text]
      case 'tap':
      case 'down':
      case 'up':
        return [action.type, ...action.keycodes.map((kc) => serialize(kc))]
      case 'delay':
        return ['delay', action.delay]
    }
  })
  return JSON.stringify(items)
}

/** Parse a Python-compatible JSON string into macro actions.
 *  Returns null if the JSON is invalid or has an unrecognized structure. */
export function jsonToMacroActions(json: string): MacroAction[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const actions: MacroAction[] = []
  for (const item of parsed) {
    if (!Array.isArray(item) || item.length < 1 || typeof item[0] !== 'string') return null
    const tag = item[0] as string

    switch (tag) {
      case 'text': {
        if (item.length !== 2 || typeof item[1] !== 'string') return null
        if (!isValidMacroText(item[1])) return null
        actions.push({ type: 'text', text: item[1] })
        break
      }
      case 'tap':
      case 'down':
      case 'up': {
        if (item.length < 2) return null
        const keycodes: number[] = []
        for (let i = 1; i < item.length; i++) {
          if (typeof item[i] !== 'string') return null
          keycodes.push(deserialize(item[i] as string))
        }
        actions.push({ type: tag, keycodes })
        break
      }
      case 'delay': {
        if (item.length !== 2 || typeof item[1] !== 'number') return null
        if (!Number.isInteger(item[1]) || item[1] < 0) return null
        actions.push({ type: 'delay', delay: item[1] })
        break
      }
      default:
        return null
    }
  }
  return actions
}
