// SPDX-License-Identifier: GPL-2.0-or-later
//
// React hook around the theme pack store. Wraps the IPC surface in a
// stable React state and broadcasts `pipette:theme-pack-changed`
// CustomEvents so multiple hook instances stay in sync.
//
// Simpler than useI18nPackStore: no enabled toggle, no coverage
// computation, no bundle registration, no pack-removal fallback notice.
// useTheme handles theme application and fallback directly.

import { useCallback, useEffect, useState } from 'react'
import type {
  ThemePackMeta,
  ThemePackImportDialogResult,
  ThemePackImportApplyOptions,
} from '../../shared/types/theme-store'

const THEME_PACK_CHANGED_EVENT = 'pipette:theme-pack-changed'

export interface UseThemePackStoreReturn {
  metas: ThemePackMeta[]
  loading: boolean
  refresh(): Promise<void>
  rename(id: string, newName: string): Promise<{ success: boolean; error?: string }>
  remove(id: string): Promise<{ success: boolean; error?: string }>
  importFromDialog(): Promise<ThemePackImportDialogResult>
  applyImport(raw: unknown, options?: ThemePackImportApplyOptions): Promise<{ success: boolean; meta?: ThemePackMeta; error?: string }>
  exportPack(id: string): Promise<{ success: boolean; error?: string }>
}

export function useThemePackStore(): UseThemePackStoreReturn {
  const [metas, setMetas] = useState<ThemePackMeta[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const list = window.vialAPI.themePackList
      if (!list) {
        setMetas([])
        return
      }
      const result = await list()
      if (result.success && result.data) {
        setMetas(result.data)
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
    window.addEventListener(THEME_PACK_CHANGED_EVENT, handler)
    const unsubscribeIpc = window.vialAPI.themePackOnChanged?.(() => { void refresh() })
    return () => {
      window.removeEventListener(THEME_PACK_CHANGED_EVENT, handler)
      unsubscribeIpc?.()
    }
  }, [refresh])

  const rename = useCallback(async (id: string, newName: string) => {
    const result = await window.vialAPI.themePackRename(id, newName)
    if (result.success) return { success: true }
    return { success: false, error: result.error }
  }, [])

  const remove = useCallback(async (id: string) => {
    const result = await window.vialAPI.themePackDelete(id)
    if (result.success) {
      const cfg = await window.vialAPI.appConfigGetAll()
      if (cfg.theme === `pack:${id}`) {
        await window.vialAPI.appConfigSet('theme', 'system')
      }
      return { success: true }
    }
    return { success: false, error: result.error }
  }, [])

  const importFromDialog = useCallback(async () => {
    return window.vialAPI.themePackImport()
  }, [])

  const applyImport = useCallback(async (raw: unknown, options?: ThemePackImportApplyOptions) => {
    const result = await window.vialAPI.themePackImportApply(raw, options)
    if (result.success && result.data) return { success: true, meta: result.data }
    return { success: false, error: result.error }
  }, [])

  const exportPack = useCallback(async (id: string) => {
    const result = await window.vialAPI.themePackExport(id)
    if (result.success) {
      return { success: true }
    }
    return { success: false, error: result.error }
  }, [])

  return {
    metas,
    loading,
    refresh,
    rename,
    remove,
    importFromDialog,
    applyImport,
    exportPack,
  }
}
