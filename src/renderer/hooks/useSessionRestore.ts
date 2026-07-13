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
  /** True once app-config has finished its initial load. Used only to
   * detect the single render where the launch decision gets latched —
   * see the module doc comment below. */
  configLoaded: boolean
  /** The restoreLastSession setting as read from app-config. Only its
   * value at the moment configLoaded first becomes true is used; later
   * changes (the user toggling it in Settings) are intentionally
   * ignored for the rest of this session. */
  restoreEnabled: boolean
  devices: DeviceInfo[]
  connectedDevice: DeviceInfo | null
  /** Same latching rule as restoreEnabled: only the snapshot present at
   * the moment configLoaded first becomes true is used. */
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
 * Launch-only by design: the decision to arm restoration is latched
 * exactly once, on the first render where `configLoaded` is true, from
 * the `restoreEnabled` / `lastDevice` values at that instant. Toggling
 * Restore Last Session in Settings mid-session never arms (or disarms)
 * this hook — the change only takes effect on the next launch. This
 * prevents flipping the toggle ON from immediately hijacking the
 * device the user is about to pick by hand while the 10s window is
 * still open.
 *
 * Never triggers for the dummy device path: `devices` only ever lists
 * real HID devices from `listDevices()`, and connectDummy()/
 * connectPipetteFile() never add entries to it.
 */
export function useSessionRestore({ configLoaded, restoreEnabled, devices, connectedDevice, lastDevice, connect }: UseSessionRestoreOptions): void {
  const attemptedRef = useRef(false)
  const armedRef = useRef(false)
  const latchedRef = useRef(false)
  const lastDeviceSnapshotRef = useRef<LastDeviceInfo | null>(null)
  const connectRef = useRef(connect)
  connectRef.current = connect

  // Latch the launch decision exactly once, on the first render where
  // config has finished loading. Reads happen during render (not in an
  // effect) so the very first post-load render already has the correct
  // armed state before the matcher effect below runs.
  if (configLoaded && !latchedRef.current) {
    latchedRef.current = true
    lastDeviceSnapshotRef.current = lastDevice
    armedRef.current = restoreEnabled && lastDevice != null
  }

  useEffect(() => {
    const id = window.setTimeout(() => {
      attemptedRef.current = true
    }, SESSION_RESTORE_TIMEOUT_MS)
    return () => window.clearTimeout(id)
  }, [])

  // configLoaded is included in the deps below solely to force this
  // effect to re-run on the render where arming gets latched above
  // (armedRef flips outside of React's dependency tracking) — it is not
  // read in the effect body itself.
  useEffect(() => {
    if (!armedRef.current || attemptedRef.current) return

    if (connectedDevice) {
      // The user connected something themselves before a match was found.
      attemptedRef.current = true
      return
    }

    const snapshot = lastDeviceSnapshotRef.current
    if (!snapshot) return

    const match = findLastDeviceMatch(devices, snapshot)
    if (!match) return

    attemptedRef.current = true
    void connectRef.current(match)
  }, [configLoaded, devices, connectedDevice])
}
