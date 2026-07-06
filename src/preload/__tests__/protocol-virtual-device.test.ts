// SPDX-License-Identifier: GPL-2.0-or-later
// Integration test: the REAL preload protocol parsers (src/preload/protocol.ts)
// wired to the virtual GPK60-63R emulator (src/main/virtual-device), proving
// wire-format compatibility without Playwright/Electron. Runs under plain
// Vitest so CI's `test` step exercises it.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { MSG_LEN } from '../../shared/constants/protocol'

// Mocked in place of the real IPC bridge: routes straight into the virtual
// device's report handler. Uses a dynamic import inside each function body
// (rather than a module-level import) so it resolves after Vitest's mock
// hoisting has fully linked the module graph.
vi.mock('../hid-transport', () => ({
  sendReceive: async (data: Uint8Array): Promise<Uint8Array> => {
    const { handleVirtualReport } = await import('../../main/virtual-device')
    return Uint8Array.from(handleVirtualReport(Array.from(data)))
  },
  send: async (data: Uint8Array): Promise<void> => {
    const { handleVirtualReport } = await import('../../main/virtual-device')
    handleVirtualReport(Array.from(data))
  },
}))

import {
  getProtocolVersion,
  getKeyboardId,
  getLayerCount,
  getKeymapBuffer,
  getUnlockStatus,
  unlockStart,
  unlockPoll,
  getDefinitionSize,
  getDefinitionRaw,
  getDynamicEntryCount,
  qmkSettingsQuery,
  getVialRGBInfo,
  getVialRGBMode,
  getVialRGBSupported,
} from '../protocol'
import { openVirtualDevice, closeVirtualDevice, getVirtualDeviceController } from '../../main/virtual-device'
import {
  LAYERS,
  VIRTUAL_DEVICE_UID_BYTES,
  VIRTUAL_DEVICE_UNLOCK_COMBO,
  VIALRGB_SUPPORTED_EFFECTS,
  buildDefaultKeymap,
} from '../../main/virtual-device/gpk60-63r'
import { decompressLzma } from '../../main/lzma'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Mirrors protocol.ts's readLE64Hex so the expected uid isn't a hand-transcribed magic string. */
function expectedUidHex(bytes: Uint8Array): string {
  let hex = '0x'
  for (let i = bytes.length - 1; i >= 0; i--) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

/** Flattens the first `count` keycodes of a keymap into BE16 byte pairs, matching the wire format. */
function keymapToBE16Bytes(keymap: Uint16Array, count: number): number[] {
  const bytes: number[] = []
  for (let i = 0; i < count; i++) {
    bytes.push((keymap[i] >> 8) & 0xff, keymap[i] & 0xff)
  }
  return bytes
}

beforeAll(async () => {
  await openVirtualDevice()
})

afterAll(() => {
  closeVirtualDevice()
})

describe('preload protocol against the virtual device emulator', () => {
  it('getProtocolVersion resolves to VIA protocol 9', async () => {
    await expect(getProtocolVersion()).resolves.toBe(9)
  })

  it('getKeyboardId resolves to vial protocol 6 and the VIRTGPK uid', async () => {
    const id = await getKeyboardId()
    expect(id.vialProtocol).toBe(6)
    expect(id.uid).toBe(expectedUidHex(VIRTUAL_DEVICE_UID_BYTES))
  })

  it('getLayerCount resolves to the emulator layer count', async () => {
    await expect(getLayerCount()).resolves.toBe(LAYERS)
  })

  it('getKeymapBuffer round-trips the first chunk of buildDefaultKeymap', async () => {
    const expectedKeymap = buildDefaultKeymap()
    const chunk = await getKeymapBuffer(0, 28)
    expect(chunk).toEqual(keymapToBE16Bytes(expectedKeymap, 14))
  })

  it('getUnlockStatus reports locked with the two-key unlock combo', async () => {
    const status = await getUnlockStatus()
    expect(status.unlocked).toBe(false)
    expect(status.keys).toEqual(VIRTUAL_DEVICE_UNLOCK_COMBO)
  })

  it('getDefinitionSize/getDefinitionRaw decompress to the GPK60-63R Virtual definition', async () => {
    const size = await getDefinitionSize()
    const raw = await getDefinitionRaw(size)
    const jsonStr = await decompressLzma(Array.from(raw))
    expect(jsonStr).not.toBeNull()
    const definition = JSON.parse(jsonStr as string) as { name: string }
    expect(definition.name).toBe('GPK60-63R Virtual')
  })

  it('getDynamicEntryCount returns all zeros without throwing echo-detected', async () => {
    await expect(getDynamicEntryCount()).resolves.toEqual({
      tapDance: 0,
      combo: 0,
      keyOverride: 0,
      altRepeatKey: 0,
      featureFlags: 0,
    })
  })

  it('qmkSettingsQuery yields an all-0xFF (unsupported / empty) qsid list', async () => {
    const result = await qmkSettingsQuery(0)
    expect(result).toHaveLength(MSG_LEN)
    expect(result.every((b) => b === 0xff)).toBe(true)
  })

  it('getVialRGBInfo/getVialRGBMode/getVialRGBSupported parse cleanly', async () => {
    const info = await getVialRGBInfo()
    expect(info.version).toBe(1)
    expect(info.maxBrightness).toBe(255)

    const mode = await getVialRGBMode()
    expect(typeof mode.mode).toBe('number')
    expect(typeof mode.speed).toBe('number')
    expect(typeof mode.hue).toBe('number')
    expect(typeof mode.sat).toBe('number')
    expect(typeof mode.val).toBe('number')

    const supported = await getVialRGBSupported()
    expect(supported.has(0)).toBe(true)
    expect(supported.size).toBe(VIALRGB_SUPPORTED_EFFECTS.length)
  })

  it('unlocks via unlockStart + repeated unlockPoll while the combo is held', async () => {
    const controller = getVirtualDeviceController()
    controller.reset()
    controller.holdKeys(VIRTUAL_DEVICE_UNLOCK_COMBO as [number, number][])
    controller.setUnlockCounterMax(2)

    await unlockStart()

    let result: number[] = []
    for (let attempt = 0; attempt < 3 && result[0] !== 1; attempt++) {
      await delay(120)
      result = await unlockPoll()
    }
    expect(result[0]).toBe(1)

    const status = await getUnlockStatus()
    expect(status.unlocked).toBe(true)

    controller.releaseAll()
  })
})
