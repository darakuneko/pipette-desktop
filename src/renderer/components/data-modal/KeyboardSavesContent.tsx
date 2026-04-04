// SPDX-License-Identifier: GPL-2.0-or-later
// Unified keyboard saves view — works for both local and sync (remote) data

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutStoreEntry } from '../editors/LayoutStoreEntry'
import { useSnapshotActions } from './useSnapshotActions'
import type { SnapshotMeta, SnapshotIndex } from '../../../shared/types/snapshot-store'
import type { UseSyncReturn } from '../../hooks/useSync'

interface BaseProps {
  uid: string
  name: string
}

interface LocalProps extends BaseProps {
  source: 'local'
  hubOrigin?: string
  sync?: never
  onDeleted?: () => void
}

interface SyncProps extends BaseProps {
  source: 'sync'
  hubOrigin?: never
  sync: UseSyncReturn
  onDeleted?: () => void
}

type Props = LocalProps | SyncProps

const BTN_DANGER_OUTLINE = 'rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50'
const BTN_SECONDARY = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50'

export function KeyboardSavesContent(props: Props) {
  const { uid, name, source } = props
  const { t } = useTranslation()
  const [entries, setEntries] = useState<SnapshotMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [confirmHubRemoveId, setConfirmHubRemoveId] = useState<string | null>(null)

  const actions = source === 'local' ? useSnapshotActions({ uid, deviceName: name }) : null

  const loadEntries = useCallback(async () => {
    setLoading(true)
    try {
      if (source === 'local') {
        const result = await window.vialAPI.snapshotStoreList(uid)
        if (result.success && result.entries) {
          setEntries(result.entries)
        }
      } else {
        const bundle = await window.vialAPI.syncFetchRemoteBundle(`keyboards/${uid}/snapshots`)
        if (bundle && typeof bundle === 'object' && 'index' in bundle) {
          const index = (bundle as { index: SnapshotIndex }).index
          if (index.entries) {
            setEntries(index.entries.filter((e) => !e.deletedAt))
          }
        }
      }
    } catch {
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [uid, source])

  useEffect(() => {
    void loadEntries()
  }, [loadEntries])

  const handleDelete = useCallback(async (entryId: string) => {
    if (source !== 'local') return
    await window.vialAPI.snapshotStoreDelete(uid, entryId)
    setConfirmDeleteId(null)
    void loadEntries()
  }, [uid, source, loadEntries])

  const handleDeleteAll = useCallback(async () => {
    if (source === 'local') {
      await window.vialAPI.resetKeyboardData(uid)
    } else {
      await props.sync.resetSyncTargets({ keyboards: [uid], favorites: false })
    }
    setConfirmDeleteAll(false)
    setEntries([])
    props.onDeleted?.()
  }, [uid, source, props])

  // Hub actions (local only)
  const handleUploadToHub = useCallback(async (entryId: string) => {
    if (!actions) return
    const entry = entries.find((e) => e.id === entryId)
    if (!entry) return
    await actions.handleUploadToHub(entryId, entry.label)
    void loadEntries()
  }, [entries, actions, loadEntries])

  const handleUpdateOnHub = useCallback(async (entryId: string) => {
    if (!actions) return
    const entry = entries.find((e) => e.id === entryId)
    if (!entry?.hubPostId) return
    await actions.handleUpdateOnHub(entryId, entry.hubPostId, entry.label)
    void loadEntries()
  }, [entries, actions, loadEntries])

  const handleRemoveFromHub = useCallback(async (entryId: string) => {
    if (!actions) return
    const entry = entries.find((e) => e.id === entryId)
    if (!entry?.hubPostId) return
    await actions.handleRemoveFromHub(entry.hubPostId)
    void loadEntries()
  }, [entries, actions, loadEntries])

  const deleteAllFooter = (
    <div className="mt-4 border-t border-edge pt-3 shrink-0">
      <div className="flex items-center justify-end gap-2">
        {confirmDeleteAll ? (
          <>
            <span className="text-sm text-danger">{t('dataModal.deleteAllConfirm')}</span>
            <button
              type="button"
              className={BTN_DANGER_OUTLINE}
              onClick={() => void handleDeleteAll()}
              data-testid="kb-saves-delete-all-confirm"
            >
              {t('common.confirmDelete')}
            </button>
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() => setConfirmDeleteAll(false)}
              data-testid="kb-saves-delete-all-cancel"
            >
              {t('common.cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={BTN_DANGER_OUTLINE}
            onClick={() => setConfirmDeleteAll(true)}
            data-testid="kb-saves-delete-all"
          >
            {t('dataModal.deleteAll')}
          </button>
        )}
      </div>
    </div>
  )

  if (loading) {
    return <div className="py-4 text-center text-[13px] text-content-muted">{t('common.loading')}</div>
  }

  if (entries.length === 0) {
    return (
      <div className="flex flex-col h-full" data-testid="kb-saves-empty">
        <div className="flex-1 py-4 text-center text-[13px] text-content-muted">
          {t('dataModal.noSaves')}
        </div>
        {deleteAllFooter}
      </div>
    )
  }

  const hubOrigin = source === 'local' ? props.hubOrigin : undefined

  return (
    <div className="flex flex-col h-full" data-testid="kb-saves-list">
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => {
            const isV2 = entry.vilVersion === 2
            const isLocal = source === 'local'
            return (
              <LayoutStoreEntry
                key={entry.id}
                entry={entry}
                entryHubPostId={isLocal ? entry.hubPostId : undefined}
                confirmDeleteId={confirmDeleteId}
                setConfirmDeleteId={setConfirmDeleteId}
                onDelete={isLocal ? (id) => void handleDelete(id) : () => {}}
                hasEntryExport={isLocal && isV2}
                onExportEntryVil={isLocal && isV2 && actions ? actions.handleExportVil : undefined}
                onExportEntryKeymapC={isLocal && isV2 && actions ? actions.handleExportKeymapC : undefined}
                onExportEntryPdf={isLocal && isV2 && actions ? actions.handleExportPdf : undefined}
                hasHubActions={isLocal && isV2 && !!hubOrigin}
                keyboardName={name}
                hubOrigin={hubOrigin}
                confirmHubRemoveId={confirmHubRemoveId}
                setConfirmHubRemoveId={setConfirmHubRemoveId}
                onUploadToHub={isLocal && isV2 ? (id) => void handleUploadToHub(id) : undefined}
                onUpdateOnHub={isLocal && isV2 ? (id) => void handleUpdateOnHub(id) : undefined}
                onRemoveFromHub={isLocal && isV2 ? (id) => void handleRemoveFromHub(id) : undefined}
              />
            )
          })}
        </div>
      </div>
      {deleteAllFooter}
    </div>
  )
}
