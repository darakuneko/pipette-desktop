// SPDX-License-Identifier: GPL-2.0-or-later

import { useTranslation } from 'react-i18next'
import { FORMAT_BTN } from './layout-store-types'
import type { HubEntryResult } from './layout-store-types'
import { LayoutStoreHubRow } from './LayoutStoreHubActions'
import { ACTION_BTN, CONFIRM_DELETE_BTN, DELETE_BTN, formatDate } from './store-modal-shared'
import type { SnapshotMeta } from '../../../shared/types/snapshot-store'
import type { HubMyPost } from '../../../shared/types/hub'

interface FormatButtonsProps {
  className: string
  testIdPrefix: string
  disabled?: boolean
  onVil?: () => void
  onKeymapC?: () => void
  onPdf?: () => void
}

function FormatButtons({ className, testIdPrefix, disabled, onVil, onKeymapC, onPdf }: FormatButtonsProps) {
  const { t } = useTranslation()
  return (
    <>
      {onVil && (
        <button
          type="button"
          className={className}
          onClick={onVil}
          disabled={disabled}
          data-testid={`${testIdPrefix}-vil`}
        >
          {t('layoutStore.exportVil')}
        </button>
      )}
      {onKeymapC && (
        <button
          type="button"
          className={className}
          onClick={onKeymapC}
          disabled={disabled}
          data-testid={`${testIdPrefix}-keymap-c`}
        >
          {t('layoutStore.exportKeymapC')}
        </button>
      )}
      {onPdf && (
        <button
          type="button"
          className={className}
          onClick={onPdf}
          disabled={disabled}
          data-testid={`${testIdPrefix}-pdf`}
        >
          {t('layoutStore.exportPdf')}
        </button>
      )}
    </>
  )
}

export { FormatButtons }
export type { FormatButtonsProps }

interface LayoutStoreEntryProps {
  entry: SnapshotMeta
  entryHubPostId?: string | undefined
  rename?: {
    editingId: string | null
    editLabel: string
    confirmedId: string | null
    setEditLabel: (label: string) => void
    startRename: (id: string, label: string) => void
    cancelRename: () => void
  }
  confirmDeleteId: string | null
  setConfirmDeleteId: (id: string | null) => void
  onCommitRename?: (entryId: string) => void
  onHandleRenameKeyDown?: (e: React.KeyboardEvent, entryId: string) => void
  onLoad?: (entryId: string) => void
  onDelete: (entryId: string) => void
  hasEntryExport: boolean
  hasHubActions: boolean
  fileDisabled?: boolean
  onExportEntryVil?: (entryId: string) => void
  onExportEntryKeymapC?: (entryId: string) => void
  onExportEntryPdf?: (entryId: string) => void
  keyboardName: string
  hubOrigin?: string
  hubMyPosts?: HubMyPost[]
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: HubEntryResult | null
  confirmHubRemoveId: string | null
  setConfirmHubRemoveId: (id: string | null) => void
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
  onReuploadToHub?: (entryId: string, orphanedPostId: string) => void
  onDeleteOrphanedHubPost?: (entryId: string, orphanedPostId: string) => void
}

export function LayoutStoreEntry({
  entry,
  entryHubPostId,
  rename,
  confirmDeleteId,
  setConfirmDeleteId,
  onCommitRename,
  onHandleRenameKeyDown,
  onLoad,
  onDelete,
  hasEntryExport,
  hasHubActions,
  fileDisabled,
  onExportEntryVil,
  onExportEntryKeymapC,
  onExportEntryPdf,
  keyboardName,
  hubOrigin,
  hubMyPosts,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  confirmHubRemoveId,
  setConfirmHubRemoveId,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
  onReuploadToHub,
  onDeleteOrphanedHubPost,
}: LayoutStoreEntryProps) {
  const { t } = useTranslation()

  return (
    <div
      className={`rounded-lg border border-edge bg-surface/20 p-3 hover:border-content-muted/30 ${rename?.confirmedId === entry.id ? 'confirm-flash' : ''}`}
      data-testid="layout-store-entry"
    >
      {/* Top row: label + action buttons */}
      <div className="flex items-center justify-between mb-1">
        <div className="min-w-0 flex-1">
          {rename && rename.editingId === entry.id ? (
            <input
              type="text"
              value={rename.editLabel}
              onChange={(e) => rename.setEditLabel(e.target.value)}
              onBlur={() => onCommitRename?.(entry.id)}
              onKeyDown={(e) => onHandleRenameKeyDown?.(e, entry.id)}
              maxLength={200}
              className="w-full border-b border-edge bg-transparent px-1 text-sm font-semibold text-content outline-none focus:border-accent"
              data-testid="layout-store-rename-input"
              autoFocus
            />
          ) : (
            <div
              className={`truncate text-sm font-semibold text-content ${rename ? 'cursor-pointer' : ''}`}
              data-testid="layout-store-entry-label"
              onClick={rename ? () => rename.startRename(entry.id, entry.label) : undefined}
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
                onClick={() => { onDelete(entry.id); setConfirmDeleteId(null) }}
                data-testid="layout-store-delete-confirm"
              >
                {t('common.confirmDelete')}
              </button>
              <button
                type="button"
                className={ACTION_BTN}
                onClick={() => setConfirmDeleteId(null)}
                data-testid="layout-store-delete-cancel"
              >
                {t('common.cancel')}
              </button>
            </>
          ) : (
            <>
              {onLoad && (
                <button
                  type="button"
                  className={ACTION_BTN}
                  onClick={() => onLoad(entry.id)}
                  data-testid="layout-store-load-btn"
                >
                  {t('common.load')}
                </button>
              )}
              <button
                type="button"
                className={DELETE_BTN}
                onClick={() => setConfirmDeleteId(entry.id)}
                data-testid="layout-store-delete-btn"
              >
                {t('layoutStore.delete')}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Row 2: date + format tags */}
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-content-muted font-mono">
          {entry.vilVersion != null && t('layoutStore.versionPrefix', { version: entry.vilVersion })}{formatDate(entry.savedAt)}
        </span>
        {hasEntryExport && (
          <div className="flex gap-1">
            <FormatButtons
              className={FORMAT_BTN}
              testIdPrefix="layout-store-entry-export"
              disabled={fileDisabled}
              onVil={onExportEntryVil ? () => onExportEntryVil(entry.id) : undefined}
              onKeymapC={onExportEntryKeymapC ? () => onExportEntryKeymapC(entry.id) : undefined}
              onPdf={onExportEntryPdf ? () => onExportEntryPdf(entry.id) : undefined}
            />
          </div>
        )}
      </div>

      {/* Row 3: Hub actions */}
      {hasHubActions && (
        <LayoutStoreHubRow
          entry={entry}
          entryHubPostId={entryHubPostId}
          keyboardName={keyboardName}
          hubOrigin={hubOrigin}
          hubMyPosts={hubMyPosts}
          hubNeedsDisplayName={hubNeedsDisplayName}
          hubUploading={hubUploading}
          hubUploadResult={hubUploadResult}
          fileDisabled={fileDisabled}
          confirmHubRemoveId={confirmHubRemoveId}
          setConfirmHubRemoveId={setConfirmHubRemoveId}
          onUploadToHub={onUploadToHub}
          onUpdateOnHub={onUpdateOnHub}
          onRemoveFromHub={onRemoveFromHub}
          onReuploadToHub={onReuploadToHub}
          onDeleteOrphanedHubPost={onDeleteOrphanedHubPost}
        />
      )}
    </div>
  )
}
