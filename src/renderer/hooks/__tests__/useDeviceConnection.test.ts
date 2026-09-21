// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDeviceConnection, POLL_INTERVAL_MS } from '../useDeviceConnection'
import type { DeviceInfo } from '../../../shared/types/protocol'

// Switchable per-test so a stale-ref bug (the hook reading `t` from the
// render that mounted it, instead of the latest one) is actually observable.
// Each call to useTranslation() snapshots the current tPrefix into a fresh
// `t` closure — mirroring real react-i18next, where `t` gets a new identity
// per render — so a `t` captured on an earlier render keeps producing that
// render's prefix even after tPrefix is later changed.
let tPrefix = ''

vi.mock('react-i18next', () => ({
  useTranslation: () => {
    const prefix = tPrefix
    return { t: (k: string) => `${prefix}${k}` }
  },
}))

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
  tPrefix = ''
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
      // (listDevices only runs when deviceListActive is true)
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

    it('does not overlap polls when async callback is slow', async () => {
      // Simulate a slow listDevices call that takes longer than POLL_INTERVAL_MS
      let resolveSlowCall: ((devices: DeviceInfo[]) => void) | null = null
      mockListDevices
        .mockImplementationOnce(() => Promise.resolve([])) // initial fetch
        .mockImplementation(
          () =>
            new Promise<DeviceInfo[]>((resolve) => {
              resolveSlowCall = resolve
            }),
        )

      renderHook(() => useDeviceConnection())

      // Wait for initial fetch
      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalledTimes(1)
      })

      // Wait for first poll to start (slow call)
      await waitFor(
        () => {
          expect(mockListDevices).toHaveBeenCalledTimes(2)
        },
        { timeout: 5000, interval: 200 },
      )

      // Wait for another interval to pass while first poll is still pending
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 200))

      // Should NOT have started another poll — still waiting for slow call
      expect(mockListDevices).toHaveBeenCalledTimes(2)

      // Resolve the slow call — resolveSlowCall is guaranteed non-null
      // because waitFor above confirmed the mock was invoked
      expect(resolveSlowCall).not.toBeNull()
      await act(async () => {
        resolveSlowCall!([])
      })

      // Now the next poll should fire after the interval
      await waitFor(
        () => {
          expect(mockListDevices.mock.calls.length).toBeGreaterThanOrEqual(3)
        },
        { timeout: 5000, interval: 200 },
      )
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

  describe('clearError', () => {
    it('clears the error via clearError', async () => {
      mockOpenDevice.mockResolvedValue(false)
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalled()
      })

      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })
      expect(result.current.error).toBe('error.deviceOpenFailed')

      act(() => {
        result.current.clearError()
      })

      expect(result.current.error).toBeNull()
    })

    it('clears the error at the start of the next connectDevice call', async () => {
      mockOpenDevice.mockResolvedValueOnce(false)
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalled()
      })

      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })
      expect(result.current.error).toBe('error.deviceOpenFailed')

      mockOpenDevice.mockResolvedValueOnce(true)
      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })

      expect(result.current.error).toBeNull()
    })
  })

  describe('error persistence across list refreshes', () => {
    it('keeps a connect failure visible across a subsequent successful refreshDevices', async () => {
      mockOpenDevice.mockResolvedValue(false)
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalled()
      })

      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })
      expect(result.current.error).toBe('error.deviceOpenFailed')

      mockListDevices.mockResolvedValue([mockDevice])
      await act(async () => {
        await result.current.refreshDevices()
      })

      expect(result.current.error).toBe('error.deviceOpenFailed')
    })

    it('keeps a connect failure visible across a subsequent successful poll tick', async () => {
      mockOpenDevice.mockResolvedValue(false)
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalled()
      })

      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })
      expect(result.current.error).toBe('error.deviceOpenFailed')

      mockListDevices.mockClear()
      mockListDevices.mockResolvedValue([mockDevice])
      await waitFor(
        () => {
          expect(mockListDevices).toHaveBeenCalled()
        },
        { timeout: 5000, interval: 200 },
      )

      expect(result.current.error).toBe('error.deviceOpenFailed')
    })
  })

  describe('raw error strings never reach the UI', () => {
    it('translates an openDevice rejection instead of surfacing the raw IPC error', async () => {
      mockOpenDevice.mockRejectedValue(
        new Error("Error invoking remote method 'hid:open': cannot open /dev/hidraw3"),
      )
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalled()
      })

      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })

      expect(result.current.error).toBe('error.deviceOpenFailed')
      expect(result.current.error).not.toContain('hidraw')
      expect(result.current.error).not.toContain('Error')
    })

    it('translates a listDevices rejection at mount', async () => {
      mockListDevices.mockRejectedValue(new Error('USB enumeration failed'))
      const { result } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(result.current.error).toBe('error.deviceListFailed')
      })
    })
  })

  describe('translation ref freshness', () => {
    it('uses the latest t after a re-render when a connect failure is translated', async () => {
      const { result, rerender } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalled()
      })

      tPrefix = 'v2:'
      rerender()

      mockOpenDevice.mockRejectedValue(new Error('boom'))
      await act(async () => {
        await result.current.connectDevice(mockDevice)
      })

      expect(result.current.error).toBe('v2:error.deviceOpenFailed')
    })
  })

  describe('callback identity', () => {
    it('keeps connectDevice and refreshDevices identities stable across a re-render', async () => {
      const { result, rerender } = renderHook(() => useDeviceConnection())

      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalled()
      })

      const { connectDevice, refreshDevices } = result.current
      rerender()

      expect(result.current.connectDevice).toBe(connectDevice)
      expect(result.current.refreshDevices).toBe(refreshDevices)
    })
  })
})
