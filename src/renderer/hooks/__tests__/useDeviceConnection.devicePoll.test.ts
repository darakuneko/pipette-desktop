// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDeviceConnection, POLL_INTERVAL_MS } from '../useDeviceConnection'
import type { DeviceInfo } from '../../../shared/types/protocol'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const DEVICE_A: DeviceInfo = {
  vendorId: 0x1234, productId: 0x5678, productName: 'Keyboard A', serialNumber: 'SN-A', type: 'vial',
}
const DEVICE_B: DeviceInfo = {
  vendorId: 0x1234, productId: 0x9abc, productName: 'Keyboard B', serialNumber: 'SN-B', type: 'vial',
}

const mockListDevices = vi.fn<() => Promise<DeviceInfo[]>>()
const mockOpenDevice = vi.fn<(v: number, p: number) => Promise<boolean>>()
const mockCloseDevice = vi.fn<() => Promise<void>>()
const mockIsDeviceOpen = vi.fn<() => Promise<boolean>>()

/** Every call hands back a fresh array of fresh objects, like the real IPC. */
function listReturns(devices: DeviceInfo[]): void {
  mockListDevices.mockImplementation(() => Promise.resolve(devices.map((d) => ({ ...d }))))
}

async function flush(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
}

async function tick(): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS) })
}

async function mountConnected() {
  const hook = renderHook(() => useDeviceConnection())
  await flush()
  await act(async () => { await hook.result.current.connectDevice(DEVICE_A) })
  return hook
}

beforeEach(() => {
  vi.useFakeTimers()
  listReturns([DEVICE_A])
  mockOpenDevice.mockResolvedValue(true)
  mockCloseDevice.mockResolvedValue(undefined)
  mockIsDeviceOpen.mockResolvedValue(true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = {
    listDevices: mockListDevices,
    openDevice: mockOpenDevice,
    closeDevice: mockCloseDevice,
    isDeviceOpen: mockIsDeviceOpen,
  }
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('useDeviceConnection — device list polling while connected', () => {
  it('lists devices each tick while the device list is active, and stops once inactive', async () => {
    const { result } = await mountConnected()
    mockListDevices.mockClear()

    await tick()
    expect(mockListDevices).not.toHaveBeenCalled()

    act(() => { result.current.setDeviceListActive(true) })
    await tick()
    expect(mockListDevices).toHaveBeenCalledTimes(1)
    await tick()
    expect(mockListDevices).toHaveBeenCalledTimes(2)

    act(() => { result.current.setDeviceListActive(false) })
    mockListDevices.mockClear()
    await tick()
    await tick()
    expect(mockListDevices).not.toHaveBeenCalled()
  })
})

describe('useDeviceConnection — unchanged device lists keep the same state', () => {
  it('keeps the same devices reference when a poll returns an identical list', async () => {
    const { result } = renderHook(() => useDeviceConnection())
    await flush()
    const first = result.current.devices
    expect(first).toEqual([DEVICE_A])

    await tick()
    expect(mockListDevices).toHaveBeenCalledTimes(2)
    expect(result.current.devices).toBe(first)
  })

  it('replaces the devices reference when a poll returns a different list', async () => {
    const { result } = renderHook(() => useDeviceConnection())
    await flush()
    const first = result.current.devices

    listReturns([DEVICE_A, DEVICE_B])
    await tick()
    expect(result.current.devices).not.toBe(first)
    expect(result.current.devices).toEqual([DEVICE_A, DEVICE_B])
  })

  it('replaces the devices reference when only the order changes', async () => {
    listReturns([DEVICE_A, DEVICE_B])
    const { result } = renderHook(() => useDeviceConnection())
    await flush()
    const first = result.current.devices

    listReturns([DEVICE_B, DEVICE_A])
    await tick()
    expect(result.current.devices).not.toBe(first)
    expect(result.current.devices).toEqual([DEVICE_B, DEVICE_A])
  })

  it('replaces the devices reference when a single field differs', async () => {
    const { result } = renderHook(() => useDeviceConnection())
    await flush()
    const first = result.current.devices

    listReturns([{ ...DEVICE_A, serialNumber: 'SN-OTHER' }])
    await tick()
    expect(result.current.devices).not.toBe(first)
  })

  it('refreshDevices keeps the same reference for an identical list and replaces it for a different one', async () => {
    const { result } = await mountConnected()
    const first = result.current.devices

    await act(async () => { await result.current.refreshDevices() })
    expect(result.current.devices).toBe(first)

    listReturns([DEVICE_B])
    await act(async () => { await result.current.refreshDevices() })
    expect(result.current.devices).not.toBe(first)
    expect(result.current.devices).toEqual([DEVICE_B])
  })
})

describe('useDeviceConnection — poll timeouts are cleared once settled', () => {
  it('leaves only the next poll timer after a listDevices poll', async () => {
    renderHook(() => useDeviceConnection())
    await flush()
    await tick()
    expect(mockListDevices).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('leaves only the next poll timer after an isDeviceOpen poll', async () => {
    await mountConnected()
    await tick()
    expect(mockIsDeviceOpen).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
  })
})
