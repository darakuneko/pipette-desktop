// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { ModalCloseButton } from './ModalCloseButton'
import { ACTION_BTN, CONFIRM_DELETE_BTN, DELETE_BTN, SectionHeader, formatDate } from './store-modal-shared'
import type { FavoriteType, SavedFavoriteMeta } from '../../../shared/types/favorite-store'

interface Props {
  favoriteType: FavoriteType
  entries: SavedFavoriteMeta[]
  loading?: boolean
  saving?: boolean
  canSave?: boolean
  onSave: (label: string) => void
  onLoad: (entryId: string) => void
  onRename: (entryId: string, newLabel: string) => void
  onDelete: (entryId: string) => void
  onClose: () => void
}

const TYPE_LABEL_KEYS: Record<FavoriteType, string> = {
  tapDance: 'editor.tapDance.title',
  macro: 'editor.macro.title',
  combo: 'editor.combo.title',
  keyOverride: 'editor.keyOverride.title',
  altRepeatKey: 'editor.altRepeatKey.title',
}

export function FavoriteStoreModal({
  favoriteType,
  entries,
  loading,
  saving,
  canSave = true,
  onSave,
  onLoad,
  onRename,
  onDelete,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const [saveLabel, setSaveLabel] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const originalLabelRef = useRef('')

  function handleSaveSubmit(e: React.FormEvent): void {
    e.preventDefault()
    if (saving || !canSave) return
    onSave(saveLabel.trim())
    setSaveLabel('')
  }

  function handleRenameSubmit(entryId: string): void {
    const trimmed = editLabel.trim()
    if (trimmed !== originalLabelRef.current) {
      onRename(entryId, trimmed)
    }
    setEditingId(null)
  }

  function handleRenameKeyDown(e: React.KeyboardEvent, entryId: string): void {
    if (e.key === 'Enter') {
      handleRenameSubmit(entryId)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      setEditingId(null)
    }
  }

  function startRename(entry: SavedFavoriteMeta): void {
    setEditingId(entry.id)
    setEditLabel(entry.label)
    originalLabelRef.current = entry.label
  }

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50"
      data-testid="favorite-store-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[90vw] max-h-[85vh] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-edge shrink-0">
          <h2 className="text-lg font-bold text-content">
            {t('favoriteStore.title')}
            <span className="ml-2 rounded bg-accent/20 px-2 py-0.5 text-xs text-accent">
              {t(TYPE_LABEL_KEYS[favoriteType])}
            </span>
          </h2>
          <ModalCloseButton testid="favorite-store-modal-close" onClick={onClose} />
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">

          {/* Save Current State section */}
          <div className="pt-4">
            <SectionHeader label={t('favoriteStore.saveCurrentState')} />
            <form onSubmit={handleSaveSubmit} className="flex gap-2">
              <input
                type="text"
                value={saveLabel}
                onChange={(e) => setSaveLabel(e.target.value)}
                placeholder={t('favoriteStore.labelPlaceholder')}
                className="flex-1 rounded-lg border border-edge bg-surface px-3.5 py-2 text-[13px] text-content placeholder:text-content-muted focus:border-accent focus:outline-none"
                data-testid="favorite-store-save-input"
              />
              <button
                type="submit"
                disabled={saving || !canSave}
                className="shrink-0 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
                data-testid="favorite-store-save-submit"
              >
                {t('common.save')}
              </button>
            </form>
          </div>

          {/* Synced Data section */}
          <div className="pt-5">
            <SectionHeader label={t('favoriteStore.history')} count={entries.length} />

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
                    className="rounded-lg border border-edge bg-surface/20 p-3 hover:border-content-muted/30"
                    data-testid="favorite-store-entry"
                  >
                    {/* Top row: label + action buttons */}
                    <div className="flex items-center justify-between mb-1">
                      <div className="min-w-0 flex-1">
                        {editingId === entry.id ? (
                          <div className="flex items-center gap-1">
                            <input
                              type="text"
                              value={editLabel}
                              onChange={(e) => setEditLabel(e.target.value)}
                              onBlur={() => handleRenameSubmit(entry.id)}
                              onKeyDown={(e) => handleRenameKeyDown(e, entry.id)}
                              className="flex-1 rounded-md border border-accent bg-surface px-2 py-0.5 text-sm font-semibold text-content focus:outline-none"
                              data-testid="favorite-store-rename-input"
                              autoFocus
                            />
                          </div>
                        ) : (
                          <div
                            className="truncate text-sm font-semibold text-content"
                            data-testid="favorite-store-entry-label"
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
                              className={ACTION_BTN}
                              onClick={() => startRename(entry)}
                              data-testid="favorite-store-rename-btn"
                            >
                              {t('favoriteStore.rename')}
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

                    {/* Bottom row: date */}
                    <span className="text-[11px] text-content-muted font-mono">
                      {formatDate(entry.savedAt)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
