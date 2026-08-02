// SPDX-License-Identifier: GPL-2.0-or-later
//
// Per-row Installed-tab actions for Theme Packs: Export, Delete (with
// the owned-post Hub cascade), Upload / Update / Sync / Remove.
// Split out of ThemePacksModal (Task-split-pack-modals) — mirrors
// use-language-pack-actions.ts; `pushPackToHub` is returned because the
// sibling import hook's rename-commit and multi-file batch reuse it for
// their own auto-sync step.

import { useCallback } from 'react'
import type { TFunction } from 'i18next'
import { isPackTheme, extractPackId } from '../../hooks/useTheme'
import { localizeHubError } from '../../utils/hub-error-i18n'
import { fetchHubPackMeta } from '../pack-modal/fetch-hub-pack-meta'
import { isOwnPack } from '../pack-modal/ownership'
import type { HubThemePackBody } from '../../../shared/types/hub'
import type { ThemeSelection } from '../../../shared/types/app-config'
import type { UseThemePackStoreReturn } from '../../hooks/useThemePackStore'
import type { PackActionResult } from '../pack-modal/pack-modal-types'

export interface UseThemePackActionsOptions {
  store: UseThemePackStoreReturn
  t: TFunction
  activeTheme: ThemeSelection
  onThemeChange: (mode: ThemeSelection) => void
  currentDisplayName: string | null
  setPendingId: (id: string | null) => void
  setActionError: (error: string | null) => void
  setLastResult: (result: PackActionResult | PackActionResult[] | null) => void
  setConfirmDeleteId: (id: string | null) => void
  setConfirmRemoveId: (id: string | null) => void
}

export function useThemePackActions({
  store,
  t,
  activeTheme,
  onThemeChange,
  currentDisplayName,
  setPendingId,
  setActionError,
  setLastResult,
  setConfirmDeleteId,
  setConfirmRemoveId,
}: UseThemePackActionsOptions) {
  const pushPackToHub = useCallback(async (
    packId: string,
    hubPostId: string,
  ): Promise<{ success: boolean; error?: string }> => {
    const get = await window.vialAPI.themePackGet(packId)
    if (!get.success || !get.data) {
      return { success: false, error: get.error ?? t('themePacks.parseError') }
    }
    const res = await window.vialAPI.hubUpdateThemePost({
      postId: hubPostId,
      entryId: packId,
      pack: get.data.pack as HubThemePackBody,
    })
    if (res.success) {
      await store.refresh()
      return { success: true }
    }
    return { success: false, error: localizeHubError(res.error, 'hub.updateFailed', t) }
  }, [store, t])

  const handleExport = useCallback(async (id: string) => {
    setActionError(null)
    setPendingId(id)
    try {
      const result = await store.exportPack(id)
      if (!result.success && result.error) setActionError(result.error)
    } finally {
      setPendingId(null)
    }
  }, [store])

  const handleDelete = useCallback(async (id: string) => {
    setActionError(null)
    setLastResult(null)
    setPendingId(id)
    try {
      const meta = store.metas.find((m) => m.id === id)
      // Cascade to Hub only for posts *we* own — the orphan-post
      // prevention argument (a local-only delete would strand a name
      // nobody can re-upload) only holds for a post the user could
      // actually re-upload themselves. A downloaded (foreign) pack
      // also carries `hubPostId` (for Sync/freshness linkage), so
      // gating on presence alone would attempt — and fail — a Hub
      // delete the user has no rights to, then block the local delete
      // on that failure. Not-owned entries delete locally only, no
      // Hub call, same as Update/Remove's `isMine` gating.
      if (meta?.hubPostId && isOwnPack(meta.hubPostId, meta.uploaderName ?? '', currentDisplayName)) {
        // If the Hub deletion fails, abort the cascade — proceeding to
        // a local-only delete would strand an orphan post whose name
        // can never be re-uploaded, exactly what the cascade is meant
        // to avoid.
        const hubResult = await window.vialAPI.hubDeleteThemePost(meta.hubPostId, id)
          .catch((err) => ({ success: false, error: err instanceof Error ? err.message : String(err) }))
        if (!hubResult.success) {
          setLastResult({ id, kind: 'error', message: hubResult.error ?? t('themePacks.parseError') })
          return
        }
      }
      const result = await store.remove(id)
      if (!result.success && result.error) setActionError(result.error)
      if (result.success && isPackTheme(activeTheme) && extractPackId(activeTheme) === id) {
        onThemeChange('system')
      }
    } finally {
      setPendingId(null)
      setConfirmDeleteId(null)
    }
  }, [store, activeTheme, onThemeChange, t, currentDisplayName])

  const handleUpload = useCallback(async (id: string): Promise<void> => {
    setPendingId(id)
    setActionError(null)
    setLastResult(null)
    try {
      const get = await window.vialAPI.themePackGet(id)
      if (!get.success || !get.data) {
        setLastResult({ id, kind: 'error', message: get.error ?? t('themePacks.parseError') })
        return
      }
      const result = await window.vialAPI.hubUploadThemePost({
        entryId: id,
        pack: get.data.pack as HubThemePackBody,
      })
      if (result.success) {
        setLastResult({ id, kind: 'success', message: t('hub.uploadSuccess') })
        await store.refresh()
      } else {
        setLastResult({ id, kind: 'error', message: result.error ?? t('hub.uploadFailed') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store, t])

  const handleUpdate = useCallback(async (id: string): Promise<void> => {
    const meta = store.metas.find((m) => m.id === id)
    if (!meta?.hubPostId) return
    setPendingId(id)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await pushPackToHub(id, meta.hubPostId)
      if (result.success) {
        setLastResult({ id, kind: 'success', message: t('hub.updateSuccess') })
      } else {
        setLastResult({ id, kind: 'error', message: result.error ?? t('hub.updateFailed') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store.metas, pushPackToHub, t])

  const handleSync = useCallback(async (id: string): Promise<void> => {
    const meta = store.metas.find((m) => m.id === id)
    if (!meta?.hubPostId) return
    setPendingId(id)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await window.vialAPI.hubDownloadThemePost(meta.hubPostId)
      if (!result.success || !result.data) {
        setLastResult({ id, kind: 'error', message: result.error ?? t('themePacks.parseError') })
        return
      }
      // Refresh the Author/Updated cache the same way upload/update do —
      // the download body carries no metadata, so look the post back up
      // by its (possibly just-changed) name via the Hub list endpoint.
      const enriched = await fetchHubPackMeta(window.vialAPI.hubListThemePosts, result.data.name, meta.hubPostId)
      const apply = await store.applyImport(result.data, {
        id,
        hubPostId: meta.hubPostId,
        hubUpdatedAt: enriched.hubUpdatedAt,
        uploaderName: enriched.uploaderName,
      })
      if (apply.success) {
        setLastResult({ id, kind: 'success', message: t('common.synced') })
        await store.refresh()
      } else {
        setLastResult({ id, kind: 'error', message: apply.error ?? t('themePacks.parseError') })
      }
    } finally {
      setPendingId(null)
    }
  }, [store, t])

  const handleRemove = useCallback(async (id: string): Promise<void> => {
    const meta = store.metas.find((m) => m.id === id)
    if (!meta?.hubPostId) return
    setPendingId(id)
    setActionError(null)
    setLastResult(null)
    try {
      const result = await window.vialAPI.hubDeleteThemePost(meta.hubPostId, id)
      if (result.success) {
        setLastResult({ id, kind: 'success', message: t('hub.removeSuccess') })
        await store.refresh()
      } else {
        setLastResult({ id, kind: 'error', message: result.error ?? t('hub.removeFailed') })
      }
    } finally {
      setPendingId(null)
      setConfirmRemoveId(null)
    }
  }, [store, t])

  return {
    pushPackToHub,
    handleExport,
    handleDelete,
    handleUpload,
    handleUpdate,
    handleSync,
    handleRemove,
  }
}
