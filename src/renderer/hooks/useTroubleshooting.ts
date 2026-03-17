// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useEffect } from 'react'
import type { UseSyncReturn } from './useSync'
import type { LocalResetTargets, StoredKeyboardInfo } from '../../shared/types/sync'

export interface UseTroubleshootingOptions {
  sync: UseSyncReturn
  active: boolean
  onResetStart?: () => void
  onResetEnd?: () => void
}

export function useTroubleshooting({ sync, active, onResetStart, onResetEnd }: UseTroubleshootingOptions) {
  const [busy, setBusy] = useState(false)
  const [localTargets, setLocalTargets] = useState<LocalResetTargets>({
    keyboards: false,
    favorites: false,
    appSettings: false,
  })
  const [confirmingLocalReset, setConfirmingLocalReset] = useState(false)
  const [importResult, setImportResult] = useState<'success' | 'error' | null>(null)
  const [storedKeyboards, setStoredKeyboards] = useState<StoredKeyboardInfo[]>([])
  const [selectedKeyboardUids, setSelectedKeyboardUids] = useState<Set<string>>(new Set())
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (!active || fetchedRef.current) return
    fetchedRef.current = true
    window.vialAPI.listStoredKeyboards().then(setStoredKeyboards).catch(() => {})
  }, [active])

  const isSyncing = sync.syncStatus === 'syncing'
  const syncDisabled = busy || !sync.authStatus.authenticated || !sync.hasPassword || isSyncing || sync.syncUnavailable

  const handleResetLocalTargets = useCallback(async () => {
    setBusy(true)
    onResetStart?.()
    try {
      const keyboardUids = Array.from(selectedKeyboardUids)
      const deletedUids = new Set<string>()
      for (const uid of keyboardUids) {
        try {
          await window.vialAPI.resetKeyboardData(uid)
          deletedUids.add(uid)
        } catch {
          /* continue deleting other keyboards */
        }
      }
      const hasNonKeyboardTargets = localTargets.favorites || localTargets.appSettings
      if (hasNonKeyboardTargets) {
        await window.vialAPI.resetLocalTargets({
          keyboards: false,
          favorites: localTargets.favorites,
          appSettings: localTargets.appSettings,
        })
      }
      if (deletedUids.size > 0 || hasNonKeyboardTargets) {
        setConfirmingLocalReset(false)
        setLocalTargets({ keyboards: false, favorites: false, appSettings: false })
        setSelectedKeyboardUids((prev) => {
          const next = new Set(prev)
          for (const uid of deletedUids) next.delete(uid)
          return next
        })
        setStoredKeyboards((prev) => prev.filter((kb) => !deletedUids.has(kb.uid)))
      }
    } finally {
      setBusy(false)
      onResetEnd?.()
    }
  }, [localTargets, selectedKeyboardUids, onResetStart, onResetEnd])

  const handleExport = useCallback(async () => {
    setBusy(true)
    try {
      await window.vialAPI.exportLocalData()
    } finally {
      setBusy(false)
    }
  }, [])

  const handleImport = useCallback(async () => {
    setBusy(true)
    try {
      const result = await window.vialAPI.importLocalData()
      setImportResult(result.success ? 'success' : 'error')
    } finally {
      setBusy(false)
    }
  }, [])

  return {
    storedKeyboards,
    selectedKeyboardUids,
    setSelectedKeyboardUids,
    localTargets,
    setLocalTargets,
    confirmingLocalReset,
    setConfirmingLocalReset,
    busy,
    isSyncing,
    syncDisabled,
    importResult,
    handleResetLocalTargets,
    handleExport,
    handleImport,
  }
}
