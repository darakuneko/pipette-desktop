// SPDX-License-Identifier: GPL-2.0-or-later

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useInlineRename } from '../../hooks/useInlineRename'
import { ModalCloseButton } from './ModalCloseButton'
import { ACTION_BTN, CONFIRM_DELETE_BTN, DELETE_BTN, SectionHeader, formatDate } from './store-modal-shared'
import { ROW_CLASS } from './modal-controls'
import type { SnapshotMeta } from '../../../shared/types/snapshot-store'
import type { HubMyPost } from '../../../shared/types/hub'

export type FileStatus =
  | 'idle'
  | 'importing'
  | 'exporting'
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string }

export interface HubEntryResult {
  kind: 'success' | 'error'
  message: string
  entryId: string
}

interface Props extends LayoutStoreContentProps {
  onClose: () => void
}

const FORMAT_BTN = 'text-[11px] font-medium text-content-muted bg-surface/50 border border-edge px-2 py-0.5 rounded hover:text-content hover:border-content-muted disabled:opacity-50'
const IMPORT_BTN = 'rounded-lg border border-edge bg-surface/30 px-3 py-1.5 text-xs font-semibold text-content-muted hover:text-content hover:border-content-muted'
const EXPORT_BTN = 'rounded-lg border border-edge bg-surface/30 px-3 py-1.5 text-xs font-semibold text-content-muted hover:text-content hover:border-content-muted disabled:opacity-50'
const HUB_BTN = 'text-[11px] font-medium text-accent bg-accent/10 border border-accent/30 px-2 py-0.5 rounded hover:bg-accent/20 hover:border-accent/50 disabled:opacity-50'
const SHARE_LINK_BTN = 'text-[11px] font-medium text-accent bg-accent/10 border border-accent/30 px-2 py-0.5 rounded hover:bg-accent/20 hover:border-accent/50'

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

interface HubOrphanButtonsProps {
  entry: SnapshotMeta
  keyboardName: string
  hubMyPosts?: HubMyPost[]
  hubUploading?: string | null
  fileDisabled?: boolean
  onUploadToHub?: (entryId: string) => void
  onReuploadToHub?: (entryId: string, orphanedPostId: string) => void
  onDeleteOrphanedHubPost?: (entryId: string, orphanedPostId: string) => void
}

function HubOrphanButtons({
  entry,
  keyboardName,
  hubMyPosts,
  hubUploading,
  fileDisabled,
  onUploadToHub,
  onReuploadToHub,
  onDeleteOrphanedHubPost,
}: HubOrphanButtonsProps) {
  const { t } = useTranslation()
  const orphanPost = hubMyPosts?.find((p) => p.title === entry.label && p.keyboard_name === keyboardName)
  const disabled = !!hubUploading || fileDisabled

  if (orphanPost) {
    return (
      <>
        {onReuploadToHub && (
          <button
            type="button"
            className={HUB_BTN}
            onClick={() => onReuploadToHub(entry.id, orphanPost.id)}
            disabled={disabled}
            data-testid="layout-store-reupload-hub"
          >
            {hubUploading === entry.id ? t('hub.uploading') : t('hub.uploadQuestion')}
          </button>
        )}
        {onDeleteOrphanedHubPost && (
          <button
            type="button"
            className={HUB_BTN}
            onClick={() => onDeleteOrphanedHubPost(entry.id, orphanPost.id)}
            disabled={disabled}
            data-testid="layout-store-delete-orphan-hub"
          >
            {t('hub.deleteFromHub')}
          </button>
        )}
      </>
    )
  }

  if (!onUploadToHub) return null

  return (
    <button
      type="button"
      className={HUB_BTN}
      onClick={() => onUploadToHub(entry.id)}
      disabled={disabled}
      data-testid="layout-store-upload-hub"
    >
      {hubUploading === entry.id ? t('hub.uploading') : t('hub.uploadToHub')}
    </button>
  )
}

function ShareLink({ url }: { url: string }) {
  const { t } = useTranslation()

  function handleClick(e: React.MouseEvent): void {
    e.preventDefault()
    window.vialAPI.openExternal(url).catch(() => {})
  }

  return (
    <a
      href={url}
      onClick={handleClick}
      className={SHARE_LINK_BTN}
      data-testid="layout-store-hub-share-link"
    >
      {t('hub.openInBrowser')}
    </a>
  )
}

function fileStatusColorClass(status: FileStatus): string {
  if (status === 'importing' || status === 'exporting') return 'text-content-muted'
  if (typeof status === 'object' && status.kind === 'success') return 'text-accent'
  if (typeof status === 'object' && status.kind === 'error') return 'text-danger'
  return ''
}

function FileStatusDisplay({ fileStatus }: { fileStatus: Exclude<FileStatus, 'idle'> }) {
  const { t } = useTranslation()

  function statusText(): string | null {
    if (fileStatus === 'importing') return t('fileIO.importing')
    if (fileStatus === 'exporting') return t('fileIO.exporting')
    if (typeof fileStatus === 'object') return fileStatus.message
    return null
  }

  return (
    <div
      className={`pt-3 text-[13px] font-medium ${fileStatusColorClass(fileStatus)}`}
      data-testid="layout-store-file-status"
    >
      {statusText()}
    </div>
  )
}

export interface LayoutStoreContentProps {
  entries: SnapshotMeta[]
  loading?: boolean
  saving?: boolean
  fileStatus?: FileStatus
  isDummy?: boolean
  defaultSaveLabel?: string
  onSave: (label: string) => void
  onLoad: (entryId: string) => void
  onRename: (entryId: string, newLabel: string) => void
  onDelete: (entryId: string) => void
  onImportVil?: () => void
  onExportVil?: () => void
  onExportKeymapC?: () => void
  onExportPdf?: () => void
  onSideloadJson?: () => void
  onExportEntryVil?: (entryId: string) => void
  onExportEntryKeymapC?: (entryId: string) => void
  onExportEntryPdf?: (entryId: string) => void
  onOverwriteSave?: (overwriteEntryId: string, label: string) => void
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
  onReuploadToHub?: (entryId: string, orphanedPostId: string) => void
  onDeleteOrphanedHubPost?: (entryId: string, orphanedPostId: string) => void
  keyboardName: string
  hubOrigin?: string
  hubMyPosts?: HubMyPost[]
  hubKeyboardPosts?: HubMyPost[]
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: HubEntryResult | null
  fileDisabled?: boolean
  listClassName?: string
  footer?: React.ReactNode
}

export function LayoutStoreContent({
  entries,
  loading,
  saving,
  fileStatus,
  isDummy,
  defaultSaveLabel,
  onSave,
  onLoad,
  onRename,
  onDelete,
  onOverwriteSave,
  onImportVil,
  onExportVil,
  onExportKeymapC,
  onExportPdf,
  onSideloadJson,
  onExportEntryVil,
  onExportEntryKeymapC,
  onExportEntryPdf,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
  onReuploadToHub,
  onDeleteOrphanedHubPost,
  keyboardName,
  hubOrigin,
  hubMyPosts,
  hubKeyboardPosts,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  fileDisabled,
  listClassName,
  footer,
}: LayoutStoreContentProps) {
  const { t } = useTranslation()
  const [saveLabel, setSaveLabel] = useState(defaultSaveLabel ?? '')
  const rename = useInlineRename<string>()
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmHubRemoveId, setConfirmHubRemoveId] = useState<string | null>(null)
  const [confirmOverwriteId, setConfirmOverwriteId] = useState<string | null>(null)

  function handleSaveSubmit(e: React.FormEvent): void {
    e.preventDefault()
    const trimmed = saveLabel.trim()
    if (saving || !trimmed) return

    // First submit with a duplicate label: ask for confirmation
    const existing = entries.find((entry) => entry.label === trimmed)
    if (existing && !confirmOverwriteId) {
      setConfirmOverwriteId(existing.id)
      return
    }

    // Second submit (confirmed overwrite)
    if (confirmOverwriteId) {
      if (onOverwriteSave) {
        onOverwriteSave(confirmOverwriteId, trimmed)
        setConfirmOverwriteId(null)
        setSaveLabel('')
        return
      }
      onDelete(confirmOverwriteId)
      setConfirmOverwriteId(null)
    }

    onSave(trimmed)
    setSaveLabel('')
  }

  function handleRenameKeyDown(e: React.KeyboardEvent, entryId: string): void {
    const newLabel = rename.handleKeyDown(e, entryId)
    if (newLabel) onRename(entryId, newLabel)
  }

  function getEntryHubPostId(entry: SnapshotMeta): string | undefined {
    return entry.hubPostId || hubKeyboardPosts?.find((p) => p.title === entry.label)?.id
  }

  const hasImportSideload = onImportVil || onSideloadJson
  const hasEntryExport = onExportEntryVil || onExportEntryKeymapC || onExportEntryPdf
  const hasCurrentExport = onExportVil || onExportKeymapC || onExportPdf
  const hasHubActions = onUploadToHub || onUpdateOnHub || onRemoveFromHub || onReuploadToHub || onDeleteOrphanedHubPost || hubNeedsDisplayName
  const isPanel = !!listClassName
  const fixedSection = isPanel ? ' shrink-0' : ''
  const sectionGap = isPanel ? 'pt-3' : 'pt-5'
  const importGap = isPanel ? 'pt-3' : 'pt-4'

  return (
    <div className={isPanel ? 'flex flex-col h-full' : ''}>
      {/* File status */}
      {fileStatus && fileStatus !== 'idle' && (
        <FileStatusDisplay fileStatus={fileStatus} />
      )}

      {/* Save & Export section (unified card in panel mode) */}
      {isPanel ? (
        (!isDummy || hasCurrentExport) && (
          <div className={`${sectionGap}${fixedSection}`} data-testid="layout-store-current-section">
            <div className="rounded-lg border border-edge bg-surface/20 p-3">
              {!isDummy && (
                <form onSubmit={handleSaveSubmit} className="flex gap-2">
                  <input
                    type="text"
                    value={saveLabel}
                    onChange={(e) => { setSaveLabel(e.target.value); setConfirmOverwriteId(null) }}
                    placeholder={t('layoutStore.labelPlaceholder')}
                    maxLength={200}
                    className="flex-1 rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-content placeholder:text-content-muted focus:border-accent focus:outline-none"
                    data-testid="layout-store-save-input"
                  />
                  {confirmOverwriteId ? (
                    <>
                      <button
                        type="submit"
                        disabled={saving}
                        className="shrink-0 rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white hover:bg-danger/90 disabled:opacity-50"
                        data-testid="layout-store-overwrite-confirm"
                      >
                        {t('layoutStore.confirmOverwrite')}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmOverwriteId(null)}
                        className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-content-muted hover:text-content"
                        data-testid="layout-store-overwrite-cancel"
                      >
                        {t('common.cancel')}
                      </button>
                    </>
                  ) : (
                    <button
                      type="submit"
                      disabled={saving || !saveLabel.trim()}
                      className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
                      data-testid="layout-store-save-submit"
                    >
                      {t('common.save')}
                    </button>
                  )}
                </form>
              )}
              {hasCurrentExport && (
                <div className={`flex justify-end gap-1${!isDummy ? ' mt-2' : ''}`}>
                  <FormatButtons
                    className={FORMAT_BTN}
                    testIdPrefix="layout-store-current-export"
                    disabled={fileDisabled}
                    onVil={onExportVil}
                    onKeymapC={onExportKeymapC}
                    onPdf={onExportPdf}
                  />
                </div>
              )}
            </div>
          </div>
        )
      ) : (
        <>
          {/* Save section */}
          {!isDummy && (
            <div className={`${sectionGap}${fixedSection}`}>
              <form onSubmit={handleSaveSubmit} className="flex gap-2">
                <input
                  type="text"
                  value={saveLabel}
                  onChange={(e) => { setSaveLabel(e.target.value); setConfirmOverwriteId(null) }}
                  placeholder={t('layoutStore.labelPlaceholder')}
                  maxLength={200}
                  className="flex-1 rounded-lg border border-edge bg-surface px-3 py-1.5 text-xs text-content placeholder:text-content-muted focus:border-accent focus:outline-none"
                  data-testid="layout-store-save-input"
                />
                {confirmOverwriteId ? (
                  <>
                    <button
                      type="submit"
                      disabled={saving}
                      className="shrink-0 rounded-lg bg-danger px-3 py-1.5 text-xs font-semibold text-white hover:bg-danger/90 disabled:opacity-50"
                      data-testid="layout-store-overwrite-confirm"
                    >
                      {t('layoutStore.confirmOverwrite')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmOverwriteId(null)}
                      className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-xs font-medium text-content-muted hover:text-content"
                      data-testid="layout-store-overwrite-cancel"
                    >
                      {t('common.cancel')}
                    </button>
                  </>
                ) : (
                  <button
                    type="submit"
                    disabled={saving || !saveLabel.trim()}
                    className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
                    data-testid="layout-store-save-submit"
                  >
                    {t('common.save')}
                  </button>
                )}
              </form>
            </div>
          )}

          {/* Export Current State section */}
          {hasCurrentExport && (
            <div className={`${sectionGap}${fixedSection}`} data-testid="layout-store-current-section">
              <SectionHeader label={t('layoutStore.export')} />
              <div className="flex justify-end gap-2">
                <FormatButtons
                  className={EXPORT_BTN}
                  testIdPrefix="layout-store-current-export"
                  disabled={fileDisabled}
                  onVil={onExportVil}
                  onKeymapC={onExportKeymapC}
                  onPdf={onExportPdf}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* History section */}
      {!isDummy && (
        <div className={`${sectionGap}${isPanel ? ' flex-1 min-h-0 flex flex-col' : ''}`}>
          <SectionHeader label={t('layoutStore.history')} count={entries.length} />

          {loading && (
            <div className="py-4 text-center text-[13px] text-content-muted">{t('common.loading')}</div>
          )}

          {!loading && entries.length === 0 && (
            <div className="py-4 text-center text-[13px] text-content-muted" data-testid="layout-store-empty">
              {t('layoutStore.noSavedLayouts')}
            </div>
          )}

          {!loading && entries.length > 0 && (
            <div className={`flex flex-col gap-1.5${isPanel ? ` flex-1 ${listClassName}` : ''}`} data-testid="layout-store-list">
              {entries.map((entry) => {
                const entryHubPostId = getEntryHubPostId(entry)
                return (<div
                  key={entry.id}
                  className={`rounded-lg border border-edge bg-surface/20 p-3 hover:border-content-muted/30 ${rename.confirmedId === entry.id ? 'confirm-flash' : ''}`}
                  data-testid="layout-store-entry"
                  onMouseDown={(e) => rename.handleCardMouseDown(e, entry.id)}
                >
                  {/* Top row: label + action buttons */}
                  <div className="flex items-center justify-between mb-1">
                    <div className="min-w-0 flex-1">
                      {rename.editingId === entry.id ? (
                        <input
                          type="text"
                          value={rename.editLabel}
                          onChange={(e) => rename.setEditLabel(e.target.value)}
                          onBlur={rename.cancelRename}
                          onKeyDown={(e) => handleRenameKeyDown(e, entry.id)}
                          maxLength={200}
                          className="w-full border-b border-edge bg-transparent px-1 text-sm font-semibold text-content outline-none focus:border-accent"
                          data-testid="layout-store-rename-input"
                          autoFocus
                        />
                      ) : (
                        <div
                          className="truncate text-sm font-semibold text-content cursor-pointer"
                          data-testid="layout-store-entry-label"
                          onClick={() => rename.startRename(entry.id, entry.label)}
                        >
                          {entry.label || t('layoutStore.noLabel')}
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
                            {t('layoutStore.confirmDelete')}
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
                          <button
                            type="button"
                            className={ACTION_BTN}
                            onClick={() => onLoad(entry.id)}
                            data-testid="layout-store-load-btn"
                          >
                            {t('layoutStore.load')}
                          </button>
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
                      {formatDate(entry.savedAt)}
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
                    <div className="mt-1.5 border-t border-edge pt-1.5" data-testid="layout-store-hub-row">
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] font-medium text-accent">{t('hub.pipetteHub')}</span>
                        <div className="flex gap-1">
                          {entryHubPostId && hubOrigin && (
                            <ShareLink url={`${hubOrigin}/post/${encodeURIComponent(entryHubPostId)}`} />
                          )}
                          {entryHubPostId && confirmHubRemoveId === entry.id && (
                            <>
                              <button
                                type="button"
                                className={CONFIRM_DELETE_BTN}
                                onClick={() => { onRemoveFromHub?.(entry.id); setConfirmHubRemoveId(null) }}
                                data-testid="layout-store-hub-remove-confirm"
                              >
                                {t('hub.confirmRemove')}
                              </button>
                              <button
                                type="button"
                                className={ACTION_BTN}
                                onClick={() => setConfirmHubRemoveId(null)}
                                data-testid="layout-store-hub-remove-cancel"
                              >
                                {t('common.cancel')}
                              </button>
                            </>
                          )}
                          {entryHubPostId && confirmHubRemoveId !== entry.id && (
                            <>
                              {onUpdateOnHub && (
                                <button
                                  type="button"
                                  className={HUB_BTN}
                                  onClick={() => onUpdateOnHub(entry.id)}
                                  disabled={!!hubUploading || fileDisabled}
                                  data-testid="layout-store-update-hub"
                                >
                                  {hubUploading === entry.id ? t('hub.updating') : t('hub.updateOnHub')}
                                </button>
                              )}
                              {onRemoveFromHub && (
                                <button
                                  type="button"
                                  className={HUB_BTN}
                                  onClick={() => setConfirmHubRemoveId(entry.id)}
                                  disabled={!!hubUploading || fileDisabled}
                                  data-testid="layout-store-remove-hub"
                                >
                                  {t('hub.removeFromHub')}
                                </button>
                              )}
                            </>
                          )}
                          {!entryHubPostId && (
                            <HubOrphanButtons
                              entry={entry}
                              keyboardName={keyboardName}
                              hubMyPosts={hubMyPosts}
                              hubUploading={hubUploading}
                              fileDisabled={fileDisabled}
                              onUploadToHub={onUploadToHub}
                              onReuploadToHub={onReuploadToHub}
                              onDeleteOrphanedHubPost={onDeleteOrphanedHubPost}
                            />
                          )}
                        </div>
                      </div>
                      {hubNeedsDisplayName && (entryHubPostId ? !onUpdateOnHub : !onUploadToHub) && (
                        <div
                          className="mt-1 text-[11px] text-content-muted"
                          data-testid="layout-store-hub-needs-display-name"
                        >
                          {t('hub.needsDisplayName')}
                        </div>
                      )}
                      {hubUploadResult && hubUploadResult.entryId === entry.id && (
                        <div
                          className={`mt-1 flex items-center text-[11px] font-medium ${hubUploadResult.kind === 'success' ? 'text-accent' : 'text-danger'}`}
                          data-testid="layout-store-hub-result"
                        >
                          {hubUploadResult.message}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* Import section */}
      {hasImportSideload && (
        <div className={`${importGap}${fixedSection}`} data-testid="layout-store-import-section">
          {isPanel ? (
            <div className={ROW_CLASS}>
              <span className="text-[13px] font-medium text-content">{t('layoutStore.import')}</span>
              <div className="flex gap-2">
                {onImportVil && (
                  <button
                    type="button"
                    className={IMPORT_BTN}
                    onClick={onImportVil}
                    disabled={fileDisabled}
                    data-testid="layout-store-import-vil"
                  >
                    {t('fileIO.loadLayout')}
                  </button>
                )}
                {onSideloadJson && (
                  <button
                    type="button"
                    className={IMPORT_BTN}
                    onClick={onSideloadJson}
                    disabled={fileDisabled}
                    data-testid="layout-store-sideload-json"
                  >
                    {t('fileIO.sideloadJson')}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <SectionHeader label={t('layoutStore.import')} />
              <div className="flex gap-2">
                {onImportVil && (
                  <button
                    type="button"
                    className={IMPORT_BTN}
                    onClick={onImportVil}
                    disabled={fileDisabled}
                    data-testid="layout-store-import-vil"
                  >
                    {t('fileIO.loadLayout')}
                  </button>
                )}
                {onSideloadJson && (
                  <button
                    type="button"
                    className={IMPORT_BTN}
                    onClick={onSideloadJson}
                    disabled={fileDisabled}
                    data-testid="layout-store-sideload-json"
                  >
                    {t('fileIO.sideloadJson')}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {!isDummy && footer}
    </div>
  )
}

export function LayoutStoreModal({ onClose, ...contentProps }: Props) {
  const { t } = useTranslation()

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="layout-store-modal-backdrop"
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[90vw] max-h-[85vh] flex flex-col rounded-2xl bg-surface-alt border border-edge shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-edge shrink-0">
          <h2 className="text-lg font-bold text-content">{t('layoutStore.title')}</h2>
          <ModalCloseButton testid="layout-store-modal-close" onClick={onClose} />
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 pb-5">
          <LayoutStoreContent {...contentProps} />
        </div>
      </div>
    </div>
  )
}
