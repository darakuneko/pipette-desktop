// SPDX-License-Identifier: GPL-2.0-or-later

import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('../hid-transport', () => ({
  sendReceive: vi.fn(),
}))

import { sendReceive } from '../hid-transport'
import type { Mock } from 'vitest'

import {
  getProtocolVersion,
  getLayerCount,
  getKeymapBuffer,
  setKeycode,
  getLayoutOptions,
  setLayoutOptions,
  getMacroCount,
  getMacroBufferSize,
  getMacroBuffer,
  setMacroBuffer,
  getLightingValue,
  setLightingValue,
  saveLighting,
  getMatrixState,
  getKeyboardId,
  getDefinitionSize,
  getDefinitionRaw,
  getEncoder,
  setEncoder,
  getUnlockStatus,
  unlockStart,
  unlockPoll,
  lock,
  getDynamicEntryCount,
  getTapDance,
  setTapDance,
  getCombo,
  setCombo,
  getKeyOverride,
  setKeyOverride,
  getAltRepeatKey,
  setAltRepeatKey,
  qmkSettingsQuery,
  qmkSettingsGet,
  qmkSettingsSet,
  qmkSettingsReset,
} from '../protocol'

const mockSendReceive = sendReceive as Mock

// Helper: build a 32-byte response Uint8Array with specified bytes at the start
function resp(...bytes: number[]): Uint8Array {
  const r = new Uint8Array(32)
  bytes.forEach((b, i) => {
    r[i] = b
  })
  return r
}

// Helper: extract the sent packet from the first call argument
function sentPacket(callIndex = 0): Uint8Array {
  return mockSendReceive.mock.calls[callIndex][0] as Uint8Array
}

beforeEach(() => {
  vi.clearAllMocks()
})

// =====================================================================
// VIA Protocol Commands
// =====================================================================

describe('VIA Protocol Commands', () => {
  describe('getProtocolVersion', () => {
    it('sends [0x01, 0...] and parses BE16 from resp[1..2]', async () => {
      // Protocol version 0x090A = 2314
      mockSendReceive.mockResolvedValueOnce(resp(0x01, 0x09, 0x0a))

      const version = await getProtocolVersion()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x01)
      expect(pkt.length).toBe(32)
      // Remaining bytes should be zero
      for (let i = 1; i < 32; i++) expect(pkt[i]).toBe(0)
      expect(version).toBe(0x090a)
    })
  })

  describe('getLayerCount', () => {
    it('sends [0x11, 0...] and returns resp[1]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp(0x11, 4))

      const count = await getLayerCount()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x11)
      expect(count).toBe(4)
    })
  })

  describe('getKeymapBuffer', () => {
    it('sends [0x12, offset_BE16, size] and returns resp.subarray(4, 4+size)', async () => {
      const offset = 0x0100 // 256
      const size = 10
      const responseData = resp(0x12, 0x01, 0x00, 10)
      // Fill response data bytes at positions 4..13
      for (let i = 0; i < size; i++) responseData[4 + i] = 0xa0 + i
      mockSendReceive.mockResolvedValueOnce(responseData)

      const data = await getKeymapBuffer(offset, size)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x12)
      // offset BE16: 0x0100
      expect(pkt[1]).toBe(0x01)
      expect(pkt[2]).toBe(0x00)
      expect(pkt[3]).toBe(10)
      expect(data).toEqual(Array.from({ length: 10 }, (_, i) => 0xa0 + i))
    })
  })

  describe('setKeycode', () => {
    it('sends [0x05, layer, row, col, keycode_BE16]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await setKeycode(2, 3, 4, 0x1234)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x05)
      expect(pkt[1]).toBe(2)
      expect(pkt[2]).toBe(3)
      expect(pkt[3]).toBe(4)
      // keycode BE16: 0x1234
      expect(pkt[4]).toBe(0x12)
      expect(pkt[5]).toBe(0x34)
    })
  })

  describe('getLayoutOptions', () => {
    it('sends [0x02, 0x02, 0...] and parses BE32 from resp[2..5]', async () => {
      // Layout options = 0xDEADBEEF
      mockSendReceive.mockResolvedValueOnce(resp(0x02, 0x02, 0xde, 0xad, 0xbe, 0xef))

      const options = await getLayoutOptions()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x02)
      expect(pkt[1]).toBe(0x02)
      expect(options).toBe(0xdeadbeef)
    })
  })

  describe('setLayoutOptions', () => {
    it('sends [0x03, 0x02, options_BE32]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await setLayoutOptions(0xcafebabe)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x03)
      expect(pkt[1]).toBe(0x02)
      // BE32: 0xCAFEBABE
      expect(pkt[2]).toBe(0xca)
      expect(pkt[3]).toBe(0xfe)
      expect(pkt[4]).toBe(0xba)
      expect(pkt[5]).toBe(0xbe)
    })
  })

  describe('getMacroCount', () => {
    it('sends [0x0c] and returns resp[1]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp(0x0c, 16))

      const count = await getMacroCount()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x0c)
      expect(count).toBe(16)
    })
  })

  describe('getMacroBufferSize', () => {
    it('sends [0x0d] and parses BE16 from resp[1..2]', async () => {
      // Buffer size = 0x0200 = 512
      mockSendReceive.mockResolvedValueOnce(resp(0x0d, 0x02, 0x00))

      const size = await getMacroBufferSize()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x0d)
      expect(size).toBe(512)
    })
  })

  describe('getMacroBuffer', () => {
    it('fetches 28-byte chunks; totalSize=60 produces 3 chunks (28+28+4)', async () => {
      const totalSize = 60

      // Chunk 0: offset=0, size=28
      const resp0 = new Uint8Array(32)
      for (let i = 0; i < 28; i++) resp0[4 + i] = i
      mockSendReceive.mockResolvedValueOnce(resp0)

      // Chunk 1: offset=28, size=28
      const resp1 = new Uint8Array(32)
      for (let i = 0; i < 28; i++) resp1[4 + i] = 28 + i
      mockSendReceive.mockResolvedValueOnce(resp1)

      // Chunk 2: offset=56, size=4
      const resp2 = new Uint8Array(32)
      for (let i = 0; i < 4; i++) resp2[4 + i] = 56 + i
      mockSendReceive.mockResolvedValueOnce(resp2)

      const buffer = await getMacroBuffer(totalSize)

      expect(mockSendReceive).toHaveBeenCalledTimes(3)

      // Verify chunk 0 packet: [0x0e, offset_BE16(0,0), 28]
      const pkt0 = sentPacket(0)
      expect(pkt0[0]).toBe(0x0e)
      expect(pkt0[1]).toBe(0x00)
      expect(pkt0[2]).toBe(0x00)
      expect(pkt0[3]).toBe(28)

      // Verify chunk 1 packet: [0x0e, offset_BE16(0,28), 28]
      const pkt1 = sentPacket(1)
      expect(pkt1[0]).toBe(0x0e)
      expect(pkt1[1]).toBe(0x00)
      expect(pkt1[2]).toBe(28)
      expect(pkt1[3]).toBe(28)

      // Verify chunk 2 packet: [0x0e, offset_BE16(0,56), 4]
      const pkt2 = sentPacket(2)
      expect(pkt2[0]).toBe(0x0e)
      expect(pkt2[1]).toBe(0x00)
      expect(pkt2[2]).toBe(56)
      expect(pkt2[3]).toBe(4)

      // Verify returned buffer is 0..59
      expect(buffer).toHaveLength(60)
      expect(buffer).toEqual(Array.from({ length: 60 }, (_, i) => i))
    })

    it('encodes large offsets > 255 correctly as BE16', async () => {
      // totalSize=300: chunk at offset 280 (0x0118) should encode as BE16 [0x01, 0x18]
      const totalSize = 300
      const chunkCount = Math.ceil(totalSize / 28) // 11 chunks

      for (let c = 0; c < chunkCount; c++) {
        const r = new Uint8Array(32)
        mockSendReceive.mockResolvedValueOnce(r)
      }

      await getMacroBuffer(totalSize)

      // Check chunk at offset 280 (index 10): BE16 should be [0x01, 0x18]
      const pkt10 = sentPacket(10)
      expect(pkt10[0]).toBe(0x0e) // CMD_VIA_MACRO_GET_BUFFER
      expect(pkt10[1]).toBe(0x01) // high byte of 280
      expect(pkt10[2]).toBe(0x18) // low byte of 280
      expect(pkt10[3]).toBe(totalSize - 280) // remaining 20 bytes
    })

    it('returns empty array and makes no calls for zero-length buffer', async () => {
      const result = await getMacroBuffer(0)

      expect(result).toEqual([])
      expect(mockSendReceive).not.toHaveBeenCalled()
    })
  })

  describe('setMacroBuffer', () => {
    it('makes no calls for empty data array', async () => {
      await setMacroBuffer([])

      expect(mockSendReceive).not.toHaveBeenCalled()
    })

    it('writes 28-byte chunks; 60 bytes produces 3 chunks (28+28+4)', async () => {
      const data = Array.from({ length: 60 }, (_, i) => i)
      mockSendReceive.mockResolvedValue(resp())

      await setMacroBuffer(data)

      expect(mockSendReceive).toHaveBeenCalledTimes(3)

      // Chunk 0: [0x0f, offset_BE16(0,0), 28, data[0..27]]
      const pkt0 = sentPacket(0)
      expect(pkt0[0]).toBe(0x0f)
      expect(pkt0[1]).toBe(0x00)
      expect(pkt0[2]).toBe(0x00)
      expect(pkt0[3]).toBe(28)
      for (let i = 0; i < 28; i++) expect(pkt0[4 + i]).toBe(i)

      // Chunk 1: [0x0f, offset_BE16(0,28), 28, data[28..55]]
      const pkt1 = sentPacket(1)
      expect(pkt1[0]).toBe(0x0f)
      expect(pkt1[1]).toBe(0x00)
      expect(pkt1[2]).toBe(28)
      expect(pkt1[3]).toBe(28)
      for (let i = 0; i < 28; i++) expect(pkt1[4 + i]).toBe(28 + i)

      // Chunk 2: [0x0f, offset_BE16(0,56), 4, data[56..59]]
      const pkt2 = sentPacket(2)
      expect(pkt2[0]).toBe(0x0f)
      expect(pkt2[1]).toBe(0x00)
      expect(pkt2[2]).toBe(56)
      expect(pkt2[3]).toBe(4)
      for (let i = 0; i < 4; i++) expect(pkt2[4 + i]).toBe(56 + i)
    })
  })

  describe('getLightingValue', () => {
    it('sends [0x08, id] and returns resp.subarray(2)', async () => {
      const response = resp(0x08, 0x09, 0x80, 0x40, 0x20)
      mockSendReceive.mockResolvedValueOnce(response)

      const value = await getLightingValue(0x09)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x08)
      expect(pkt[1]).toBe(0x09)
      // subarray(2) returns 30 bytes from offset 2
      expect(value).toHaveLength(30)
      expect(value[0]).toBe(0x80)
      expect(value[1]).toBe(0x40)
      expect(value[2]).toBe(0x20)
    })
  })

  describe('setLightingValue', () => {
    it('sends [0x07, id, ...args]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await setLightingValue(0x83, 0x10, 0x20)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x07)
      expect(pkt[1]).toBe(0x83)
      expect(pkt[2]).toBe(0x10)
      expect(pkt[3]).toBe(0x20)
    })
  })

  describe('saveLighting', () => {
    it('sends [0x09]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await saveLighting()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x09)
      for (let i = 1; i < 32; i++) expect(pkt[i]).toBe(0)
    })
  })

  describe('getMatrixState', () => {
    it('sends [0x02, 0x03] and returns resp.subarray(2)', async () => {
      const response = resp(0x02, 0x03, 0xff, 0x00, 0xab)
      mockSendReceive.mockResolvedValueOnce(response)

      const state = await getMatrixState()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0x02)
      expect(pkt[1]).toBe(0x03)
      expect(state).toHaveLength(30)
      expect(state[0]).toBe(0xff)
      expect(state[1]).toBe(0x00)
      expect(state[2]).toBe(0xab)
    })
  })
})

// =====================================================================
// Vial Protocol Commands (0xFE prefix)
// =====================================================================

describe('Vial Protocol Commands', () => {
  describe('getKeyboardId', () => {
    it('sends [0xFE, 0x00] and parses LE32 vialProtocol + LE64 uid hex', async () => {
      const response = new Uint8Array(32)
      // vialProtocol LE32 at [0..3]: 0x00000006 = 6
      response[0] = 0x06
      response[1] = 0x00
      response[2] = 0x00
      response[3] = 0x00
      // uid LE64 at [4..11]: bytes [0x07, 0x30, 0xB0, 0xD3, 0xBF, 0x7B, 0x86, 0x0A]
      // LE64 hex = 0x0a867bbfd3b03007
      response[4] = 0x07
      response[5] = 0x30
      response[6] = 0xb0
      response[7] = 0xd3
      response[8] = 0xbf
      response[9] = 0x7b
      response[10] = 0x86
      response[11] = 0x0a
      mockSendReceive.mockResolvedValueOnce(response)

      const id = await getKeyboardId()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x00)
      expect(id.vialProtocol).toBe(6)
      expect(id.uid).toBe('0x0a867bbfd3b03007')
    })
  })

  describe('getDefinitionSize', () => {
    it('sends [0xFE, 0x01] and parses LE32 from resp[0..3]', async () => {
      // Size = 0x00001234 = 4660 in LE32
      mockSendReceive.mockResolvedValueOnce(resp(0x34, 0x12, 0x00, 0x00))

      const size = await getDefinitionSize()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x01)
      expect(size).toBe(0x1234)
    })
  })

  describe('getDefinitionRaw', () => {
    it('fetches MSG_LEN-sized blocks; size=70 produces 3 blocks', async () => {
      const size = 70

      // Block 0: 32 bytes
      const blockResp0 = new Uint8Array(32)
      for (let i = 0; i < 32; i++) blockResp0[i] = i
      mockSendReceive.mockResolvedValueOnce(blockResp0)

      // Block 1: 32 bytes
      const blockResp1 = new Uint8Array(32)
      for (let i = 0; i < 32; i++) blockResp1[i] = 32 + i
      mockSendReceive.mockResolvedValueOnce(blockResp1)

      // Block 2: 6 bytes of real data (70 - 64 = 6), rest zero
      const blockResp2 = new Uint8Array(32)
      for (let i = 0; i < 6; i++) blockResp2[i] = 64 + i
      mockSendReceive.mockResolvedValueOnce(blockResp2)

      const data = await getDefinitionRaw(size)

      expect(mockSendReceive).toHaveBeenCalledTimes(3)

      // Verify block 0 packet: [0xFE, 0x02, block_LE32(0)]
      const pkt0 = sentPacket(0)
      expect(pkt0[0]).toBe(0xfe)
      expect(pkt0[1]).toBe(0x02)
      expect(pkt0[2]).toBe(0x00) // block 0 LE32
      expect(pkt0[3]).toBe(0x00)
      expect(pkt0[4]).toBe(0x00)
      expect(pkt0[5]).toBe(0x00)

      // Verify block 1 packet: [0xFE, 0x02, block_LE32(1)]
      const pkt1 = sentPacket(1)
      expect(pkt1[0]).toBe(0xfe)
      expect(pkt1[1]).toBe(0x02)
      expect(pkt1[2]).toBe(0x01)
      expect(pkt1[3]).toBe(0x00)
      expect(pkt1[4]).toBe(0x00)
      expect(pkt1[5]).toBe(0x00)

      // Verify block 2 packet: [0xFE, 0x02, block_LE32(2)]
      const pkt2 = sentPacket(2)
      expect(pkt2[0]).toBe(0xfe)
      expect(pkt2[1]).toBe(0x02)
      expect(pkt2[2]).toBe(0x02)
      expect(pkt2[3]).toBe(0x00)
      expect(pkt2[4]).toBe(0x00)
      expect(pkt2[5]).toBe(0x00)

      // Verify returned data is 0..69
      expect(data).toHaveLength(70)
      for (let i = 0; i < 70; i++) {
        expect(data[i]).toBe(i)
      }
    })

    it('returns empty Uint8Array and makes no calls for size 0', async () => {
      const data = await getDefinitionRaw(0)

      expect(data).toBeInstanceOf(Uint8Array)
      expect(data).toHaveLength(0)
      expect(mockSendReceive).not.toHaveBeenCalled()
    })
  })

  describe('getEncoder', () => {
    it('sends [0xFE, 0x03, layer, idx] and returns [BE16 cw, BE16 ccw]', async () => {
      // CW keycode = 0x0041 (KC_A), CCW keycode = 0x0042 (KC_B)
      mockSendReceive.mockResolvedValueOnce(resp(0x00, 0x41, 0x00, 0x42))

      const [cw, ccw] = await getEncoder(1, 0)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x03)
      expect(pkt[2]).toBe(1)
      expect(pkt[3]).toBe(0)
      expect(cw).toBe(0x0041)
      expect(ccw).toBe(0x0042)
    })
  })

  describe('setEncoder', () => {
    it('sends [0xFE, 0x04, layer, idx, direction, keycode_BE16]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await setEncoder(2, 1, 0, 0x1234)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x04)
      expect(pkt[2]).toBe(2) // layer
      expect(pkt[3]).toBe(1) // encoder index
      expect(pkt[4]).toBe(0) // direction
      // keycode BE16: 0x1234
      expect(pkt[5]).toBe(0x12)
      expect(pkt[6]).toBe(0x34)
    })
  })

  describe('getUnlockStatus', () => {
    it('parses unlocked=true, inProgress=false, and key pairs, skipping 0xFF,0xFF', async () => {
      const response = new Uint8Array(32)
      response[0] = 1 // unlocked
      response[1] = 0 // not in progress
      // Key pair 0: row=2, col=3
      response[2] = 2
      response[3] = 3
      // Key pair 1: row=4, col=5
      response[4] = 4
      response[5] = 5
      // Key pair 2: unused (0xFF, 0xFF)
      response[6] = 0xff
      response[7] = 0xff
      // Fill remaining with 0xFF
      for (let i = 8; i < 32; i++) response[i] = 0xff
      mockSendReceive.mockResolvedValueOnce(response)

      const status = await getUnlockStatus()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x05)
      expect(status.unlocked).toBe(true)
      expect(status.inProgress).toBe(false)
      expect(status.keys).toEqual([
        [2, 3],
        [4, 5],
      ])
    })

    it('parses unlocked=false, inProgress=true with no valid keys', async () => {
      const response = new Uint8Array(32)
      response[0] = 0 // locked
      response[1] = 1 // in progress
      // All key pairs unused
      for (let i = 2; i < 32; i++) response[i] = 0xff
      mockSendReceive.mockResolvedValueOnce(response)

      const status = await getUnlockStatus()

      expect(status.unlocked).toBe(false)
      expect(status.inProgress).toBe(true)
      expect(status.keys).toEqual([])
    })
  })

  describe('unlockStart', () => {
    it('sends [0xFE, 0x06]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await unlockStart()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x06)
    })
  })

  describe('unlockPoll', () => {
    it('sends [0xFE, 0x07] and returns Array.from(resp)', async () => {
      const response = resp(1, 0, 42)
      mockSendReceive.mockResolvedValueOnce(response)

      const result = await unlockPoll()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x07)
      expect(result).toHaveLength(32)
      expect(result[0]).toBe(1)
      expect(result[1]).toBe(0)
      expect(result[2]).toBe(42)
    })
  })

  describe('lock', () => {
    it('sends [0xFE, 0x08]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await lock()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x08)
    })
  })
})

// =====================================================================
// Dynamic Entry Commands
// =====================================================================

describe('Dynamic Entry Commands', () => {
  describe('getDynamicEntryCount', () => {
    it('sends [0xFE, 0x0d, 0x00] and returns counts from resp[0..3] and feature flags from last byte', async () => {
      mockSendReceive.mockResolvedValueOnce(resp(8, 4, 2, 1))

      const counts = await getDynamicEntryCount()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0d)
      expect(pkt[2]).toBe(0x00)
      expect(counts).toEqual({
        tapDance: 8,
        combo: 4,
        keyOverride: 2,
        altRepeatKey: 1,
        featureFlags: 0,
      })
    })

    it('reads feature flags from the last byte of the response', async () => {
      const response = new Uint8Array(32)
      response[0] = 3 // tapDance
      response[1] = 2 // combo
      response[2] = 1 // keyOverride
      response[3] = 0 // altRepeatKey
      response[31] = 0x03 // caps_word + layer_lock
      mockSendReceive.mockResolvedValueOnce(response)

      const counts = await getDynamicEntryCount()

      expect(counts.featureFlags).toBe(0x03)
    })
  })

  describe('getTapDance', () => {
    it('sends [0xFE, 0x0d, 0x01, index] and reads 5x LE16 on success', async () => {
      const response = new Uint8Array(32)
      response[0] = 0 // status: ok
      // onTap LE16 at [1..2]: 0x0041
      response[1] = 0x41
      response[2] = 0x00
      // onHold LE16 at [3..4]: 0x0042
      response[3] = 0x42
      response[4] = 0x00
      // onDoubleTap LE16 at [5..6]: 0x0043
      response[5] = 0x43
      response[6] = 0x00
      // onTapHold LE16 at [7..8]: 0x0044
      response[7] = 0x44
      response[8] = 0x00
      // tappingTerm LE16 at [9..10]: 200 = 0x00C8
      response[9] = 0xc8
      response[10] = 0x00
      mockSendReceive.mockResolvedValueOnce(response)

      const entry = await getTapDance(3)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0d)
      expect(pkt[2]).toBe(0x01)
      expect(pkt[3]).toBe(3)
      expect(entry).toEqual({
        onTap: 0x0041,
        onHold: 0x0042,
        onDoubleTap: 0x0043,
        onTapHold: 0x0044,
        tappingTerm: 200,
      })
    })

    it('throws when resp[0] != 0', async () => {
      const response = new Uint8Array(32)
      response[0] = 1 // status: error
      mockSendReceive.mockResolvedValueOnce(response)

      await expect(getTapDance(5)).rejects.toThrow('Failed to get tap dance entry 5')
    })
  })

  describe('setTapDance', () => {
    it('sends [0xFE, 0x0d, 0x02, index, 5x LE16 fields]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await setTapDance(2, {
        onTap: 0x0041,
        onHold: 0x0042,
        onDoubleTap: 0x0043,
        onTapHold: 0x0044,
        tappingTerm: 200,
      })

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0d)
      expect(pkt[2]).toBe(0x02)
      expect(pkt[3]).toBe(2)
      // onTap LE16 at [4..5]
      expect(pkt[4]).toBe(0x41)
      expect(pkt[5]).toBe(0x00)
      // onHold LE16 at [6..7]
      expect(pkt[6]).toBe(0x42)
      expect(pkt[7]).toBe(0x00)
      // onDoubleTap LE16 at [8..9]
      expect(pkt[8]).toBe(0x43)
      expect(pkt[9]).toBe(0x00)
      // onTapHold LE16 at [10..11]
      expect(pkt[10]).toBe(0x44)
      expect(pkt[11]).toBe(0x00)
      // tappingTerm LE16 at [12..13]: 200 = 0xC8, 0x00
      expect(pkt[12]).toBe(0xc8)
      expect(pkt[13]).toBe(0x00)
    })
  })

  describe('getCombo', () => {
    it('sends [0xFE, 0x0d, 0x03, index] and reads 5x LE16 on success', async () => {
      const response = new Uint8Array(32)
      response[0] = 0 // status: ok
      // key1 LE16: 0x0004 (KC_A)
      response[1] = 0x04
      response[2] = 0x00
      // key2 LE16: 0x0005 (KC_B)
      response[3] = 0x05
      response[4] = 0x00
      // key3 LE16: 0x0006
      response[5] = 0x06
      response[6] = 0x00
      // key4 LE16: 0x0000 (unused)
      response[7] = 0x00
      response[8] = 0x00
      // output LE16: 0x0029 (KC_ESCAPE)
      response[9] = 0x29
      response[10] = 0x00
      mockSendReceive.mockResolvedValueOnce(response)

      const entry = await getCombo(1)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0d)
      expect(pkt[2]).toBe(0x03)
      expect(pkt[3]).toBe(1)
      expect(entry).toEqual({
        key1: 0x0004,
        key2: 0x0005,
        key3: 0x0006,
        key4: 0x0000,
        output: 0x0029,
      })
    })

    it('throws when resp[0] != 0', async () => {
      const response = new Uint8Array(32)
      response[0] = 1
      mockSendReceive.mockResolvedValueOnce(response)

      await expect(getCombo(7)).rejects.toThrow('Failed to get combo entry 7')
    })
  })

  describe('setCombo', () => {
    it('sends packet with 5x LE16 combo fields', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await setCombo(0, {
        key1: 0x0004,
        key2: 0x0005,
        key3: 0x0006,
        key4: 0x0000,
        output: 0x0029,
      })

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0d)
      expect(pkt[2]).toBe(0x04) // DYNAMIC_VIAL_COMBO_SET
      expect(pkt[3]).toBe(0) // index
      // key1 LE16
      expect(pkt[4]).toBe(0x04)
      expect(pkt[5]).toBe(0x00)
      // key2 LE16
      expect(pkt[6]).toBe(0x05)
      expect(pkt[7]).toBe(0x00)
      // key3 LE16
      expect(pkt[8]).toBe(0x06)
      expect(pkt[9]).toBe(0x00)
      // key4 LE16
      expect(pkt[10]).toBe(0x00)
      expect(pkt[11]).toBe(0x00)
      // output LE16
      expect(pkt[12]).toBe(0x29)
      expect(pkt[13]).toBe(0x00)
    })
  })

  describe('getKeyOverride', () => {
    it('sends [0xFE, 0x0d, 0x05, index] and parses fields with enabled from bit 7', async () => {
      const response = new Uint8Array(32)
      response[0] = 0 // status: ok
      // triggerKey LE16 at [1..2]: 0x0041
      response[1] = 0x41
      response[2] = 0x00
      // replacementKey LE16 at [3..4]: 0x0042
      response[3] = 0x42
      response[4] = 0x00
      // layers LE16 at [5..6]: 0x000F (layers 0-3)
      response[5] = 0x0f
      response[6] = 0x00
      // triggerMods u8 at [7]: 0x01
      response[7] = 0x01
      // negativeMods u8 at [8]: 0x02
      response[8] = 0x02
      // suppressedMods u8 at [9]: 0x04
      response[9] = 0x04
      // options u8 at [10]: 0x85 → enabled = (0x85 & 0x80) != 0 = true, options = 0x85 & 0x7F = 0x05
      response[10] = 0x85
      mockSendReceive.mockResolvedValueOnce(response)

      const entry = await getKeyOverride(0)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0d)
      expect(pkt[2]).toBe(0x05)
      expect(pkt[3]).toBe(0)
      expect(entry).toEqual({
        triggerKey: 0x0041,
        replacementKey: 0x0042,
        layers: 0x000f,
        triggerMods: 0x01,
        negativeMods: 0x02,
        suppressedMods: 0x04,
        options: 0x05,
        enabled: true,
      })
    })

    it('parses enabled=false when bit 7 is 0', async () => {
      const response = new Uint8Array(32)
      response[0] = 0 // ok
      response[1] = 0x10
      response[2] = 0x00
      response[3] = 0x20
      response[4] = 0x00
      response[5] = 0xff
      response[6] = 0x00
      response[7] = 0x00
      response[8] = 0x00
      response[9] = 0x00
      response[10] = 0x03 // bit 7 = 0, so enabled = false, options = 0x03
      mockSendReceive.mockResolvedValueOnce(response)

      const entry = await getKeyOverride(1)

      expect(entry.enabled).toBe(false)
      expect(entry.options).toBe(0x03)
    })

    it('throws when resp[0] != 0', async () => {
      const response = new Uint8Array(32)
      response[0] = 1
      mockSendReceive.mockResolvedValueOnce(response)

      await expect(getKeyOverride(2)).rejects.toThrow('Failed to get key override entry 2')
    })
  })

  describe('setKeyOverride', () => {
    it('sends packet with LE16 fields and options byte with enabled in bit 7', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await setKeyOverride(3, {
        triggerKey: 0x0041,
        replacementKey: 0x0042,
        layers: 0x000f,
        triggerMods: 0x01,
        negativeMods: 0x02,
        suppressedMods: 0x04,
        options: 0x05,
        enabled: true,
      })

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0d)
      expect(pkt[2]).toBe(0x06) // DYNAMIC_VIAL_KEY_OVERRIDE_SET
      expect(pkt[3]).toBe(3) // index
      // triggerKey LE16
      expect(pkt[4]).toBe(0x41)
      expect(pkt[5]).toBe(0x00)
      // replacementKey LE16
      expect(pkt[6]).toBe(0x42)
      expect(pkt[7]).toBe(0x00)
      // layers LE16
      expect(pkt[8]).toBe(0x0f)
      expect(pkt[9]).toBe(0x00)
      // triggerMods
      expect(pkt[10]).toBe(0x01)
      // negativeMods
      expect(pkt[11]).toBe(0x02)
      // suppressedMods
      expect(pkt[12]).toBe(0x04)
      // options byte: (0x05 & 0x7F) | 0x80 = 0x85
      expect(pkt[13]).toBe(0x85)
    })

    it('clears bit 7 when enabled is false', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await setKeyOverride(0, {
        triggerKey: 0,
        replacementKey: 0,
        layers: 0,
        triggerMods: 0,
        negativeMods: 0,
        suppressedMods: 0,
        options: 0x7f,
        enabled: false,
      })

      const pkt = sentPacket()
      // options byte: (0x7F & 0x7F) | 0x00 = 0x7F
      expect(pkt[13]).toBe(0x7f)
    })
  })

  describe('getAltRepeatKey', () => {
    it('sends [0xFE, 0x0d, 0x07, index] and parses LE16x2 + u8x2 with enabled from bit 3', async () => {
      const response = new Uint8Array(32)
      response[0] = 0 // status: ok
      // lastKey LE16 at [1..2]: 0x0004
      response[1] = 0x04
      response[2] = 0x00
      // altKey LE16 at [3..4]: 0x0005
      response[3] = 0x05
      response[4] = 0x00
      // allowedMods u8 at [5]: 0x0F
      response[5] = 0x0f
      // options u8 at [6]: 0x0B → enabled = (0x0B & 0x08) != 0 = true, options = 0x0B & 0x07 = 0x03
      response[6] = 0x0b
      mockSendReceive.mockResolvedValueOnce(response)

      const entry = await getAltRepeatKey(4)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0d)
      expect(pkt[2]).toBe(0x07)
      expect(pkt[3]).toBe(4)
      expect(entry).toEqual({
        lastKey: 0x0004,
        altKey: 0x0005,
        allowedMods: 0x0f,
        options: 0x03,
        enabled: true,
      })
    })

    it('parses enabled=false when bit 3 is 0', async () => {
      const response = new Uint8Array(32)
      response[0] = 0
      response[1] = 0x10
      response[2] = 0x00
      response[3] = 0x20
      response[4] = 0x00
      response[5] = 0xff
      response[6] = 0x05 // bit 3 = 0, options = 0x05 & 0x07 = 0x05, enabled = false
      mockSendReceive.mockResolvedValueOnce(response)

      const entry = await getAltRepeatKey(0)

      expect(entry.enabled).toBe(false)
      expect(entry.options).toBe(0x05)
    })

    it('throws when resp[0] != 0', async () => {
      const response = new Uint8Array(32)
      response[0] = 2
      mockSendReceive.mockResolvedValueOnce(response)

      await expect(getAltRepeatKey(9)).rejects.toThrow('Failed to get alt repeat key entry 9')
    })
  })

  describe('setAltRepeatKey', () => {
    it('sends packet with LE16x2 + u8 + options byte with enabled in bit 3', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await setAltRepeatKey(1, {
        lastKey: 0x0004,
        altKey: 0x0005,
        allowedMods: 0x0f,
        options: 0x03,
        enabled: true,
      })

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0d)
      expect(pkt[2]).toBe(0x08) // DYNAMIC_VIAL_ALT_REPEAT_KEY_SET
      expect(pkt[3]).toBe(1) // index
      // lastKey LE16
      expect(pkt[4]).toBe(0x04)
      expect(pkt[5]).toBe(0x00)
      // altKey LE16
      expect(pkt[6]).toBe(0x05)
      expect(pkt[7]).toBe(0x00)
      // allowedMods
      expect(pkt[8]).toBe(0x0f)
      // options byte: (0x03 & 0x07) | 0x08 = 0x0B
      expect(pkt[9]).toBe(0x0b)
    })

    it('clears bit 3 when enabled is false', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await setAltRepeatKey(0, {
        lastKey: 0,
        altKey: 0,
        allowedMods: 0,
        options: 0x07,
        enabled: false,
      })

      const pkt = sentPacket()
      // options byte: (0x07 & 0x07) | 0x00 = 0x07
      expect(pkt[9]).toBe(0x07)
    })
  })
})

// =====================================================================
// QMK Settings Commands
// =====================================================================

describe('QMK Settings Commands', () => {
  describe('qmkSettingsQuery', () => {
    it('sends [0xFE, 0x09, startId_LE16] and returns Array.from(resp)', async () => {
      const response = resp(0x01, 0x00, 0x02, 0x00, 0xff, 0xff)
      mockSendReceive.mockResolvedValueOnce(response)

      const result = await qmkSettingsQuery(1)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x09)
      // startId=1 as LE16 at [2..3]
      expect(pkt[2]).toBe(0x01)
      expect(pkt[3]).toBe(0x00)
      expect(result).toHaveLength(32)
      expect(result[0]).toBe(0x01)
      expect(result[1]).toBe(0x00)
      expect(result[2]).toBe(0x02)
      expect(result[3]).toBe(0x00)
      expect(result[4]).toBe(0xff)
      expect(result[5]).toBe(0xff)
    })

    it('encodes startId > 255 correctly as LE16', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await qmkSettingsQuery(0x0301)

      const pkt = sentPacket()
      // 0x0301 LE16: low byte = 0x01, high byte = 0x03
      expect(pkt[2]).toBe(0x01)
      expect(pkt[3]).toBe(0x03)
    })
  })

  describe('qmkSettingsGet', () => {
    it('sends [0xFE, 0x0a, qsid_LE16] and returns data after status byte', async () => {
      // Response: [0x00(status), 0x42(value byte 0), 0x00, ...]
      const response = resp(0x00, 0x42, 0x00, 0x00, 0x00)
      mockSendReceive.mockResolvedValueOnce(response)

      const result = await qmkSettingsGet(0x0100)

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0a)
      // qsid=0x0100 LE16: low=0x00, high=0x01
      expect(pkt[2]).toBe(0x00)
      expect(pkt[3]).toBe(0x01)
      // Status byte stripped — data starts at original byte 1
      expect(result).toHaveLength(31)
      expect(result[0]).toBe(0x42) // value (was at resp[1])
    })

    it('throws when status byte is non-zero', async () => {
      // Response: [0x01(error status), ...]
      mockSendReceive.mockResolvedValueOnce(resp(0x01))

      await expect(qmkSettingsGet(0x0100)).rejects.toThrow('Failed to get QMK setting')
    })
  })

  describe('qmkSettingsSet', () => {
    it('sends [0xFE, 0x0b, qsid_LE16, ...data]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await qmkSettingsSet(0x0200, [0xaa, 0xbb, 0xcc])

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0b)
      // qsid=0x0200 LE16: low=0x00, high=0x02
      expect(pkt[2]).toBe(0x00)
      expect(pkt[3]).toBe(0x02)
      // data at [4..]
      expect(pkt[4]).toBe(0xaa)
      expect(pkt[5]).toBe(0xbb)
      expect(pkt[6]).toBe(0xcc)
    })
  })

  describe('qmkSettingsReset', () => {
    it('sends [0xFE, 0x0c]', async () => {
      mockSendReceive.mockResolvedValueOnce(resp())

      await qmkSettingsReset()

      const pkt = sentPacket()
      expect(pkt[0]).toBe(0xfe)
      expect(pkt[1]).toBe(0x0c)
      for (let i = 2; i < 32; i++) expect(pkt[i]).toBe(0)
    })
  })
})
