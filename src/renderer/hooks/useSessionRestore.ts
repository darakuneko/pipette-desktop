// SPDX-License-Identifier: GPL-2.0-or-later

import { useEffect, useRef } from 'react'
import type { DeviceInfo } from '../../shared/types/protocol'
import type { LastDeviceInfo } from '../../shared/types/app-config'

/** How long to keep looking for the last-used keyboard before giving up
 * silently. The matcher itself re-runs on the ~1s device-list polls (see
 * useDeviceConnection), but the give-up is an owned timer so it fires
 * even if that polling cadence ever changes or pauses. */
const SESSION_RESTORE_TIMEOUT_MS = 10_000

interface UseSessionRestoreOptions {
  /** True only once app-config has finished loading, restoreLastSession
   * is on, and a last-used device is on record. */
  enabled: boolean
  devices: DeviceInfo[]
  connectedDevice: DeviceInfo | null
  lastDevice: LastDeviceInfo | null
  /** The exact connect function DeviceSelector uses, so the full
   * handleConnect chain (uid load, sync download, prefs apply) runs the
   * same way a manual click would trigger it. */
  connect: (device: DeviceInfo) => void | Promise<void>
}

function findLastDeviceMatch(devices: DeviceInfo[], lastDevice: LastDeviceInfo): DeviceInfo | undefined {
  if (lastDevice.serialNumber) {
    return devices.find((d) =>
      d.vendorId === lastDevice.vendorId &&
      d.productId === lastDevice.productId &&
      d.serialNumber === lastDevice.serialNumber)
  }
  return devices.find((d) => d.vendorId === lastDevice.vendorId && d.productId === lastDevice.productId)
}

/**
 * Auto-connects the last-used keyboard once at launch when
 * restoreLastSession is enabled. One-shot per app session: gives up
 * silently once a match connects, the user connects a device
 * themselves, or SESSION_RESTORE_TIMEOUT_MS elapses without a match —
 * no toast, no warning, the user just sees the normal device selector
 * (or, on a hidden launch, nothing at all).
 *
 * Never triggers for the dummy device path: `devices` only ever lists
 * real HID devices from `listDevices()`, and connectDummy()/
 * connectPipetteFile() never add entries to it.
 */
export function useSessionRestore({ enabled, devices, connectedDevice, lastDevice, connect }: UseSessionRestoreOptions): void {
  const attemptedRef = useRef(false)
  const connectRef = useRef(connect)
  connectRef.current = connect

  useEffect(() => {
    const id = window.setTimeout(() => {
      attemptedRef.current = true
    }, SESSION_RESTORE_TIMEOUT_MS)
    return () => window.clearTimeout(id)
  }, [])

  useEffect(() => {
    if (!enabled || attemptedRef.current) return

    if (connectedDevice) {
      // The user connected something themselves before a match was found.
      attemptedRef.current = true
      return
    }

    if (!lastDevice) return

    const match = findLastDeviceMatch(devices, lastDevice)
    if (!match) return

    attemptedRef.current = true
    void connectRef.current(match)
  }, [enabled, devices, connectedDevice, lastDevice])
}
