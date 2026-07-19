// SPDX-License-Identifier: GPL-2.0-or-later
//
// Settings → Tools → Theme Packs modal. Mirrors LanguagePacksModal:
//   - Built-in themes (System, Light, Dark) as a horizontal selector bar
//   - Imported theme packs listed below with Select / Rename / Export / Delete
//   - Import button in the Installed tab toolbar

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, CheckCircle2, Monitor, Sun, Moon } from 'lucide-react'
import { ICON_MD } from '../../constants/ui-tokens'
import { useAppConfig } from '../../hooks/useAppConfig'
import { useInlineRename } from '../../hooks/useInlineRename'
import { useThemePackStore } from '../../hooks/useThemePackStore'
import { applyPackColors, clearPackColors, isPackTheme, extractPackId } from '../../hooks/useTheme'
import type { ThemeColorScheme, ThemePackColors } from '../../../shared/types/theme-store'
import type { HubThemePostListItem, HubThemePackBody } from '../../../shared/types/hub'
import { HUB_CATEGORY } from '../../../shared/hub-urls'
import { useHubFreshness } from '../../hooks/useHubFreshness'
import type { ThemeMode, ThemeSelection } from '../../../shared/types/app-config'
import { PackRow } from './ThemePackRow'
import { PackManagerModal } from '../pack-modal/PackManagerModal'
import { PackHubTab } from '../pack-modal/PackHubTab'
import { PackHubResultRow } from '../pack-modal/PackHubResultRow'
import { PackSortButton } from '../pack-modal/PackSortButton'
import { useHubOrigin } from '../pack-modal/useHubOrigin'
import { useHubSearchList } from '../pack-modal/useHubSearchList'
import { useDragReorder } from '../pack-modal/useDragReorder'
import { applyDragOrder } from '../pack-modal/drag-order'
import { useNameSort } from '../pack-modal/useNameSort'
import { useImportPlacement } from '../pack-modal/useImportPlacement'
import { isHubItemInstalled, type InstalledDetectionEntry } from '../pack-modal/installed-detection'
import { fetchHubPackMeta } from '../pack-modal/fetch-hub-pack-meta'
import type { PackActionResult, PackManagerTabId } from '../pack-modal/pack-modal-types'

export interface ThemePacksModalProps {
  open: boolean
  onClose: () => void
  onThemeChange: (mode: ThemeSelection) => void
  /** Hub display name of the signed-in user, or null when not signed in. */
  currentDisplayName?: string | null
  hubCanWrite?: boolean
}

const BUILTIN_THEMES: { mode: ThemeMode; icon: typeof Monitor }[] = [
  { mode: 'system', icon: Monitor },
  { mode: 'light', icon: Sun },
  { mode: 'dark', icon: Moon },
]

export function ThemePacksModal({
  open,
  onClose,
  onThemeChange,
  currentDisplayName = null,
  hubCanWrite = false,
}: ThemePacksModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const store = useThemePackStore()
  const rename = useInlineRename<string>()
  const appConfig = useAppConfig()

  const [activeTab, setActiveTab] = useState<PackManagerTabId>('installed')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<PackActionResult | null>(null)
  const [previewPostId, setPreviewPostId] = useState<string | null>(null)
  const previewSeqRef = useRef(0)
  const hubPreviewCacheRef = useRef(new Map<string, HubThemePackBody>())
  const activePackCacheRef = useRef<{ id: string; colors: ThemePackColors; colorScheme: ThemeColorScheme } | null>(null)

  const activeTheme = appConfig.config.theme
  const hubOrigin = useHubOrigin(open)

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

  useEffect(() => {
    if (!open) {
      if (previewPostId) restoreActiveTheme()
      setActionError(null)
      setLastResult(null)
      setConfirmDeleteId(null)
      setConfirmRemoveId(null)
      hubPreviewCacheRef.current.clear()
      activePackCacheRef.current = null
    }
  }, [open, previewPostId, restoreActiveTheme])

  useEffect(() => {
    activePackCacheRef.current = null
  }, [activeTheme])

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
    return { success: false, error: res.error ?? t('hub.updateFailed') }
  }, [store, t])

  const handleTabChange = useCallback((tab: PackManagerTabId) => {
    if (tab === 'installed' && previewPostId) restoreActiveTheme()
    setActiveTab(tab)
  }, [previewPostId, restoreActiveTheme])

  const handleSelectTheme = useCallback((selection: ThemeSelection) => {
    if (selection === activeTheme) return
    setActionError(null)
    onThemeChange(selection)
  }, [activeTheme, onThemeChange])

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
      if (meta?.hubPostId) {
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
  }, [store, activeTheme, onThemeChange, t])

  const handleImportFile = useCallback(async () => {
    setActionError(null)
    setLastResult(null)
    try {
      const dialogResult = await store.importFromDialog()
      if (dialogResult.canceled) return
      if (dialogResult.parseError) {
        setActionError(dialogResult.parseError)
        return
      }
      if (!dialogResult.raw) return
      const beforeIds = placement.snapshotBeforeIds()
      const result = await store.applyImport(dialogResult.raw)
      if (!result.success || !result.meta) {
        if (result.error) setActionError(result.error)
        return
      }
      setLastResult({ id: result.meta.id, kind: 'success', message: t('common.saved') })
      handleSelectTheme(`pack:${result.meta.id}`)
      await placement.place({ id: result.meta.id, name: result.meta.name }, { beforeIds })

      if (result.meta.hubPostId) {
        const upd = await pushPackToHub(result.meta.id, result.meta.hubPostId)
        if (upd.success) {
          setLastResult({ id: result.meta.id, kind: 'success', message: t('common.synced') })
        } else {
          setActionError(upd.error ?? t('hub.updateFailed'))
        }
      }
    } catch {
      setActionError(t('themePacks.parseError'))
    }
  }, [store, t, pushPackToHub, handleSelectTheme, placement])

  const handleRenameCommit = useCallback(async (id: string) => {
    const newName = rename.commitRename(id)
    if (!newName) return
    setActionError(null)
    setPendingId(id)
    try {
      const result = await store.rename(id, newName)
      if (!result.success && result.error) {
        setActionError(result.error)
        return
      }
      const meta = store.metas.find((m) => m.id === id)
      if (meta?.hubPostId) {
        const upd = await pushPackToHub(id, meta.hubPostId)
        if (upd.success) {
          setLastResult({ id, kind: 'success', message: t('common.synced') })
        } else {
          setActionError(upd.error ?? t('hub.updateFailed'))
        }
      }
    } finally {
      setPendingId(null)
    }
  }, [rename, store, t, pushPackToHub])

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

  const handleHubDownload = useCallback(async (postId: string): Promise<void> => {
    setPendingId(postId)
    setActionError(null)
    try {
      const result = await window.vialAPI.hubDownloadThemePost(postId)
      if (!result.success || !result.data) {
        setActionError(result.error ?? t('themePacks.hubEmpty'))
        return
      }
      const beforeIds = placement.snapshotBeforeIds()
      const enriched = await fetchHubPackMeta(window.vialAPI.hubListThemePosts, result.data.name, postId)
      const apply = await store.applyImport(result.data, { hubPostId: postId, hubUpdatedAt: enriched.hubUpdatedAt, uploaderName: enriched.uploaderName })
      if (!apply.success || !apply.meta) return
      await placement.place({ id: apply.meta.id, name: apply.meta.name }, { beforeIds })
    } finally {
      setPendingId(null)
    }
  }, [store, t, placement])

  const handleRenameKey = (event: React.KeyboardEvent<HTMLInputElement>, id: string): void => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void handleRenameCommit(id)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      rename.cancelRename()
    }
  }

  return (
    <PackManagerModal
      open={open}
      onClose={onClose}
      title={t('themePacks.title')}
      testids={{
        backdrop: 'theme-packs-backdrop',
        modal: 'theme-packs-modal',
        closeButton: 'theme-packs-close',
        tabsContainer: 'theme-packs-tabs',
        tabInstalled: 'theme-packs-tab-installed',
        tabHub: 'theme-packs-tab-hub',
        searchInput: 'theme-packs-search-input',
        searchButton: 'theme-packs-search-button',
        importButton: 'theme-packs-import-button',
        errorBanner: 'theme-packs-error',
        importFeedback: 'theme-packs-import-feedback',
      }}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      installedLabel={t('common.installed')}
      hubLabel={t('common.findOnHub')}
      search={search}
      onSearchChange={setSearch}
      onSearchEnter={() => void runSearch(search)}
      onSearchClick={() => void runSearch(search.trim())}
      searchPlaceholder={t('common.searchPlaceholder')}
      searchButtonLabel={hubSearching ? t('keyLabels.searching') : t('i18n.search')}
      searchDisabled={hubSearching || search.trim().length < 2}
      importLabel={t('i18n.import')}
      onImport={() => void handleImportFile()}
      sortButton={(
        <PackSortButton
          direction={nameSort.direction}
          onClick={handleSortByName}
          disabled={nameSort.pending}
          testid="theme-packs-sort-button"
        />
      )}
      importFeedback={placement.feedback}
      actionError={actionError}
    >
      {activeTab === 'installed' ? (
        <div className="space-y-2">
          <div className="flex rounded border border-edge bg-surface p-1 gap-0.5">
            {BUILTIN_THEMES.map(({ mode, icon: Icon }) => {
              const isActive = activeTheme === mode
              return (
                <button
                  key={mode}
                  type="button"
                  aria-label={t('themePacks.selectTheme', { name: t(`theme.${mode}`) })}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    isActive
                      ? 'bg-accent/15 text-accent'
                      : 'text-content-secondary hover:text-content'
                  }`}
                  onClick={() => handleSelectTheme(mode)}
                  data-testid={`theme-packs-builtin-${mode}`}
                >
                  {isActive ? (
                    <CheckCircle2 size={ICON_MD} className="text-accent" aria-hidden="true" />
                  ) : (
                    <Circle size={ICON_MD} aria-hidden="true" />
                  )}
                  <Icon size={ICON_MD} aria-hidden="true" />
                  {t(`theme.${mode}`)}
                </button>
              )
            })}
          </div>

          {displayedMetas.map((meta) => (
            <PackRow
              key={meta.id}
              meta={meta}
              isActive={activeTheme === `pack:${meta.id}`}
              pendingId={pendingId}
              confirmDeleteId={confirmDeleteId}
              setConfirmDeleteId={setConfirmDeleteId}
              rename={rename}
              onRenameKey={handleRenameKey}
              onRenameCommit={handleRenameCommit}
              onSelect={handleSelectTheme}
              onExport={handleExport}
              onDelete={handleDelete}
              hubOrigin={hubOrigin}
              currentDisplayName={currentDisplayName}
              hubCanWrite={hubCanWrite}
              hubFreshness={hubFreshness}
              lastResult={lastResult}
              confirmRemoveId={confirmRemoveId}
              setConfirmRemoveId={setConfirmRemoveId}
              onUpload={handleUpload}
              onUpdate={handleUpdate}
              onSync={handleSync}
              onRemove={handleRemove}
              onDragStart={() => drag.onDragStart(meta.id)}
              onDragOver={() => drag.onDragOver(meta.id)}
              onDragEnd={() => {
                void (async () => {
                  const moved = await drag.onDragEnd()
                  if (moved) nameSort.markFree()
                })()
              }}
            />
          ))}
        </div>
      ) : (
        <PackHubTab
          rows={hubRows}
          renderRow={(row) => (
            <ThemeHubRow
              key={row.hubPostId}
              row={row}
              pendingId={pendingId}
              hubOrigin={hubOrigin}
              previewPostId={previewPostId}
              onPreview={(postId) => void handlePreview(postId)}
              onDownload={(postId) => void handleHubDownload(postId)}
            />
          )}
          hubSearched={hubSearched}
          emptyText={t('themePacks.hubEmpty')}
          emptyTestid="theme-packs-hub-empty"
          hubOrigin={hubOrigin}
          category={HUB_CATEGORY.THEME_PACKS}
          initialLinkTestid="theme-packs-hub-initial-link"
        />
      )}
    </PackManagerModal>
  )
}

/* ------------------------------------------------------------------ */

interface ThemeHubRowData {
  hubPostId: string
  name: string
  version: string
  uploaderName: string
  alreadyInstalled: boolean
}

interface ThemeHubRowProps {
  row: ThemeHubRowData
  pendingId: string | null
  hubOrigin: string
  previewPostId: string | null
  onPreview: (postId: string) => void
  onDownload: (postId: string) => void
}

function ThemeHubRow({ row, pendingId, previewPostId, onPreview, onDownload }: ThemeHubRowProps): JSX.Element {
  const { t } = useTranslation()
  const busy = pendingId === row.hubPostId
  return (
    <PackHubResultRow
      hubPostId={row.hubPostId}
      testidPrefix="theme-packs"
      name={row.name}
      version={row.version}
      uploaderName={row.uploaderName}
      alreadyInstalled={row.alreadyInstalled}
      busy={busy}
      onDownload={() => onDownload(row.hubPostId)}
      leadingActions={
        <button
          type="button"
          className={`text-xs font-medium hover:underline disabled:opacity-50 ${
            previewPostId === row.hubPostId ? 'text-success' : 'text-content-secondary'
          }`}
          onClick={() => onPreview(row.hubPostId)}
          disabled={busy}
          data-testid={`theme-packs-hub-preview-${row.hubPostId}`}
        >
          {previewPostId === row.hubPostId ? t('themePacks.previewing') : t('themePacks.preview')}
        </button>
      }
    />
  )
}
