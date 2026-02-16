// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import type { DeviceInfo } from '../../shared/types/protocol'

export interface DeviceConnectionState {
  devices: DeviceInfo[]
  connectedDevice: DeviceInfo | null
  connecting: boolean
  error: string | null
  isDummy: boolean
}

/** Polling interval for device auto-detection and disconnect monitoring (ms) */
export const POLL_INTERVAL_MS = 1000

export function useDeviceConnection() {
  const [state, setState] = useState<DeviceConnectionState>({
    devices: [],
    connectedDevice: null,
    connecting: false,
    error: null,
    isDummy: false,
  })
  const mountedRef = useRef(true)
  const connectedDeviceRef = useRef<DeviceInfo | null>(null)
  const isDummyRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Keep refs in sync with state
  useEffect(() => {
    connectedDeviceRef.current = state.connectedDevice
    isDummyRef.current = state.isDummy
  }, [state.connectedDevice, state.isDummy])

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await window.vialAPI.listDevices()
      if (mountedRef.current) {
        setState((s) => ({ ...s, devices, error: null }))
      }
    } catch (err) {
      if (mountedRef.current) {
        setState((s) => ({ ...s, error: String(err) }))
      }
    }
  }, [])

  const connectDevice = useCallback(async (device: DeviceInfo) => {
    setState((s) => ({ ...s, connecting: true, error: null }))
    try {
      const success = await window.vialAPI.openDevice(
        device.vendorId,
        device.productId,
      )
      if (mountedRef.current) {
        if (success) {
          setState((s) => ({
            ...s,
            connectedDevice: device,
            connecting: false,
          }))
        } else {
          setState((s) => ({
            ...s,
            connecting: false,
            error: 'Failed to open device',
          }))
        }
      }
      return success
    } catch (err) {
      if (mountedRef.current) {
        setState((s) => ({ ...s, connecting: false, error: String(err) }))
      }
      return false
    }
  }, [])

  const connectDummy = useCallback(() => {
    const dummyDevice: DeviceInfo = {
      vendorId: 0,
      productId: 0,
      productName: 'Dummy_Keyboard',
      serialNumber: '',
      type: 'vial',
    }
    // Update refs immediately to avoid stale-ref races
    connectedDeviceRef.current = dummyDevice
    isDummyRef.current = true
    if (mountedRef.current) {
      setState((s) => ({
        ...s,
        connectedDevice: dummyDevice,
        isDummy: true,
        connecting: false,
        error: null,
      }))
    }
  }, [])

  const disconnectDevice = useCallback(async () => {
    const wasDummy = isDummyRef.current
    // Update refs immediately to avoid stale-ref races
    connectedDeviceRef.current = null
    isDummyRef.current = false
    try {
      if (!wasDummy) {
        await window.vialAPI.closeDevice()
      }
    } finally {
      if (mountedRef.current) {
        setState((s) => ({ ...s, connectedDevice: null, isDummy: false }))
      }
    }
  }, [])

  // Initial device list fetch
  useEffect(() => {
    refreshDevices()
  }, [refreshDevices])

  // Auto-detect polling: refresh device list when disconnected,
  // monitor connection health when connected
  useEffect(() => {
    async function handleDisconnect(): Promise<void> {
      try {
        await window.vialAPI.closeDevice()
      } catch {
        // Device already closed — ignore cleanup errors
      }
      connectedDeviceRef.current = null
      isDummyRef.current = false
      if (mountedRef.current) {
        setState((s) => ({ ...s, connectedDevice: null, isDummy: false }))
      }
    }

    const interval = setInterval(async () => {
      if (!mountedRef.current) return

      if (connectedDeviceRef.current) {
        // Skip health check for dummy keyboards
        if (isDummyRef.current) return
        // Check if the connected device is still physically present
        const open = await window.vialAPI.isDeviceOpen().catch(() => false)
        if (!open) await handleDisconnect()
      } else {
        // Refresh device list for auto-detection
        try {
          const devices = await window.vialAPI.listDevices()
          if (mountedRef.current) {
            setState((s) => ({ ...s, devices, error: null }))
          }
        } catch {
          // Ignore polling errors to avoid flooding the UI
        }
      }
    }, POLL_INTERVAL_MS)

    return () => clearInterval(interval)
  }, []) // stable — uses refs internally

  return {
    ...state,
    refreshDevices,
    connectDevice,
    connectDummy,
    disconnectDevice,
  }
}
