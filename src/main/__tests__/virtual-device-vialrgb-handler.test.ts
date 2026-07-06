// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { MSG_LEN, VIALRGB_GET_INFO, VIALRGB_GET_MODE, VIALRGB_GET_SUPPORTED, VIALRGB_SET_MODE } from '../../shared/constants/protocol'
import { VIALRGB_SUPPORTED_EFFECTS } from '../virtual-device/gpk60-63r'
import { createVirtualDeviceState } from '../virtual-device/state'
import { getLightingValue, setLightingValue } from '../virtual-device/vialrgb-handler'
import { readLE16, writeLE16 } from '../virtual-device/byte-utils'

function req(...bytes: number[]): Uint8Array {
  const buf = new Uint8Array(MSG_LEN)
  buf.set(bytes.slice(0, MSG_LEN))
  return buf
}

describe('getLightingValue', () => {
  it('VIALRGB_GET_INFO returns LE16 protocol version and max brightness', () => {
    const state = createVirtualDeviceState()
    const r = req(0x08, VIALRGB_GET_INFO)
    const resp = getLightingValue(state, r, new Uint8Array(r))
    expect(readLE16(resp, 2)).toBe(1)
    expect(resp[4]).toBe(255)
  })

  it('VIALRGB_GET_MODE reflects current state', () => {
    const state = createVirtualDeviceState()
    state.rgb = { mode: 7, speed: 100, hue: 50, sat: 200, val: 150 }
    const r = req(0x08, VIALRGB_GET_MODE)
    const resp = getLightingValue(state, r, new Uint8Array(r))
    expect(readLE16(resp, 2)).toBe(7)
    expect(resp[4]).toBe(100)
    expect(resp[5]).toBe(50)
    expect(resp[6]).toBe(200)
    expect(resp[7]).toBe(150)
  })

  it('VIALRGB_GET_SUPPORTED pagination: gt=0 returns ascending effects greater than 0 (excludes DIRECT)', () => {
    const state = createVirtualDeviceState()
    const r = req(0x08, VIALRGB_GET_SUPPORTED)
    writeLE16(r, 2, 0)
    const resp = getLightingValue(state, r, new Uint8Array(r))

    const expected = VIALRGB_SUPPORTED_EFFECTS.filter((e) => e > 0)
    for (let i = 0; i < Math.min(expected.length, 15); i++) {
      expect(readLE16(resp, 2 + i * 2)).toBe(expected[i])
    }
    expect(resp).not.toContain(1) // DIRECT excluded — no byte pair equals 1 as LE16 in the used slots

    // Last page (beyond all known effects) is entirely 0xFF-padded.
    const beyondReq = req(0x08, VIALRGB_GET_SUPPORTED)
    writeLE16(beyondReq, 2, 9999)
    const beyondResp = getLightingValue(state, beyondReq, new Uint8Array(beyondReq))
    for (let i = 2; i < MSG_LEN; i++) {
      expect(beyondResp[i]).toBe(0xff)
    }
  })
})

describe('setLightingValue', () => {
  it('stores mode/speed/hsv from VIALRGB_SET_MODE', () => {
    const state = createVirtualDeviceState()
    const r = req(0x07, VIALRGB_SET_MODE)
    writeLE16(r, 2, 9)
    r[4] = 111
    r[5] = 22
    r[6] = 33
    r[7] = 44
    setLightingValue(state, r)
    expect(state.rgb).toEqual({ mode: 9, speed: 111, hue: 22, sat: 33, val: 44 })
  })

  it('ignores unrelated lighting set sub-commands', () => {
    const state = createVirtualDeviceState()
    const before = { ...state.rgb }
    setLightingValue(state, req(0x07, 0x99))
    expect(state.rgb).toEqual(before)
  })
})
