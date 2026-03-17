// SPDX-License-Identifier: GPL-2.0-or-later
// Remote keyboard saves — fetches from Google Drive and displays with same layout as local

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutStoreEntry } from '../editors/LayoutStoreEntry'
import type { SnapshotMeta, SnapshotIndex } from '../../../shared/types/snapshot-store'
import type { UseSyncReturn } from '../../hooks/useSync'

interface Props {
  uid: string
  name: string
  sync: UseSyncReturn
  onDeleted?: () => void
}

const BTN_DANGER_OUTLINE = 'rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50'
const BTN_SECONDARY = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50'

export function SyncKeyboardContent({ uid, name: _name, sync, onDeleted }: Props) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<SnapshotMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)

  const loadEntries = useCallback(async () => {
    setLoading(true)
    try {
      const bundle = await window.vialAPI.syncFetchRemoteBundle(`keyboards/${uid}/snapshots`)
      if (bundle && typeof bundle === 'object' && 'index' in bundle) {
        const index = (bundle as { index: SnapshotIndex }).index
        if (index.entries) {
          setEntries(index.entries.filter((e) => !e.deletedAt))
        }
      }
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [uid])

  useEffect(() => {
    void loadEntries()
  }, [loadEntries])

  const handleDeleteAll = useCallback(async () => {
    await sync.resetSyncTargets({ keyboards: [uid], favorites: false })
    setConfirmDeleteAll(false)
    setEntries([])
    onDeleted?.()
  }, [uid, sync, onDeleted])

  if (loading) {
    return <div className="py-4 text-center text-[13px] text-content-muted">{t('common.loading')}</div>
  }

  if (entries.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="sync-kb-saves-empty">
        {t('dataModal.noSaves')}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="sync-kb-saves-list">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <LayoutStoreEntry
              key={entry.id}
              entry={entry}
              confirmDeleteId={confirmDeleteId}
              setConfirmDeleteId={setConfirmDeleteId}
              onDelete={() => {/* remote individual delete not supported */}}
              hasEntryExport={false}
              hasHubActions={false}
              keyboardName=""
              confirmHubRemoveId={null}
              setConfirmHubRemoveId={() => {}}
            />
          ))}
        </div>
      </div>

      {/* Footer: Delete All */}
      <div className="mt-4 border-t border-edge pt-3 shrink-0">
        <div className="flex items-center justify-end gap-2">
          {confirmDeleteAll ? (
            <>
              <span className="text-sm text-danger">{t('dataModal.deleteAllConfirm')}</span>
              <button
                type="button"
                className={BTN_DANGER_OUTLINE}
                onClick={() => void handleDeleteAll()}
                data-testid="sync-kb-delete-all-confirm"
              >
                {t('common.confirmDelete')}
              </button>
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => setConfirmDeleteAll(false)}
                data-testid="sync-kb-delete-all-cancel"
              >
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={BTN_DANGER_OUTLINE}
              onClick={() => setConfirmDeleteAll(true)}
              data-testid="sync-kb-delete-all"
            >
              {t('dataModal.deleteAll')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
