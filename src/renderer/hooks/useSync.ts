// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useAppConfig } from './useAppConfig'
import type { AppConfig } from '../../shared/types/app-config'
import type {
  SyncAuthStatus,
  SyncProgress,
  SyncStatusType,
  PasswordStrength,
  LastSyncResult,
  SyncResetTargets,
} from '../../shared/types/sync'

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
  resetPassword: (password: string) => Promise<{ success: boolean; error?: string }>
  resetSyncTargets: (targets: SyncResetTargets) => Promise<{ success: boolean; error?: string }>
  validatePassword: (password: string) => Promise<PasswordStrength>
  cancelPending: () => Promise<void>
  syncNow: (direction: 'download' | 'upload') => Promise<void>
  refreshStatus: () => Promise<void>
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
      if (p.status === 'success' || p.status === 'error') {
        // Only update lastSyncResult on final events (no syncUnit = end of entire sync)
        if (!p.syncUnit) {
          setLastSyncResult({ status: p.status, message: p.message, timestamp: Date.now() })
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

  const resetPassword = useCallback(
    (password: string) => callPasswordApi(window.vialAPI.syncResetPassword, password),
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

  const syncNow = useCallback(async (direction: 'download' | 'upload') => {
    await window.vialAPI.syncExecute(direction)
  }, [])

  const syncStatus = useMemo((): SyncStatusType => {
    if (progress?.status === 'syncing') return 'syncing'
    if (progress?.status === 'error') return 'error'
    if (progress?.status === 'success') return 'synced'
    if (!authStatus.authenticated || !hasPassword) return 'none'
    if (config.autoSync && hasPendingChangesState) return 'pending'
    if (lastSyncResult?.status === 'error') return 'error'
    if (lastSyncResult?.status === 'success') return 'synced'
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
    resetPassword,
    resetSyncTargets,
    validatePassword,
    cancelPending,
    syncNow,
    refreshStatus,
  }
}
