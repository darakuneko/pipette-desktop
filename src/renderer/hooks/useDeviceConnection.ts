// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import type { DeviceInfo } from '../../shared/types/protocol'

export interface DeviceConnectionState {
  devices: DeviceInfo[]
  connectedDevice: DeviceInfo | null
  connecting: boolean
  error: string | null
  isDummy: boolean
  isPipetteFile: boolean
}

/** Polling interval for device auto-detection and disconnect monitoring (ms) */
export const POLL_INTERVAL_MS = 1000

/** Maximum time to wait for a single poll IPC call before giving up (ms) */
export const POLL_TIMEOUT_MS = 5000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Poll timeout')), ms),
    ),
  ])
}

export function useDeviceConnection() {
  const [state, setState] = useState<DeviceConnectionState>({
    devices: [],
    connectedDevice: null,
    connecting: false,
    error: null,
    isDummy: false,
    isPipetteFile: false,
  })
  const mountedRef = useRef(true)
  const connectedDeviceRef = useRef<DeviceInfo | null>(null)
  const isDummyRef = useRef(false)
  const deviceListActiveRef = useRef(false)
  // Skip all USB activity when suspended (e.g. during unlock dialog).
  // USB device enumeration disrupts firmware operations like unlock counter.
  const pollSuspendedRef = useRef(false)

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
        isPipetteFile: false,
        connecting: false,
        error: null,
      }))
    }
  }, [])

  const connectPipetteFile = useCallback((deviceName: string) => {
    const pipetteFileDevice: DeviceInfo = {
      vendorId: 0,
      productId: 0,
      productName: deviceName,
      serialNumber: '',
      type: 'vial',
    }
    // Update refs immediately to avoid stale-ref races
    connectedDeviceRef.current = pipetteFileDevice
    isDummyRef.current = true
    if (mountedRef.current) {
      setState((s) => ({
        ...s,
        connectedDevice: pipetteFileDevice,
        isDummy: true,
        isPipetteFile: true,
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
        setState((s) => ({ ...s, connectedDevice: null, isDummy: false, isPipetteFile: false }))
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
        setState((s) => ({ ...s, connectedDevice: null, isDummy: false, isPipetteFile: false }))
      }
    }

    let timerId: ReturnType<typeof setTimeout> | null = null
    let cancelled = false

    async function poll(): Promise<void> {
      if (!mountedRef.current || cancelled) return

      // Skip all USB activity while suspended (e.g. during unlock dialog)
      if (pollSuspendedRef.current) {
        if (!cancelled) timerId = setTimeout(poll, POLL_INTERVAL_MS)
        return
      }

      // Refresh device list only when device picker is actively browsing
      if (deviceListActiveRef.current || !connectedDeviceRef.current) {
        try {
          const devices = await withTimeout(
            window.vialAPI.listDevices(),
            POLL_TIMEOUT_MS,
          )
          if (mountedRef.current) {
            setState((s) => ({ ...s, devices, error: null }))
          }
        } catch {
          // Ignore polling errors (including timeouts) to avoid flooding the UI
        }
      }

      if (connectedDeviceRef.current) {
        // Health check for connected device (skip for dummy keyboards)
        if (!isDummyRef.current) {
          const open = await withTimeout(
            window.vialAPI.isDeviceOpen(),
            POLL_TIMEOUT_MS,
          ).catch(() => false)
          if (!open) await handleDisconnect()
        }
      }

      // Schedule next poll only after current one completes
      if (!cancelled) {
        timerId = setTimeout(poll, POLL_INTERVAL_MS)
      }
    }

    timerId = setTimeout(poll, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      if (timerId !== null) clearTimeout(timerId)
    }
  }, []) // stable — uses refs internally

  const setDeviceListActive = useCallback((active: boolean) => { deviceListActiveRef.current = active }, [])
  const setPollSuspended = useCallback((suspended: boolean) => { pollSuspendedRef.current = suspended }, [])

  return {
    ...state,
    refreshDevices,
    connectDevice,
    connectDummy,
    connectPipetteFile,
    disconnectDevice,
    setDeviceListActive,
    setPollSuspended,
  }
}
