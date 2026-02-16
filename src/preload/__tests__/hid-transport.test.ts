// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MSG_LEN } from '../../shared/constants/protocol'

// --- Mock electron ipcRenderer ---

const mockInvoke = vi.fn()

vi.mock('electron', () => ({
  ipcRenderer: {
    invoke: (...args: unknown[]) => mockInvoke(...args),
    send: vi.fn(),
  },
}))

// --- Import after mocking ---

import {
  listDevices,
  openHidDevice,
  closeHidDevice,
  sendReceive,
  send,
  isDeviceOpen,
} from '../hid-transport'

// --- Test suites ---

beforeEach(async () => {
  vi.clearAllMocks()
  // Reset deviceOpen state
  mockInvoke.mockResolvedValue(undefined)
  await closeHidDevice()
})

describe('listDevices', () => {
  it('delegates to IPC and returns device list', async () => {
    const devices = [
      {
        vendorId: 0x1234,
        productId: 0x5678,
        productName: 'Test Keyboard',
        serialNumber: 'vial:f64c2b3c',
        type: 'vial' as const,
      },
    ]
    mockInvoke.mockResolvedValue(devices)

    const result = await listDevices()

    expect(mockInvoke).toHaveBeenCalledWith('hid:listDevices')
    expect(result).toEqual(devices)
  })

  it('returns empty array when no devices exist', async () => {
    mockInvoke.mockResolvedValue([])

    const result = await listDevices()

    expect(result).toEqual([])
  })
})

describe('openHidDevice / closeHidDevice', () => {
  it('opens device via IPC and updates local state', async () => {
    mockInvoke.mockResolvedValue(true)

    const result = await openHidDevice(0x1234, 0x5678)

    expect(mockInvoke).toHaveBeenCalledWith('hid:openDevice', 0x1234, 0x5678)
    expect(result).toBe(true)
    await expect(isDeviceOpen()).resolves.toBe(true)
  })

  it('returns false when IPC returns false', async () => {
    mockInvoke.mockResolvedValue(false)

    const result = await openHidDevice(0x1234, 0x5678)

    expect(result).toBe(false)
    await expect(isDeviceOpen()).resolves.toBe(false)
  })

  it('closeHidDevice resets local state', async () => {
    mockInvoke.mockResolvedValue(true)
    await openHidDevice(0x1234, 0x5678)
    await expect(isDeviceOpen()).resolves.toBe(true)

    mockInvoke.mockResolvedValue(undefined)
    await closeHidDevice()

    expect(mockInvoke).toHaveBeenCalledWith('hid:closeDevice')
    await expect(isDeviceOpen()).resolves.toBe(false)
  })
})

describe('sendReceive', () => {
  it('sends data via IPC and returns Uint8Array response', async () => {
    const response = new Array(MSG_LEN).fill(0)
    response[0] = 0x42
    mockInvoke.mockResolvedValue(response)

    const input = new Uint8Array([0x01, 0x02, 0x03])
    const result = await sendReceive(input)

    expect(mockInvoke).toHaveBeenCalledWith(
      'hid:sendReceive',
      [0x01, 0x02, 0x03],
    )
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result[0]).toBe(0x42)
    expect(result.length).toBe(MSG_LEN)
  })

  it('propagates IPC errors', async () => {
    mockInvoke.mockRejectedValue(new Error('No HID device is open'))

    await expect(sendReceive(new Uint8Array([0x01]))).rejects.toThrow(
      'No HID device is open',
    )
  })
})

describe('send', () => {
  it('sends data via IPC without expecting response', async () => {
    mockInvoke.mockResolvedValue(undefined)

    await send(new Uint8Array([0x07, 0x08]))

    expect(mockInvoke).toHaveBeenCalledWith('hid:send', [0x07, 0x08])
  })

  it('propagates IPC errors', async () => {
    mockInvoke.mockRejectedValue(new Error('No HID device is open'))

    await expect(send(new Uint8Array([0x01]))).rejects.toThrow(
      'No HID device is open',
    )
  })
})

describe('isDeviceOpen', () => {
  it('returns false initially', async () => {
    await expect(isDeviceOpen()).resolves.toBe(false)
  })

  it('returns true after successful open', async () => {
    mockInvoke.mockResolvedValue(true)
    await openHidDevice(0x1234, 0x5678)

    await expect(isDeviceOpen()).resolves.toBe(true)
  })

  it('returns false after close', async () => {
    mockInvoke.mockResolvedValue(true)
    await openHidDevice(0x1234, 0x5678)

    mockInvoke.mockResolvedValue(undefined)
    await closeHidDevice()

    await expect(isDeviceOpen()).resolves.toBe(false)
  })

  it('returns false and updates cache when IPC reports device gone', async () => {
    mockInvoke.mockResolvedValue(true)
    await openHidDevice(0x1234, 0x5678)

    // IPC now reports device is no longer present
    mockInvoke.mockResolvedValue(false)

    await expect(isDeviceOpen()).resolves.toBe(false)

    // Cache is updated — subsequent call should short-circuit without IPC
    mockInvoke.mockClear()
    await expect(isDeviceOpen()).resolves.toBe(false)
    expect(mockInvoke).not.toHaveBeenCalled()
  })
})
