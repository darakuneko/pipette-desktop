// SPDX-License-Identifier: GPL-2.0-or-later
//
// Settings → Tools → Theme Packs modal. Mirrors LanguagePacksModal:
//   - Built-in themes (System, Light, Dark) as a horizontal selector bar
//   - Imported theme packs listed below with Select / Rename / Export / Delete
//   - Import button in the Installed tab toolbar
//
// The row model (installed + Hub browse), Hub preview, the per-row
// actions, and the import surface each live in their own sibling hook
// (Task-split-pack-modals) — this shell only owns the 7 top-level
// state atoms, the (non-preview) on-close reset, the built-in
// System/Light/Dark selector, and the JSX.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Circle, CheckCircle2, Monitor, Sun, Moon } from 'lucide-react'
import { ICON_MD } from '../../constants/ui-tokens'
import { useAppConfig } from '../../hooks/useAppConfig'
import { useInlineRename } from '../../hooks/useInlineRename'
import { useThemePackStore } from '../../hooks/useThemePackStore'
import { HUB_CATEGORY } from '../../../shared/hub-urls'
import type { ThemeMode, ThemeSelection } from '../../../shared/types/app-config'
import { PackRow } from './ThemePackRow'
import { ThemeHubRow } from './ThemeHubRow'
import { PackManagerModal } from '../pack-modal/PackManagerModal'
import { PackHubTab } from '../pack-modal/PackHubTab'
import { PackSortButton } from '../pack-modal/PackSortButton'
import { useHubOrigin } from '../pack-modal/useHubOrigin'
import type { PackActionResult, PackManagerTabId } from '../pack-modal/pack-modal-types'
import { useThemePreview } from './use-theme-preview'
import { useThemePackList } from './use-theme-pack-list'
import { useThemePackActions } from './use-theme-pack-actions'
import { useThemePackImport } from './use-theme-pack-import'

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
  const [lastResult, setLastResult] = useState<PackActionResult | PackActionResult[] | null>(null)
  const [previewPostId, setPreviewPostId] = useState<string | null>(null)

  const activeTheme = appConfig.config.theme
  const hubOrigin = useHubOrigin(open)

  const { handlePreview, handleTabChange } = useThemePreview({
    open,
    activeTheme,
    previewPostId,
    setPreviewPostId,
    setActiveTab,
    setPendingId,
  })

  const {
    displayedMetas,
    drag,
    nameSort,
    handleSortByName,
    placement,
    hubFreshness,
    search,
    setSearch,
    hubSearched,
    hubSearching,
    runSearch,
    hubRows,
    handleSelectTheme,
  } = useThemePackList({ open, activeTab, store, activeTheme, onThemeChange, setActionError, t })

  useEffect(() => {
    if (!open) {
      setActionError(null)
      setLastResult(null)
      setConfirmDeleteId(null)
      setConfirmRemoveId(null)
    }
  }, [open])

  const {
    pushPackToHub,
    handleExport,
    handleDelete,
    handleUpload,
    handleUpdate,
    handleSync,
    handleRemove,
  } = useThemePackActions({
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
  })

  const {
    importing,
    importSummary,
    runImport,
    handleRenameCommit,
    handleRenameKey,
    pull,
    handleHubDownload,
  } = useThemePackImport({
    open,
    store,
    t,
    rename,
    placement,
    pushPackToHub,
    handleSelectTheme,
    setPendingId,
    setActionError,
    setLastResult,
  })

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
        pullButton: 'theme-packs-pull-button',
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
      onImport={() => void runImport()}
      importDisabled={importing}
      pullLabel={pull.pulling ? t('common.pulling') : t('common.pullFromCloud')}
      onPull={() => void pull.pull()}
      pullDisabled={importing}
      pulling={pull.pulling}
      sortButton={(
        <PackSortButton
          direction={nameSort.direction}
          onClick={handleSortByName}
          disabled={nameSort.pending || importing}
          testid="theme-packs-sort-button"
        />
      )}
      importFeedback={importing ? t('common.importing') : (importSummary ?? placement.feedback)}
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
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:opacity-50 ${
                    isActive
                      ? 'bg-accent/15 text-accent'
                      : 'text-content-secondary hover:text-content'
                  }`}
                  onClick={() => handleSelectTheme(mode)}
                  disabled={importing}
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
              importing={importing}
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
              importing={importing}
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
