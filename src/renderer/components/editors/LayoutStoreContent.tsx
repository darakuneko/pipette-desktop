// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useInlineRename } from '../../hooks/useInlineRename'
import { SectionHeader } from './store-modal-shared'
import { ROW_CLASS } from './modal-controls'
import { FORMAT_BTN, EXPORT_BTN, IMPORT_BTN } from './layout-store-types'
import type { FileStatus, LayoutStoreContentProps } from './layout-store-types'
import { FormatButtons } from './LayoutStoreEntry'
import { LayoutStoreEntry } from './LayoutStoreEntry'

// Re-export types and interfaces for backward compatibility
export type { FileStatus, HubEntryResult, LayoutStoreContentProps } from './layout-store-types'

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
  // Sync save label when a layout is loaded (defaultSaveLabel changes)
  useEffect(() => { setSaveLabel(defaultSaveLabel ?? '') }, [defaultSaveLabel])
  const [showSaved, setShowSaved] = useState(false)
  const [showExported, setShowExported] = useState(false)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const exportedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const rename = useInlineRename<string>()
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [confirmHubRemoveId, setConfirmHubRemoveId] = useState<string | null>(null)
  const [confirmOverwriteId, setConfirmOverwriteId] = useState<string | null>(null)

  function flashSaved(): void {
    setShowSaved(true)
    clearTimeout(savedTimerRef.current)
    savedTimerRef.current = setTimeout(() => setShowSaved(false), 2000)
  }

  function flashExported(): void {
    setShowExported(true)
    clearTimeout(exportedTimerRef.current)
    exportedTimerRef.current = setTimeout(() => setShowExported(false), 2000)
  }

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
        flashSaved()
        return
      }
      onDelete(confirmOverwriteId)
      setConfirmOverwriteId(null)
    }

    onSave(trimmed)
    flashSaved()
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

  function getEntryHubPostId(entry: { hubPostId?: string; label: string }): string | undefined {
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
                    placeholder={t('common.labelPlaceholder')}
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
              {(hasCurrentExport || showSaved || showExported) && (
                <div className={`flex items-center gap-1${!isDummy ? ' mt-2' : ''}`}>
                  {showSaved && (
                    <span className="text-[11px] font-medium text-emerald-500" data-testid="layout-store-saved">{t('common.saved')}</span>
                  )}
                  {showExported && (
                    <span className="text-[11px] font-medium text-emerald-500" data-testid="layout-store-exported">{t('common.exported')}</span>
                  )}
                  <div className="ml-auto flex gap-1">
                    <FormatButtons
                      className={FORMAT_BTN}
                      testIdPrefix="layout-store-current-export"
                      disabled={fileDisabled}
                      onVil={onExportVil ? async () => { if (await onExportVil()) flashExported() } : undefined}
                      onKeymapC={onExportKeymapC ? async () => { if (await onExportKeymapC()) flashExported() } : undefined}
                      onPdf={onExportPdf ? async () => { if (await onExportPdf()) flashExported() } : undefined}
                    />
                  </div>
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
                  placeholder={t('common.labelPlaceholder')}
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
          {(hasCurrentExport || showSaved || showExported) && (
            <div className={`${sectionGap}${fixedSection}`} data-testid="layout-store-current-section">
              <SectionHeader label={t('layoutStore.export')} />
              <div className="flex items-center gap-2">
                {showSaved && (
                  <span className="text-xs font-medium text-emerald-500" data-testid="layout-store-saved">{t('common.saved')}</span>
                )}
                {showExported && (
                  <span className="text-xs font-medium text-emerald-500" data-testid="layout-store-exported">{t('common.exported')}</span>
                )}
                <div className="ml-auto flex gap-2">
                  <FormatButtons
                    className={EXPORT_BTN}
                    testIdPrefix="layout-store-current-export"
                    disabled={fileDisabled}
                    onVil={onExportVil ? async () => { if (await onExportVil()) flashExported() } : undefined}
                    onKeymapC={onExportKeymapC ? async () => { if (await onExportKeymapC()) flashExported() } : undefined}
                    onPdf={onExportPdf ? async () => { if (await onExportPdf()) flashExported() } : undefined}
                  />
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* History section */}
      {!isDummy && (
        <div className={`${sectionGap}${isPanel ? ' flex-1 min-h-0 flex flex-col' : ''}`}>
          <SectionHeader label={t('common.synced')} count={entries.length} />

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
                return (
                  <LayoutStoreEntry
                    key={entry.id}
                    entry={entry}
                    entryHubPostId={entryHubPostId}
                    rename={rename}
                    confirmDeleteId={confirmDeleteId}
                    setConfirmDeleteId={setConfirmDeleteId}
                    onCommitRename={commitRename}
                    onHandleRenameKeyDown={handleRenameKeyDown}
                    onLoad={onLoad}
                    onDelete={onDelete}
                    hasEntryExport={!!hasEntryExport}
                    hasHubActions={!!hasHubActions}
                    fileDisabled={fileDisabled}
                    onExportEntryVil={onExportEntryVil}
                    onExportEntryKeymapC={onExportEntryKeymapC}
                    onExportEntryPdf={onExportEntryPdf}
                    keyboardName={keyboardName}
                    hubOrigin={hubOrigin}
                    hubMyPosts={hubMyPosts}
                    hubNeedsDisplayName={hubNeedsDisplayName}
                    hubUploading={hubUploading}
                    hubUploadResult={hubUploadResult}
                    confirmHubRemoveId={confirmHubRemoveId}
                    setConfirmHubRemoveId={setConfirmHubRemoveId}
                    onUploadToHub={onUploadToHub}
                    onUpdateOnHub={onUpdateOnHub}
                    onRemoveFromHub={onRemoveFromHub}
                    onReuploadToHub={onReuploadToHub}
                    onDeleteOrphanedHubPost={onDeleteOrphanedHubPost}
                  />
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
