// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDeviceConnection, POLL_INTERVAL_MS } from '../useDeviceConnection'
import type { DeviceInfo } from '../../../shared/types/protocol'

const mockDevice: DeviceInfo = {
  vendorId: 0x1234,
  productId: 0x5678,
  productName: 'Test Keyboard',
  serialNumber: 'SN001',
  type: 'vial',
}

const mockListDevices = vi.fn<() => Promise<DeviceInfo[]>>()
const mockOpenDevice = vi.fn<(v: number, p: number) => Promise<boolean>>()
const mockCloseDevice = vi.fn<() => Promise<void>>()
const mockIsDeviceOpen = vi.fn<() => Promise<boolean>>()

beforeEach(() => {
  mockListDevices.mockResolvedValue([])
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
  vi.restoreAllMocks()
})

describe('useDeviceConnection', () => {
  it('exports POLL_INTERVAL_MS constant', () => {
    expect(POLL_INTERVAL_MS).toBe(1000)
  })

  it('fetches device list on mount', async () => {
    mockListDevices.mockResolvedValue([mockDevice])
    const { result } = renderHook(() => useDeviceConnection())

    await waitFor(() => {
      expect(result.current.devices).toEqual([mockDevice])
    })
  })

  it('connects to a device', async () => {
    const { result } = renderHook(() => useDeviceConnection())

    await waitFor(() => {
      expect(mockListDevices).toHaveBeenCalled()
    })

    let success: boolean | undefined
    await act(async () => {
      success = await result.current.connectDevice(mockDevice)
    })

    expect(success).toBe(true)
    expect(result.current.connectedDevice).toEqual(mockDevice)
    expect(result.current.connecting).toBe(false)
  })

  it('disconnects from a device', async () => {
    const { result } = renderHook(() => useDeviceConnection())

    await waitFor(() => {
      expect(mockListDevices).toHaveBeenCalled()
    })

    await act(async () => {
      await result.current.connectDevice(mockDevice)
    })
    expect(result.current.connectedDevice).toEqual(mockDevice)

    await act(async () => {
      await result.current.disconnectDevice()
    })
    expect(result.current.connectedDevice).toBeNull()
    expect(mockCloseDevice).toHaveBeenCalled()
  })

  describe('auto-detect polling', () => {
    it('polls listDevices when not connected', async () => {
      mockListDevices.mockResolvedValue([])
      const { result } = renderHook(() => useDeviceConnection())

      // Wait for initial fetch
      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalled()
      })
      mockListDevices.mockClear()

      // Set the mock to return a device for the next poll
      mockListDevices.mockResolvedValue([mockDevice])

      // The polling interval fires every 1s; wait up to 5s
      await waitFor(
        () => {
          expect(result.current.devices).toEqual([mockDevice])
        },
        { timeout: 5000, interval: 200 },
      )
    })

    it('does not poll listDevices when connected', async () => {
      mockListDevices.mockResolvedValue([mockDevice])
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(result.current.devices).toEqual([mockDevice])
      })

      // Connect to device
      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })
      expect(result.current.connectedDevice).toEqual(mockDevice)

      mockListDevices.mockClear()

      // Wait for the polling interval to call isDeviceOpen instead of listDevices
      await waitFor(
        () => {
          expect(mockIsDeviceOpen).toHaveBeenCalled()
        },
        { timeout: 5000, interval: 200 },
      )

      expect(mockListDevices).not.toHaveBeenCalled()
    })

    it('detects disconnection via isDeviceOpen returning false', async () => {
      mockListDevices.mockResolvedValue([mockDevice])
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(result.current.devices).toEqual([mockDevice])
      })

      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })
      expect(result.current.connectedDevice).toEqual(mockDevice)

      // Simulate device disconnection
      mockIsDeviceOpen.mockResolvedValue(false)

      await waitFor(
        () => {
          expect(result.current.connectedDevice).toBeNull()
        },
        { timeout: 5000, interval: 200 },
      )

      expect(mockCloseDevice).toHaveBeenCalled()
    })

    it('sets connectedDevice to null even if closeDevice throws', async () => {
      mockListDevices.mockResolvedValue([mockDevice])
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(result.current.devices).toEqual([mockDevice])
      })

      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })

      mockIsDeviceOpen.mockResolvedValue(false)
      mockCloseDevice.mockRejectedValue(new Error('already closed'))

      await waitFor(
        () => {
          expect(result.current.connectedDevice).toBeNull()
        },
        { timeout: 5000, interval: 200 },
      )
    })

    it('treats isDeviceOpen exception as disconnection', async () => {
      mockListDevices.mockResolvedValue([mockDevice])
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(result.current.devices).toEqual([mockDevice])
      })

      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })

      mockIsDeviceOpen.mockRejectedValue(new Error('device error'))

      await waitFor(
        () => {
          expect(result.current.connectedDevice).toBeNull()
        },
        { timeout: 5000, interval: 200 },
      )
    })

    it('ignores listDevices polling errors silently', async () => {
      mockListDevices.mockResolvedValue([])
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalled()
      })

      const initialCallCount = mockListDevices.mock.calls.length

      // Simulate polling error
      mockListDevices.mockRejectedValue(new Error('USB error'))

      // Wait for at least one poll to fire with the error
      await waitFor(
        () => {
          expect(mockListDevices.mock.calls.length).toBeGreaterThan(initialCallCount)
        },
        { timeout: 5000, interval: 200 },
      )

      // Should not set error state from polling failures
      expect(result.current.error).toBeNull()
      expect(result.current.devices).toEqual([])
    })

    it('resumes listDevices polling after disconnect', async () => {
      mockListDevices.mockResolvedValue([mockDevice])
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(result.current.devices).toEqual([mockDevice])
      })

      // Connect
      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })
      expect(result.current.connectedDevice).toEqual(mockDevice)

      // Disconnect via polling
      mockIsDeviceOpen.mockResolvedValue(false)
      await waitFor(
        () => {
          expect(result.current.connectedDevice).toBeNull()
        },
        { timeout: 5000, interval: 200 },
      )

      // Next poll should call listDevices again
      mockListDevices.mockClear()
      mockListDevices.mockResolvedValue([mockDevice])

      await waitFor(
        () => {
          expect(mockListDevices).toHaveBeenCalled()
        },
        { timeout: 5000, interval: 200 },
      )

      expect(result.current.devices).toEqual([mockDevice])
    })
  })
})
