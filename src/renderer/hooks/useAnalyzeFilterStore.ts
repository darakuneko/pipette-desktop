// SPDX-License-Identifier: GPL-2.0-or-later
// Per-keyboard analyze filter snapshot store (label + search condition).
// Mirrors useLayoutStore.ts so the UI layer can reuse the
// list/save/load/rename/delete idiom. The snapshot payload itself is
// renderer-side because it composes the full AnalyzeFilters state and
// the renderer-only AnalysisTab key — main only stores the JSON
// opaquely.

import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ANALYZE_FILTER_STORE_ERROR_MAX_ENTRIES,
  ANALYZE_FILTER_STORE_MAX_ENTRIES_PER_KEYBOARD,
  type AnalyzeFilterSnapshotMeta,
} from '../../shared/types/analyze-filter-store'
import type { AnalysisTabKey, RangeMs } from '../components/analyze/analyze-types'
import type { AnalyzeFiltersState } from './useAnalyzeFilters'

/** Serialized snapshot payload. `version` lets us evolve the shape
 * later without losing already-saved entries — readers should bail out
 * gracefully on unknown versions rather than crash. */
export interface AnalyzeFilterSnapshotPayload {
  version: 1
  analysisTab: AnalysisTabKey
  range: RangeMs
  filters: AnalyzeFiltersState
}

export function isAnalyzeFilterSnapshotPayload(value: unknown): value is AnalyzeFilterSnapshotPayload {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return v.version === 1
    && typeof v.analysisTab === 'string'
    && typeof v.range === 'object'
    && v.range !== null
    && typeof v.filters === 'object'
    && v.filters !== null
}

export interface UseAnalyzeFilterStoreOptions {
  /** Currently selected keyboard. `null` disables the hook (no IPC fires). */
  uid: string | null
}

export function useAnalyzeFilterStore({ uid }: UseAnalyzeFilterStoreOptions) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<AnalyzeFilterSnapshotMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)

  const refreshEntries = useCallback(async () => {
    // Clear first so a uid switch doesn't briefly show the prior
    // keyboard's list. The IPC then repopulates if the new uid has any.
    setEntries([])
    if (!uid) return
    try {
      const result = await window.vialAPI.analyzeFilterStoreList(uid)
      if (result.success && result.entries) {
        setEntries(result.entries)
      }
    } catch {
      // Silently ignore list errors — UI shows the empty state instead
    }
  }, [uid])

  const saveSnapshot = useCallback(async (
    label: string,
    payload: AnalyzeFilterSnapshotPayload,
    summary?: string,
  ): Promise<string | null> => {
    if (!uid) return null
    setError(null)
    setSaving(true)
    try {
      const json = JSON.stringify(payload, null, 2)
      const result = await window.vialAPI.analyzeFilterStoreSave(uid, json, label, summary)
      if (!result.success) {
        setError(result.error === ANALYZE_FILTER_STORE_ERROR_MAX_ENTRIES
          ? t('analyzeFilterStore.maxEntriesReached', { max: ANALYZE_FILTER_STORE_MAX_ENTRIES_PER_KEYBOARD })
          : t('analyzeFilterStore.saveFailed'))
        return null
      }
      await refreshEntries()
      return result.entry?.id ?? null
    } catch {
      setError(t('analyzeFilterStore.saveFailed'))
      return null
    } finally {
      setSaving(false)
    }
  }, [uid, refreshEntries, t])

  const loadSnapshot = useCallback(async (
    entryId: string,
  ): Promise<AnalyzeFilterSnapshotPayload | null> => {
    if (!uid) return null
    setError(null)
    setLoading(true)
    try {
      const result = await window.vialAPI.analyzeFilterStoreLoad(uid, entryId)
      if (!result.success || !result.data) {
        setError(t('analyzeFilterStore.loadFailed'))
        return null
      }
      const parsed: unknown = JSON.parse(result.data)
      if (!isAnalyzeFilterSnapshotPayload(parsed)) {
        // Distinguish unknown-version payloads from generic I/O errors so
        // the user gets actionable guidance instead of a vague retry hint.
        const looksVersioned = !!parsed && typeof parsed === 'object' && 'version' in (parsed as Record<string, unknown>)
        setError(t(looksVersioned ? 'analyzeFilterStore.unsupportedVersion' : 'analyzeFilterStore.loadFailed'))
        return null
      }
      return parsed
    } catch {
      setError(t('analyzeFilterStore.loadFailed'))
      return null
    } finally {
      setLoading(false)
    }
  }, [uid, t])

  const renameEntry = useCallback(async (entryId: string, newLabel: string): Promise<boolean> => {
    if (!uid) return false
    setError(null)
    try {
      const result = await window.vialAPI.analyzeFilterStoreRename(uid, entryId, newLabel)
      if (!result.success) return false
      await refreshEntries()
      return true
    } catch {
      return false
    }
  }, [uid, refreshEntries])

  const deleteEntry = useCallback(async (entryId: string): Promise<boolean> => {
    if (!uid) return false
    setError(null)
    try {
      const result = await window.vialAPI.analyzeFilterStoreDelete(uid, entryId)
      if (!result.success) return false
      await refreshEntries()
      return true
    } catch {
      return false
    }
  }, [uid, refreshEntries])

  return {
    entries,
    error,
    saving,
    loading,
    refreshEntries,
    saveSnapshot,
    loadSnapshot,
    renameEntry,
    deleteEntry,
  }
}
