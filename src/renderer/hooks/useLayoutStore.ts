// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { KeyboardDefinition, VilFile } from '../../shared/types/protocol'
import type { SnapshotMeta } from '../../shared/types/snapshot-store'
import { isVilFile, isVilFileV1, migrateVilFileToV2 } from '../../shared/vil-file'

export interface UseLayoutStoreOptions {
  deviceUid: string
  deviceName: string
  serialize: () => VilFile
  applyVilFile: (vil: VilFile) => Promise<void>
  /** Current device definition — used for v1→v2 auto-migration */
  currentDefinition: KeyboardDefinition | null
}

export function useLayoutStore({
  deviceUid,
  deviceName,
  serialize,
  applyVilFile,
  currentDefinition,
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

  const saveLayout = useCallback(async (label: string): Promise<string | null> => {
    setError(null)
    setSaving(true)
    try {
      const vilFile = serialize()
      const json = JSON.stringify(vilFile, null, 2)
      const result = await window.vialAPI.snapshotStoreSave(deviceUid, json, deviceName, label, vilFile.version)
      if (!result.success) {
        setError(result.error === 'max entries reached' ? t('layoutStore.maxEntriesReached') : t('layoutStore.saveFailed'))
        return null
      }
      await refreshEntries()
      return result.entry?.id ?? null
    } catch {
      setError(t('layoutStore.saveFailed'))
      return null
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

      // Auto-migrate v1 → v2: embed current device definition + protocol metadata
      if (isVilFileV1(parsed) && currentDefinition) {
        const current = serialize()
        const migrated = migrateVilFileToV2(parsed, {
          definition: currentDefinition,
          viaProtocol: current.viaProtocol,
          vialProtocol: current.vialProtocol,
          featureFlags: current.featureFlags,
        })
        // Fire-and-forget: persist migrated file without blocking the load
        window.vialAPI.snapshotStoreUpdate(
          deviceUid,
          entryId,
          JSON.stringify(migrated, null, 2),
          migrated.version,
        ).then((r) => { if (!r.success) console.warn('[Snapshot] v1→v2 migration failed:', r.error) })
        await applyVilFile(migrated)
        return true
      }

      await applyVilFile(parsed)
      return true
    } catch {
      setError(t('layoutStore.loadFailed'))
      return false
    } finally {
      setLoading(false)
    }
  }, [deviceUid, applyVilFile, currentDefinition, t])

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
