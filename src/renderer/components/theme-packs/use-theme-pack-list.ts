// SPDX-License-Identifier: GPL-2.0-or-later
//
// Installed-tab row model (drag reorder / Name sort / import placement)
// plus the Find-on-Hub browse list (search + freshness), and theme
// selection. Split out of ThemePacksModal (Task-split-pack-modals) —
// mirrors use-language-pack-list.ts; the built-in System/Light/Dark
// selector bar itself stays in the shell's JSX since it isn't a store
// row.

import { useCallback, useMemo } from 'react'
import type { TFunction } from 'i18next'
import type { HubThemePostListItem } from '../../../shared/types/hub'
import type { ThemeSelection } from '../../../shared/types/app-config'
import type { UseThemePackStoreReturn } from '../../hooks/useThemePackStore'
import { useHubFreshness } from '../../hooks/useHubFreshness'
import { useHubSearchList } from '../pack-modal/useHubSearchList'
import { useDragReorder } from '../pack-modal/useDragReorder'
import { applyDragOrder } from '../pack-modal/drag-order'
import { useNameSort } from '../pack-modal/useNameSort'
import { useImportPlacement } from '../pack-modal/useImportPlacement'
import { isHubItemInstalled, type InstalledDetectionEntry } from '../pack-modal/installed-detection'
import type { PackManagerTabId } from '../pack-modal/pack-modal-types'

export interface UseThemePackListOptions {
  open: boolean
  activeTab: PackManagerTabId
  store: UseThemePackStoreReturn
  activeTheme: ThemeSelection
  onThemeChange: (mode: ThemeSelection) => void
  setActionError: (error: string | null) => void
  t: TFunction
}

export function useThemePackList({
  open,
  activeTab,
  store,
  activeTheme,
  onThemeChange,
  setActionError,
  t,
}: UseThemePackListOptions) {
  // hubPostId-first + name-fallback (unified with Language Packs / Key
  // Labels — see installed-detection.ts).
  const installedEntries = useMemo<InstalledDetectionEntry[]>(
    () => store.metas.filter((m) => !m.deletedAt).map((m) => ({ hubPostId: m.hubPostId, name: m.name })),
    [store.metas],
  )

  // Drag reorder + Name sort. The built-in System/Light/Dark selector
  // bar is a separate UI block above this list (not a PackListRow),
  // so every entry here is a real, draggable/sortable store pack.
  const dragReorderIds = useMemo(() => store.metas.map((meta) => meta.id), [store.metas])
  const drag = useDragReorder({
    ids: dragReorderIds,
    reorder: store.reorder,
    onError: (error) => setActionError(error ?? t('themePacks.parseError')),
  })
  const displayedMetas = useMemo(
    () => applyDragOrder(store.metas, drag.dragOrder, (meta) => meta.id),
    [store.metas, drag.dragOrder],
  )
  const nameSortEntries = useMemo(
    () => store.metas.map((meta) => ({ id: meta.id, name: meta.name })),
    [store.metas],
  )
  const nameSort = useNameSort({
    open,
    ready: !store.loading,
    entries: nameSortEntries,
    reorder: store.reorder,
    onError: (error) => setActionError(error ?? t('themePacks.parseError')),
  })
  const handleSortByName = useCallback((): void => {
    void nameSort.toggle(store.metas.map((meta) => ({ id: meta.id, name: meta.name })))
  }, [nameSort, store.metas])
  const placement = useImportPlacement({
    open,
    entries: nameSortEntries,
    direction: nameSort.direction,
    reorder: store.reorder,
    rowTestidPrefix: 'theme-packs',
    onReorderError: (error) => { if (error) setActionError(error) },
  })

  const freshnessCandidates = useMemo(
    () => store.metas
      .filter((m) => !m.deletedAt && !!m.hubPostId)
      .map((m) => ({ localId: m.id, hubPostId: m.hubPostId as string })),
    [store.metas],
  )

  const fetchTimestamps = useCallback(
    (ids: string[]) => window.vialAPI.themePackHubTimestamps(ids),
    [],
  )

  const hubFreshness = useHubFreshness({
    enabled: open && activeTab === 'installed',
    candidates: freshnessCandidates,
    fetchTimestamps,
  })

  const { search, setSearch, hubResults, hubSearched, hubSearching, runSearch } = useHubSearchList<HubThemePostListItem>({
    open,
    activeTab,
    hubTabId: 'hub',
    fetchPage: (query) => window.vialAPI.hubListThemePosts({ q: query }),
    errorMessage: (error) => error ?? t('themePacks.hubEmpty'),
    onSearchStart: () => setActionError(null),
    onError: setActionError,
  })

  const hubRows = useMemo(() => hubResults.map((item) => ({
    hubPostId: item.id,
    name: item.name,
    version: item.version,
    uploaderName: item.uploaderName ?? '',
    alreadyInstalled: isHubItemInstalled(item, installedEntries),
  })), [hubResults, installedEntries])

  const handleSelectTheme = useCallback((selection: ThemeSelection) => {
    if (selection === activeTheme) return
    setActionError(null)
    onThemeChange(selection)
  }, [activeTheme, onThemeChange])

  return {
    displayedMetas,
    drag,
    nameSort,
    handleSortByName,
    placement,
    hubFreshness,
    search,
    setSearch,
    hubResults,
    hubSearched,
    hubSearching,
    runSearch,
    hubRows,
    handleSelectTheme,
  }
}
