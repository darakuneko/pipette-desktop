// SPDX-License-Identifier: GPL-2.0-or-later
//
// Hub-preview plumbing for Theme Packs: applying/restoring live theme
// colors while browsing the Find-on-Hub tab, and the caches that keep
// repeat previews / the active theme's own colors from re-fetching.
// Split out of ThemePacksModal (Task-split-pack-modals) — `previewPostId`
// itself is one of the shell's 7 state atoms and stays there; this hook
// owns the refs and the effects/handlers that read and clear them.

import { useCallback, useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { applyPackColors, clearPackColors, isPackTheme, extractPackId } from '../../hooks/useTheme'
import type { ThemeColorScheme, ThemePackColors } from '../../../shared/types/theme-store'
import type { HubThemePackBody } from '../../../shared/types/hub'
import type { ThemeSelection } from '../../../shared/types/app-config'
import type { PackManagerTabId } from '../pack-modal/pack-modal-types'

export interface UseThemePreviewOptions {
  open: boolean
  activeTheme: ThemeSelection
  previewPostId: string | null
  setPreviewPostId: Dispatch<SetStateAction<string | null>>
  setActiveTab: Dispatch<SetStateAction<PackManagerTabId>>
  setPendingId: (id: string | null) => void
}

export function useThemePreview({
  open,
  activeTheme,
  previewPostId,
  setPreviewPostId,
  setActiveTab,
  setPendingId,
}: UseThemePreviewOptions) {
  const previewSeqRef = useRef(0)
  const hubPreviewCacheRef = useRef(new Map<string, HubThemePackBody>())
  const activePackCacheRef = useRef<{ id: string; colors: ThemePackColors; colorScheme: ThemeColorScheme } | null>(null)

  const restoreActiveTheme = useCallback(() => {
    clearPackColors()
    if (isPackTheme(activeTheme)) {
      const packId = extractPackId(activeTheme)
      const cached = activePackCacheRef.current
      if (cached && cached.id === packId) {
        applyPackColors(cached.colors, cached.colorScheme)
      } else {
        void window.vialAPI.themePackGet(packId).then((result) => {
          if (result.success && result.data) {
            activePackCacheRef.current = { id: packId, colors: result.data.pack.colors, colorScheme: result.data.pack.colorScheme }
            applyPackColors(result.data.pack.colors, result.data.pack.colorScheme)
          }
        })
      }
    }
    setPreviewPostId(null)
  }, [activeTheme])

  const handlePreview = useCallback(async (postId: string): Promise<void> => {
    if (previewPostId === postId) {
      restoreActiveTheme()
      return
    }
    const cached = hubPreviewCacheRef.current.get(postId)
    if (cached) {
      applyPackColors(cached.colors as ThemePackColors, cached.colorScheme)
      setPreviewPostId(postId)
      return
    }
    const seq = ++previewSeqRef.current
    setPendingId(postId)
    try {
      const result = await window.vialAPI.hubDownloadThemePost(postId)
      if (!result.success || !result.data || previewSeqRef.current !== seq) return
      hubPreviewCacheRef.current.set(postId, result.data)
      applyPackColors(result.data.colors as ThemePackColors, result.data.colorScheme)
      setPreviewPostId(postId)
    } finally {
      if (previewSeqRef.current === seq) setPendingId(null)
    }
  }, [previewPostId, restoreActiveTheme])

  // Preview-specific half of the on-close reset — the shell's own
  // effect handles the non-preview state resets (action error / last
  // result / confirm ids). Restoring the live theme and clearing the
  // preview caches only matters while a preview was actually active.
  useEffect(() => {
    if (!open) {
      if (previewPostId) restoreActiveTheme()
      hubPreviewCacheRef.current.clear()
      activePackCacheRef.current = null
    }
  }, [open, previewPostId, restoreActiveTheme])

  useEffect(() => {
    activePackCacheRef.current = null
  }, [activeTheme])

  const handleTabChange = useCallback((tab: PackManagerTabId) => {
    if (tab === 'installed' && previewPostId) restoreActiveTheme()
    setActiveTab(tab)
  }, [previewPostId, restoreActiveTheme])

  return {
    restoreActiveTheme,
    handlePreview,
    handleTabChange,
  }
}
