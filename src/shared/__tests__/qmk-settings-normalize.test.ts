// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { normalizeQmkSettingData } from '../qmk-settings-normalize'

describe('normalizeQmkSettingData', () => {
  it('trims 31-byte HID response to declared width for a 2-byte setting (QSID 7 = Tapping Term)', () => {
    // QSID 7 has width: 2
    const hidResponse = new Array(31).fill(0)
    hidResponse[0] = 0xc8 // 200 LE low byte
    hidResponse[1] = 0x00 // 200 LE high byte
    hidResponse[2] = 0xff // padding (should be trimmed)

    const result = normalizeQmkSettingData(7, hidResponse)
    expect(result).toEqual([0xc8, 0x00])
  })

  it('trims to width 4 for a 4-byte boolean setting (QSID 21 = Magic)', () => {
    // QSID 21 has width: 4
    const hidResponse = new Array(31).fill(0)
    hidResponse[0] = 0x0f
    hidResponse[3] = 0x01
    hidResponse[4] = 0xff // padding

    const result = normalizeQmkSettingData(21, hidResponse)
    expect(result).toEqual([0x0f, 0x00, 0x00, 0x01])
  })

  it('trims to width 1 for a 1-byte setting (QSID 5 = One Shot Count)', () => {
    // QSID 5 has width: 1
    const hidResponse = new Array(31).fill(0xaa)
    hidResponse[0] = 0x05

    const result = normalizeQmkSettingData(5, hidResponse)
    expect(result).toEqual([0x05])
  })

  it('defaults to 4 bytes max for unknown QSIDs', () => {
    const hidResponse = new Array(31).fill(0xff)

    const result = normalizeQmkSettingData(9999, hidResponse)
    expect(result).toEqual([0xff, 0xff, 0xff, 0xff])
  })

  it('passes through already-trimmed data unchanged', () => {
    const trimmed = [0x88, 0x13]
    const result = normalizeQmkSettingData(7, trimmed)
    expect(result).toEqual([0x88, 0x13])
  })

  it('handles empty array', () => {
    const result = normalizeQmkSettingData(7, [])
    expect(result).toEqual([])
  })

  it('handles shorter-than-width array', () => {
    // QSID 7 has width 2, but only 1 byte provided
    const result = normalizeQmkSettingData(7, [0x42])
    expect(result).toEqual([0x42])
  })
})
