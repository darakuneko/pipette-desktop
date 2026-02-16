// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { VilFile } from '../../shared/types/protocol'
import type { SnapshotMeta } from '../../shared/types/snapshot-store'
import { isVilFile } from '../../shared/vil-file'

export interface UseLayoutStoreOptions {
  deviceUid: string
  deviceName: string
  serialize: () => VilFile
  applyVilFile: (vil: VilFile) => Promise<void>
}

export function useLayoutStore({
  deviceUid,
  deviceName,
  serialize,
  applyVilFile,
}: UseLayoutStoreOptions) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<SnapshotMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  const refreshEntries = useCallback(async () => {
    try {
      const result = await window.vialAPI.snapshotStoreList(deviceUid)
      if (result.success && result.entries) {
        setEntries(result.entries)
      }
    } catch {
      // Silently ignore list errors
    }
  }, [deviceUid])

  const saveLayout = useCallback(async (label: string): Promise<boolean> => {
    setError(null)
    setSaving(true)
    try {
      const json = JSON.stringify(serialize(), null, 2)
      const result = await window.vialAPI.snapshotStoreSave(deviceUid, json, deviceName, label)
      if (!result.success) {
        setError(t('layoutStore.saveFailed'))
        return false
      }
      await refreshEntries()
      return true
    } catch {
      setError(t('layoutStore.saveFailed'))
      return false
    } finally {
      setSaving(false)
    }
  }, [deviceUid, deviceName, serialize, refreshEntries, t])

  const loadLayout = useCallback(async (entryId: string): Promise<boolean> => {
    setError(null)
    setLoading(true)
    try {
      const result = await window.vialAPI.snapshotStoreLoad(deviceUid, entryId)
      if (!result.success || !result.data) {
        setError(t('layoutStore.loadFailed'))
        return false
      }

      const parsed: unknown = JSON.parse(result.data)
      if (!isVilFile(parsed)) {
        setError(t('layoutStore.loadFailed'))
        return false
      }

      await applyVilFile(parsed)
      return true
    } catch {
      setError(t('layoutStore.loadFailed'))
      return false
    } finally {
      setLoading(false)
    }
  }, [deviceUid, applyVilFile, t])

  const renameEntry = useCallback(async (entryId: string, newLabel: string): Promise<boolean> => {
    setError(null)
    try {
      const result = await window.vialAPI.snapshotStoreRename(deviceUid, entryId, newLabel)
      if (!result.success) {
        return false
      }
      await refreshEntries()
      return true
    } catch {
      return false
    }
  }, [deviceUid, refreshEntries])

  const deleteEntry = useCallback(async (entryId: string): Promise<boolean> => {
    setError(null)
    try {
      const result = await window.vialAPI.snapshotStoreDelete(deviceUid, entryId)
      if (!result.success) {
        return false
      }
      await refreshEntries()
      return true
    } catch {
      return false
    }
  }, [deviceUid, refreshEntries])

  return {
    entries,
    error,
    saving,
    loading,
    refreshEntries,
    saveLayout,
    loadLayout,
    renameEntry,
    deleteEntry,
  }
}
