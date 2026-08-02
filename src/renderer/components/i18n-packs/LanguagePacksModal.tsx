// SPDX-License-Identifier: GPL-2.0-or-later
//
// Settings → Tools → Language Packs modal. Two tabs:
//   - Installed: built-in English + every imported language pack.
//                Actions: Open / Sync / Update / Remove / Delete + Import.
//   - Find on Hub: search input + Pipette Hub results. Hits already
//                  installed locally are tagged "Installed" rather than
//                  exposing Download (avoids duplicate-name conflicts).
// Mirrors KeyLabelsModal so users can predict behaviour across the
// two manage modals — including built-in English's real-store-entry
// treatment, which mirrors Key Labels' built-in QWERTY: both drag
// reorder and Name sort include it like any imported entry (see
// `ensureBuiltinEnglishEntry` in main/i18n-pack-store.ts).
//
// The row model (built-in + installed + Hub browse), the per-row
// actions, and the import surface each live in their own sibling hook
// (Task-split-pack-modals) — this shell only owns the 7 top-level
// state atoms, the on-close reset, and the JSX.

import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppConfig } from '../../hooks/useAppConfig'
import { useInlineRename } from '../../hooks/useInlineRename'
import { useI18nPackStore } from '../../hooks/useI18nPackStore'
import { ENGLISH_PACK_BODY } from '../../i18n/coverage-cache'
import { MissingKeysModal } from './MissingKeysModal'
import { HUB_CATEGORY } from '../../../shared/hub-urls'
import { PackManagerModal } from '../pack-modal/PackManagerModal'
import { PackHubTab } from '../pack-modal/PackHubTab'
import { PackSortButton } from '../pack-modal/PackSortButton'
import { useHubOrigin } from '../pack-modal/useHubOrigin'
import type { PackActionResult, PackManagerTabId } from '../pack-modal/pack-modal-types'
import { LanguageInstalledRow, LanguageHubRow } from './LanguageInstalledRow'
import { useLanguagePackCoverage } from './use-language-pack-coverage'
import { useLanguagePackList } from './use-language-pack-list'
import { useLanguagePackActions } from './use-language-pack-actions'
import { useLanguagePackImport } from './use-language-pack-import'

export interface LanguagePacksModalProps {
  open: boolean
  onClose: () => void
  /** Hub display name of the signed-in user, or null when not signed in. */
  currentDisplayName?: string | null
  /** True when the user is signed into the Hub and can perform writes. */
  hubCanWrite?: boolean
}

export function LanguagePacksModal({
  open,
  onClose,
  currentDisplayName,
  hubCanWrite,
}: LanguagePacksModalProps): JSX.Element | null {
  const { t } = useTranslation()
  const store = useI18nPackStore()
  const rename = useInlineRename<string>()
  const appConfig = useAppConfig()

  const [activeTab, setActiveTab] = useState<PackManagerTabId>('installed')
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<PackActionResult | PackActionResult[] | null>(null)
  const [missingKeysFor, setMissingKeysFor] = useState<{ name: string; keys: string[] } | null>(null)

  const hubOrigin = useHubOrigin(open)

  useLanguagePackCoverage({ open, store })

  const {
    handleSelectLanguage,
    displayedRows,
    drag,
    nameSort,
    handleSortByName,
    placement,
    search,
    setSearch,
    hubRows,
    hubSearched,
    hubSearching,
    runSearch,
    hubFreshness,
  } = useLanguagePackList({ open, activeTab, store, appConfig, setActionError, t })

  useEffect(() => {
    if (!open) {
      setActionError(null)
      setLastResult(null)
      setConfirmDeleteId(null)
      setConfirmRemoveId(null)
    }
  }, [open])

  const {
    handleOpen,
    handleDelete,
    pushPackToHub,
    handleSync,
    handleUpdate,
    handleRemove,
    handleUpload,
    handleNotSetKeys,
    handleExport,
  } = useLanguagePackActions({
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
  })

  const {
    importing,
    importSummary,
    runImport,
    handleRenameCommit,
    handleRenameKey,
    pull,
    handleHubDownload,
  } = useLanguagePackImport({
    open,
    store,
    t,
    rename,
    placement,
    pushPackToHub,
    handleSelectLanguage,
    setPendingId,
    setActionError,
    setLastResult,
  })

  return (
    <PackManagerModal
      open={open}
      onClose={onClose}
      title={t('i18n.modalTitle')}
      testids={{
        backdrop: 'language-packs-modal-backdrop',
        modal: 'language-packs-modal',
        closeButton: 'language-packs-modal-close',
        tabsContainer: 'language-packs-tabs',
        tabInstalled: 'language-packs-tab-installed',
        tabHub: 'language-packs-tab-hub',
        searchInput: 'language-packs-search-input',
        searchButton: 'language-packs-search-button',
        importButton: 'language-packs-import-button',
        errorBanner: 'language-packs-error',
        importFeedback: 'language-packs-import-feedback',
        pullButton: 'language-packs-pull-button',
      }}
      activeTab={activeTab}
      onTabChange={setActiveTab}
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
          testid="language-packs-sort-button"
        />
      )}
      importFeedback={importing ? t('common.importing') : (importSummary ?? placement.feedback)}
      actionError={actionError}
      afterContent={(
        <MissingKeysModal
          open={!!missingKeysFor}
          onClose={() => setMissingKeysFor(null)}
          packName={missingKeysFor?.name ?? ''}
          missingKeys={missingKeysFor?.keys ?? []}
          base={ENGLISH_PACK_BODY}
        />
      )}
    >
      {activeTab === 'installed' ? (
        <div className="space-y-2">
          {displayedRows.map((row) => (
            <LanguageInstalledRow
              key={row.reactKey}
              row={row}
              pendingId={pendingId}
              importing={importing}
              confirmDeleteId={confirmDeleteId}
              setConfirmDeleteId={setConfirmDeleteId}
              confirmRemoveId={confirmRemoveId}
              setConfirmRemoveId={setConfirmRemoveId}
              lastResult={lastResult}
              currentDisplayName={currentDisplayName ?? null}
              hubCanWrite={hubCanWrite ?? false}
              hubFreshness={hubFreshness}
              rename={rename}
              onRenameKey={handleRenameKey}
              onRenameCommit={handleRenameCommit}
              onSelectLanguage={handleSelectLanguage}
              onOpen={handleOpen}
              onUpload={handleUpload}
              onUpdate={handleUpdate}
              onSync={handleSync}
              onRemove={handleRemove}
              onDelete={handleDelete}
              onExport={handleExport}
              onNotSetKeys={handleNotSetKeys}
              onDragStart={() => drag.onDragStart(row.packId as string)}
              onDragOver={() => drag.onDragOver(row.packId as string)}
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
            <LanguageHubRow
              key={row.reactKey}
              row={row}
              pendingId={pendingId}
              importing={importing}
              onDownload={(postId) => void handleHubDownload(postId)}
            />
          )}
          hubSearched={hubSearched}
          emptyText={t('i18n.hubEmpty')}
          emptyTestid="language-packs-hub-empty"
          hubOrigin={hubOrigin}
          category={HUB_CATEGORY.I18N_PACKS}
          initialLinkTestid="language-packs-hub-initial-link"
        />
      )}
    </PackManagerModal>
  )
}
