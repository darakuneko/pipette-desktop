// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useFavoriteManage } from '../hooks/useFavoriteManage'
import { useInlineRename } from '../hooks/useInlineRename'
import { ModalCloseButton } from './editors/ModalCloseButton'
import { ModalTabBar, ModalTabPanel } from './editors/modal-tabs'
import { ACTION_BTN, CONFIRM_DELETE_BTN, DELETE_BTN, formatDate } from './editors/store-modal-shared'
import { FavoriteHubActions } from './editors/FavoriteHubActions'
import type { FavHubEntryResult } from './editors/FavoriteHubActions'
import { HubPostRow, HubRefreshButton, DEFAULT_PER_PAGE, BTN_SECONDARY } from './hub-post-shared'
import type { DataModalTabId, TabDef } from './editors/modal-tabs'
import type { FavoriteType } from '../../shared/types/favorite-store'
import type { FavoriteImportResultState } from '../hooks/useFavoriteStore'
import type { HubMyPost, HubPaginationMeta, HubFetchMyPostsParams } from '../../shared/types/hub'

interface Props {
  onClose: () => void
  hubEnabled: boolean
  hubAuthenticated: boolean
  hubPosts: HubMyPost[]
  hubPostsPagination?: HubPaginationMeta
  onHubRefresh?: (params?: HubFetchMyPostsParams) => Promise<void>
  onHubRename: (postId: string, newTitle: string) => Promise<void>
  onHubDelete: (postId: string) => Promise<void>
  hubOrigin?: string
  // Favorite Hub upload props
  hubNeedsDisplayName?: boolean
  hubFavUploading?: string | null
  hubFavUploadResult?: FavHubEntryResult | null
  onFavUploadToHub?: (type: FavoriteType, entryId: string) => void
  onFavUpdateOnHub?: (type: FavoriteType, entryId: string) => void
  onFavRemoveFromHub?: (type: FavoriteType, entryId: string) => void
}

const FAV_TABS: TabDef<DataModalTabId>[] = [
  { id: 'tapDance', labelKey: 'editor.tapDance.title' },
  { id: 'macro', labelKey: 'editor.macro.title' },
  { id: 'combo', labelKey: 'editor.combo.title' },
  { id: 'keyOverride', labelKey: 'editor.keyOverride.title' },
  { id: 'altRepeatKey', labelKey: 'editor.altRepeatKey.title' },
]

const HUB_TAB: TabDef<DataModalTabId> = { id: 'hubPost', labelKey: 'hub.hubPosts' }

function formatImportMessage(t: (key: string, opts?: Record<string, unknown>) => string, result: FavoriteImportResultState): string {
  if (result.imported === 0) return t('favoriteStore.importEmpty')
  if (result.skipped > 0) return t('favoriteStore.importPartial', { imported: result.imported, skipped: result.skipped })
  return t('favoriteStore.importSuccess', { imported: result.imported })
}

interface FavoriteTabContentProps {
  favoriteType: FavoriteType
  active: boolean
  hubOrigin?: string
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: FavHubEntryResult | null
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
}

function FavoriteTabContent({
  favoriteType,
  active,
  hubOrigin,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
}: FavoriteTabContentProps) {
  const { t } = useTranslation()
  const manage = useFavoriteManage(favoriteType)
  const hasInitialized = useRef(false)
  const rename = useInlineRename<string>()
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    if (active && !hasInitialized.current) {
      hasInitialized.current = true
      void manage.refreshEntries()
    }
  }, [active, manage.refreshEntries])

  // Refresh entries when hub operation completes (upload/update/remove changes hubPostId)
  useEffect(() => {
    if (hubUploadResult) void manage.refreshEntries()
  }, [hubUploadResult, manage.refreshEntries])

  function commitRename(entryId: string): void {
    const newLabel = rename.commitRename(entryId)
    if (newLabel) void manage.renameEntry(entryId, newLabel)
  }

  function handleRenameKeyDown(e: React.KeyboardEvent, entryId: string): void {
    if (e.key === 'Enter') {
      commitRename(entryId)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      rename.cancelRename()
    }
  }

  return (
    <div className="pt-4 flex flex-col h-full">
      {/* Entry list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {manage.entries.length === 0 ? (
          <div className="py-4 text-center text-[13px] text-content-muted" data-testid="data-modal-fav-empty">
            {t('favoriteStore.noSaved')}
          </div>
        ) : (
          <div className="flex flex-col gap-1.5" data-testid="data-modal-fav-list">
            {manage.entries.map((entry) => (
              <div
                key={entry.id}
                className={`rounded-lg border border-edge bg-surface/20 p-3 hover:border-content-muted/30 ${rename.confirmedId === entry.id ? 'confirm-flash' : ''}`}
                data-testid="data-modal-fav-entry"
              >
                <div className="flex items-center justify-between mb-1">
                  <div className="min-w-0 flex-1">
                    {rename.editingId === entry.id ? (
                      <input
                        type="text"
                        value={rename.editLabel}
                        onChange={(e) => rename.setEditLabel(e.target.value)}
                        onBlur={() => commitRename(entry.id)}
                        onKeyDown={(e) => handleRenameKeyDown(e, entry.id)}
                        maxLength={200}
                        className="flex-1 w-full border-b border-edge bg-transparent px-1 text-sm font-semibold text-content outline-none focus:border-accent"
                        data-testid="data-modal-fav-rename-input"
                        autoFocus
                      />
                    ) : (
                      <div
                        className="truncate text-sm font-semibold text-content cursor-pointer"
                        data-testid="data-modal-fav-entry-label"
                        onClick={() => rename.startRename(entry.id, entry.label)}
                      >
                        {entry.label || t('favoriteStore.noLabel')}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 ml-2 shrink-0">
                    {confirmDeleteId === entry.id ? (
                      <>
                        <button
                          type="button"
                          className={CONFIRM_DELETE_BTN}
                          onClick={() => { void manage.deleteEntry(entry.id); setConfirmDeleteId(null) }}
                          data-testid="data-modal-fav-delete-confirm"
                        >
                          {t('favoriteStore.confirmDelete')}
                        </button>
                        <button
                          type="button"
                          className={ACTION_BTN}
                          onClick={() => setConfirmDeleteId(null)}
                          data-testid="data-modal-fav-delete-cancel"
                        >
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className={DELETE_BTN}
                        onClick={() => setConfirmDeleteId(entry.id)}
                        data-testid="data-modal-fav-delete-btn"
                      >
                        {t('favoriteStore.delete')}
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-content-muted font-mono">
                    {formatDate(entry.savedAt)}
                  </span>
                  <button
                    type="button"
                    disabled={manage.exporting || manage.importing}
                    className={ACTION_BTN}
                    onClick={() => void manage.exportEntry(entry.id)}
                    data-testid="data-modal-fav-export-entry-btn"
                  >
                    {t('favoriteStore.export')}
                  </button>
                </div>

                <FavoriteHubActions
                  entry={entry}
                  hubOrigin={hubOrigin}
                  hubNeedsDisplayName={hubNeedsDisplayName}
                  hubUploading={hubUploading}
                  hubUploadResult={hubUploadResult}
                  onUploadToHub={onUploadToHub}
                  onUpdateOnHub={onUpdateOnHub}
                  onRemoveFromHub={onRemoveFromHub}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer: Import / Export */}
      <div className="mt-4 border-t border-edge pt-3">
        <div className="flex items-center gap-2">
          {manage.importResult && (
            <span
              className="text-sm text-accent"
              data-testid="data-modal-fav-import-result"
            >
              {formatImportMessage(t, manage.importResult)}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={manage.importing || manage.exporting}
              className="rounded-lg border border-edge bg-surface px-4 py-2 text-[13px] font-semibold text-content hover:bg-surface-alt disabled:opacity-50"
              onClick={() => void manage.importFavorites()}
              data-testid="data-modal-fav-import-btn"
            >
              {t('favoriteStore.import')}
            </button>
            <button
              type="button"
              disabled={manage.exporting || manage.importing}
              className="rounded-lg border border-edge bg-surface px-4 py-2 text-[13px] font-semibold text-content hover:bg-surface-alt disabled:opacity-50"
              onClick={() => void manage.exportAll()}
              data-testid="data-modal-fav-export-all-btn"
            >
              {t('favoriteStore.exportAll')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export function DataModal({
  onClose,
  hubEnabled,
  hubAuthenticated,
  hubPosts,
  hubPostsPagination,
  onHubRefresh,
  onHubRename,
  onHubDelete,
  hubOrigin,
  hubNeedsDisplayName,
  hubFavUploading,
  hubFavUploadResult,
  onFavUploadToHub,
  onFavUpdateOnHub,
  onFavRemoveFromHub,
}: Props) {
  const { t } = useTranslation()
  const showHubTab = hubEnabled && hubAuthenticated
  const tabs = showHubTab ? [...FAV_TABS, HUB_TAB] : FAV_TABS
  const [activeTab, setActiveTab] = useState<DataModalTabId>('tapDance')
  const [hubPage, setHubPage] = useState(1)

  useEffect(() => {
    if (hubPostsPagination?.page != null) setHubPage(hubPostsPagination.page)
  }, [hubPostsPagination?.page])

  // Reset to first fav tab if hub tab becomes hidden while active
  useEffect(() => {
    if (!showHubTab && activeTab === 'hubPost') {
      setActiveTab('tapDance')
    }
  }, [showHubTab, activeTab])

  const refreshHubPage = useCallback(async (page: number) => {
    await onHubRefresh?.({ page, per_page: DEFAULT_PER_PAGE })
  }, [onHubRefresh])

  const handleHubPageChange = useCallback((newPage: number) => {
    setHubPage(newPage)
    void refreshHubPage(newPage)
  }, [refreshHubPage])

  const handleHubRenameWithPageRefresh = useCallback(async (postId: string, newTitle: string) => {
    await onHubRename(postId, newTitle)
    void refreshHubPage(hubPage)
  }, [onHubRename, hubPage, refreshHubPage])

  const handleHubDeleteWithPageAdjust = useCallback(async (postId: string) => {
    await onHubDelete(postId)
    if (hubPosts.length <= 1 && hubPage > 1) {
      handleHubPageChange(hubPage - 1)
    } else {
      void refreshHubPage(hubPage)
    }
  }, [onHubDelete, hubPosts.length, hubPage, handleHubPageChange, refreshHubPage])

  const isFavTab = (id: DataModalTabId): id is FavoriteType =>
    id !== 'hubPost'

  function renderHubPostList(): React.ReactNode {
    const totalPages = hubPostsPagination?.total_pages ?? 1
    const hasPosts = hubPosts.length > 0
    const showPagination = totalPages > 1

    if (!hasPosts && !showPagination) {
      return (
        <p className="text-sm text-content-muted" data-testid="hub-no-posts">
          {t('hub.noPosts')}
        </p>
      )
    }

    return (
      <div data-testid="hub-post-list">
        {hasPosts ? (
          <div className="space-y-1">
            {hubPosts.map((post) => (
              <HubPostRow key={post.id} post={post} onRename={handleHubRenameWithPageRefresh} onDelete={handleHubDeleteWithPageAdjust} hubOrigin={hubOrigin} />
            ))}
          </div>
        ) : (
          <p className="text-sm text-content-muted" data-testid="hub-no-posts">
            {t('hub.noPosts')}
          </p>
        )}
        {showPagination && (
          <div className="mt-2 flex items-center justify-center gap-3" data-testid="hub-pagination">
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => handleHubPageChange(hubPage - 1)}
              disabled={hubPage <= 1}
              data-testid="hub-page-prev"
            >
              {t('hub.pagePrev')}
            </button>
            <span className="text-xs text-content-muted" data-testid="hub-page-info">
              {t('hub.pageInfo', { current: hubPage, total: totalPages })}
            </span>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => handleHubPageChange(hubPage + 1)}
              disabled={hubPage >= totalPages}
              data-testid="hub-page-next"
            >
              {t('hub.pageNext')}
            </button>
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="data-modal-backdrop"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="data-modal-title"
        className="w-[680px] max-w-[90vw] h-[min(720px,80vh)] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        data-testid="data-modal"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-0 shrink-0">
          <h2 id="data-modal-title" className="text-lg font-bold text-content">{t('dataModal.title')}</h2>
          <ModalCloseButton testid="data-modal-close" onClick={onClose} />
        </div>

        <ModalTabBar<DataModalTabId>
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          idPrefix="data-modal"
          testIdPrefix="data-modal"
        />

        <ModalTabPanel<DataModalTabId> activeTab={activeTab} idPrefix="data-modal">
          {isFavTab(activeTab) && (
            <FavoriteTabContent
              key={activeTab}
              favoriteType={activeTab}
              active={isFavTab(activeTab)}
              hubOrigin={hubOrigin}
              hubNeedsDisplayName={hubNeedsDisplayName}
              hubUploading={hubFavUploading}
              hubUploadResult={hubFavUploadResult}
              onUploadToHub={onFavUploadToHub ? (entryId) => onFavUploadToHub(activeTab, entryId) : undefined}
              onUpdateOnHub={onFavUpdateOnHub ? (entryId) => onFavUpdateOnHub(activeTab, entryId) : undefined}
              onRemoveFromHub={onFavRemoveFromHub ? (entryId) => onFavRemoveFromHub(activeTab, entryId) : undefined}
            />
          )}
          {activeTab === 'hubPost' && (
            <div className="pt-4 space-y-6">
              <section>
                {onHubRefresh && (
                  <div className="mb-2 flex justify-end">
                    <HubRefreshButton onRefresh={() => refreshHubPage(hubPage)} />
                  </div>
                )}
                {renderHubPostList()}
              </section>
            </div>
          )}
        </ModalTabPanel>
      </div>
    </div>
  )
}
