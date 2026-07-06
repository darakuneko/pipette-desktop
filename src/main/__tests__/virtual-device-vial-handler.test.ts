// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { MSG_LEN } from '../../shared/constants/protocol'
import { VIAL_PROTOCOL, VIRTUAL_DEVICE_UID_BYTES, VIRTUAL_DEVICE_UNLOCK_COMBO } from '../virtual-device/gpk60-63r'
import { createVirtualDeviceState, pressKey } from '../virtual-device/state'
import { handleVialReport } from '../virtual-device/vial-handler'
import { writeLE32, writeLE16, readLE16 } from '../virtual-device/byte-utils'
import {
  TAP_DANCE_ENTRY_COUNT,
  COMBO_ENTRY_COUNT,
  KEY_OVERRIDE_ENTRY_COUNT,
  ALT_REPEAT_KEY_ENTRY_COUNT,
  DYNAMIC_ENTRY_FEATURE_FLAGS,
} from '../virtual-device/dynamic-entries'
import { SUPPORTED_QSIDS } from '../virtual-device/qmk-settings'

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

  it('qmk settings query returns the full first page of supported qsids, 0xFFFF-padded', () => {
    const state = createVirtualDeviceState()
    const resp = handleVialReport(state, req(0xfe, 0x09, 0x00, 0x00), FAKE_COMPRESSED, 0)
    const firstPage = SUPPORTED_QSIDS.slice(0, 16)
    for (let i = 0; i < firstPage.length; i++) {
      expect(readLE16(resp, i * 2)).toBe(firstPage[i])
    }
    for (let i = firstPage.length; i < 16; i++) {
      expect(readLE16(resp, i * 2)).toBe(0xffff)
    }
  })

  it('qmk settings query second page starts past the last qsid seen and ends in 0xFFFF padding', () => {
    const state = createVirtualDeviceState()
    const lastOfFirstPage = SUPPORTED_QSIDS[15]
    const resp = handleVialReport(
      state,
      req(0xfe, 0x09, lastOfFirstPage & 0xff, (lastOfFirstPage >> 8) & 0xff),
      FAKE_COMPRESSED,
      0,
    )
    const secondPage = SUPPORTED_QSIDS.slice(16)
    for (let i = 0; i < secondPage.length; i++) {
      expect(readLE16(resp, i * 2)).toBe(secondPage[i])
    }
    expect(readLE16(resp, secondPage.length * 2)).toBe(0xffff)
  })

  it('qmk settings get/set round-trips a known qsid (7 = tapping_term) and rejects an unsupported one', () => {
    const state = createVirtualDeviceState()
    const getPkt = req(0xfe, 0x0a, 0x07, 0x00)
    const before = handleVialReport(state, getPkt, FAKE_COMPRESSED, 0)
    expect(before[0]).toBe(0)
    expect(readLE16(before, 1)).toBe(200) // TAPPING_TERM default

    const setPkt = new Uint8Array(MSG_LEN)
    setPkt[0] = 0xfe
    setPkt[1] = 0x0b
    writeLE16(setPkt, 2, 7)
    writeLE16(setPkt, 4, 150)
    const setResp = handleVialReport(state, setPkt, FAKE_COMPRESSED, 0)
    expect(setResp[0]).toBe(0)

    const after = handleVialReport(state, getPkt, FAKE_COMPRESSED, 0)
    expect(readLE16(after, 1)).toBe(150)

    // qsid 8 was never assigned by this vial-qmk version's protos[] table.
    const unsupported = handleVialReport(state, req(0xfe, 0x0a, 0x08, 0x00), FAKE_COMPRESSED, 0)
    expect(unsupported[0]).toBe(0xff)
  })

  it('qmk settings reset restores defaults and echoes the request', () => {
    const state = createVirtualDeviceState()
    const setPkt = new Uint8Array(MSG_LEN)
    setPkt[0] = 0xfe
    setPkt[1] = 0x0b
    writeLE16(setPkt, 2, 7)
    writeLE16(setPkt, 4, 999)
    handleVialReport(state, setPkt, FAKE_COMPRESSED, 0)

    const resetPkt = req(0xfe, 0x0c)
    const resetResp = handleVialReport(state, resetPkt, FAKE_COMPRESSED, 0)
    expect(Array.from(resetResp)).toEqual(Array.from(resetPkt))

    const after = handleVialReport(state, req(0xfe, 0x0a, 0x07, 0x00), FAKE_COMPRESSED, 0)
    expect(readLE16(after, 1)).toBe(200)
  })

  it('dynamic entry counts report the 32-entry tier and caps-word/layer-lock feature flags', () => {
    const state = createVirtualDeviceState()
    const resp = handleVialReport(state, req(0xfe, 0x0d, 0x00), FAKE_COMPRESSED, 0)
    expect(resp[0]).toBe(TAP_DANCE_ENTRY_COUNT)
    expect(resp[1]).toBe(COMBO_ENTRY_COUNT)
    expect(resp[2]).toBe(KEY_OVERRIDE_ENTRY_COUNT)
    expect(resp[3]).toBe(ALT_REPEAT_KEY_ENTRY_COUNT)
    expect(resp[MSG_LEN - 1]).toBe(DYNAMIC_ENTRY_FEATURE_FLAGS)
  })

  it('tap dance get returns the seeded sample at index 0 and a zero entry out of range', () => {
    const state = createVirtualDeviceState()
    const resp = handleVialReport(state, req(0xfe, 0x0d, 0x01, 0x00), FAKE_COMPRESSED, 0)
    expect(resp[0]).toBe(0)
    expect(readLE16(resp, 1)).not.toBe(0) // onTap = KC_A, non-zero

    const outOfRange = handleVialReport(state, req(0xfe, 0x0d, 0x01, 32), FAKE_COMPRESSED, 0)
    expect(outOfRange[0]).toBe(0xff)
    expect(Array.from(outOfRange.subarray(1, 11))).toEqual(new Array(10).fill(0))
  })

  it('tap dance set stores an entry and blocks QK_BOOT while locked', () => {
    const state = createVirtualDeviceState()
    expect(state.unlocked).toBe(false)
    const setPkt = new Uint8Array(MSG_LEN)
    setPkt[0] = 0xfe
    setPkt[1] = 0x0d
    setPkt[2] = 0x02
    setPkt[3] = 5
    writeLE16(setPkt, 4, 0x7c00) // QK_BOOT (protocol v6)
    writeLE16(setPkt, 6, 0)
    writeLE16(setPkt, 8, 0)
    writeLE16(setPkt, 10, 0)
    writeLE16(setPkt, 12, 200)
    const setResp = handleVialReport(state, setPkt, FAKE_COMPRESSED, 0)
    expect(setResp[0]).toBe(0)

    const getResp = handleVialReport(state, req(0xfe, 0x0d, 0x01, 5), FAKE_COMPRESSED, 0)
    expect(readLE16(getResp, 1)).toBe(0) // QK_BOOT replaced with KC_NO while locked
  })

  it('tap dance set stores QK_BOOT unchanged once unlocked', () => {
    const state = createVirtualDeviceState()
    state.unlocked = true
    const setPkt = new Uint8Array(MSG_LEN)
    setPkt[0] = 0xfe
    setPkt[1] = 0x0d
    setPkt[2] = 0x02
    setPkt[3] = 6
    writeLE16(setPkt, 4, 0x7c00) // QK_BOOT (protocol v6)
    writeLE16(setPkt, 6, 0)
    writeLE16(setPkt, 8, 0)
    writeLE16(setPkt, 10, 0)
    writeLE16(setPkt, 12, 200)
    const setResp = handleVialReport(state, setPkt, FAKE_COMPRESSED, 0)
    expect(setResp[0]).toBe(0)

    const getResp = handleVialReport(state, req(0xfe, 0x0d, 0x01, 6), FAKE_COMPRESSED, 0)
    expect(readLE16(getResp, 1)).toBe(0x7c00) // QK_BOOT stored unchanged once unlocked
  })

  it('combo set/get round-trips and out-of-range index is rejected', () => {
    const state = createVirtualDeviceState()
    const setPkt = new Uint8Array(MSG_LEN)
    setPkt[0] = 0xfe
    setPkt[1] = 0x0d
    setPkt[2] = 0x04
    setPkt[3] = 1
    writeLE16(setPkt, 4, 1)
    writeLE16(setPkt, 6, 2)
    writeLE16(setPkt, 8, 0)
    writeLE16(setPkt, 10, 0)
    writeLE16(setPkt, 12, 41)
    expect(handleVialReport(state, setPkt, FAKE_COMPRESSED, 0)[0]).toBe(0)

    const getResp = handleVialReport(state, req(0xfe, 0x0d, 0x03, 1), FAKE_COMPRESSED, 0)
    expect(readLE16(getResp, 1)).toBe(1)
    expect(readLE16(getResp, 9)).toBe(41)

    const badIdx = new Uint8Array(setPkt)
    badIdx[3] = 32
    expect(handleVialReport(state, badIdx, FAKE_COMPRESSED, 0)[0]).toBe(0xff)
  })

  it('combo set blocks QK_BOOT in output while locked, condition keys untouched', () => {
    const state = createVirtualDeviceState()
    expect(state.unlocked).toBe(false)
    const setPkt = new Uint8Array(MSG_LEN)
    setPkt[0] = 0xfe
    setPkt[1] = 0x0d
    setPkt[2] = 0x04
    setPkt[3] = 2
    writeLE16(setPkt, 4, 1)
    writeLE16(setPkt, 6, 2)
    writeLE16(setPkt, 8, 0)
    writeLE16(setPkt, 10, 0)
    writeLE16(setPkt, 12, 0x7c00) // QK_BOOT output
    expect(handleVialReport(state, setPkt, FAKE_COMPRESSED, 0)[0]).toBe(0)

    const getResp = handleVialReport(state, req(0xfe, 0x0d, 0x03, 2), FAKE_COMPRESSED, 0)
    expect(readLE16(getResp, 9)).toBe(0) // output replaced with KC_NO while locked
    expect(readLE16(getResp, 1)).toBe(1) // condition keycodes are not gated by vial.c's firewall
  })

  it('key override get exposes the seeded sample enabled bit and combined options byte', () => {
    const state = createVirtualDeviceState()
    const resp = handleVialReport(state, req(0xfe, 0x0d, 0x05, 0x00), FAKE_COMPRESSED, 0)
    expect(resp[0]).toBe(0)
    const optionsByte = resp[10]
    expect((optionsByte & 0x80) !== 0).toBe(true) // enabled
    expect(optionsByte & 0x7f).toBe(0x07)
  })

  it('key override set blocks QK_BOOT in replacement while locked, trigger key untouched', () => {
    const state = createVirtualDeviceState()
    expect(state.unlocked).toBe(false)
    const setPkt = new Uint8Array(MSG_LEN)
    setPkt[0] = 0xfe
    setPkt[1] = 0x0d
    setPkt[2] = 0x06
    setPkt[3] = 1
    writeLE16(setPkt, 4, 4) // triggerKey
    writeLE16(setPkt, 6, 0x7c00) // replacementKey = QK_BOOT
    writeLE16(setPkt, 8, 0) // layers
    setPkt[10] = 0 // triggerMods
    setPkt[11] = 0 // negativeMods
    setPkt[12] = 0 // suppressedMods
    setPkt[13] = 0x80 // enabled bit only
    expect(handleVialReport(state, setPkt, FAKE_COMPRESSED, 0)[0]).toBe(0)

    const getResp = handleVialReport(state, req(0xfe, 0x0d, 0x05, 1), FAKE_COMPRESSED, 0)
    expect(readLE16(getResp, 3)).toBe(0) // replacement replaced with KC_NO while locked
    expect(readLE16(getResp, 1)).toBe(4) // trigger key is not gated by vial.c's firewall
  })

  it('alt repeat key set/get round-trips through the 6-byte wire entry', () => {
    const state = createVirtualDeviceState()
    const setPkt = new Uint8Array(MSG_LEN)
    setPkt[0] = 0xfe
    setPkt[1] = 0x0d
    setPkt[2] = 0x08
    setPkt[3] = 2
    writeLE16(setPkt, 4, 4)
    writeLE16(setPkt, 6, 5)
    setPkt[8] = 0
    setPkt[9] = 0x08 // enabled bit only
    expect(handleVialReport(state, setPkt, FAKE_COMPRESSED, 0)[0]).toBe(0)

    const getResp = handleVialReport(state, req(0xfe, 0x0d, 0x07, 2), FAKE_COMPRESSED, 0)
    expect(readLE16(getResp, 1)).toBe(4)
    expect(readLE16(getResp, 3)).toBe(5)
    expect((getResp[6] & 0x08) !== 0).toBe(true)
  })

  it('alt repeat key set blocks QK_BOOT in both keycode and alt keycode while locked', () => {
    const state = createVirtualDeviceState()
    expect(state.unlocked).toBe(false)
    const setPkt = new Uint8Array(MSG_LEN)
    setPkt[0] = 0xfe
    setPkt[1] = 0x0d
    setPkt[2] = 0x08
    setPkt[3] = 3
    writeLE16(setPkt, 4, 0x7c00) // lastKey = QK_BOOT
    writeLE16(setPkt, 6, 0x7c00) // altKey = QK_BOOT
    setPkt[8] = 0
    setPkt[9] = 0x08 // enabled bit only
    expect(handleVialReport(state, setPkt, FAKE_COMPRESSED, 0)[0]).toBe(0)

    const getResp = handleVialReport(state, req(0xfe, 0x0d, 0x07, 3), FAKE_COMPRESSED, 0)
    expect(readLE16(getResp, 1)).toBe(0) // lastKey replaced with KC_NO while locked
    expect(readLE16(getResp, 3)).toBe(0) // altKey replaced with KC_NO while locked
  })

  it('encoder get (sub 0x03) is a pure echo', () => {
    const state = createVirtualDeviceState()
    const r = req(0xfe, 0x03, 0, 1)
    const resp = handleVialReport(state, r, FAKE_COMPRESSED, 0)
    expect(resp.subarray(0, 4)).toEqual(r.subarray(0, 4))
  })
})
