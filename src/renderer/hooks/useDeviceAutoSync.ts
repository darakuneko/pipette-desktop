// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef } from 'react'
import { EMPTY_UID } from '../../shared/constants/protocol'
import type { DeviceInfo } from '../../shared/types/protocol'

interface Options {
  connectedDevice: DeviceInfo | null
  isPipetteFile: boolean
  keyboardUid: string | undefined
  keyboardLoading: boolean
  syncLoading: boolean
  autoSync: boolean
  authenticated: boolean
  hasPassword: boolean
  syncNow: (direction: 'download', opts: { favorites: true; keyboard: string }) => Promise<void>
}

interface DeviceAutoSyncResult {
  deviceSyncing: boolean
  phase2SyncPending: boolean
}

export function useDeviceAutoSync(options: Options): DeviceAutoSyncResult {
  const {
    connectedDevice,
    isPipetteFile,
    keyboardUid,
    keyboardLoading,
    syncLoading,
    autoSync,
    authenticated,
    hasPassword,
    syncNow,
  } = options

  const [deviceSyncing, setDeviceSyncing] = useState(false)
  const hasSyncedRef = useRef(false)
  const hasKeyboardSyncedRef = useRef<string | null>(null)

  useEffect(() => {
    if (!connectedDevice) {
      if (!deviceSyncing) {
        hasSyncedRef.current = false
        hasKeyboardSyncedRef.current = null
      }
      return
    }

    if (isPipetteFile) return

    if (!keyboardUid || keyboardUid === EMPTY_UID) {
      hasKeyboardSyncedRef.current = null
      return
    }

    if (hasKeyboardSyncedRef.current === keyboardUid) return
    if (!autoSync || !authenticated || !hasPassword) return
    if (syncLoading || deviceSyncing) return

    hasSyncedRef.current = true
    hasKeyboardSyncedRef.current = keyboardUid
    setDeviceSyncing(true)
    syncNow('download', { favorites: true as const, keyboard: keyboardUid })
      .catch(() => { hasSyncedRef.current = false; hasKeyboardSyncedRef.current = null })
      .finally(() => setDeviceSyncing(false))
  }, [connectedDevice, isPipetteFile, keyboardUid, keyboardLoading,
      syncLoading, autoSync, authenticated, hasPassword,
      syncNow, deviceSyncing])

  const phase2SyncPending = !deviceSyncing && !isPipetteFile &&
    !!connectedDevice && !!keyboardUid && keyboardUid !== EMPTY_UID &&
    hasKeyboardSyncedRef.current !== keyboardUid &&
    autoSync && authenticated && hasPassword && !syncLoading

  return { deviceSyncing, phase2SyncPending }
}
