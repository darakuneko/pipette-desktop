// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useFavoriteManage } from '../../hooks/useFavoriteManage'
import { useInlineRename } from '../../hooks/useInlineRename'
import { ACTION_BTN, CONFIRM_DELETE_BTN, DELETE_BTN, formatDate } from '../editors/store-modal-shared'
import { FavoriteHubActions } from '../editors/FavoriteHubActions'
import type { FavHubEntryResult } from '../editors/FavoriteHubActions'
import type { FavoriteType } from '../../../shared/types/favorite-store'
import type { FavoriteImportResultState } from '../../hooks/useFavoriteStore'

function formatImportMessage(t: (key: string, opts?: Record<string, unknown>) => string, result: FavoriteImportResultState): string {
  if (result.imported === 0) return t('favoriteStore.importEmpty')
  if (result.skipped > 0) return t('favoriteStore.importPartial', { imported: result.imported, skipped: result.skipped })
  return t('favoriteStore.importSuccess', { imported: result.imported })
}

export interface FavoriteTabContentProps {
  favoriteType: FavoriteType
  hubOrigin?: string
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: FavHubEntryResult | null
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
  onRenameOnHub?: (entryId: string, hubPostId: string, newLabel: string) => void
}

export function FavoriteTabContent({
  favoriteType,
  hubOrigin,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
  onRenameOnHub,
}: FavoriteTabContentProps) {
  const { t } = useTranslation()
  const manage = useFavoriteManage(favoriteType)
  const hasInitialized = useRef(false)
  const rename = useInlineRename<string>()
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    void manage.refreshEntries()
  }, [manage.refreshEntries])

  useEffect(() => {
    if (hubUploadResult) void manage.refreshEntries()
  }, [hubUploadResult, manage.refreshEntries])

  async function commitRename(entryId: string): Promise<void> {
    const newLabel = rename.commitRename(entryId)
    if (!newLabel) return
    const entry = manage.entries.find((e) => e.id === entryId)
    const ok = await manage.renameEntry(entryId, newLabel)
    if (ok && entry?.hubPostId && onRenameOnHub) {
      onRenameOnHub(entryId, entry.hubPostId, newLabel)
    }
  }

  function handleRenameKeyDown(e: React.KeyboardEvent, entryId: string): void {
    if (e.key === 'Enter') {
      void commitRename(entryId)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      rename.cancelRename()
    }
  }

  return (
    <div className="flex flex-col h-full">
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
                        onBlur={() => void commitRename(entry.id)}
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
                        {entry.label || t('common.noLabel')}
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
                          {t('common.confirmDelete')}
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

      <div className="mt-4 border-t border-edge pt-3">
        <div className="flex items-center gap-2">
          {manage.importResult && (
            <span className="text-sm text-accent" data-testid="data-modal-fav-import-result">
              {formatImportMessage(t, manage.importResult)}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={manage.importing || manage.exporting}
              className="rounded border border-edge px-4 py-2 text-sm hover:bg-surface-dim disabled:opacity-50"
              onClick={() => void manage.importFavorites()}
              data-testid="data-modal-fav-import-btn"
            >
              {t('favoriteStore.import')}
            </button>
            <button
              type="button"
              disabled={manage.exporting || manage.importing}
              className="rounded border border-edge px-4 py-2 text-sm hover:bg-surface-dim disabled:opacity-50"
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
