// SPDX-License-Identifier: GPL-2.0-or-later
// Per-keyboard analyze filter snapshot store (label + search condition).
// Mirrors useLayoutStore.ts so the UI layer can reuse the
// list/save/load/rename/delete idiom. The snapshot payload itself is
// renderer-side because it composes the full AnalyzeFilters state and
// the renderer-only AnalysisTab key — main only stores the JSON
// opaquely.

import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ANALYZE_FILTER_STORE_ERROR_MAX_ENTRIES,
  ANALYZE_FILTER_STORE_MAX_ENTRIES_PER_KEYBOARD,
  type AnalyzeFilterSnapshotMeta,
} from '../../shared/types/analyze-filter-store'
import type { AnalysisTabKey, RangeMs } from '../components/analyze/analyze-types'
import type { AnalyzeFiltersState } from './useAnalyzeFilters'
import type {
  HubAnalyticsCategoryId,
  HubAnalyticsLayoutComparisonInputs,
} from '../../shared/types/hub'
import type { HubEntryResult } from '../components/editors/layout-store-types'
import { localizeHubError } from '../utils/hub-error-i18n'

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

/** Per-call inputs for the Hub upload pipeline. The hook stays
 * decoupled from AnalyzePane state — the caller assembles the bits the
 * IPC needs (keyboard meta, finger overrides, optional layout
 * comparison maps, thumbnail, category picks) and the hook drives the
 * round-trip + the panel's status flash. */
export interface UploadAnalyticsToHubInput {
  entryId: string
  title: string
  thumbnailBase64: string
  keyboard: { productName: string; vendorId: number; productId: number }
  fingerOverrides: Record<string, string>
  layoutComparisonInputs: HubAnalyticsLayoutComparisonInputs | null
  /** User's category selection from the upload modal. Empty / absent
   * ships everything (back-compat with the early build). */
  categories?: HubAnalyticsCategoryId[]
  /** Which apps to include in `appData`. Undefined ships every app. */
  appDataApps?: string[]
}

const HUB_RESULT_FLASH_MS = 4_000

export function useAnalyzeFilterStore({ uid }: UseAnalyzeFilterStoreOptions) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<AnalyzeFilterSnapshotMeta[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  // Mirrors useHubState's flash pattern: which entry is mid-upload, and
  // the last upload's success/failure with the entry id stamped on it
  // so the panel can show the row-local status banner.
  const [hubUploading, setHubUploading] = useState<string | null>(null)
  const [hubUploadResult, setHubUploadResult] = useState<HubEntryResult | null>(null)
  const hubResultTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hubInflightRef = useRef(false)

  const flashHubResult = useCallback((result: HubEntryResult) => {
    setHubUploadResult(result)
    if (hubResultTimerRef.current) clearTimeout(hubResultTimerRef.current)
    hubResultTimerRef.current = setTimeout(() => {
      setHubUploadResult((current) => current === result ? null : current)
    }, HUB_RESULT_FLASH_MS)
  }, [])

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

  /** Overwrite an existing entry while preserving its `hubPostId` so
   * the user's Hub link stays valid after the rewrite. Implemented as
   * delete + re-save to mirror the keymap save panel
   * (`useHubState.handleOverwriteSave`) — that approach refreshes
   * `summary` + `savedAt` automatically and lets us re-stamp the
   * postId on the freshly created entry. */
  const overwriteSnapshot = useCallback(async (
    entryId: string,
    label: string,
    payload: AnalyzeFilterSnapshotPayload,
    summary?: string,
  ): Promise<string | null> => {
    if (!uid) return null
    setError(null)
    const previous = entries.find((e) => e.id === entryId)
    const previousHubPostId = previous?.hubPostId
    setSaving(true)
    try {
      const deleteResult = await window.vialAPI.analyzeFilterStoreDelete(uid, entryId)
      if (!deleteResult.success) {
        setError(t('analyzeFilterStore.saveFailed'))
        return null
      }
      const json = JSON.stringify(payload, null, 2)
      const saveResult = await window.vialAPI.analyzeFilterStoreSave(uid, json, label, summary)
      if (!saveResult.success || !saveResult.entry) {
        setError(saveResult.error === ANALYZE_FILTER_STORE_ERROR_MAX_ENTRIES
          ? t('analyzeFilterStore.maxEntriesReached', { max: ANALYZE_FILTER_STORE_MAX_ENTRIES_PER_KEYBOARD })
          : t('analyzeFilterStore.saveFailed'))
        return null
      }
      const newEntryId = saveResult.entry.id
      // Re-stamp the hubPostId so the Hub row keeps showing the same
      // post id after the in-place overwrite. Best-effort: a failure
      // here just downgrades to "row reverts to Upload affordance",
      // not a save failure.
      if (previousHubPostId) {
        await window.vialAPI.analyzeFilterStoreSetHubPostId(uid, newEntryId, previousHubPostId)
          .catch(() => { /* leave the row without a hub link rather than block the save */ })
      }
      await refreshEntries()
      return newEntryId
    } catch {
      setError(t('analyzeFilterStore.saveFailed'))
      return null
    } finally {
      setSaving(false)
    }
  }, [uid, entries, refreshEntries, t])

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
      const entry = entries.find((e) => e.id === entryId)
      const [, result] = await Promise.all([
        entry?.hubPostId
          ? window.vialAPI.hubDeletePost(entry.hubPostId).catch(() => {})
          : Promise.resolve(),
        window.vialAPI.analyzeFilterStoreDelete(uid, entryId),
      ])
      if (!result.success) return false
      await refreshEntries()
      return true
    } catch {
      return false
    }
  }, [uid, entries, refreshEntries])

  const uploadEntryToHub = useCallback(async (input: UploadAnalyticsToHubInput): Promise<{ ok: boolean }> => {
    if (!uid || hubInflightRef.current) return { ok: false }
    hubInflightRef.current = true
    setHubUploading(input.entryId)
    let ok = false
    try {
      const result = await window.vialAPI.hubUploadAnalyticsPost({
        uid,
        entryId: input.entryId,
        title: input.title,
        thumbnailBase64: input.thumbnailBase64,
        keyboard: input.keyboard,
        fingerOverrides: input.fingerOverrides,
        layoutComparisonInputs: input.layoutComparisonInputs,
        categories: input.categories,
        appDataApps: input.appDataApps,
      })
      if (result.success && result.postId) {
        ok = true
        flashHubResult({ kind: 'success', message: t('hub.uploadSuccess'), entryId: input.entryId })
        await refreshEntries()
      } else {
        flashHubResult({
          kind: 'error',
          message: localizeHubError(result.error, 'hub.uploadFailed', t),
          entryId: input.entryId,
        })
      }
    } catch (err) {
      flashHubResult({
        kind: 'error',
        message: localizeHubError(err instanceof Error ? err.message : undefined, 'hub.uploadFailed', t),
        entryId: input.entryId,
      })
    } finally {
      hubInflightRef.current = false
      setHubUploading(null)
    }
    return { ok }
  }, [uid, refreshEntries, t, flashHubResult])

  const updateEntryOnHub = useCallback(async (input: UploadAnalyticsToHubInput): Promise<{ ok: boolean }> => {
    if (!uid || hubInflightRef.current) return { ok: false }
    const entry = entries.find((e) => e.id === input.entryId)
    const postId = entry?.hubPostId
    if (!entry || !postId) {
      flashHubResult({ kind: 'error', message: t('hub.updateFailed'), entryId: input.entryId })
      return { ok: false }
    }
    hubInflightRef.current = true
    setHubUploading(input.entryId)
    let ok = false
    try {
      const result = await window.vialAPI.hubUpdateAnalyticsPost({
        uid,
        entryId: input.entryId,
        title: input.title,
        thumbnailBase64: input.thumbnailBase64,
        keyboard: input.keyboard,
        fingerOverrides: input.fingerOverrides,
        layoutComparisonInputs: input.layoutComparisonInputs,
        categories: input.categories,
        appDataApps: input.appDataApps,
        postId,
      })
      if (result.success) {
        ok = true
        flashHubResult({ kind: 'success', message: t('hub.updateSuccess'), entryId: input.entryId })
        await refreshEntries()
      } else {
        flashHubResult({
          kind: 'error',
          message: localizeHubError(result.error, 'hub.updateFailed', t),
          entryId: input.entryId,
        })
      }
    } catch (err) {
      flashHubResult({
        kind: 'error',
        message: localizeHubError(err instanceof Error ? err.message : undefined, 'hub.updateFailed', t),
        entryId: input.entryId,
      })
    } finally {
      hubInflightRef.current = false
      setHubUploading(null)
    }
    return { ok }
  }, [uid, entries, refreshEntries, t, flashHubResult])

  // Remove from Hub — deletes the post on the Hub server, then clears
  // the local hubPostId so the row reverts to the upload state.
  const removeEntryFromHub = useCallback(async (entryId: string): Promise<void> => {
    if (!uid || hubInflightRef.current) return
    const entry = entries.find((e) => e.id === entryId)
    const postId = entry?.hubPostId
    if (!entry || !postId) return
    hubInflightRef.current = true
    setHubUploading(entryId)
    try {
      const deleteResult = await window.vialAPI.hubDeletePost(postId)
      if (!deleteResult.success) {
        flashHubResult({
          kind: 'error',
          message: localizeHubError(deleteResult.error, 'hub.removeFailed', t),
          entryId,
        })
        return
      }
      await window.vialAPI.analyzeFilterStoreSetHubPostId(uid, entryId, null).catch(() => {})
      flashHubResult({ kind: 'success', message: t('hub.removeSuccess'), entryId })
      await refreshEntries()
    } catch (err) {
      flashHubResult({
        kind: 'error',
        message: localizeHubError(err instanceof Error ? err.message : undefined, 'hub.removeFailed', t),
        entryId,
      })
    } finally {
      hubInflightRef.current = false
      setHubUploading(null)
    }
  }, [uid, entries, refreshEntries, t, flashHubResult])

  return {
    entries,
    error,
    saving,
    loading,
    refreshEntries,
    saveSnapshot,
    overwriteSnapshot,
    loadSnapshot,
    renameEntry,
    deleteEntry,
    hubUploading,
    hubUploadResult,
    uploadEntryToHub,
    updateEntryOnHub,
    removeEntryFromHub,
  }
}
