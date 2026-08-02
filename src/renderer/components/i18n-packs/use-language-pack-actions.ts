// SPDX-License-Identifier: GPL-2.0-or-later
//
// Per-row Installed-tab actions: Open on Hub, Sync / Update / Remove /
// Upload / Delete, "not set keys" lookup, and Export (including the
// built-in English browser-download branch). Split out of
// LanguagePacksModal (Task-split-pack-modals) — `pushPackToHub` is
// returned because the sibling import hook's rename-commit and
// overwrite-reimport paths reuse it for their own auto-sync step.

import { useCallback } from 'react'
import type { TFunction } from 'i18next'
import { computeCoverage } from '../../../shared/i18n/coverage'
import { BASE_REVISION, ENGLISH_PACK_BODY } from '../../i18n/coverage-cache'
import english from '../../i18n/locales/english.json'
import { downloadJson } from '../../utils/download-json'
import { buildHubI18nPackUrl } from '../../../shared/hub-urls'
import { localizeHubError } from '../../utils/hub-error-i18n'
import { fetchHubPackMeta } from '../pack-modal/fetch-hub-pack-meta'
import { isOwnPack } from '../pack-modal/ownership'
import type { UseI18nPackStoreReturn } from '../../hooks/useI18nPackStore'
import type { PackActionResult } from '../pack-modal/pack-modal-types'
import type { InstalledRow } from './LanguageInstalledRow'

const APP_VERSION = (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? '0.0.0'

export interface UseLanguagePackActionsOptions {
  store: UseI18nPackStoreReturn
  t: TFunction
  hubOrigin: string
  currentDisplayName?: string | null
  setPendingId: (id: string | null) => void
  setActionError: (error: string | null) => void
  setLastResult: (result: PackActionResult | PackActionResult[] | null) => void
  setConfirmDeleteId: (id: string | null) => void
  setConfirmRemoveId: (id: string | null) => void
  setMissingKeysFor: (value: { name: string; keys: string[] } | null) => void
}

export function useLanguagePackActions({
  store,
  t,
  hubOrigin,
  currentDisplayName,
  setPendingId,
  setActionError,
  setLastResult,
  setConfirmDeleteId,
  setConfirmRemoveId,
  setMissingKeysFor,
}: UseLanguagePackActionsOptions) {
  const handleOpen = useCallback((row: InstalledRow): void => {
    if (!row.hubPostId || !hubOrigin) return
    void window.vialAPI.openExternal(buildHubI18nPackUrl(hubOrigin.replace(/\/$/, ''), row.hubPostId))
  }, [hubOrigin])

  const handleDelete = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.packId) return
    // Delete is the strongest action: tombstone locally and, if the
    // pack mirrors a Hub post *we own*, drop the post too so the user
    // does not need to click Remove + Delete in sequence to fully
    // clean up. If the Hub deletion fails, abort the cascade —
    // proceeding to a local-only delete would strand an orphan post
    // whose name can never be re-uploaded, exactly what the cascade is
    // meant to avoid. That argument only holds for a post the user
    // could actually re-upload themselves, though — a downloaded
    // (foreign) pack also carries `hubPostId` (for Sync/freshness
    // linkage), so gating on presence alone would attempt — and fail —
    // a Hub delete the user has no rights to, then block the local
    // delete on that failure. Not-owned entries delete locally only,
    // no Hub call, same as Update/Remove's `isMine` gating.
    const owned = row.hubPostId && isOwnPack(row.hubPostId, row.uploaderName, currentDisplayName ?? null)
    setPendingId(row.packId)
    setActionError(null)
    setLastResult(null)
    try {
      if (owned) {
        const hubResult = await window.vialAPI.hubDeleteI18nPost(row.hubPostId as string, row.packId)
          .catch((err) => ({ success: false, error: err instanceof Error ? err.message : String(err) }))
        if (!hubResult.success) {
          setLastResult({ id: row.packId, kind: 'error', message: hubResult.error ?? t('i18n.errorGeneric') })
          return
        }
      }
      const result = await store.remove(row.packId)
      if (!result.success) {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('i18n.errorGeneric') })
        return
      }
      await store.refresh()
    } finally {
      setPendingId(null)
      setConfirmDeleteId(null)
    }
  }, [store, t, currentDisplayName])

  // Push the local pack body to its existing Hub post. Used by the
  // explicit "Update" action here and by the sibling import hook's
  // auto-sync paths (rename / overwrite re-import). Returns the
  // IPC-style result so callers can decide whether to surface the
  // error inline.
  const pushPackToHub = useCallback(async (
    packId: string,
    hubPostId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    const get = await window.vialAPI.i18nPackGet(packId)
    if (!get.success || !get.data) {
      return { success: false, error: get.error ?? t('i18n.errorGeneric') }
    }
    const res = await window.vialAPI.hubUpdateI18nPost({
      postId: hubPostId,
      entryId: packId,
      pack: get.data.pack as { version: string; name: string; [k: string]: unknown },
    })
    if (res.success) {
      await store.refresh()
      return { success: true }
    }
    return { success: false, error: localizeHubError(res.error, 'hub.updateFailed', t) }
  }, [store, t])

  const handleSync = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.hubPostId) return
    setPendingId(row.packId ?? row.hubPostId)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await window.vialAPI.hubDownloadI18nPost(row.hubPostId)
      if (!result.success || !result.data) {
        setLastResult({ id: row.packId ?? row.hubPostId, kind: 'error', message: result.error ?? t('i18n.errorGeneric') })
        return
      }
      // Re-import with the existing pack id so the entry stays linked
      // to the Hub post and any prior `hubPostId` is retained. Recompute
      // coverage / matchedBaseVersion against the *current* English so
      // a Hub sync after a baseline bump correctly drops the row to
      // "incomplete" instead of inheriting stale completeness.
      const coverage = computeCoverage(result.data.pack, ENGLISH_PACK_BODY)
      // Refresh the Author/Updated cache the same way upload/update do —
      // the download body carries no metadata, so look the post back up
      // by its (possibly just-changed) name via the Hub list endpoint.
      const enriched = await fetchHubPackMeta(window.vialAPI.hubListI18nPosts, result.data.pack.name, row.hubPostId)
      const apply = await store.applyImport(result.data.pack, {
        id: row.packId ?? undefined,
        hubPostId: row.hubPostId,
        hubUpdatedAt: enriched.hubUpdatedAt,
        uploaderName: enriched.uploaderName,
        enabled: true,
        appVersionAtImport: APP_VERSION,
        matchedBaseVersion: coverage.coverageRatio === 1 ? BASE_REVISION : null,
        coverage: { totalKeys: coverage.totalKeys, coveredKeys: coverage.coveredKeys },
      })
      if (apply.success) {
        setLastResult({ id: row.packId ?? row.hubPostId, kind: 'success', message: t('common.synced') })
        await store.refresh()
      } else {
        setLastResult({ id: row.packId ?? row.hubPostId, kind: 'error', message: apply.error ?? t('i18n.errorGeneric') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store, t])

  const handleUpdate = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.packId || !row.hubPostId) return
    setPendingId(row.packId)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await pushPackToHub(row.packId, row.hubPostId)
      if (result.success) {
        setLastResult({ id: row.packId, kind: 'success', message: t('hub.updateSuccess') })
      } else {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('hub.updateFailed') })
      }
    } finally {
      setPendingId(null)
    }
  }, [pushPackToHub, t])

  const handleRemove = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.packId || !row.hubPostId) return
    setPendingId(row.packId)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await window.vialAPI.hubDeleteI18nPost(row.hubPostId, row.packId)
      if (result.success) {
        setLastResult({ id: row.packId, kind: 'success', message: t('hub.removeSuccess') })
        await store.refresh()
      } else {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('hub.removeFailed') })
      }
    } finally {
      setPendingId(null)
      setConfirmRemoveId(null)
    }
  }, [store, t])

  const handleUpload = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.packId) return
    setPendingId(row.packId)
    setActionError(null)
    setLastResult(null)
    try {
      const get = await window.vialAPI.i18nPackGet(row.packId)
      if (!get.success || !get.data) {
        setLastResult({ id: row.packId, kind: 'error', message: t('i18n.errorGeneric') })
        return
      }
      const result = await window.vialAPI.hubUploadI18nPost({
        entryId: row.packId,
        pack: get.data.pack as { version: string; name: string; [k: string]: unknown },
      })
      if (result.success) {
        setLastResult({ id: row.packId, kind: 'success', message: t('hub.uploadSuccess') })
        // setHubPostId on the main side does not push a CustomEvent
        // back to the renderer; refresh manually so the row picks up
        // the new hubPostId and surfaces Update / Remove next render.
        await store.refresh()
      } else {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('hub.uploadFailed') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store, t])

  const handleNotSetKeys = useCallback(async (row: InstalledRow): Promise<void> => {
    if (!row.packId) return
    setPendingId(row.packId)
    setActionError(null)
    try {
      // Pull the body directly and compute coverage with no sample
      // limit so the modal gets the full set of missing keys (the
      // shared coverage-cache caps at 200 for status-line use).
      const get = await window.vialAPI.i18nPackGet(row.packId)
      if (!get.success || !get.data) {
        setActionError(get.error ?? t('i18n.errorGeneric'))
        return
      }
      const coverage = computeCoverage(get.data.pack, ENGLISH_PACK_BODY, { sampleLimit: Number.POSITIVE_INFINITY })
      setMissingKeysFor({ name: row.name, keys: coverage.missingKeys })
    } finally {
      setPendingId(null)
    }
  }, [t])

  const handleExport = useCallback(async (row: InstalledRow): Promise<void> => {
    if (row.isBuiltin) {
      // Builtin English ships with the renderer bundle; trigger an
      // in-browser download instead of going through the main-side
      // dialog so users can grab the canonical pack as a starting
      // point for translations.
      try {
        downloadJson(row.name, english, { prefix: 'i18n-packs', fallback: 'English' })
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (!row.packId) return
    setPendingId(row.packId)
    setActionError(null)
    try {
      const result = await window.vialAPI.i18nPackExport(row.packId)
      if (!result.success) {
        setLastResult({ id: row.packId, kind: 'error', message: result.error ?? t('i18n.errorGeneric') })
      }
    } finally {
      setPendingId(null)
    }
  }, [t])

  return {
    handleOpen,
    handleDelete,
    pushPackToHub,
    handleSync,
    handleUpdate,
    handleRemove,
    handleUpload,
    handleNotSetKeys,
    handleExport,
  }
}
