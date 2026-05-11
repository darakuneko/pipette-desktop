// SPDX-License-Identifier: GPL-2.0-or-later
//
// React hook around the i18n language pack store. Wraps the IPC
// surface in a stable React state, broadcasts `pipette:i18n-changed`
// CustomEvents so multiple hook instances stay in sync, and reconciles
// i18next resource bundles whenever the store mutates.
//
// Pack-removal fallback (T07) lives here: when the active language is
// `pack:{id}` and that pack disappears (delete / disable / remote
// reset), the hook flips the language back to `builtin:en` and
// stamps a one-shot notice so the UI can surface it.

import { useCallback, useEffect, useState } from 'react'
import i18n from '../i18n'
import { useAppConfig } from './useAppConfig'
import {
  packResourceBundleId,
  registerOnePack,
  syncBundlesWithStore,
  unregisterOnePack,
} from '../i18n/dynamic-bundles'
import {
  invalidateCoverage,
  refreshCoverageFromIpc,
} from '../i18n/coverage-cache'
import type {
  I18nPackImportApplyOptions,
  I18nPackImportDialogResult,
  I18nPackMeta,
} from '../../shared/types/i18n-store'

const I18N_CHANGED_EVENT = 'pipette:i18n-changed'

interface PackRemovalNotice {
  packId: string
  name: string | null
  at: number
}

export interface UseI18nPackStoreReturn {
  metas: I18nPackMeta[]
  loading: boolean
  refresh: () => Promise<void>
  setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>
  rename: (id: string, newName: string) => Promise<{ success: boolean; meta?: I18nPackMeta; error?: string }>
  remove: (id: string) => Promise<{ success: boolean; error?: string }>
  importFromDialog: () => Promise<I18nPackImportDialogResult>
  applyImport: (raw: unknown, options?: I18nPackImportApplyOptions) => Promise<{ success: boolean; meta?: I18nPackMeta; error?: string }>
  packRemovedNotice: PackRemovalNotice | null
  dismissPackRemovedNotice: () => void
}

function emitChanged(): void {
  window.dispatchEvent(new CustomEvent(I18N_CHANGED_EVENT))
}

export function useI18nPackStore(): UseI18nPackStoreReturn {
  const appConfig = useAppConfig()
  const [metas, setMetas] = useState<I18nPackMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [packRemovedNotice, setPackRemovedNotice] = useState<PackRemovalNotice | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      // Older renderer test fixtures stub a partial vialAPI; guard so a
      // missing IPC method degrades to an empty list rather than
      // tearing down React inside a useEffect.
      const list = window.vialAPI.i18nPackList
      if (!list) {
        setMetas([])
        return
      }
      const result = await list()
      if (result.success && result.data) {
        setMetas(result.data)
        await syncBundlesWithStore()
      } else {
        setMetas([])
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const handler = (): void => { void refresh() }
    window.addEventListener(I18N_CHANGED_EVENT, handler)
    // Main process broadcasts I18N_PACK_CHANGED after the startup
    // auto-update applies a Hub-side update so this hook re-renders
    // without waiting for the user to interact with the Language Pack
    // modal. Optional chain tolerates partial vialAPI mocks in tests.
    const unsubscribeIpc = window.vialAPI.i18nPackOnChanged?.(() => { void refresh() })
    return () => {
      window.removeEventListener(I18N_CHANGED_EVENT, handler)
      unsubscribeIpc?.()
    }
  }, [refresh])

  // Coverage recompute trigger. Whenever the meta list changes we
  // (re)compute coverage for every enabled pack in the background.
  // The cache key includes packVersion + the bundled English version,
  // so an unchanged pack short-circuits without re-flattening. The
  // refresh calls are independent IPCs and run in parallel.
  useEffect(() => {
    if (loading) return
    let cancelled = false
    void (async () => {
      const refreshTargets = metas.filter((meta) => {
        if (meta.deletedAt) {
          invalidateCoverage(meta.id)
          return false
        }
        return true
      })
      await Promise.all(refreshTargets.map((meta) => {
        if (cancelled) return undefined
        return refreshCoverageFromIpc(meta.id, meta.version)
      }))
    })()
    return () => { cancelled = true }
  }, [loading, metas])

  // Pack-removal fallback: if the active language references a pack
  // that no longer exists in the index (or is disabled / tombstoned),
  // flip back to builtin:en and stamp a notice.
  useEffect(() => {
    if (loading) return
    const active = appConfig.config.language ?? 'builtin:en'
    if (!active.startsWith('pack:')) return
    const packId = active.slice('pack:'.length)
    const meta = metas.find((m) => m.id === packId)
    if (meta && !meta.deletedAt && meta.enabled) return
    setPackRemovedNotice({
      packId,
      name: meta?.name ?? null,
      at: Date.now(),
    })
    appConfig.set('language', 'builtin:en')
    void i18n.changeLanguage('builtin:en')
  }, [appConfig, loading, metas])

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    const result = await window.vialAPI.i18nPackSetEnabled(id, enabled)
    if (result.success) {
      if (enabled) {
        await registerOnePack(id)
      } else {
        unregisterOnePack(id)
      }
      emitChanged()
      return { success: true }
    }
    return { success: false, error: result.error }
  }, [])

  const rename = useCallback(async (id: string, newName: string) => {
    const result = await window.vialAPI.i18nPackRename(id, newName)
    if (result.success) {
      emitChanged()
      return { success: true, meta: result.data }
    }
    return { success: false, error: result.error }
  }, [])

  const remove = useCallback(async (id: string) => {
    const result = await window.vialAPI.i18nPackDelete(id)
    if (result.success) {
      unregisterOnePack(id)
      invalidateCoverage(id)
      emitChanged()
      return { success: true }
    }
    return { success: false, error: result.error }
  }, [])

  const importFromDialog = useCallback(async () => {
    return window.vialAPI.i18nPackImport()
  }, [])

  const applyImport = useCallback(async (raw: unknown, options?: I18nPackImportApplyOptions) => {
    const result = await window.vialAPI.i18nPackImportApply(raw, options)
    if (result.success && result.data) {
      await registerOnePack(result.data.id)
      emitChanged()
      return { success: true, meta: result.data }
    }
    return { success: false, error: result.error }
  }, [])

  const dismissPackRemovedNotice = useCallback(() => {
    setPackRemovedNotice(null)
  }, [])

  // Activate the current language once metas have settled. Without
  // this, restarting with `language: 'pack:{id}'` would not pick up
  // the bundle until the user manually switches and back.
  useEffect(() => {
    if (loading) return
    const active = appConfig.config.language ?? 'builtin:en'
    if (i18n.language !== active) {
      void i18n.changeLanguage(active.startsWith('pack:')
        ? packResourceBundleId(active.slice('pack:'.length))
        : active)
    }
  }, [loading, appConfig.config.language])

  return {
    metas,
    loading,
    refresh,
    setEnabled,
    rename,
    remove,
    importFromDialog,
    applyImport,
    packRemovedNotice,
    dismissPackRemovedNotice,
  }
}
