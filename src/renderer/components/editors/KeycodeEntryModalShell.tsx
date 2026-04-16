// SPDX-License-Identifier: GPL-2.0-or-later

import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import type { KeycodeEntryModalReturn, KeycodeEntryModalAdapter, KeycodeFieldDescriptor } from '../../hooks/useKeycodeEntryModal'
import type { FavHubEntryResult } from './FavoriteHubActions'
import { ConfirmButton } from './ConfirmButton'
import { KeycodeField } from './KeycodeField'
import { ModalCloseButton } from './ModalCloseButton'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import { FavoriteStoreContent } from './FavoriteStoreContent'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'

// ---------------------------------------------------------------------------
// Hub props (forwarded to FavoriteStoreContent)
// ---------------------------------------------------------------------------

export interface HubIntegrationProps {
  hubOrigin?: string
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: FavHubEntryResult | null
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
  onRenameOnHub?: (entryId: string, hubPostId: string, newLabel: string) => void
}

/** Extract HubIntegrationProps from component props to avoid repetitive construction. */
export function pickHubProps(props: HubIntegrationProps): HubIntegrationProps {
  return {
    hubOrigin: props.hubOrigin,
    hubNeedsDisplayName: props.hubNeedsDisplayName,
    hubUploading: props.hubUploading,
    hubUploadResult: props.hubUploadResult,
    onUploadToHub: props.onUploadToHub,
    onUpdateOnHub: props.onUpdateOnHub,
    onRemoveFromHub: props.onRemoveFromHub,
    onRenameOnHub: props.onRenameOnHub,
  }
}

// ---------------------------------------------------------------------------
// Shell props
// ---------------------------------------------------------------------------

export interface KeycodeEntryModalShellProps<TEntry extends Record<string, unknown>> {
  adapter: KeycodeEntryModalAdapter<TEntry>
  hook: KeycodeEntryModalReturn<TEntry>
  index: number

  /** Slot rendered before keycode fields (e.g. enabled checkbox) */
  renderBeforeFields?: () => ReactNode
  /** Slot rendered after keycode fields (e.g. layer/mod pickers, tappingTerm, options) */
  renderAfterFields?: () => ReactNode
  // TabbedKeycodes props
  splitKeyMode?: SplitKeyMode
  basicViewType?: BasicViewType
  quickSelect?: boolean

  // Hub
  hubProps?: HubIntegrationProps
}

// ---------------------------------------------------------------------------
// Shell component
// ---------------------------------------------------------------------------

export function KeycodeEntryModalShell<TEntry extends Record<string, unknown>>({
  adapter,
  hook,
  index,
  renderBeforeFields,
  renderAfterFields,
  splitKeyMode,
  basicViewType,
  quickSelect,
  hubProps,
}: KeycodeEntryModalShellProps<TEntry>) {
  const { t } = useTranslation()
  const prefix = adapter.testIdPrefix
  const headerTitle = t(adapter.titleKey, adapter.titleParams(index))

  const {
    editedEntry,
    selectedField,
    popoverState,
    hasChanges,
    handleClose,
    handleEntrySave,
    handleFieldSelect,
    handleFieldMaskPartClick,
    handleFieldDoubleClick,
    handlePickerClose,
    closePopover,
    confirmPopover,
    handlePopoverKeycodeSelect,
    handlePopoverRawKeycodeSelect,
    clearAction,
    revertAction,
    maskedSelection,
    tabContentOverride,
    favStore,
    preEditValueRef,
    showFavorites,
    modalWidth,
  } = hook

  useEscapeClose(handleClose)

  const isConfigured = editedEntry !== null && adapter.isConfigured(editedEntry)

  function renderKeycodeField(fd: KeycodeFieldDescriptor<TEntry>) {
    if (!editedEntry) return null
    const { key, labelKey, labelOpts } = fd
    if (selectedField && selectedField !== key) return null
    const value = editedEntry[key] as number
    return (
      <div key={key} className="flex items-center gap-3">
        <label className="min-w-[140px] text-sm text-content">{t(labelKey, labelOpts)}</label>
        <KeycodeField
          value={value}
          selected={selectedField === key}
          selectedMaskPart={selectedField === key && maskedSelection.editingPart === 'inner'}
          onSelect={() => handleFieldSelect(key)}
          onMaskPartClick={(part) => handleFieldMaskPartClick(key, part)}
          onDoubleClick={selectedField ? (rect) => handleFieldDoubleClick(key, rect) : undefined}
          label={t(labelKey, labelOpts)}
        />
        {selectedField === key && !popoverState && !quickSelect && value !== preEditValueRef.current && (
          <span className="text-xs text-content-muted">{t('editor.keymap.pickerDoubleClickHint')}</span>
        )}
      </div>
    )
  }

  function renderPicker() {
    if (!selectedField) return null
    return (
      <div className="mt-3">
        <TabbedKeycodes
          onKeycodeSelect={maskedSelection.pickerSelect}
          onKeycodeDoubleClick={maskedSelection.pickerDoubleClick}
          onConfirm={maskedSelection.confirm}
          maskOnly={maskedSelection.maskOnly}
          lmMode={maskedSelection.lmMode}
          tabContentOverride={tabContentOverride}
          splitKeyMode={splitKeyMode}
          basicViewType={basicViewType}
          onClose={handlePickerClose}
        />
      </div>
    )
  }

  function renderPopover() {
    if (!popoverState || !editedEntry) return null
    return (
      <KeyPopover
        anchorRect={popoverState.anchorRect}
        currentKeycode={editedEntry[popoverState.field] as number}
        onKeycodeSelect={handlePopoverKeycodeSelect}
        onRawKeycodeSelect={handlePopoverRawKeycodeSelect}
        onClose={closePopover}
        onConfirm={confirmPopover}
        quickSelect={quickSelect}
      />
    )
  }

  function renderFooterButtons() {
    if (selectedField || !editedEntry) return null
    return (
      <div className="flex justify-end gap-2 pt-4">
        <ConfirmButton
          testId={`${prefix}-modal-clear`}
          confirming={clearAction.confirming}
          onClick={() => { revertAction.reset(); clearAction.trigger() }}
          labelKey="common.clear"
          confirmLabelKey="common.confirmClear"
        />
        <ConfirmButton
          testId={`${prefix}-modal-revert`}
          confirming={revertAction.confirming}
          onClick={() => { clearAction.reset(); revertAction.trigger() }}
          labelKey="common.revert"
          confirmLabelKey="common.confirmRevert"
        />
        <button
          type="button"
          data-testid={`${prefix}-modal-save`}
          className="rounded bg-accent px-4 py-2 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
          disabled={!hasChanges}
          onClick={handleEntrySave}
        >
          {t('common.save')}
        </button>
      </div>
    )
  }

  function renderFavoritesPanel() {
    if (!showFavorites) return null
    return (
      <div
        className={`w-[456px] shrink-0 flex flex-col ${selectedField ? 'hidden' : ''}`}
        data-testid={`${prefix}-favorites-panel`}
      >
        <FavoriteStoreContent
          entries={favStore.entries}
          loading={favStore.loading}
          saving={favStore.saving}
          canSave={isConfigured}
          onSave={favStore.saveFavorite}
          onLoad={favStore.loadFavorite}
          onRename={favStore.renameEntry}
          onDelete={favStore.deleteEntry}
          onExport={favStore.exportFavorites}
          onExportEntry={favStore.exportEntry}
          onImport={favStore.importFavorites}
          onExportCurrent={favStore.exportCurrent}
          onImportCurrent={favStore.importCurrent}
          exporting={favStore.exporting}
          importing={favStore.importing}
          importResult={favStore.importResult}
          hubOrigin={hubProps?.hubOrigin}
          hubNeedsDisplayName={hubProps?.hubNeedsDisplayName}
          hubUploading={hubProps?.hubUploading}
          hubUploadResult={hubProps?.hubUploadResult}
          onUploadToHub={hubProps?.onUploadToHub}
          onUpdateOnHub={hubProps?.onUpdateOnHub}
          onRemoveFromHub={hubProps?.onRemoveFromHub}
          onRenameOnHub={hubProps?.onRenameOnHub}
          onRefreshEntries={favStore.refreshEntries}
        />
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid={`${prefix}-modal-backdrop`}
      onClick={handleClose}
    >
      <div
        className={`overflow-hidden rounded-lg bg-surface-alt shadow-xl ${modalWidth} max-w-[95vw] h-[80vh] flex flex-col`}
        data-testid={`${prefix}-modal`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {!selectedField && (
          <div className="flex items-center justify-between shrink-0 px-6 pt-6 pb-4">
            <h3 className="text-lg font-semibold">{headerTitle}</h3>
            <ModalCloseButton testid={`${prefix}-modal-close`} onClick={handleClose} />
          </div>
        )}

        {/* Body */}
        <div className="flex min-h-0 flex-1 overflow-hidden" data-testid={adapter.bodyTestId ?? `editor-${prefix}`}>
          {/* Left panel */}
          <div className="flex-1 flex flex-col min-h-0">
            <div className={`flex-1 overflow-y-auto px-6 pb-6 ${selectedField ? 'pt-6' : ''}`}>
              {editedEntry && (
                <>
                  <div className="space-y-2">
                    {/* Before-fields slot (e.g. enabled checkbox) */}
                    {!selectedField && renderBeforeFields?.()}

                    {/* Keycode fields */}
                    {adapter.keycodeFields.map((fd) => renderKeycodeField(fd))}

                    {/* After-fields slot (e.g. layer/mod pickers, tappingTerm) */}
                    {!selectedField && renderAfterFields?.()}
                  </div>

                  {renderPicker()}
                  {renderPopover()}

                  {renderFooterButtons()}
                </>
              )}
            </div>
          </div>

          {/* Right panel: favorites */}
          {renderFavoritesPanel()}
        </div>
      </div>
    </div>
  )
}
