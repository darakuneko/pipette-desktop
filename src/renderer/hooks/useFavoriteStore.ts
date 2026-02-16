// SPDX-License-Identifier: GPL-2.0-or-later

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { FavoriteType, SavedFavoriteMeta } from '../../shared/types/favorite-store'
import { isFavoriteDataFile } from '../../shared/favorite-data'

export interface UseFavoriteStoreOptions {
  favoriteType: FavoriteType
  serialize: () => unknown
  apply: (data: unknown) => void
  enabled?: boolean
}

export interface UseFavoriteStoreReturn {
  entries: SavedFavoriteMeta[]
  error: string | null
  saving: boolean
  loading: boolean
  showModal: boolean
  refreshEntries: () => Promise<void>
  openModal: () => Promise<void>
  closeModal: () => void
  saveFavorite: (label: string) => Promise<boolean>
  loadFavorite: (entryId: string) => Promise<boolean>
  renameEntry: (entryId: string, newLabel: string) => Promise<boolean>
  deleteEntry: (entryId: string) => Promise<boolean>
}

export function useFavoriteStore({ favoriteType, serialize, apply, enabled = true }: UseFavoriteStoreOptions): UseFavoriteStoreReturn {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<SavedFavoriteMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)

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

  const openModal = useCallback(async () => {
    await refreshEntries()
    setShowModal(true)
  }, [refreshEntries])

  const closeModal = useCallback(() => {
    setShowModal(false)
  }, [])

  const saveFavorite = useCallback(async (label: string): Promise<boolean> => {
    if (!enabled) return false
    setError(null)
    setSaving(true)
    try {
      const data = serialize()
      const json = JSON.stringify({ type: favoriteType, data })
      const result = await window.vialAPI.favoriteStoreSave(favoriteType, json, label)
      if (!result.success) {
        setError(t('favoriteStore.saveFailed'))
        return false
      }
      await refreshEntries()
      return true
    } catch {
      setError(t('favoriteStore.saveFailed'))
      return false
    } finally {
      setSaving(false)
    }
  }, [enabled, favoriteType, serialize, refreshEntries, t])

  const loadFavorite = useCallback(async (entryId: string): Promise<boolean> => {
    setError(null)
    setLoading(true)
    try {
      const result = await window.vialAPI.favoriteStoreLoad(favoriteType, entryId)
      if (!result.success || !result.data) {
        setError(t('favoriteStore.loadFailed'))
        return false
      }

      const parsed = JSON.parse(result.data) as Record<string, unknown>
      if (!isFavoriteDataFile(parsed, favoriteType)) {
        setError(t('favoriteStore.loadFailed'))
        return false
      }

      apply(parsed.data)
      setShowModal(false)
      return true
    } catch {
      setError(t('favoriteStore.loadFailed'))
      return false
    } finally {
      setLoading(false)
    }
  }, [favoriteType, apply, t])

  const renameEntry = useCallback(async (entryId: string, newLabel: string): Promise<boolean> => {
    setError(null)
    try {
      const result = await window.vialAPI.favoriteStoreRename(favoriteType, entryId, newLabel)
      if (!result.success) {
        return false
      }
      await refreshEntries()
      return true
    } catch {
      return false
    }
  }, [favoriteType, refreshEntries])

  const deleteEntry = useCallback(async (entryId: string): Promise<boolean> => {
    setError(null)
    try {
      const result = await window.vialAPI.favoriteStoreDelete(favoriteType, entryId)
      if (!result.success) {
        return false
      }
      await refreshEntries()
      return true
    } catch {
      return false
    }
  }, [favoriteType, refreshEntries])

  return {
    entries,
    error,
    saving,
    loading,
    showModal,
    refreshEntries,
    openModal,
    closeModal,
    saveFavorite,
    loadFavorite,
    renameEntry,
    deleteEntry,
  }
}
