// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { MSG_LEN } from '../../shared/constants/protocol'
import { VIAL_PROTOCOL, VIRTUAL_DEVICE_UID_BYTES, VIRTUAL_DEVICE_UNLOCK_COMBO } from '../virtual-device/gpk60-63r'
import { createVirtualDeviceState, pressKey } from '../virtual-device/state'
import { handleVialReport } from '../virtual-device/vial-handler'
import { writeLE32 } from '../virtual-device/byte-utils'

function req(...bytes: number[]): Uint8Array {
  const buf = new Uint8Array(MSG_LEN)
  buf.set(bytes.slice(0, MSG_LEN))
  return buf
}

const FAKE_COMPRESSED = new Uint8Array(70)
for (let i = 0; i < FAKE_COMPRESSED.length; i++) FAKE_COMPRESSED[i] = (i * 3 + 7) % 256

describe('handleVialReport', () => {
  it('keyboard id: LE32 protocol, UID bytes, VialRGB flag', () => {
    const state = createVirtualDeviceState()
    const resp = handleVialReport(state, req(0xfe, 0x00), FAKE_COMPRESSED, 0)
    const protocol = resp[0] | (resp[1] << 8) | (resp[2] << 16) | (resp[3] << 24)
    expect(protocol).toBe(VIAL_PROTOCOL)
    expect(Array.from(resp.subarray(4, 12))).toEqual(Array.from(VIRTUAL_DEVICE_UID_BYTES))
    expect(resp[12]).toBe(1)
  })

  it('definition size + block reassembly equals the compressed buffer', () => {
    const state = createVirtualDeviceState()
    const sizeResp = handleVialReport(state, req(0xfe, 0x01), FAKE_COMPRESSED, 0)
    const size = sizeResp[0] | (sizeResp[1] << 8) | (sizeResp[2] << 16) | (sizeResp[3] << 24)
    expect(size).toBe(FAKE_COMPRESSED.length)

    const blocks = Math.ceil(size / MSG_LEN)
    const reassembled = new Uint8Array(size)
    for (let block = 0; block < blocks; block++) {
      const blockReq = new Uint8Array(MSG_LEN)
      blockReq[0] = 0xfe
      blockReq[1] = 0x02
      writeLE32(blockReq, 2, block)
      const resp = handleVialReport(state, blockReq, FAKE_COMPRESSED, 0)
      const copyLen = Math.min(MSG_LEN, size - block * MSG_LEN)
      reassembled.set(resp.subarray(0, copyLen), block * MSG_LEN)
    }
    expect(Array.from(reassembled)).toEqual(Array.from(FAKE_COMPRESSED))
  })

  it('unlock status: 0xFF-filled with unlocked/inProgress bytes and combo pairs', () => {
    const state = createVirtualDeviceState()
    const resp = handleVialReport(state, req(0xfe, 0x05), FAKE_COMPRESSED, 0)
    expect(resp[0]).toBe(0) // locked
    expect(resp[1]).toBe(0) // not in progress
    for (let i = 0; i < VIRTUAL_DEVICE_UNLOCK_COMBO.length; i++) {
      expect(resp[2 + i * 2]).toBe(VIRTUAL_DEVICE_UNLOCK_COMBO[i][0])
      expect(resp[3 + i * 2]).toBe(VIRTUAL_DEVICE_UNLOCK_COMBO[i][1])
    }
    // Remaining slots are 0xFF sentinel pairs
    const usedSlots = VIRTUAL_DEVICE_UNLOCK_COMBO.length
    expect(resp[2 + usedSlots * 2]).toBe(0xff)
    expect(resp[3 + usedSlots * 2]).toBe(0xff)
  })

  it('unlock start + poll sequence progresses the counter and eventually unlocks', () => {
    const state = createVirtualDeviceState()
    state.unlockCounterMax = 2
    pressKey(state, 0, 0)
    pressKey(state, 0, 1)

    handleVialReport(state, req(0xfe, 0x06), FAKE_COMPRESSED, 0)
    expect(state.unlockInProgress).toBe(true)

    let resp = handleVialReport(state, req(0xfe, 0x07), FAKE_COMPRESSED, 200)
    expect(resp[0]).toBe(0)
    expect(resp[2]).toBe(1)

    resp = handleVialReport(state, req(0xfe, 0x07), FAKE_COMPRESSED, 400)
    expect(resp[0]).toBe(1)
    expect(resp[2]).toBe(0)
    expect(state.unlocked).toBe(true)
  })

  it('lock resets unlocked to false', () => {
    const state = createVirtualDeviceState()
    state.unlocked = true
    handleVialReport(state, req(0xfe, 0x08), FAKE_COMPRESSED, 0)
    expect(state.unlocked).toBe(false)
  })

  it('qmk settings query returns an all-0xFF response', () => {
    const state = createVirtualDeviceState()
    const resp = handleVialReport(state, req(0xfe, 0x09, 0x00, 0x00), FAKE_COMPRESSED, 0)
    expect(Array.from(resp)).toEqual(new Array(MSG_LEN).fill(0xff))
  })

  it('dynamic entry counts are all zero', () => {
    const state = createVirtualDeviceState()
    const resp = handleVialReport(state, req(0xfe, 0x0d, 0x00), FAKE_COMPRESSED, 0)
    expect(Array.from(resp)).toEqual(new Array(MSG_LEN).fill(0))
  })

  it('encoder get (sub 0x03) is a pure echo', () => {
    const state = createVirtualDeviceState()
    const r = req(0xfe, 0x03, 0, 1)
    const resp = handleVialReport(state, r, FAKE_COMPRESSED, 0)
    expect(resp.subarray(0, 4)).toEqual(r.subarray(0, 4))
  })
})
