// SPDX-License-Identifier: GPL-2.0-or-later
// VIA protocol command handler for the virtual device (byte0 !== 0xFE).
// Response starts as an exact copy of the request — an unhandled command
// falls through unchanged, which is how real firmware "echoes" commands
// it doesn't support (the app's echo-detection treats that as unsupported).

import { BUFFER_FETCH_CHUNK } from '../../shared/constants/protocol'
import {
  CMD_VIA_GET_PROTOCOL_VERSION,
  CMD_VIA_GET_KEYBOARD_VALUE,
  CMD_VIA_SET_KEYBOARD_VALUE,
  CMD_VIA_GET_KEYCODE,
  CMD_VIA_SET_KEYCODE,
  CMD_VIA_LIGHTING_GET_VALUE,
  CMD_VIA_LIGHTING_SET_VALUE,
  CMD_VIA_LIGHTING_SAVE,
  CMD_VIA_MACRO_GET_COUNT,
  CMD_VIA_MACRO_GET_BUFFER_SIZE,
  CMD_VIA_MACRO_GET_BUFFER,
  CMD_VIA_MACRO_SET_BUFFER,
  CMD_VIA_GET_LAYER_COUNT,
  CMD_VIA_KEYMAP_GET_BUFFER,
  VIA_LAYOUT_OPTIONS,
  VIA_SWITCH_MATRIX_STATE,
} from '../../shared/constants/protocol'
import { setProtocolValue } from '../../shared/keycodes/keycodes'
import { resolve } from '../../shared/keycodes/keycodes-utils'
import { readBE16, writeBE16, readBE32, writeBE32 } from './byte-utils'
import { VIAL_PROTOCOL, LAYERS, ROWS, COLS, MACRO_COUNT, MACRO_BUFFER_SIZE } from './gpk60-63r'
import type { VirtualDeviceState } from './state'
import { isValidKeymapPosition, keymapIndex, packMatrixState } from './state'
import { getLightingValue, setLightingValue } from './vialrgb-handler'

function isBootKeycode(keycode: number): boolean {
  setProtocolValue(VIAL_PROTOCOL)
  return keycode === resolve('QK_BOOT')
}

export function handleViaReport(state: VirtualDeviceState, req: Uint8Array): Uint8Array {
  const resp = new Uint8Array(req)
  const cmd = req[0]

  switch (cmd) {
    case CMD_VIA_GET_PROTOCOL_VERSION: {
      writeBE16(resp, 1, 9)
      break
    }

    case CMD_VIA_GET_KEYBOARD_VALUE: {
      const sub = req[1]
      if (sub === VIA_LAYOUT_OPTIONS) {
        writeBE32(resp, 2, state.layoutOptions)
      } else if (sub === VIA_SWITCH_MATRIX_STATE) {
        if (state.unlocked) {
          resp.set(packMatrixState(state), 2)
        }
        // Locked: leave the echoed request bytes unchanged, matching firmware.
      }
      break
    }

    case CMD_VIA_SET_KEYBOARD_VALUE: {
      const sub = req[1]
      if (sub === VIA_LAYOUT_OPTIONS) {
        state.layoutOptions = readBE32(req, 2)
      }
      break
    }

    case CMD_VIA_GET_KEYCODE: {
      const [layer, row, col] = [req[1], req[2], req[3]]
      const value = isValidKeymapPosition(layer, row, col) ? state.keymap[keymapIndex(layer, row, col)] : 0
      writeBE16(resp, 4, value)
      break
    }

    case CMD_VIA_SET_KEYCODE: {
      const [layer, row, col] = [req[1], req[2], req[3]]
      const keycode = readBE16(req, 4)
      if (isValidKeymapPosition(layer, row, col)) {
        const blocked = !state.unlocked && isBootKeycode(keycode)
        state.keymap[keymapIndex(layer, row, col)] = blocked ? 0 : keycode
      }
      break
    }

    case CMD_VIA_GET_LAYER_COUNT: {
      resp[1] = LAYERS
      break
    }

    case CMD_VIA_KEYMAP_GET_BUFFER: {
      const offset = readBE16(req, 1)
      const size = Math.min(req[3], BUFFER_FETCH_CHUNK)
      const keymapBytes = new Uint8Array(LAYERS * ROWS * COLS * 2)
      for (let i = 0; i < state.keymap.length; i++) {
        writeBE16(keymapBytes, i * 2, state.keymap[i])
      }
      for (let i = 0; i < size; i++) {
        const srcIndex = offset + i
        resp[4 + i] = srcIndex < keymapBytes.length ? keymapBytes[srcIndex] : 0
      }
      break
    }

    case CMD_VIA_MACRO_GET_COUNT: {
      resp[1] = MACRO_COUNT
      break
    }

    case CMD_VIA_MACRO_GET_BUFFER_SIZE: {
      writeBE16(resp, 1, MACRO_BUFFER_SIZE)
      break
    }

    case CMD_VIA_MACRO_GET_BUFFER: {
      const offset = readBE16(req, 1)
      const size = Math.min(req[3], BUFFER_FETCH_CHUNK)
      for (let i = 0; i < size; i++) {
        const srcIndex = offset + i
        resp[4 + i] = srcIndex < state.macroBuffer.length ? state.macroBuffer[srcIndex] : 0
      }
      break
    }

    case CMD_VIA_MACRO_SET_BUFFER: {
      const offset = readBE16(req, 1)
      const size = Math.min(req[3], BUFFER_FETCH_CHUNK)
      for (let i = 0; i < size; i++) {
        const dstIndex = offset + i
        if (dstIndex < state.macroBuffer.length) {
          state.macroBuffer[dstIndex] = req[4 + i]
        }
      }
      break
    }

    case CMD_VIA_LIGHTING_GET_VALUE: {
      getLightingValue(state, req, resp)
      break
    }

    case CMD_VIA_LIGHTING_SET_VALUE: {
      setLightingValue(state, req)
      break
    }

    case CMD_VIA_LIGHTING_SAVE: {
      // No persistent EEPROM to flush — ack only.
      break
    }

    default:
      // Unhandled command: echo request back unchanged.
      break
  }

  return resp
}
