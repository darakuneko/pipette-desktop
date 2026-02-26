// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useInlineRename } from '../../hooks/useInlineRename'
import { ACTION_BTN, CONFIRM_DELETE_BTN, DELETE_BTN, SectionHeader, formatDate } from './store-modal-shared'
import { FavoriteHubActions } from './FavoriteHubActions'
import type { FavHubEntryResult } from './FavoriteHubActions'
import type { FavoriteType, SavedFavoriteMeta } from '../../../shared/types/favorite-store'
import type { FavoriteImportResultState } from '../../hooks/useFavoriteStore'

export function formatImportMessage(t: (key: string, opts?: Record<string, unknown>) => string, result: FavoriteImportResultState): string {
  if (result.imported === 0) return t('favoriteStore.importEmpty')
  if (result.skipped > 0) return t('favoriteStore.importPartial', { imported: result.imported, skipped: result.skipped })
  return t('favoriteStore.importSuccess', { imported: result.imported })
}

export const TYPE_LABEL_KEYS: Record<FavoriteType, string> = {
  tapDance: 'editor.tapDance.title',
  macro: 'editor.macro.title',
  combo: 'editor.combo.title',
  keyOverride: 'editor.keyOverride.title',
  altRepeatKey: 'editor.altRepeatKey.title',
}

export interface FavoriteStoreContentProps {
  entries: SavedFavoriteMeta[]
  loading?: boolean
  saving?: boolean
  exporting?: boolean
  importing?: boolean
  importResult?: FavoriteImportResultState | null
  canSave?: boolean
  onSave: (label: string) => void
  onLoad: (entryId: string) => void
  onRename: (entryId: string, newLabel: string) => void
  onDelete: (entryId: string) => void
  onExport: () => void
  onExportEntry: (entryId: string) => void
  onImport: () => void
  // Hub integration (optional)
  hubOrigin?: string
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: FavHubEntryResult | null
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
  onRefreshEntries?: () => void
}

export function FavoriteStoreContent({
  entries,
  loading,
  saving,
  exporting,
  importing,
  importResult,
  canSave = true,
  onSave,
  onLoad,
  onRename,
  onDelete,
  onExport,
  onExportEntry,
  onImport,
  hubOrigin,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
  onRefreshEntries,
}: FavoriteStoreContentProps) {
  const { t } = useTranslation()
  const [saveLabel, setSaveLabel] = useState('')
  const rename = useInlineRename<string>()
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  // Refresh entries when hub operation completes (upload/update/remove changes hubPostId)
  useEffect(() => {
    if (hubUploadResult) onRefreshEntries?.()
  }, [hubUploadResult, onRefreshEntries])

  const trimmedSaveLabel = saveLabel.trim()
  const canSubmitSave = canSave && !saving && trimmedSaveLabel.length > 0

  function handleSaveSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (!canSubmitSave) return
    onSave(trimmedSaveLabel)
    setSaveLabel('')
  }

  function commitRename(entryId: string): void {
    const newLabel = rename.commitRename(entryId)
    if (newLabel) onRename(entryId, newLabel)
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
    <div className="flex flex-col h-full" data-testid="favorite-store-content">
      {/* Fixed top sections */}
      <div className="shrink-0 border-l border-edge px-5">
        {/* Save Current State section */}
        <div className="pt-4">
          <SectionHeader label={t('favoriteStore.saveCurrentState')} />
          <form onSubmit={handleSaveSubmit} className="flex gap-2">
            <input
              type="text"
              value={saveLabel}
              onChange={(e) => setSaveLabel(e.target.value)}
              placeholder={t('favoriteStore.labelPlaceholder')}
              maxLength={200}
              className="flex-1 rounded-lg border border-edge bg-surface px-3.5 py-2 text-[13px] text-content placeholder:text-content-muted focus:border-accent focus:outline-none"
              data-testid="favorite-store-save-input"
            />
            <button
              type="submit"
              disabled={!canSubmitSave}
              className="shrink-0 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
              data-testid="favorite-store-save-submit"
            >
              {t('common.save')}
            </button>
          </form>
        </div>

        {/* Synced Data header */}
        <div className="pt-5">
          <SectionHeader label={t('favoriteStore.history')} count={entries.length} />
        </div>
      </div>

      {/* Scrollable Synced Data list */}
      <div className="flex-1 min-h-0 overflow-y-auto border-l border-edge px-5 pb-5">
        {loading && (
          <div className="py-4 text-center text-[13px] text-content-muted">{t('common.loading')}</div>
        )}

        {!loading && entries.length === 0 && (
          <div className="py-4 text-center text-[13px] text-content-muted" data-testid="favorite-store-empty">
            {t('favoriteStore.noSaved')}
          </div>
        )}

        {!loading && entries.length > 0 && (
          <div className="flex flex-col gap-1.5" data-testid="favorite-store-list">
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={`rounded-lg border border-edge bg-surface/20 p-3 hover:border-content-muted/30 ${rename.confirmedId === entry.id ? 'confirm-flash' : ''}`}
                data-testid="favorite-store-entry"
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
                        className="w-full border-b border-edge bg-transparent px-1 text-sm font-semibold text-content outline-none focus:border-accent"
                        data-testid="favorite-store-rename-input"
                        autoFocus
                      />
                    ) : (
                      <div
                        className="truncate text-sm font-semibold text-content cursor-pointer"
                        data-testid="favorite-store-entry-label"
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
                          onClick={() => { onDelete(entry.id); setConfirmDeleteId(null) }}
                          data-testid="favorite-store-delete-confirm"
                        >
                          {t('favoriteStore.confirmDelete')}
                        </button>
                        <button
                          type="button"
                          className={ACTION_BTN}
                          onClick={() => setConfirmDeleteId(null)}
                          data-testid="favorite-store-delete-cancel"
                        >
                          {t('common.cancel')}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={ACTION_BTN}
                          onClick={() => onLoad(entry.id)}
                          data-testid="favorite-store-load-btn"
                        >
                          {t('favoriteStore.load')}
                        </button>
                        <button
                          type="button"
                          className={DELETE_BTN}
                          onClick={() => setConfirmDeleteId(entry.id)}
                          data-testid="favorite-store-delete-btn"
                        >
                          {t('favoriteStore.delete')}
                        </button>
                      </>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <span className="text-[11px] text-content-muted font-mono">
                    {formatDate(entry.savedAt)}
                  </span>
                  <button
                    type="button"
                    disabled={exporting || importing}
                    className={ACTION_BTN}
                    onClick={() => onExportEntry(entry.id)}
                    data-testid="favorite-store-export-entry-btn"
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

      {/* Fixed footer: Import / Export */}
      <div className="relative shrink-0 px-5 py-3">
        <div className="absolute left-0 top-0 h-1/2 border-l border-edge" />
        <div className="flex items-center gap-2">
          {importResult && (
            <span
              className="text-sm text-accent"
              data-testid="favorite-store-import-result"
            >
              {formatImportMessage(t, importResult)}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={importing || exporting}
              className="rounded-lg border border-edge bg-surface px-4 py-2 text-[13px] font-semibold text-content hover:bg-surface-alt disabled:opacity-50"
              onClick={onImport}
              data-testid="favorite-store-import-btn"
            >
              {t('favoriteStore.import')}
            </button>
            <button
              type="button"
              disabled={exporting || importing}
              className="rounded-lg border border-edge bg-surface px-4 py-2 text-[13px] font-semibold text-content hover:bg-surface-alt disabled:opacity-50"
              onClick={onExport}
              data-testid="favorite-store-export-btn"
            >
              {t('favoriteStore.exportAll')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
