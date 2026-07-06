// SPDX-License-Identifier: GPL-2.0-or-later
// VialRGB lighting sub-commands, reached through CMD_VIA_LIGHTING_GET_VALUE /
// CMD_VIA_LIGHTING_SET_VALUE (byte1 selects the VialRGB sub-command).

import { MSG_LEN, VIALRGB_GET_INFO, VIALRGB_GET_MODE, VIALRGB_GET_SUPPORTED, VIALRGB_SET_MODE } from '../../shared/constants/protocol'
import { readLE16, writeLE16 } from './byte-utils'
import { VIALRGB_SUPPORTED_EFFECTS } from './gpk60-63r'
import type { VirtualDeviceState } from './state'

const VIALRGB_PROTOCOL_VERSION = 1
const VIALRGB_MAX_BRIGHTNESS = 255
/** Slots available for effect IDs after the 2-byte response header. */
const SUPPORTED_ENTRIES_PER_PAGE = Math.floor((MSG_LEN - 2) / 2)

/** Handle CMD_VIA_LIGHTING_GET_VALUE sub-commands. `resp` is the echo-seeded response buffer. */
export function getLightingValue(state: VirtualDeviceState, req: Uint8Array, resp: Uint8Array): Uint8Array {
  const sub = req[1]

  switch (sub) {
    case VIALRGB_GET_INFO: {
      writeLE16(resp, 2, VIALRGB_PROTOCOL_VERSION)
      resp[4] = VIALRGB_MAX_BRIGHTNESS
      break
    }

    case VIALRGB_GET_MODE: {
      writeLE16(resp, 2, state.rgb.mode)
      resp[4] = state.rgb.speed
      resp[5] = state.rgb.hue
      resp[6] = state.rgb.sat
      resp[7] = state.rgb.val
      break
    }

    case VIALRGB_GET_SUPPORTED: {
      const greaterThan = readLE16(req, 2)
      resp.fill(0xff, 2, MSG_LEN)
      const candidates = VIALRGB_SUPPORTED_EFFECTS.filter((effect) => effect > greaterThan)
      const count = Math.min(candidates.length, SUPPORTED_ENTRIES_PER_PAGE)
      for (let i = 0; i < count; i++) {
        writeLE16(resp, 2 + i * 2, candidates[i])
      }
      break
    }

    default:
      // Unhandled lighting sub-command: leave the echoed request bytes as-is.
      break
  }

  return resp
}

/** Handle CMD_VIA_LIGHTING_SET_VALUE sub-commands (mutates state; caller returns the echo response). */
export function setLightingValue(state: VirtualDeviceState, req: Uint8Array): void {
  if (req[1] !== VIALRGB_SET_MODE) return

  state.rgb.mode = readLE16(req, 2)
  state.rgb.speed = req[4]
  state.rgb.hue = req[5]
  state.rgb.sat = req[6]
  state.rgb.val = req[7]
}
