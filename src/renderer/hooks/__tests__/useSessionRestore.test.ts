// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSessionRestore } from '../useSessionRestore'
import type { DeviceInfo } from '../../../shared/types/protocol'
import type { LastDeviceInfo } from '../../../shared/types/app-config'

function makeDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    vendorId: 0x1234,
    productId: 0x5678,
    productName: 'Test Keyboard',
    serialNumber: 'SN001',
    type: 'vial',
    ...overrides,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useSessionRestore', () => {
  it('connects on a serial-preferred match when multiple devices share vendorId/productId', () => {
    const stored: LastDeviceInfo = { vendorId: 0x1234, productId: 0x5678, serialNumber: 'SN002' }
    const wrongSerial = makeDevice({ serialNumber: 'SN001' })
    const rightSerial = makeDevice({ serialNumber: 'SN002' })
    const connect = vi.fn()

    renderHook(() => useSessionRestore({
      enabled: true,
      devices: [wrongSerial, rightSerial],
      connectedDevice: null,
      lastDevice: stored,
      connect,
    }))

    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith(rightSerial)
  })

  it('falls back to a vendorId/productId match when no serial is stored', () => {
    const stored: LastDeviceInfo = { vendorId: 0x1234, productId: 0x5678 }
    const device = makeDevice({ serialNumber: 'whatever' })
    const connect = vi.fn()

    renderHook(() => useSessionRestore({
      enabled: true,
      devices: [device],
      connectedDevice: null,
      lastDevice: stored,
      connect,
    }))

    expect(connect).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledWith(device)
  })

  it('is one-shot — a second devices-list refresh after a successful match does not connect again', () => {
    const stored: LastDeviceInfo = { vendorId: 0x1234, productId: 0x5678 }
    const device = makeDevice()
    const connect = vi.fn()

    const { rerender } = renderHook(({ devices }) => useSessionRestore({
      enabled: true,
      devices,
      connectedDevice: null,
      lastDevice: stored,
      connect,
    }), { initialProps: { devices: [device] } })

    expect(connect).toHaveBeenCalledTimes(1)

    // Simulate another poll tick still returning the same device.
    rerender({ devices: [makeDevice()] })

    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('gives up silently 10 seconds after mount without a message or state churn', () => {
    const stored: LastDeviceInfo = { vendorId: 0x1234, productId: 0x5678 }
    const device = makeDevice()
    const connect = vi.fn()

    const { rerender } = renderHook(({ devices }) => useSessionRestore({
      enabled: true,
      devices,
      connectedDevice: null,
      lastDevice: stored,
      connect,
    }), { initialProps: { devices: [] as DeviceInfo[] } })

    vi.advanceTimersByTime(10_001)
    // A matching device only shows up after the deadline has passed.
    rerender({ devices: [device] })

    expect(connect).not.toHaveBeenCalled()
  })

  it('suppresses the restore attempt once the user connects a device themselves first', () => {
    const stored: LastDeviceInfo = { vendorId: 0x1234, productId: 0x5678 }
    const userDevice = makeDevice({ vendorId: 0x9999, productId: 0x1111 })
    const matchingDevice = makeDevice()
    const connect = vi.fn()

    const { rerender } = renderHook(({ connectedDevice, devices }) => useSessionRestore({
      enabled: true,
      devices,
      connectedDevice,
      lastDevice: stored,
      connect,
    }), { initialProps: { connectedDevice: userDevice as DeviceInfo | null, devices: [] as DeviceInfo[] } })

    // The matching device only appears in the list after the user already connected.
    rerender({ connectedDevice: userDevice, devices: [matchingDevice] })

    expect(connect).not.toHaveBeenCalled()
  })

  it('does not connect when disabled (restoreLastSession off or lastDevice null)', () => {
    const device = makeDevice()
    const connect = vi.fn()

    renderHook(() => useSessionRestore({
      enabled: false,
      devices: [device],
      connectedDevice: null,
      lastDevice: { vendorId: 0x1234, productId: 0x5678 },
      connect,
    }))

    expect(connect).not.toHaveBeenCalled()
  })

  it('does not connect when lastDevice is null even if enabled', () => {
    const device = makeDevice()
    const connect = vi.fn()

    renderHook(() => useSessionRestore({
      enabled: true,
      devices: [device],
      connectedDevice: null,
      lastDevice: null,
      connect,
    }))

    expect(connect).not.toHaveBeenCalled()
  })
})
