// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { readLE16, readLE32 } from '../virtual-device/byte-utils'
import {
  SUPPORTED_QSIDS,
  createDefaultQmkSettings,
  resetQmkSettings,
  qmkSettingsQuery,
  qmkSettingsGet,
  qmkSettingsSet,
} from '../virtual-device/qmk-settings'

describe('createDefaultQmkSettings', () => {
  it('matches qmk_settings_reset()/quantum default macros', () => {
    const store = createDefaultQmkSettings()
    expect(store.comboTerm).toBe(50)
    expect(store.autoShiftTimeout).toBe(175)
    expect(store.oskTapToggle).toBe(5)
    expect(store.oskTimeout).toBe(5000)
    expect(store.tappingTerm).toBe(200)
    expect(store.mousekeyDelay).toBe(10)
    expect(store.mousekeyInterval).toBe(20)
    expect(store.mousekeyMoveDelta).toBe(8)
    expect(store.mousekeyMaxSpeed).toBe(10)
    expect(store.mousekeyTimeToMax).toBe(30)
    expect(store.mousekeyWheelDelay).toBe(10)
    expect(store.mousekeyWheelInterval).toBe(80)
    expect(store.mousekeyWheelMaxSpeed).toBe(8)
    expect(store.mousekeyWheelTimeToMax).toBe(40)
    expect(store.tapCodeDelay).toBe(0)
    expect(store.tapHoldCapsDelay).toBe(80)
    expect(store.tappingToggle).toBe(5)
    expect(store.quickTapTerm).toBe(200)
    expect(store.flowTapTerm).toBe(0)
    expect(store.magicFlags).toBe(0)
    expect(store.tappingV2).toBe(0)
  })
})

describe('SUPPORTED_QSIDS', () => {
  it('has 26 entries: qsid 8 is absent, mousekey qsids 9-17 are present', () => {
    expect(SUPPORTED_QSIDS).toHaveLength(26)
    expect(SUPPORTED_QSIDS).not.toContain(8)
    for (const qsid of [9, 10, 11, 12, 13, 14, 15, 16, 17]) {
      expect(SUPPORTED_QSIDS).toContain(qsid)
    }
  })

  it('is already in ascending order (protos[] table declaration order)', () => {
    const sorted = [...SUPPORTED_QSIDS].sort((a, b) => a - b)
    expect(SUPPORTED_QSIDS).toEqual(sorted)
  })
})

describe('qmkSettingsQuery', () => {
  it('fills the buffer with 0xFFFF-terminated qsids greater than the cursor', () => {
    const buf = new Uint8Array(32)
    qmkSettingsQuery(0, buf)
    const firstPage = SUPPORTED_QSIDS.slice(0, 16)
    for (let i = 0; i < firstPage.length; i++) {
      expect(readLE16(buf, i * 2)).toBe(firstPage[i])
    }
  })

  it('a cursor past the last qsid yields an all-0xFFFF buffer', () => {
    const buf = new Uint8Array(32)
    qmkSettingsQuery(9999, buf)
    expect(Array.from(buf)).toEqual(new Array(32).fill(0xff))
  })
})

describe('qmkSettingsGet/qmkSettingsSet', () => {
  it('round-trips a u8 field (qsid 1)', () => {
    const store = createDefaultQmkSettings()
    const buf = new Uint8Array(4)
    buf[0] = 0x0f
    expect(qmkSettingsSet(store, 1, buf, 0)).toBe(0)
    expect(store.graveEscOverride).toBe(0x0f)
    const out = new Uint8Array(4)
    expect(qmkSettingsGet(store, 1, out, 0)).toBe(0)
    expect(out[0]).toBe(0x0f)
  })

  it('round-trips a u16 field (qsid 7 = tapping_term)', () => {
    const store = createDefaultQmkSettings()
    const buf = new Uint8Array(4)
    buf[0] = 0x2c
    buf[1] = 0x01 // 300 LE16
    expect(qmkSettingsSet(store, 7, buf, 0)).toBe(0)
    expect(store.tappingTerm).toBe(300)
    const out = new Uint8Array(4)
    qmkSettingsGet(store, 7, out, 0)
    expect(readLE16(out, 0)).toBe(300)
  })

  it('round-trips the u32 magic-settings field (qsid 21) without disturbing other bits', () => {
    const store = createDefaultQmkSettings()
    const buf = new Uint8Array(4)
    buf[0] = 0x81 // bit0 (swap ctrl/caps) + bit7 (nkro)
    expect(qmkSettingsSet(store, 21, buf, 0)).toBe(0)
    expect(store.magicFlags).toBe(0x81)
    const out = new Uint8Array(4)
    qmkSettingsGet(store, 21, out, 0)
    expect(readLE32(out, 0)).toBe(0x81)
  })

  it('individual tappingV2 bit qsids (22/23/24/26) address distinct bits of the same byte', () => {
    const store = createDefaultQmkSettings()
    const one = new Uint8Array([1])
    qmkSettingsSet(store, 22, one, 0)
    qmkSettingsSet(store, 26, one, 0)
    expect(store.tappingV2).toBe((1 << 0) | (1 << 3))

    const out23 = new Uint8Array(1)
    qmkSettingsGet(store, 23, out23, 0)
    expect(out23[0]).toBe(0)

    const out22 = new Uint8Array(1)
    qmkSettingsGet(store, 22, out22, 0)
    expect(out22[0]).toBe(1)

    // Clearing bit 22 must not disturb bit 26.
    const zero = new Uint8Array([0])
    qmkSettingsSet(store, 22, zero, 0)
    expect(store.tappingV2).toBe(1 << 3)
  })

  it('rejects an unsupported qsid (8) without touching the store', () => {
    const store = createDefaultQmkSettings()
    const before = { ...store }
    const buf = new Uint8Array([1, 2, 3, 4])
    expect(qmkSettingsSet(store, 8, buf, 0)).toBe(0xff)
    expect(store).toEqual(before)
    const out = new Uint8Array(4)
    expect(qmkSettingsGet(store, 8, out, 0)).toBe(0xff)
  })
})

describe('resetQmkSettings', () => {
  it('restores every field to its default after mutation', () => {
    const store = createDefaultQmkSettings()
    store.tappingTerm = 999
    store.tappingV2 = 0x0f
    resetQmkSettings(store)
    expect(store).toEqual(createDefaultQmkSettings())
  })
})
