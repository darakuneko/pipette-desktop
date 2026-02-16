// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDeviceConnection, POLL_INTERVAL_MS } from '../useDeviceConnection'
import type { DeviceInfo } from '../../../shared/types/protocol'

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

describe('useDeviceConnection — dummy mode', () => {
  describe('connectDummy', () => {
    it('sets connectedDevice with fake DeviceInfo', () => {
      const { result } = renderHook(() => useDeviceConnection())

      act(() => {
        result.current.connectDummy()
      })

      expect(result.current.connectedDevice).toEqual({
        vendorId: 0,
        productId: 0,
        productName: 'Dummy_Keyboard',
        serialNumber: '',
        type: 'vial',
      })
    })

    it('sets isDummy to true', () => {
      const { result } = renderHook(() => useDeviceConnection())

      act(() => {
        result.current.connectDummy()
      })

      expect(result.current.isDummy).toBe(true)
    })

    it('does not call vialAPI.openDevice', () => {
      const { result } = renderHook(() => useDeviceConnection())

      act(() => {
        result.current.connectDummy()
      })

      expect(mockOpenDevice).not.toHaveBeenCalled()
    })

    it('clears any previous error', () => {
      const { result } = renderHook(() => useDeviceConnection())

      act(() => {
        result.current.connectDummy()
      })

      expect(result.current.error).toBeNull()
      expect(result.current.connecting).toBe(false)
    })
  })

  describe('disconnectDevice for dummy', () => {
    it('does not call vialAPI.closeDevice', async () => {
      const { result } = renderHook(() => useDeviceConnection())

      act(() => {
        result.current.connectDummy()
      })
      expect(result.current.isDummy).toBe(true)

      await act(async () => {
        await result.current.disconnectDevice()
      })

      expect(mockCloseDevice).not.toHaveBeenCalled()
      expect(result.current.connectedDevice).toBeNull()
      expect(result.current.isDummy).toBe(false)
    })
  })

  describe('polling skips isDeviceOpen for dummy', () => {
    it('does not call isDeviceOpen when dummy is connected', async () => {
      const { result } = renderHook(() => useDeviceConnection())

      // Wait for initial device list fetch
      await waitFor(() => {
        expect(mockListDevices).toHaveBeenCalled()
      })

      act(() => {
        result.current.connectDummy()
      })
      expect(result.current.connectedDevice).not.toBeNull()

      mockIsDeviceOpen.mockClear()

      // Wait for at least one polling cycle
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS + 200))

      expect(mockIsDeviceOpen).not.toHaveBeenCalled()
      // Dummy should still be connected
      expect(result.current.connectedDevice).not.toBeNull()
    })
  })
})
