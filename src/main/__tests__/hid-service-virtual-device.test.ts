// SPDX-License-Identifier: GPL-2.0-or-later
// Routing tests for the virtual-device seam inside hid-service.ts —
// mirrors hid-service.test.ts's node-hid mocking pattern.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MSG_LEN, HID_USAGE_PAGE, HID_USAGE } from '../../shared/constants/protocol'

const mockWrite = vi.fn()
const mockRead = vi.fn()
const mockClose = vi.fn()
const mockHIDAsyncOpen = vi.fn()
const mockDevicesAsync = vi.fn()

vi.mock('node-hid', () => ({
  default: {
    devicesAsync: (...args: unknown[]) => mockDevicesAsync(...args),
    HIDAsync: {
      open: (...args: unknown[]) => mockHIDAsyncOpen(...args),
    },
  },
}))

vi.mock('../../main/logger', () => ({
  log: vi.fn(),
  logHidPacket: vi.fn(),
}))

import { listDevices, openHidDevice, closeHidDevice, sendReceive, isDeviceOpen } from '../hid-service'
import { VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID, VIRTUAL_DEVICE_NAME } from '../virtual-device/gpk60-63r'

function createMockDeviceInfo(overrides?: Record<string, unknown>) {
  return {
    vendorId: 0x1234,
    productId: 0x5678,
    path: '/dev/hidraw0',
    serialNumber: 'vial:f64c2b3c',
    product: 'Real Test Keyboard',
    usagePage: HID_USAGE_PAGE,
    usage: HID_USAGE,
    ...overrides,
  }
}

function createMockOpenDevice() {
  return { write: mockWrite, read: mockRead, close: mockClose }
}

beforeEach(async () => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  mockWrite.mockReturnValue(MSG_LEN + 1)
  mockDevicesAsync.mockResolvedValue([])
  await closeHidDevice()
})

afterEach(async () => {
  await closeHidDevice()
  vi.unstubAllEnvs()
})

describe('virtual device disabled (env unset)', () => {
  it('listDevices does not include the virtual device', async () => {
    mockDevicesAsync.mockResolvedValue([])
    const result = await listDevices()
    expect(result.find((d) => d.productName === VIRTUAL_DEVICE_NAME)).toBeUndefined()
  })

  it('opening the virtual vid/pid falls through to real device lookup and fails', async () => {
    mockDevicesAsync.mockResolvedValue([])
    const result = await openHidDevice(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID)
    expect(result).toBe(false)
  })
})

describe('virtual device enabled', () => {
  beforeEach(() => {
    vi.stubEnv('PIPETTE_VIRTUAL_DEVICE', '1')
  })

  it('listDevices appends the virtual device even with zero real devices', async () => {
    mockDevicesAsync.mockResolvedValue([])
    const result = await listDevices()
    expect(result).toHaveLength(1)
    expect(result[0].productName).toBe(VIRTUAL_DEVICE_NAME)
    expect(result[0].vendorId).toBe(VIRTUAL_DEVICE_VID)
    expect(result[0].productId).toBe(VIRTUAL_DEVICE_PID)
  })

  it('opens the virtual device without any node-hid calls', async () => {
    const result = await openHidDevice(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID)
    expect(result).toBe(true)
    expect(mockHIDAsyncOpen).not.toHaveBeenCalled()
  })

  it('sendReceive answers a protocol-version request with no node-hid calls', async () => {
    await openHidDevice(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID)
    const resp = await sendReceive([0x01])
    expect(resp.length).toBe(MSG_LEN)
    expect((resp[1] << 8) | resp[2]).toBe(9)
    expect(mockWrite).not.toHaveBeenCalled()
    expect(mockRead).not.toHaveBeenCalled()
  })

  it('isDeviceOpen is true while the virtual device is open', async () => {
    await openHidDevice(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID)
    await expect(isDeviceOpen()).resolves.toBe(true)
  })

  it('opening a real device closes the virtual device', async () => {
    await openHidDevice(VIRTUAL_DEVICE_VID, VIRTUAL_DEVICE_PID)
    await expect(isDeviceOpen()).resolves.toBe(true)

    mockDevicesAsync.mockResolvedValue([createMockDeviceInfo()])
    mockHIDAsyncOpen.mockResolvedValue(createMockOpenDevice())
    const opened = await openHidDevice(0x1234, 0x5678)
    expect(opened).toBe(true)

    // sendReceive should now go through the real (mocked) device, not the virtual one.
    mockRead.mockResolvedValue(Buffer.alloc(MSG_LEN))
    await sendReceive([0x01])
    expect(mockWrite).toHaveBeenCalledTimes(1)
  })
})
