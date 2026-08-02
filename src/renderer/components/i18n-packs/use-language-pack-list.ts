// SPDX-License-Identifier: GPL-2.0-or-later
//
// Installed-tab row model (built-in English synthesis + imported packs)
// plus drag reorder / Name sort / import placement, and the Find-on-Hub
// browse list (search + freshness). Split out of LanguagePacksModal
// (Task-split-pack-modals) — everything here derives from `store.metas`
// and the active language, and is consumed by both the shell's JSX and
// the sibling import hook (`placement`, `handleSelectLanguage`).

import { useCallback, useMemo } from 'react'
import type { TFunction } from 'i18next'
import english from '../../i18n/locales/english.json'
import i18n from '../../i18n'
import { BASE_REVISION } from '../../i18n/coverage-cache'
import type { useAppConfig } from '../../hooks/useAppConfig'
import type { UseI18nPackStoreReturn } from '../../hooks/useI18nPackStore'
import { BUILTIN_ENGLISH_PACK_ID } from '../../../shared/types/i18n-store'
import type { HubI18nPostListItem } from '../../../shared/types/hub'
import { useHubFreshness } from '../../hooks/useHubFreshness'
import { useHubSearchList } from '../pack-modal/useHubSearchList'
import { useDragReorder } from '../pack-modal/useDragReorder'
import { applyDragOrder } from '../pack-modal/drag-order'
import { useNameSort } from '../pack-modal/useNameSort'
import { useImportPlacement } from '../pack-modal/useImportPlacement'
import { isHubItemInstalled, type InstalledDetectionEntry } from '../pack-modal/installed-detection'
import type { PackManagerTabId } from '../pack-modal/pack-modal-types'
import { type InstalledRow, type HubRow } from './LanguageInstalledRow'

const BUILTIN_INTERNAL_ID = 'builtin:en'

export interface UseLanguagePackListOptions {
  open: boolean
  activeTab: PackManagerTabId
  store: UseI18nPackStoreReturn
  appConfig: ReturnType<typeof useAppConfig>
  setActionError: (error: string | null) => void
  t: TFunction
}

export function useLanguagePackList({
  open,
  activeTab,
  store,
  appConfig,
  setActionError,
  t,
}: UseLanguagePackListOptions) {
  const builtinName = (english as Record<string, unknown>).name as string ?? 'English'
  const builtinVersion = (english as Record<string, unknown>).version as string ?? '0.1.0'

  const activeLanguageId = appConfig.config.language ?? 'builtin:en'

  // Built-in English's row shape is always this — hardcoded rather than
  // read from the store meta, since the meta's own name/version/body is
  // just a trivial placeholder (see `ensureBuiltinEnglishEntry`'s doc in
  // main/i18n-pack-store.ts). Only `packId` varies: the real store id
  // once `ensureBuiltinEnglishEntry` has run (normal case), or `null`
  // during the brief pre-load window before `store.metas` has arrived —
  // `null` also intentionally covers older/mocked stores in tests that
  // don't include the entry, so this row's appearance never depends on
  // the caller remembering to add it.
  const builtinRow = useCallback((packId: string | null): InstalledRow => ({
    reactKey: BUILTIN_INTERNAL_ID,
    internalId: BUILTIN_INTERNAL_ID,
    packId,
    hubPostId: null,
    name: builtinName,
    version: builtinVersion,
    updatedAt: __BUILD_TIME__,
    uploaderName: 'pipette',
    isBuiltin: true,
    active: activeLanguageId === BUILTIN_INTERNAL_ID,
    isComplete: true,
  }), [builtinName, builtinVersion, activeLanguageId])

  const installedRows: InstalledRow[] = useMemo(() => {
    const rows: InstalledRow[] = []
    let sawBuiltin = false
    for (const meta of store.metas) {
      if (meta.deletedAt) continue
      if (meta.id === BUILTIN_ENGLISH_PACK_ID) {
        sawBuiltin = true
        rows.push(builtinRow(meta.id))
        continue
      }
      const internalId = `pack:${meta.id}`
      // A pack is "complete" only when its matchedBaseVersion equals
      // the *current* English baseline. A stale match for an older
      // baseline must surface as incomplete so the user sees the
      // "not set keys" entry point against the new keys.
      const isComplete = meta.matchedBaseVersion === BASE_REVISION
      rows.push({
        reactKey: meta.id,
        internalId,
        packId: meta.id,
        hubPostId: meta.hubPostId ?? null,
        name: meta.name,
        // Display the English baseline version the pack proved it
        // covers, not the pack's own semver. An empty string keeps
        // the row visually consistent while signalling partial
        // coverage to the user.
        version: meta.matchedBaseVersion ?? '',
        // Hub-side timestamp, not the local modification time — blank
        // for never-uploaded local entries and legacy rows that
        // predate this field, matching Key Labels' Updated column.
        updatedAt: meta.hubUpdatedAt ?? '',
        uploaderName: meta.uploaderName ?? '',
        isBuiltin: false,
        active: activeLanguageId === internalId,
        coverage: meta.coverage,
        isComplete,
        meta,
      })
    }
    if (!sawBuiltin) rows.unshift(builtinRow(null))
    return rows
  }, [store.metas, activeLanguageId, builtinRow])

  const handleSelectLanguage = useCallback((internalId: string) => {
    if (internalId === activeLanguageId) return
    appConfig.set('language', internalId)
    void i18n.changeLanguage(internalId)
  }, [appConfig, activeLanguageId])

  // Drag reorder + Name sort apply to every row with a real store id —
  // now including built-in English once `ensureBuiltinEnglishEntry` has
  // materialised it (see `installedRows` above). Only the transient
  // pre-load fallback row (`packId === null`) is excluded, since there
  // is no real id yet to persist an order against.
  const draggableRows = useMemo(() => installedRows.filter((row) => row.packId !== null), [installedRows])
  const dragReorderIds = useMemo(() => draggableRows.map((row) => row.packId as string), [draggableRows])
  const drag = useDragReorder({
    ids: dragReorderIds,
    reorder: store.reorder,
    onError: (error) => setActionError(error ?? t('i18n.errorGeneric')),
  })
  const displayedRows = useMemo<InstalledRow[]>(() => {
    const ordered = applyDragOrder(draggableRows, drag.dragOrder, (row) => row.packId as string)
    // Only the pre-load fallback (no real builtin id yet) needs
    // prepending by hand — the real entry already sits at its correct
    // position within `draggableRows`/`drag.dragOrder`.
    const fallbackBuiltin = installedRows.find((row) => row.isBuiltin && row.packId === null)
    return fallbackBuiltin ? [fallbackBuiltin, ...ordered] : ordered
  }, [installedRows, draggableRows, drag.dragOrder])

  const nameSortEntries = useMemo(
    () => draggableRows.map((row) => ({ id: row.packId as string, name: row.name })),
    [draggableRows],
  )
  const nameSort = useNameSort({
    open,
    ready: !store.loading,
    entries: nameSortEntries,
    reorder: store.reorder,
    onError: (error) => setActionError(error ?? t('i18n.errorGeneric')),
  })
  const handleSortByName = useCallback((): void => {
    void nameSort.toggle(draggableRows.map((row) => ({ id: row.packId as string, name: row.name })))
  }, [nameSort, draggableRows])
  const placement = useImportPlacement({
    open,
    entries: nameSortEntries,
    direction: nameSort.direction,
    reorder: store.reorder,
    rowTestidPrefix: 'language-packs',
    onReorderError: (error) => setActionError(error ?? t('i18n.errorGeneric')),
  })

  // hubPostId-first + name-fallback (unified with Theme Packs / Key
  // Labels — see installed-detection.ts). Built-in English counts as
  // an "installed" name too, so a Hub pack literally named "English"
  // shows Installed instead of a misleading Download. Sourced from
  // `builtinName` (the authoritative bundled name), not the store
  // meta's own (placeholder) `name` field — the real builtin-english
  // meta is explicitly excluded below to avoid listing it twice.
  const installedEntries = useMemo<InstalledDetectionEntry[]>(() => [
    { name: builtinName },
    ...store.metas
      .filter((m) => !m.deletedAt && m.id !== BUILTIN_ENGLISH_PACK_ID)
      .map((m) => ({ hubPostId: m.hubPostId, name: m.name })),
  ], [store.metas, builtinName])

  const { search, setSearch, hubResults, hubSearched, hubSearching, runSearch } = useHubSearchList<HubI18nPostListItem>({
    open,
    activeTab,
    hubTabId: 'hub',
    fetchPage: (query) => window.vialAPI.hubListI18nPosts({ q: query }),
    errorMessage: (error) => error ?? t('i18n.errorGeneric'),
    onSearchStart: () => setActionError(null),
    onError: setActionError,
  })

  const hubRows: HubRow[] = useMemo(() => hubResults.map((item) => ({
    reactKey: item.id,
    hubPostId: item.id,
    name: item.name,
    version: item.version,
    uploaderName: item.uploaderName ?? '',
    alreadyInstalled: isHubItemInstalled(item, installedEntries),
  })), [hubResults, installedEntries])

  const freshnessCandidates = useMemo(
    () => store.metas
      .filter((m) => !m.deletedAt && !!m.hubPostId)
      .map((m) => ({ localId: m.id, hubPostId: m.hubPostId as string })),
    [store.metas],
  )

  const fetchTimestamps = useCallback(
    (ids: string[]) => window.vialAPI.i18nPackHubTimestamps(ids),
    [],
  )

  const hubFreshness = useHubFreshness({
    enabled: open && activeTab === 'installed',
    candidates: freshnessCandidates,
    fetchTimestamps,
  })

  return {
    handleSelectLanguage,
    displayedRows,
    drag,
    nameSort,
    handleSortByName,
    placement,
    search,
    setSearch,
    hubResults,
    hubSearched,
    hubSearching,
    runSearch,
    hubRows,
    hubFreshness,
  }
}
