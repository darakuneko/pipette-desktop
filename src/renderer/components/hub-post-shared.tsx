// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ACTION_BTN, CONFIRM_DELETE_BTN, DELETE_BTN, formatDate } from './editors/store-modal-shared'
import type { HubMyPost } from '../../shared/types/hub'

export const DEFAULT_PER_PAGE = 10

const BTN_PRIMARY = 'rounded bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50'
const BTN_SECONDARY = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50'

export { BTN_PRIMARY, BTN_SECONDARY }

interface HubPostRowProps {
  post: HubMyPost
  onRename: (postId: string, newTitle: string) => Promise<void>
  onDelete: (postId: string) => Promise<void>
  hubOrigin?: string
}

export function HubPostRow({ post, onRename, onDelete, hubOrigin }: HubPostRowProps) {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [editLabel, setEditLabel] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleStartEdit = useCallback(() => {
    setEditLabel(post.title)
    setEditing(true)
    setConfirmingDelete(false)
    setError(null)
  }, [post.title])

  const handleCancelEdit = useCallback(() => {
    setEditing(false)
  }, [])

  const handleSubmitRename = useCallback(async () => {
    if (!editLabel.trim()) return
    setBusy(true)
    setError(null)
    try {
      await onRename(post.id, editLabel.trim())
      setEditing(false)
    } catch {
      setError(t('hub.renameFailed'))
    } finally {
      setBusy(false)
    }
  }, [post.id, editLabel, onRename, t])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      void handleSubmitRename()
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      handleCancelEdit()
    }
  }, [handleSubmitRename, handleCancelEdit])

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
    setEditing(false)
    setError(null)
  }, [])

  return (
    <div data-testid={`hub-post-${post.id}`}>
      <div className="flex items-center justify-between rounded-lg border border-edge bg-surface/20 px-3 py-2">
        {editing ? (
          <input
            type="text"
            className="flex-1 rounded border border-edge bg-surface px-2 py-1 text-sm text-content focus:border-accent focus:outline-none"
            value={editLabel}
            onChange={(e) => setEditLabel(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy}
            maxLength={200}
            autoFocus
            data-testid={`hub-rename-input-${post.id}`}
          />
        ) : (
          <div className="flex flex-col min-w-0">
            <span className="text-sm text-content truncate">{post.title}</span>
            <span className="text-[11px] text-content-muted truncate">
              {post.keyboard_name} · {formatDate(post.created_at)}
            </span>
          </div>
        )}
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
          {!confirmingDelete && !editing && (
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
                className={ACTION_BTN}
                onClick={handleStartEdit}
                disabled={busy}
                data-testid={`hub-rename-${post.id}`}
              >
                {t('layoutStore.rename')}
              </button>
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
