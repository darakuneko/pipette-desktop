// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { LayoutStoreEntry } from '../editors/LayoutStoreEntry'
import { useSnapshotActions } from './useSnapshotActions'
import type { SnapshotMeta } from '../../../shared/types/snapshot-store'

interface Props {
  uid: string
  name: string
  hubOrigin?: string
}

const BTN_DANGER_OUTLINE = 'rounded border border-danger px-3 py-1 text-sm text-danger hover:bg-danger/10 disabled:opacity-50'
const BTN_SECONDARY = 'rounded border border-edge px-3 py-1 text-sm text-content-secondary hover:bg-surface-dim disabled:opacity-50'

export function KeyboardSavesContent({ uid, name, hubOrigin }: Props) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<SnapshotMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false)
  const [confirmHubRemoveId, setConfirmHubRemoveId] = useState<string | null>(null)

  const actions = useSnapshotActions({ uid, deviceName: name })

  const loadEntries = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.vialAPI.snapshotStoreList(uid)
      if (result.success && result.entries) {
        setEntries(result.entries)
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

  const handleDelete = useCallback(async (entryId: string) => {
    await window.vialAPI.snapshotStoreDelete(uid, entryId)
    setConfirmDeleteId(null)
    void loadEntries()
  }, [uid, loadEntries])

  const handleDeleteAll = useCallback(async () => {
    await window.vialAPI.resetKeyboardData(uid)
    setConfirmDeleteAll(false)
    setEntries([])
  }, [uid])

  const handleRemoveFromHub = useCallback(async (entryId: string) => {
    const entry = entries.find((e) => e.id === entryId)
    if (!entry?.hubPostId) return
    await actions.handleRemoveFromHub(entry.hubPostId)
    void loadEntries()
  }, [entries, actions, loadEntries])

  if (loading) {
    return <div className="py-4 text-center text-[13px] text-content-muted">{t('common.loading')}</div>
  }

  if (entries.length === 0) {
    return (
      <div className="py-4 text-center text-[13px] text-content-muted" data-testid="kb-saves-empty">
        {t('dataModal.noSaves')}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full" data-testid="kb-saves-list">
      {/* Scrollable save list */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-1.5">
          {entries.map((entry) => {
            const isV2 = entry.vilVersion === 2
            return (
              <LayoutStoreEntry
                key={entry.id}
                entry={entry}
                entryHubPostId={entry.hubPostId}
                confirmDeleteId={confirmDeleteId}
                setConfirmDeleteId={setConfirmDeleteId}
                onDelete={(id) => void handleDelete(id)}
                hasEntryExport={isV2}
                onExportEntryVil={isV2 ? actions.handleExportVil : undefined}
                onExportEntryKeymapC={isV2 ? actions.handleExportKeymapC : undefined}
                onExportEntryPdf={isV2 ? actions.handleExportPdf : undefined}
                hasHubActions={isV2 && !!hubOrigin}
                keyboardName={name}
                hubOrigin={hubOrigin}
                confirmHubRemoveId={confirmHubRemoveId}
                setConfirmHubRemoveId={setConfirmHubRemoveId}
                onRemoveFromHub={isV2 ? (id) => void handleRemoveFromHub(id) : undefined}
              />
            )
          })}
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
    </div>
  )
}
