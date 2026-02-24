// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useInlineRename } from '../hooks/useInlineRename'
import { ACTION_BTN, CONFIRM_DELETE_BTN, DELETE_BTN, formatDate } from './editors/store-modal-shared'
import type { HubMyPost } from '../../shared/types/hub'

export const DEFAULT_PER_PAGE = 10

export const BTN_PRIMARY = 'rounded bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50'
export const BTN_SECONDARY = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50'

interface HubPostRowProps {
  post: HubMyPost
  onRename: (postId: string, newTitle: string) => Promise<void>
  onDelete: (postId: string) => Promise<void>
  hubOrigin?: string
}

export function HubPostRow({ post, onRename, onDelete, hubOrigin }: HubPostRowProps) {
  const { t } = useTranslation()
  const rename = useInlineRename<string>()
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleStartEdit = useCallback(() => {
    rename.startRename(post.id, post.title)
    setConfirmingDelete(false)
    setError(null)
  }, [post.id, post.title, rename.startRename])

  const handleSubmitRename = useCallback(async () => {
    const trimmed = rename.editLabel.trim()
    if (!trimmed || trimmed === rename.originalLabel) {
      rename.cancelRename()
      return
    }
    // Close editor immediately to prevent blur from double-committing
    rename.cancelRename()
    setBusy(true)
    setError(null)
    try {
      await onRename(post.id, trimmed)
      rename.scheduleFlash(post.id)
    } catch {
      setError(t('hub.renameFailed'))
    } finally {
      setBusy(false)
    }
  }, [post.id, rename.editLabel, rename.originalLabel, rename.cancelRename, rename.scheduleFlash, onRename, t])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      void handleSubmitRename()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      rename.cancelRename()
    }
  }, [handleSubmitRename, rename.cancelRename])

  function handleBlurCommit(): void {
    if (busy) return
    const trimmed = rename.editLabel.trim()
    const changed = !!(trimmed && trimmed !== rename.originalLabel)
    rename.cancelRename()
    if (!changed) return
    setBusy(true)
    setError(null)
    void onRename(post.id, trimmed)
      .then(() => rename.scheduleFlash(post.id))
      .catch(() => setError(t('hub.renameFailed')))
      .finally(() => setBusy(false))
  }

  const handleConfirmDelete = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await onDelete(post.id)
      setConfirmingDelete(false)
    } catch {
      setError(t('hub.deleteFailed'))
    } finally {
      setBusy(false)
    }
  }, [post.id, onDelete, t])

  const handleStartDelete = useCallback(() => {
    setConfirmingDelete(true)
    rename.cancelRename()
    setError(null)
  }, [rename.cancelRename])

  return (
    <div data-testid={`hub-post-${post.id}`}>
      <div
        className={`flex items-center justify-between rounded-lg border border-edge bg-surface/20 px-3 py-2 ${rename.confirmedId === post.id ? 'confirm-flash' : ''}`}

      >
        <div className="flex-1 flex flex-col min-w-0">
          {rename.editingId === post.id ? (
            <input
              type="text"
              className="w-full border-b border-edge bg-transparent px-1 text-sm text-content outline-none focus:border-accent"
              value={rename.editLabel}
              onChange={(e) => rename.setEditLabel(e.target.value)}
              onBlur={handleBlurCommit}
              onKeyDown={handleKeyDown}
              disabled={busy}
              maxLength={200}
              autoFocus
              data-testid={`hub-rename-input-${post.id}`}
            />
          ) : (
            <span
              className="text-sm text-content truncate cursor-pointer"
              data-testid={`hub-title-${post.id}`}
              onClick={handleStartEdit}
            >
              {post.title}
            </span>
          )}
          <span className="text-[11px] text-content-muted truncate">
            {post.keyboard_name} · {formatDate(post.created_at)}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0 ml-2">
          {confirmingDelete && (
            <>
              <button
                type="button"
                className={CONFIRM_DELETE_BTN}
                onClick={handleConfirmDelete}
                disabled={busy}
                data-testid={`hub-confirm-delete-${post.id}`}
              >
                {t('layoutStore.confirmDelete')}
              </button>
              <button
                type="button"
                className={ACTION_BTN}
                onClick={() => setConfirmingDelete(false)}
                disabled={busy}
                data-testid={`hub-cancel-delete-${post.id}`}
              >
                {t('common.cancel')}
              </button>
            </>
          )}
          {!confirmingDelete && (
            <>
              {hubOrigin && (
                <button
                  type="button"
                  className={ACTION_BTN}
                  onClick={() => window.vialAPI.openExternal(`${hubOrigin}/post/${encodeURIComponent(post.id)}`)}
                  disabled={busy}
                  data-testid={`hub-open-${post.id}`}
                >
                  {t('hub.openInBrowser')}
                </button>
              )}
              <button
                type="button"
                className={DELETE_BTN}
                onClick={handleStartDelete}
                disabled={busy}
                data-testid={`hub-delete-${post.id}`}
              >
                {t('layoutStore.delete')}
              </button>
            </>
          )}
        </div>
      </div>
      {error && (
        <p className="mt-1 text-xs text-danger" data-testid={`hub-error-${post.id}`}>
          {error}
        </p>
      )}
    </div>
  )
}

export function HubRefreshButton({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const { t } = useTranslation()
  const [refreshing, setRefreshing] = useState(false)

  const handleClick = useCallback(async () => {
    setRefreshing(true)
    try {
      await onRefresh()
    } finally {
      setRefreshing(false)
    }
  }, [onRefresh])

  return (
    <button
      type="button"
      className="text-xs text-content-muted hover:text-content disabled:opacity-50"
      onClick={handleClick}
      disabled={refreshing}
      data-testid="hub-refresh-posts"
    >
      {refreshing ? t('common.refreshing') : t('common.refresh')}
    </button>
  )
}
