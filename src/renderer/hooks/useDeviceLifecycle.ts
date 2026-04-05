// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useAutoLock } from './useAutoLock'
import { isKeyboardDefinition, isVilFile, isVilFileV1, VILFILE_CURRENT_VERSION } from '../../shared/vil-file'
import type { DeviceInfo, VilFile, KeyboardDefinition } from '../../shared/types/protocol'
import type { PipetteFileKeyboard, PipetteFileEntry } from '../app-types'

interface Options {
  // Device connection
  connectDevice: (dev: DeviceInfo) => Promise<boolean>
  disconnectDevice: () => Promise<void>
  connectDummy: () => void
  connectPipetteFile: (name: string) => void
  isPipetteFile: boolean
  // Keyboard
  keyboardUid: string | undefined
  keyboardReload: () => Promise<string | undefined>
  keyboardReset: () => void
  keyboardLoadDummy: (def: KeyboardDefinition) => void
  keyboardLoadPipetteFile: (vil: VilFile) => void
  refreshUnlockStatus: () => Promise<void>
  unlocked: boolean
  activityCount: number
  // Device prefs
  applyDevicePrefs: (uid: string) => Promise<void>
  autoLockTime: number
  // Sync
  autoSync: boolean
  authenticated: boolean
  hasPassword: boolean
  syncNow: (direction: string, target: string) => Promise<void>
  deviceSyncing: boolean
  // Cross-cutting callbacks
  resetUIState: () => void
  clearFileStatus: () => void
  resetHubState: () => void
  matrixMode: boolean
  typingTestMode: boolean
  typingTestViewOnly: boolean
}

export function useDeviceLifecycle(options: Options) {
  const {
    connectDevice,
    disconnectDevice,
    connectDummy,
    connectPipetteFile,
    isPipetteFile,
    keyboardUid,
    keyboardReload,
    keyboardReset,
    keyboardLoadDummy,
    keyboardLoadPipetteFile,
    refreshUnlockStatus,
    unlocked,
    activityCount,
    applyDevicePrefs,
    autoLockTime,
    autoSync,
    authenticated,
    hasPassword,
    syncNow,
    deviceSyncing,
    resetUIState,
    clearFileStatus,
    resetHubState,
    matrixMode,
    typingTestMode,
    typingTestViewOnly,
  } = options

  const { t } = useTranslation()

  const [fileLoadError, setFileLoadError] = useState<string | null>(null)
  const [deviceLoadError, setDeviceLoadError] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [showDataModal, setShowDataModal] = useState(false)
  const [lastLoadedLabel, setLastLoadedLabel] = useState('')
  const [pipetteFileKeyboards, setPipetteFileKeyboards] = useState<PipetteFileKeyboard[]>([])
  const [pipetteFileEntries, setPipetteFileEntries] = useState<PipetteFileEntry[]>([])
  const [resettingData, setResettingData] = useState(false)
  const pipetteFileSavedActivityRef = useRef(0)
  const hasFavSyncedForDataRef = useRef(false)

  // Clear loaded label when device identity changes
  useEffect(() => {
    if (!isPipetteFile) setLastLoadedLabel('')
  }, [keyboardUid, isPipetteFile])

  const handleDisconnect = useCallback(async () => {
    try {
      await window.vialAPI.lock().catch(() => {})
      await disconnectDevice()
    } finally {
      keyboardReset()
      resetUIState()
      clearFileStatus()
      setLastLoadedLabel('')
      setDeviceLoadError(null)
      resetHubState()
    }
  }, [disconnectDevice, keyboardReset, resetUIState, clearFileStatus, resetHubState])

  const handleConnect = useCallback(
    async (dev: DeviceInfo) => {
      setFileLoadError(null)
      setDeviceLoadError(null)
      const success = await connectDevice(dev)
      if (success) {
        const uid = await keyboardReload()
        if (uid) {
          await applyDevicePrefs(uid)
        } else {
          try { await handleDisconnect() } catch { /* cleanup best-effort */ }
          setDeviceLoadError(t('error.notVialCompatible'))
        }
      }
    },
    [connectDevice, keyboardReload, applyDevicePrefs, handleDisconnect, t],
  )

  const handleLock = useCallback(async () => {
    await window.vialAPI.lock()
    await refreshUnlockStatus()
  }, [refreshUnlockStatus])

  useAutoLock({
    unlocked,
    autoLockMinutes: autoLockTime,
    activityCounter: activityCount,
    suspended: matrixMode || typingTestMode || typingTestViewOnly,
    onLock: handleLock,
  })

  const handleOpenDataModal = useCallback(() => {
    setShowDataModal(true)
    if (!hasFavSyncedForDataRef.current &&
        autoSync && authenticated && hasPassword && !deviceSyncing) {
      hasFavSyncedForDataRef.current = true
      void syncNow('download', 'favorites').catch(() => { hasFavSyncedForDataRef.current = false })
    }
  }, [autoSync, authenticated, hasPassword, syncNow, deviceSyncing])

  const refreshPipetteFileEntries = useCallback(async () => {
    try {
      const keyboards = await window.vialAPI.listStoredKeyboards()
      const kbList: PipetteFileKeyboard[] = []
      const entries: PipetteFileEntry[] = []
      for (const kb of keyboards) {
        const result = await window.vialAPI.snapshotStoreList(kb.uid)
        if (!result.success || !result.entries) continue
        let count = 0
        for (const e of result.entries) {
          if (e.vilVersion == null || e.vilVersion >= VILFILE_CURRENT_VERSION) {
            entries.push({
              uid: kb.uid,
              entryId: e.id,
              label: e.label,
              keyboardName: kb.name,
              savedAt: e.updatedAt ?? e.savedAt,
            })
            count++
          }
        }
        if (count > 0) {
          kbList.push({ uid: kb.uid, name: kb.name, entryCount: count })
        }
      }
      entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
      setPipetteFileKeyboards(kbList)
      setPipetteFileEntries(entries)
    } catch {
      // Non-critical
    }
  }, [])

  const handleLoadDummy = useCallback(async () => {
    setFileLoadError(null)
    try {
      const result = await window.vialAPI.sideloadJson(t('app.loadDummy'))
      if (!result.success) {
        if (result.error !== 'cancelled') setFileLoadError(t('error.sideloadFailed'))
        return
      }
      if (!isKeyboardDefinition(result.data)) {
        setFileLoadError(t('error.sideloadInvalidDefinition'))
        return
      }
      connectDummy()
      keyboardLoadDummy(result.data)
    } catch {
      setFileLoadError(t('error.sideloadFailed'))
    }
  }, [connectDummy, keyboardLoadDummy, t])

  const openPipetteVil = useCallback(async (vil: VilFile, fallbackName: string, loadedLabel?: string) => {
    const name = vil.definition?.name ?? fallbackName
    connectPipetteFile(name)
    keyboardLoadPipetteFile(vil)
    pipetteFileSavedActivityRef.current = activityCount
    setLastLoadedLabel(loadedLabel ?? '')
    if (vil.uid) {
      await applyDevicePrefs(vil.uid)
    }
  }, [connectPipetteFile, keyboardLoadPipetteFile, activityCount, applyDevicePrefs])

  const handleOpenPipetteFileEntry = useCallback(async (entry: PipetteFileEntry) => {
    setFileLoadError(null)
    try {
      const result = await window.vialAPI.snapshotStoreLoad(entry.uid, entry.entryId)
      if (!result.success || !result.data) {
        setFileLoadError(t('error.loadFailed'))
        return
      }
      const parsed: unknown = JSON.parse(result.data)
      if (!isVilFile(parsed) || isVilFileV1(parsed)) {
        setFileLoadError(t('error.vilV1NotSupported'))
        return
      }
      await openPipetteVil(parsed, entry.keyboardName, entry.label || entry.keyboardName)
    } catch {
      setFileLoadError(t('error.loadFailed'))
    }
  }, [openPipetteVil, t])

  const handleLoadPipetteFile = useCallback(async () => {
    setFileLoadError(null)
    try {
      const result = await window.vialAPI.loadLayout(t('app.loadPipetteFile'), ['pipette'])
      if (!result.success) {
        if (result.error !== 'cancelled') setFileLoadError(t('error.loadFailed'))
        return
      }
      if (!result.data) {
        setFileLoadError(t('error.loadFailed'))
        return
      }
      const parsed: unknown = JSON.parse(result.data)
      if (!isVilFile(parsed) || isVilFileV1(parsed)) {
        setFileLoadError(t('error.vilV1NotSupported'))
        return
      }
      const fileName = result.filePath?.split('/').pop()?.split('\\').pop()?.replace(/\.[^.]+$/, '') ?? ''
      await openPipetteVil(parsed, 'Keyboard', fileName)
    } catch {
      setFileLoadError(t('error.loadFailed'))
    }
  }, [openPipetteVil, t])

  const clearFileLoadError = useCallback(() => setFileLoadError(null), [])

  return {
    fileLoadError,
    clearFileLoadError,
    deviceLoadError,
    showSettings,
    setShowSettings,
    showDataModal,
    setShowDataModal,
    lastLoadedLabel,
    setLastLoadedLabel,
    pipetteFileKeyboards,
    pipetteFileEntries,
    resettingData,
    setResettingData,
    pipetteFileSavedActivityRef,
    handleConnect,
    handleDisconnect,
    handleLock,
    handleOpenDataModal,
    refreshPipetteFileEntries,
    handleLoadDummy,
    handleLoadPipetteFile,
    handleOpenPipetteFileEntry,
  }
}
