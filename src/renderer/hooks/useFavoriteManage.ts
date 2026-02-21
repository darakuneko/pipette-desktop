// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FavoriteType, SavedFavoriteMeta } from '../../shared/types/favorite-store'
import type { FavoriteImportResultState } from './useFavoriteStore'

export interface UseFavoriteManageReturn {
  entries: SavedFavoriteMeta[]
  exporting: boolean
  importing: boolean
  importResult: FavoriteImportResultState | null
  refreshEntries: () => Promise<void>
  renameEntry: (entryId: string, newLabel: string) => Promise<boolean>
  deleteEntry: (entryId: string) => Promise<boolean>
  exportAll: () => Promise<boolean>
  exportEntry: (entryId: string) => Promise<boolean>
  importFavorites: () => Promise<boolean>
}

export function useFavoriteManage(favoriteType: FavoriteType): UseFavoriteManageReturn {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<SavedFavoriteMeta[]>([])
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<FavoriteImportResultState | null>(null)

  const refreshEntries = useCallback(async () => {
    try {
      const result = await window.vialAPI.favoriteStoreList(favoriteType)
      if (result.success && result.entries) {
        setEntries(result.entries)
      }
    } catch {
      // Silently ignore list errors
    }
  }, [favoriteType])

  const renameEntry = useCallback(async (entryId: string, newLabel: string): Promise<boolean> => {
    try {
      const result = await window.vialAPI.favoriteStoreRename(favoriteType, entryId, newLabel)
      if (!result.success) return false
      await refreshEntries()
      return true
    } catch {
      return false
    }
  }, [favoriteType, refreshEntries])

  const deleteEntry = useCallback(async (entryId: string): Promise<boolean> => {
    try {
      const result = await window.vialAPI.favoriteStoreDelete(favoriteType, entryId)
      if (!result.success) return false
      await refreshEntries()
      return true
    } catch {
      return false
    }
  }, [favoriteType, refreshEntries])

  const doExport = useCallback(async (entryId?: string): Promise<boolean> => {
    setExporting(true)
    try {
      const result = entryId !== undefined
        ? await window.vialAPI.favoriteStoreExport(favoriteType, entryId)
        : await window.vialAPI.favoriteStoreExport(favoriteType)
      if (!result.success) return false
      return true
    } catch {
      return false
    } finally {
      setExporting(false)
    }
  }, [favoriteType])

  const exportAll = useCallback(async (): Promise<boolean> => {
    return doExport()
  }, [doExport])

  const exportEntry = useCallback(async (entryId: string): Promise<boolean> => {
    return doExport(entryId)
  }, [doExport])

  const importFavorites = useCallback(async (): Promise<boolean> => {
    setImportResult(null)
    setImporting(true)
    try {
      const result = await window.vialAPI.favoriteStoreImport()
      if (!result.success) {
        if (result.error !== 'cancelled') {
          setImportResult({ imported: 0, skipped: 0 })
        }
        return false
      }
      setImportResult({ imported: result.imported, skipped: result.skipped })
      await refreshEntries()
      return true
    } catch {
      return false
    } finally {
      setImporting(false)
    }
  }, [refreshEntries, t])

  return {
    entries,
    exporting,
    importing,
    importResult,
    refreshEntries,
    renameEntry,
    deleteEntry,
    exportAll,
    exportEntry,
    importFavorites,
  }
}
