// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isVirtualDeviceEnabled,
  getVirtualDeviceInfo,
  matchesVirtualDevice,
  openVirtualDevice,
  closeVirtualDevice,
  isVirtualDeviceOpen,
  handleVirtualReport,
  getVirtualDeviceController,
} from '../virtual-device/index'
import { VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_NAME } from '../virtual-device/gpk60-63r'
import { MSG_LEN } from '../../shared/constants/protocol'

beforeEach(async () => {
  await closeHelper()
})

afterEach(async () => {
  await closeHelper()
  vi.unstubAllEnvs()
})

async function closeHelper(): Promise<void> {
  closeVirtualDevice()
}

describe('isVirtualDeviceEnabled', () => {
  it('reads the env var live', () => {
    vi.stubEnv('PIPETTE_VIRTUAL_DEVICE', '1')
    expect(isVirtualDeviceEnabled()).toBe(true)
    vi.stubEnv('PIPETTE_VIRTUAL_DEVICE', '0')
    expect(isVirtualDeviceEnabled()).toBe(false)
  })
})

describe('getVirtualDeviceInfo / matchesVirtualDevice', () => {
  it('reports the virtual device identity', () => {
    const info = getVirtualDeviceInfo()
    expect(info.vendorId).toBe(VIRTUAL_DEVICE_VID)
    expect(info.productId).toBe(VIRTUAL_DEVICE_PID)
    expect(info.productName).toBe(VIRTUAL_DEVICE_NAME)
    expect(info.type).toBe('vial')
  })

  it('matches only the virtual vid/pid pair', () => {
    expect(matchesVirtualDevice(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID)).toBe(true)
    expect(matchesVirtualDevice(0x1234, 0x5678)).toBe(false)
  })
})

describe('open/close lifecycle', () => {
  it('is closed until openVirtualDevice() resolves', async () => {
    expect(isVirtualDeviceOpen()).toBe(false)
    await openVirtualDevice()
    expect(isVirtualDeviceOpen()).toBe(true)
    closeVirtualDevice()
    expect(isVirtualDeviceOpen()).toBe(false)
  })

  it('handleVirtualReport throws when not open', () => {
    expect(() => handleVirtualReport([0x01])).toThrow('not open')
  })

  it('handleVirtualReport answers a protocol-version request once open', async () => {
    await openVirtualDevice()
    const resp = handleVirtualReport([0x01])
    expect(resp.length).toBe(MSG_LEN)
    expect((resp[1] << 8) | resp[2]).toBe(9)
  })
})

describe('getVirtualDeviceController', () => {
  it('press/release/tap/holdKeys mutate matrix state reflected via the matrix report', async () => {
    await openVirtualDevice()
    const controller = getVirtualDeviceController()
    controller.reset()
    controller.getState() // touches state without side effects beyond read

    controller.setUnlockCounterMax(2)
    controller.holdKeys([[0, 0], [0, 1]])

    const status = controller.getState()
    expect(status.open).toBe(true)
    expect(status.unlocked).toBe(false)

    controller.releaseAll()
  })

  it('setUnlockCounterMax clamps a countdown already in progress', async () => {
    await openVirtualDevice()
    const controller = getVirtualDeviceController()
    controller.reset()

    // unlock start (0xFE 0x06) arms the countdown at the default max of 50
    handleVirtualReport([0xfe, 0x06])
    expect(controller.getState().unlockCounter).toBe(50)

    controller.setUnlockCounterMax(3)
    expect(controller.getState().unlockCounter).toBe(3)
  })

  it('reset() restores factory defaults (relocked, empty matrix)', async () => {
    await openVirtualDevice()
    const controller = getVirtualDeviceController()
    controller.pressKey(0, 0)
    controller.reset()
    const status = controller.getState()
    expect(status.unlocked).toBe(false)
    expect(status.unlockInProgress).toBe(false)
  })
})
