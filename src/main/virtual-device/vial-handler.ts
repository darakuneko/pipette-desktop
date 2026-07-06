// SPDX-License-Identifier: GPL-2.0-or-later
// Vial protocol command handler for the virtual device (byte0 === 0xFE,
// byte1 selects the sub-command). Supported commands build their response
// from a zeroed buffer; unsupported ones echo the request back unchanged
// so the app's echo-detection correctly reports the feature as absent.

import { MSG_LEN } from '../../shared/constants/protocol'
import {
  CMD_VIAL_GET_KEYBOARD_ID,
  CMD_VIAL_GET_SIZE,
  CMD_VIAL_GET_DEFINITION,
  CMD_VIAL_GET_UNLOCK_STATUS,
  CMD_VIAL_UNLOCK_START,
  CMD_VIAL_UNLOCK_POLL,
  CMD_VIAL_LOCK,
  CMD_VIAL_QMK_SETTINGS_QUERY,
  CMD_VIAL_DYNAMIC_ENTRY_OP,
  DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES,
} from '../../shared/constants/protocol'
import { writeLE32 } from './byte-utils'
import { VIAL_PROTOCOL, VIRTUAL_DEVICE_UID_BYTES, VIRTUAL_DEVICE_UNLOCK_COMBO } from './gpk60-63r'
import type { VirtualDeviceState } from './state'
import { unlockPollTick } from './state'

/** VialRGB support flag reported in the keyboard-id response (byte 12). */
const VIALRGB_FLAG = 1
const UNLOCK_COMBO_SLOTS = 15

function handleKeyboardId(): Uint8Array {
  const resp = new Uint8Array(MSG_LEN)
  writeLE32(resp, 0, VIAL_PROTOCOL)
  resp.set(VIRTUAL_DEVICE_UID_BYTES, 4)
  resp[12] = VIALRGB_FLAG
  return resp
}

function handleDefinitionSize(compressedLength: number): Uint8Array {
  const resp = new Uint8Array(MSG_LEN)
  writeLE32(resp, 0, compressedLength)
  return resp
}

function handleDefinitionBlock(req: Uint8Array, compressed: Uint8Array): Uint8Array {
  const resp = new Uint8Array(MSG_LEN)
  const block = req[2] | (req[3] << 8) | (req[4] << 16) | (req[5] << 24)
  const start = block * MSG_LEN
  const copyLen = Math.max(0, Math.min(MSG_LEN, compressed.length - start))
  for (let i = 0; i < copyLen; i++) {
    resp[i] = compressed[start + i]
  }
  return resp
}

function handleUnlockStatus(state: VirtualDeviceState): Uint8Array {
  const resp = new Uint8Array(MSG_LEN).fill(0xff)
  resp[0] = state.unlocked ? 1 : 0
  resp[1] = state.unlockInProgress ? 1 : 0
  for (let i = 0; i < UNLOCK_COMBO_SLOTS; i++) {
    const pair = VIRTUAL_DEVICE_UNLOCK_COMBO[i]
    if (pair) {
      resp[2 + i * 2] = pair[0]
      resp[3 + i * 2] = pair[1]
    } else {
      resp[2 + i * 2] = 0xff
      resp[3 + i * 2] = 0xff
    }
  }
  return resp
}

function handleUnlockPoll(state: VirtualDeviceState, now: number): Uint8Array {
  unlockPollTick(state, now)
  const resp = new Uint8Array(MSG_LEN).fill(0xff)
  resp[0] = state.unlocked ? 1 : 0
  resp[1] = state.unlockInProgress ? 1 : 0
  resp[2] = Math.max(0, state.unlockCounter)
  return resp
}

export function handleVialReport(
  state: VirtualDeviceState,
  req: Uint8Array,
  compressedDefinition: Uint8Array,
  now: number,
): Uint8Array {
  const sub = req[1]

  switch (sub) {
    case CMD_VIAL_GET_KEYBOARD_ID:
      return handleKeyboardId()

    case CMD_VIAL_GET_SIZE:
      return handleDefinitionSize(compressedDefinition.length)

    case CMD_VIAL_GET_DEFINITION:
      return handleDefinitionBlock(req, compressedDefinition)

    case CMD_VIAL_GET_UNLOCK_STATUS:
      return handleUnlockStatus(state)

    case CMD_VIAL_UNLOCK_START:
      state.unlockInProgress = true
      state.unlockCounter = state.unlockCounterMax
      state.unlockTimer = now
      return new Uint8Array(req)

    case CMD_VIAL_UNLOCK_POLL:
      return handleUnlockPoll(state, now)

    case CMD_VIAL_LOCK:
      state.unlocked = false
      return new Uint8Array(req)

    case CMD_VIAL_QMK_SETTINGS_QUERY:
      // QMK Settings is not implemented by the virtual firmware.
      return new Uint8Array(MSG_LEN).fill(0xff)

    case CMD_VIAL_DYNAMIC_ENTRY_OP:
      if (req[2] === DYNAMIC_VIAL_GET_NUMBER_OF_ENTRIES) {
        // Tap dance, combo, key override, alt-repeat-key: all zero. Feature flags: none.
        return new Uint8Array(MSG_LEN)
      }
      // Individual entry get/set and other dynamic ops: unsupported, echo.
      return new Uint8Array(req)

    default:
      // Encoders (0x03/0x04), QMK settings get/set/reset (0x0a/0x0b/0x0c): unsupported, echo.
      return new Uint8Array(req)
  }
}
