// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDeviceConnection } from '../useDeviceConnection'
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

describe('useDeviceConnection — pipette file mode', () => {
  describe('connectPipetteFile', () => {
    it('sets connectedDevice with given name', () => {
      const { result } = renderHook(() => useDeviceConnection())

      act(() => {
        result.current.connectPipetteFile('My Keyboard')
      })

      expect(result.current.connectedDevice).toEqual({
        vendorId: 0,
        productId: 0,
        productName: 'My Keyboard',
        serialNumber: '',
        type: 'vial',
      })
    })

    it('sets isDummy and isPipetteFile to true', () => {
      const { result } = renderHook(() => useDeviceConnection())

      act(() => {
        result.current.connectPipetteFile('My Keyboard')
      })

      expect(result.current.isDummy).toBe(true)
      expect(result.current.isPipetteFile).toBe(true)
    })

    it('does not call vialAPI.openDevice', () => {
      const { result } = renderHook(() => useDeviceConnection())

      act(() => {
        result.current.connectPipetteFile('My Keyboard')
      })

      expect(mockOpenDevice).not.toHaveBeenCalled()
    })
  })

  describe('disconnectDevice for pipette file', () => {
    it('resets isPipetteFile to false', async () => {
      const { result } = renderHook(() => useDeviceConnection())

      act(() => {
        result.current.connectPipetteFile('My Keyboard')
      })
      expect(result.current.isPipetteFile).toBe(true)

      await act(async () => {
        await result.current.disconnectDevice()
      })

      expect(result.current.connectedDevice).toBeNull()
      expect(result.current.isDummy).toBe(false)
      expect(result.current.isPipetteFile).toBe(false)
      expect(mockCloseDevice).not.toHaveBeenCalled()
    })
  })

  describe('connectDummy does not set isPipetteFile', () => {
    it('isPipetteFile remains false for dummy connections', () => {
      const { result } = renderHook(() => useDeviceConnection())

      act(() => {
        result.current.connectDummy()
      })

      expect(result.current.isDummy).toBe(true)
      expect(result.current.isPipetteFile).toBe(false)
    })
  })
})
