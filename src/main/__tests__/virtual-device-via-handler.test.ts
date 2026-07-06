// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { MSG_LEN, BUFFER_FETCH_CHUNK } from '../../shared/constants/protocol'
import { setProtocolValue } from '../../shared/keycodes/keycodes'
import { resolve } from '../../shared/keycodes/keycodes-utils'
import { ROWS, COLS, LAYERS, MACRO_BUFFER_SIZE } from '../virtual-device/gpk60-63r'
import { createVirtualDeviceState, pressKey, keymapIndex } from '../virtual-device/state'
import { handleViaReport } from '../virtual-device/via-handler'
import { readBE16, writeBE16, readBE32, writeBE32 } from '../virtual-device/byte-utils'

function req(...bytes: number[]): Uint8Array {
  const buf = new Uint8Array(MSG_LEN)
  buf.set(bytes.slice(0, MSG_LEN))
  return buf
}

describe('handleViaReport', () => {
  it('CMD_VIA_GET_PROTOCOL_VERSION returns BE16 9', () => {
    const state = createVirtualDeviceState()
    const resp = handleViaReport(state, req(0x01))
    expect(readBE16(resp, 1)).toBe(9)
  })

  it('CMD_VIA_GET_LAYER_COUNT returns 4', () => {
    const state = createVirtualDeviceState()
    const resp = handleViaReport(state, req(0x11))
    expect(resp[1]).toBe(LAYERS)
  })

  it('layout options round-trip through set/get', () => {
    const state = createVirtualDeviceState()
    const setReq = req(0x03, 0x02)
    writeBE32(setReq, 2, 0xabcd1234)
    handleViaReport(state, setReq)
    expect(state.layoutOptions).toBe(0xabcd1234)

    const getResp = handleViaReport(state, req(0x02, 0x02))
    expect(readBE32(getResp, 2)).toBe(0xabcd1234)
  })

  it('fetches the full keymap buffer in 28-byte chunks, including an odd offset', () => {
    const state = createVirtualDeviceState()
    const totalBytes = LAYERS * ROWS * COLS * 2
    const collected: number[] = []
    for (let offset = 0; offset < totalBytes; offset += BUFFER_FETCH_CHUNK) {
      const chunkSize = Math.min(BUFFER_FETCH_CHUNK, totalBytes - offset)
      const r = new Uint8Array(MSG_LEN)
      r[0] = 0x12
      writeBE16(r, 1, offset)
      r[3] = chunkSize
      const resp = handleViaReport(state, r)
      for (let i = 0; i < chunkSize; i++) collected.push(resp[4 + i])
    }
    expect(collected.length).toBe(totalBytes)
    for (let i = 0; i < state.keymap.length; i++) {
      const value = (collected[i * 2] << 8) | collected[i * 2 + 1]
      expect(value).toBe(state.keymap[i])
    }

    // Odd-offset fetch mid-buffer should reassemble to the same bytes.
    const oddOffset = 5
    const oddReq = new Uint8Array(MSG_LEN)
    oddReq[0] = 0x12
    writeBE16(oddReq, 1, oddOffset)
    oddReq[3] = 10
    const oddResp = handleViaReport(state, oddReq)
    for (let i = 0; i < 10; i++) {
      expect(oddResp[4 + i]).toBe(collected[oddOffset + i])
    }
  })

  it('setKeycode is reflected in the keymap buffer', () => {
    const state = createVirtualDeviceState()
    const setReq = req(0x05, 0, 1, 2)
    writeBE16(setReq, 4, 0x1234)
    handleViaReport(state, setReq)
    expect(state.keymap[keymapIndex(0, 1, 2)]).toBe(0x1234)

    const getReq = req(0x04, 0, 1, 2)
    const getResp = handleViaReport(state, getReq)
    expect(readBE16(getResp, 4)).toBe(0x1234)
  })

  it('blocks setting QK_BOOT while locked (stores KC_NO instead)', () => {
    setProtocolValue(6)
    const qkBoot = resolve('QK_BOOT')
    const state = createVirtualDeviceState()
    expect(state.unlocked).toBe(false)

    const setReq = req(0x05, 0, 0, 0)
    writeBE16(setReq, 4, qkBoot)
    handleViaReport(state, setReq)
    expect(state.keymap[keymapIndex(0, 0, 0)]).toBe(0)
  })

  it('allows setting QK_BOOT once unlocked', () => {
    setProtocolValue(6)
    const qkBoot = resolve('QK_BOOT')
    const state = createVirtualDeviceState()
    state.unlocked = true

    const setReq = req(0x05, 0, 0, 0)
    writeBE16(setReq, 4, qkBoot)
    handleViaReport(state, setReq)
    expect(state.keymap[keymapIndex(0, 0, 0)]).toBe(qkBoot)
  })

  it('macro buffer round-trips through set/get in chunks', () => {
    const state = createVirtualDeviceState()
    const sample = new Uint8Array(MACRO_BUFFER_SIZE)
    for (let i = 0; i < sample.length; i++) sample[i] = i % 256

    for (let offset = 0; offset < sample.length; offset += BUFFER_FETCH_CHUNK) {
      const chunkSize = Math.min(BUFFER_FETCH_CHUNK, sample.length - offset)
      const r = new Uint8Array(MSG_LEN)
      r[0] = 0x0f
      writeBE16(r, 1, offset)
      r[3] = chunkSize
      r.set(sample.subarray(offset, offset + chunkSize), 4)
      handleViaReport(state, r)
    }

    expect(Array.from(state.macroBuffer)).toEqual(Array.from(sample))

    const collected: number[] = []
    for (let offset = 0; offset < sample.length; offset += BUFFER_FETCH_CHUNK) {
      const chunkSize = Math.min(BUFFER_FETCH_CHUNK, sample.length - offset)
      const r = new Uint8Array(MSG_LEN)
      r[0] = 0x0e
      writeBE16(r, 1, offset)
      r[3] = chunkSize
      const resp = handleViaReport(state, r)
      for (let i = 0; i < chunkSize; i++) collected.push(resp[4 + i])
    }
    expect(collected).toEqual(Array.from(sample))
  })

  it('matrix request while locked returns the request unchanged (echo)', () => {
    const state = createVirtualDeviceState()
    pressKey(state, 0, 0)
    const r = req(0x02, 0x03)
    const resp = handleViaReport(state, r)
    expect(Array.from(resp)).toEqual(Array.from(r))
  })

  it('matrix request while unlocked reflects pressed keys at (0,0), (0,13), (4,11)', () => {
    const state = createVirtualDeviceState()
    state.unlocked = true
    pressKey(state, 0, 0)
    pressKey(state, 0, 13)
    pressKey(state, 4, 11)

    const resp = handleViaReport(state, req(0x02, 0x03))
    // row 0: bit0 (col0) low byte, bit5 (col13-8) high byte
    expect(resp[2]).toBe(1 << 5)
    expect(resp[3]).toBe(0x01)
    // row 4: bit3 (col11-8) high byte
    expect(resp[2 + 4 * 2]).toBe(1 << 3)
    expect(resp[2 + 4 * 2 + 1]).toBe(0x00)
  })
})
