// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAppConfig } from './useAppConfig'
import type { AppConfig } from '../../shared/types/app-config'
import { isSyncTerminalStatus } from '../../shared/types/sync'
import type {
  SyncAuthStatus,
  SyncProgress,
  SyncStatus,
  SyncStatusType,
  SyncTerminalStatus,
  PasswordStrength,
  LastSyncResult,
  SyncResetTargets,
  UndecryptableFile,
  SyncScope,
} from '../../shared/types/sync'

/** Maps a SyncProgress status or LastSyncResult status to the UI SyncStatusType. */
const SYNC_STATUS_MAP: Record<SyncStatus, SyncStatusType> & Record<SyncTerminalStatus, SyncStatusType> = {
  idle: 'none',
  syncing: 'syncing',
  error: 'error',
  success: 'synced',
  partial: 'partial',
}

export interface UseSyncReturn {
  config: AppConfig
  authStatus: SyncAuthStatus
  hasPassword: boolean
  hasPendingChanges: boolean
  progress: SyncProgress | null
  lastSyncResult: LastSyncResult | null
  syncStatus: SyncStatusType
  loading: boolean
  startAuth: () => Promise<void>
  signOut: () => Promise<void>
  setConfig: (patch: Partial<AppConfig>) => void
  setPassword: (password: string) => Promise<{ success: boolean; error?: string }>
  changePassword: (newPassword: string) => Promise<{ success: boolean; error?: string }>
  resetSyncTargets: (targets: SyncResetTargets) => Promise<{ success: boolean; error?: string }>
  validatePassword: (password: string) => Promise<PasswordStrength>
  cancelPending: () => Promise<void>
  syncNow: (direction: 'download' | 'upload', scope?: SyncScope) => Promise<void>
  refreshStatus: () => Promise<void>
  listUndecryptable: () => Promise<UndecryptableFile[]>
  deleteFiles: (fileIds: string[]) => Promise<{ success: boolean; error?: string }>
}

export function useSync(): UseSyncReturn {
  const { config, set } = useAppConfig()
  const [authStatus, setAuthStatus] = useState<SyncAuthStatus>({ authenticated: false })
  const [hasPassword, setHasPassword] = useState(false)
  const [hasPendingChangesState, setHasPendingChanges] = useState(false)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [lastSyncResult, setLastSyncResult] = useState<LastSyncResult | null>(null)
  const [loading, setLoading] = useState(true)

  const refreshStatus = useCallback(async () => {
    try {
      const [auth, pwd, pending] = await Promise.all([
        window.vialAPI.syncAuthStatus(),
        window.vialAPI.syncHasPassword(),
        window.vialAPI.syncHasPendingChanges(),
      ])
      setAuthStatus(auth)
      setHasPassword(pwd)
      setHasPendingChanges(pending)
    } catch {
      // Ignore errors during initial load
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    return window.vialAPI.syncOnPendingChange(setHasPendingChanges)
  }, [])

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const cleanup = window.vialAPI.syncOnProgress((p: SyncProgress) => {
      if (timeoutId) {
        clearTimeout(timeoutId)
        timeoutId = null
      }
      setProgress(p)
      if (isSyncTerminalStatus(p.status)) {
        // Only update lastSyncResult on final events (no syncUnit = end of entire sync)
        if (!p.syncUnit) {
          setLastSyncResult({
            status: p.status,
            message: p.message,
            failedUnits: p.failedUnits,
            timestamp: Date.now(),
          })
        }
        timeoutId = setTimeout(() => setProgress(null), 3000)
      }
    })
    return () => {
      if (timeoutId) clearTimeout(timeoutId)
      cleanup()
    }
  }, [])

  const startAuth = useCallback(async () => {
    const result = await window.vialAPI.syncAuthStart()
    if (result.success) {
      await refreshStatus()
    } else {
      throw new Error(result.error ?? 'Auth failed')
    }
  }, [refreshStatus])

  const signOut = useCallback(async () => {
    await window.vialAPI.syncAuthSignOut()
    setLastSyncResult(null)
    await refreshStatus()
  }, [refreshStatus])

  const setConfig = useCallback((patch: Partial<AppConfig>) => {
    for (const [key, value] of Object.entries(patch)) {
      set(key as keyof AppConfig, value as AppConfig[keyof AppConfig])
    }
  }, [set])

  const callPasswordApi = useCallback(
    async (apiFn: (pw: string) => Promise<{ success: boolean; error?: string }>, password: string) => {
      const result = await apiFn(password)
      if (result.success) {
        setHasPassword(true)
      }
      return result
    },
    [],
  )

  const setPassword = useCallback(
    (password: string) => callPasswordApi(window.vialAPI.syncSetPassword, password),
    [callPasswordApi],
  )

  const changePassword = useCallback(
    (newPassword: string) => callPasswordApi(window.vialAPI.syncChangePassword, newPassword),
    [callPasswordApi],
  )

  const resetSyncTargets = useCallback(
    (targets: SyncResetTargets) => window.vialAPI.syncResetTargets(targets),
    [],
  )

  const validatePassword = useCallback(
    (password: string) => window.vialAPI.syncValidatePassword(password),
    [],
  )

  const cancelPending = useCallback(async () => {
    await window.vialAPI.syncCancelPending()
  }, [])

  const syncNow = useCallback(async (direction: 'download' | 'upload', scope?: SyncScope) => {
    await window.vialAPI.syncExecute(direction, scope)
  }, [])

  const listUndecryptable = useCallback(
    () => window.vialAPI.syncListUndecryptable(),
    [],
  )

  const deleteFiles = useCallback(
    (fileIds: string[]) => window.vialAPI.syncDeleteFiles(fileIds),
    [],
  )

  const syncStatus = useMemo((): SyncStatusType => {
    if (progress?.status && progress.status !== 'idle') {
      return SYNC_STATUS_MAP[progress.status]
    }
    if (!authStatus.authenticated || !hasPassword) return 'none'
    if (config.autoSync && hasPendingChangesState) return 'pending'
    if (lastSyncResult) return SYNC_STATUS_MAP[lastSyncResult.status]
    return 'none'
  }, [progress, authStatus.authenticated, hasPassword, config.autoSync, hasPendingChangesState, lastSyncResult])

  return {
    config,
    authStatus,
    hasPassword,
    hasPendingChanges: hasPendingChangesState,
    progress,
    lastSyncResult,
    syncStatus,
    loading,
    startAuth,
    signOut,
    setConfig,
    setPassword,
    changePassword,
    resetSyncTargets,
    validatePassword,
    cancelPending,
    syncNow,
    refreshStatus,
    listUndecryptable,
    deleteFiles,
  }
}
