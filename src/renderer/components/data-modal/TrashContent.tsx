// SPDX-License-Identifier: GPL-2.0-or-later
//
// Data modal > Sync > Trash — Drive copies that sync stopped reading
// because another copy of the same name was chosen. Lists them when the
// pane opens and again after each action (one Drive listing, nothing is
// downloaded). Restore swaps a copy back in with one click, except for this
// PC's own typing days (`restorable`), which can only be deleted; Delete is
// the two-step ConfirmResetRow used by Cloud Data.

import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmResetRow } from './ConfirmResetRow'
import { formatDateTime } from '../editors/store-modal-shared'
import { BTN_SECONDARY } from '../../constants/ui-tokens'
import type { UseSyncReturn } from '../../hooks/useSync'
import type { SyncTrashFile } from '../../../shared/types/sync'

export interface TrashContentProps {
  sync: UseSyncReturn
}

/** Shown when a call fails without a message of its own. */
const FALLBACK_ERROR = 'statusBar.sync.error'

export function TrashContent({ sync }: TrashContentProps) {
  const { t } = useTranslation()
  // The methods, not `sync`: useSync returns a new object on every render,
  // and the listing must run only when the pane opens and after an action.
  const { listTrash, restoreTrash, deleteTrash } = sync
  const [files, setFiles] = useState<SyncTrashFile[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  /** An i18n key, or a main-process message shown as it is. */
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await listTrash()
      if (!result.success) {
        setError(result.error ?? FALLBACK_ERROR)
        return
      }
      setFiles(result.files ?? [])
    } catch {
      setError(FALLBACK_ERROR)
    } finally {
      setLoading(false)
    }
  }, [listTrash])

  useEffect(() => {
    void load()
  }, [load])

  /** Runs one action, then lists again whatever the outcome, since Drive may
   *  have changed under the pane. `action` resolves the error to show, or
   *  null. */
  const runAction = useCallback(async (action: () => Promise<string | null>) => {
    setBusy(true)
    setError(null)
    try {
      const failure = await action()
      if (failure) setError(failure)
      setConfirmingId(null)
    } catch {
      setError(FALLBACK_ERROR)
    } finally {
      await load()
      setBusy(false)
    }
  }, [load])

  const handleRestore = useCallback((fileId: string) => runAction(async () => {
    const result = await restoreTrash(fileId)
    return result.success ? null : result.error ?? FALLBACK_ERROR
  }), [runAction, restoreTrash])

  const handleDelete = useCallback((fileId: string) => runAction(async () => {
    const result = await deleteTrash([fileId])
    if (!result.success) return result.error ?? FALLBACK_ERROR
    return result.skipped && result.skipped.length > 0 ? 'sync.trash.notFound' : null
  }), [runAction, deleteTrash])

  if (loading && !files) {
    return <div className="py-4 text-center text-sm text-content-muted">{t('sync.scanning')}</div>
  }

  return (
    <div className="space-y-4" data-testid="trash-content">
      {error && (
        <div className="text-xs text-danger" data-testid="trash-error">
          {t(error, error)}
        </div>
      )}
      <p className="text-sm text-content-muted">{t('sync.trash.description')}</p>
      {files === null ? null : files.length === 0 ? (
        <p className="text-sm text-content-muted" data-testid="trash-empty">
          {t('sync.trash.empty')}
        </p>
      ) : (
        <div className="space-y-1">
          {files.map((file) => (
            <ConfirmResetRow
              key={file.fileId}
              rowClassName="flex items-center justify-between gap-2 rounded border border-edge px-3 py-2"
              rowTestid={`trash-row-${file.fileId}`}
              labelClassName="min-w-0"
              label={
                <>
                  <span className="block truncate text-sm text-content">{file.syncUnit ?? file.originalName}</span>
                  <span className="block text-xs text-content-muted">
                    {t('sync.trash.updated', { date: formatDateTime(file.updatedAt) })}
                  </span>
                  <span className="block text-xs text-content-muted">
                    {t('sync.trash.autoDelete', { date: formatDateTime(file.expiresAt) })}
                  </span>
                </>
              }
              triggerLabel={t('common.delete')}
              confirmLabel={t('common.confirmDelete')}
              cancelLabel={t('common.cancel')}
              extraAction={file.restorable && (
                <button
                  type="button"
                  className={BTN_SECONDARY}
                  onClick={() => void handleRestore(file.fileId)}
                  disabled={busy}
                  data-testid={`trash-restore-${file.fileId}`}
                >
                  {t('sync.trash.restore')}
                </button>
              )}
              confirming={confirmingId === file.fileId}
              busy={busy}
              onTrigger={() => setConfirmingId(file.fileId)}
              onConfirm={() => void handleDelete(file.fileId)}
              onCancel={() => setConfirmingId(null)}
              triggerTestid={`trash-delete-${file.fileId}`}
              confirmTestid={`trash-delete-confirm-${file.fileId}`}
              cancelTestid={`trash-delete-cancel-${file.fileId}`}
            />
          ))}
        </div>
      )}
    </div>
  )
}
