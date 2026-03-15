// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { ComboEntry, TapDanceEntry } from '../../../shared/types/protocol'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { deserialize } from '../../../shared/keycodes/keycodes'
import type { MacroAction } from '../../../preload/macro'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { useMaskedKeycodeSelection } from '../../hooks/useMaskedKeycodeSelection'
import { useFavoriteStore } from '../../hooks/useFavoriteStore'
import { useTileContentOverride } from '../../hooks/useTileContentOverride'
import { ConfirmButton } from './ConfirmButton'
import { KeycodeField } from './KeycodeField'
import { ModalCloseButton } from './ModalCloseButton'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import { FavoriteStoreContent } from './FavoriteStoreContent'
import type { FavHubEntryResult } from './FavoriteHubActions'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'

interface Props {
  entries: ComboEntry[]
  onSetEntry: (index: number, entry: ComboEntry) => Promise<void>
  unlocked?: boolean
  onUnlock?: () => void
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
  initialIndex: number
  onClose: () => void
  // Hub integration (optional)
  hubOrigin?: string
  hubNeedsDisplayName?: boolean
  hubUploading?: string | null
  hubUploadResult?: FavHubEntryResult | null
  onUploadToHub?: (entryId: string) => void
  onUpdateOnHub?: (entryId: string) => void
  onRemoveFromHub?: (entryId: string) => void
  onRenameOnHub?: (entryId: string, hubPostId: string, newLabel: string) => void
  quickSelect?: boolean
  splitKeyMode?: SplitKeyMode
  basicViewType?: BasicViewType
}

type KeycodeFieldName = 'key1' | 'key2' | 'key3' | 'key4' | 'output'

interface FieldDescriptor {
  key: KeycodeFieldName
  labelKey: string
  labelOpts?: Record<string, unknown>
}

const keycodeFields: FieldDescriptor[] = [
  { key: 'key1', labelKey: 'editor.combo.key', labelOpts: { number: 1 } },
  { key: 'key2', labelKey: 'editor.combo.key', labelOpts: { number: 2 } },
  { key: 'key3', labelKey: 'editor.combo.key', labelOpts: { number: 3 } },
  { key: 'key4', labelKey: 'editor.combo.key', labelOpts: { number: 4 } },
  { key: 'output', labelKey: 'editor.combo.output' },
]


function isConfigured(entry: ComboEntry): boolean {
  return entry.key1 !== 0 || entry.key2 !== 0
}


export function ComboPanelModal({
  entries,
  onSetEntry,
  unlocked,
  onUnlock,
  tapDanceEntries,
  deserializedMacros,
  initialIndex,
  onClose,
  hubOrigin,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
  onRenameOnHub,
  quickSelect,
  splitKeyMode,
  basicViewType,
}: Props) {
  const { t } = useTranslation()
  const { guard, clearPending } = useUnlockGate({ unlocked, onUnlock })
  const selectedIndex = initialIndex
  const [editedEntry, setEditedEntry] = useState<ComboEntry | null>(null)
  const [selectedField, setSelectedField] = useState<KeycodeFieldName | null>(null)
  const [popoverState, setPopoverState] = useState<{ field: KeycodeFieldName; anchorRect: DOMRect } | null>(null)
  const preEditValueRef = useRef<number>(0)

  const favStore = useFavoriteStore({
    favoriteType: 'combo',
    serialize: () => editedEntry,
    apply: (data) => setEditedEntry(data as ComboEntry),
  })

  const clearAction = useConfirmAction(useCallback(() => {
    setEditedEntry((prev) => prev ? { key1: 0, key2: 0, key3: 0, key4: 0, output: 0 } : prev)
    setSelectedField(null)
    setPopoverState(null)
  }, []))

  const revertAction = useConfirmAction(useCallback(() => {
    if (!entries[selectedIndex]) return
    clearPending()
    setEditedEntry(entries[selectedIndex])
    setSelectedField(null)
    setPopoverState(null)
  }, [selectedIndex, entries, clearPending]))

  // Sync edited entry when selection changes
  useEffect(() => {
    setSelectedField(null)
    setPopoverState(null)
    clearAction.reset()
    revertAction.reset()
    if (entries[selectedIndex]) {
      setEditedEntry(entries[selectedIndex])
    } else {
      setEditedEntry(null)
    }
  }, [selectedIndex, entries])

  useEffect(() => {
    favStore.refreshEntries()
  }, [favStore.refreshEntries])

  const handleClose = useCallback(() => {
    clearPending()
    onClose()
  }, [clearPending, onClose])


  const handleEntrySave = useCallback(async () => {
    if (!editedEntry) return
    const codes = [editedEntry.key1, editedEntry.key2, editedEntry.key3, editedEntry.key4, editedEntry.output]
    await guard(codes, async () => {
      await onSetEntry(selectedIndex, editedEntry)
      handleClose()
    })
  }, [selectedIndex, editedEntry, onSetEntry, guard, handleClose])

  const updateField = useCallback((field: KeycodeFieldName, code: number) => {
    setEditedEntry((prev) => prev ? { ...prev, [field]: code } : prev)
  }, [])

  const maskedSelection = useMaskedKeycodeSelection({
    onUpdate(code: number) {
      if (!selectedField) return false
      setEditedEntry((prev) => prev ? { ...prev, [selectedField]: code } : prev)
    },
    onCommit() {
      setPopoverState(null)
      setSelectedField(null)
    },
    resetKey: selectedField,
    initialValue: selectedField && editedEntry ? editedEntry[selectedField] : undefined,
    quickSelect,
  })

  const tabContentOverride = useTileContentOverride(tapDanceEntries, deserializedMacros, maskedSelection.handleKeycodeSelect)

  const handleFieldDoubleClick = useCallback(
    (field: KeycodeFieldName, rect: DOMRect) => {
      if (!selectedField) return
      setPopoverState({ field, anchorRect: rect })
    },
    [selectedField],
  )

  const confirmPopover = useCallback(() => {
    setPopoverState(null)
    setSelectedField(null)
  }, [])

  const popoverField = popoverState?.field ?? null

  const handlePopoverKeycodeSelect = useCallback(
    (kc: Keycode) => {
      if (!popoverField) return
      updateField(popoverField, deserialize(kc.qmkId))
    },
    [popoverField, updateField],
  )

  const handlePopoverRawKeycodeSelect = useCallback(
    (code: number) => {
      if (!popoverField) return
      updateField(popoverField, code)
    },
    [popoverField, updateField],
  )

  const hasChanges =
    editedEntry !== null &&
    JSON.stringify(entries[selectedIndex]) !== JSON.stringify(editedEntry)

  const headerTitle = t('editor.combo.editTitle', { index: selectedIndex })

  function renderBody(): React.ReactNode {
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="editor-combo">
        {/* Left panel: detail editor */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className={`flex-1 overflow-y-auto px-6 pb-6 ${selectedField ? 'pt-6' : ''}`}>
            {editedEntry && (
              <>
                <div className="space-y-2">
                  {keycodeFields.map(({ key, labelKey, labelOpts }) => {
                    if (selectedField && selectedField !== key) return null
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <label className="min-w-[140px] text-sm text-content">{t(labelKey, labelOpts)}</label>
                        <KeycodeField
                          value={editedEntry[key]}
                          selected={selectedField === key}
                          selectedMaskPart={selectedField === key && maskedSelection.editingPart === 'inner'}
                          onSelect={() => { if (!selectedField) { preEditValueRef.current = editedEntry[key]; setSelectedField(key) } }}
                          onMaskPartClick={(part) => {
                            if (selectedField === key) {
                              maskedSelection.setEditingPart(part)
                            } else if (!selectedField) {
                              preEditValueRef.current = editedEntry[key]
                              maskedSelection.enterMaskMode(editedEntry[key], part)
                              setSelectedField(key)
                            }
                          }}
                          onDoubleClick={selectedField ? (rect) => handleFieldDoubleClick(key, rect) : undefined}
                          label={t(labelKey, labelOpts)}
                        />
                        {selectedField === key && !popoverState && !quickSelect && editedEntry[key] !== preEditValueRef.current && (
                          <span className="text-xs text-content-muted">{t('editor.keymap.pickerDoubleClickHint')}</span>
                        )}
                      </div>
                    )
                  })}
                </div>

                {selectedField && (
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
                      onClose={() => {
                        if (selectedField) {
                          setEditedEntry((prev) => prev ? { ...prev, [selectedField]: preEditValueRef.current } : prev)
                        }
                        maskedSelection.clearMask()
                        setSelectedField(null)
                      }}
                    />
                  </div>
                )}

                {popoverState && (
                  <KeyPopover
                    anchorRect={popoverState.anchorRect}
                    currentKeycode={editedEntry[popoverState.field]}
                    onKeycodeSelect={handlePopoverKeycodeSelect}
                    onRawKeycodeSelect={handlePopoverRawKeycodeSelect}
                    onClose={() => setPopoverState(null)}
                    onConfirm={confirmPopover}
                    quickSelect={quickSelect}
                  />
                )}

                {!selectedField && (
                  <div className="flex justify-end gap-2 pt-4">
                    <ConfirmButton
                      testId="combo-modal-clear"
                      confirming={clearAction.confirming}
                      onClick={() => { revertAction.reset(); clearAction.trigger() }}
                      labelKey="common.clear"
                      confirmLabelKey="common.confirmClear"
                    />
                    <ConfirmButton
                      testId="combo-modal-revert"
                      confirming={revertAction.confirming}
                      onClick={() => { clearAction.reset(); revertAction.trigger() }}
                      labelKey="common.revert"
                      confirmLabelKey="common.confirmRevert"
                    />
                    <button
                      type="button"
                      data-testid="combo-modal-save"
                      className="rounded bg-accent px-4 py-2 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
                      disabled={!hasChanges}
                      onClick={handleEntrySave}
                    >
                      {t('common.save')}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

        </div>

        {/* Right panel: favorites (hidden when picker is open) */}
        <div
          className={`w-[456px] shrink-0 flex flex-col ${selectedField ? 'hidden' : ''}`}
          data-testid="combo-favorites-panel"
        >
          <FavoriteStoreContent
            entries={favStore.entries}
            loading={favStore.loading}
            saving={favStore.saving}
            canSave={editedEntry !== null && isConfigured(editedEntry)}
            onSave={favStore.saveFavorite}
            onLoad={favStore.loadFavorite}
            onRename={favStore.renameEntry}
            onDelete={favStore.deleteEntry}
            onExport={favStore.exportFavorites}
            onExportEntry={favStore.exportEntry}
            onImport={favStore.importFavorites}
            exporting={favStore.exporting}
            importing={favStore.importing}
            importResult={favStore.importResult}
            hubOrigin={hubOrigin}
            hubNeedsDisplayName={hubNeedsDisplayName}
            hubUploading={hubUploading}
            hubUploadResult={hubUploadResult}
            onUploadToHub={onUploadToHub}
            onUpdateOnHub={onUpdateOnHub}
            onRemoveFromHub={onRemoveFromHub}
            onRenameOnHub={onRenameOnHub}
            onRefreshEntries={favStore.refreshEntries}
          />
        </div>
      </div>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="combo-modal-backdrop"
      onClick={handleClose}
    >
      <div
        className="overflow-hidden rounded-lg bg-surface-alt shadow-xl w-[1050px] max-w-[95vw] h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {!selectedField && (
          <div className="flex items-center justify-between shrink-0 px-6 pt-6 pb-4">
            <h3 className="text-lg font-semibold">{headerTitle}</h3>
            <ModalCloseButton testid="combo-modal-close" onClick={handleClose} />
          </div>
        )}

        {renderBody()}
      </div>
    </div>
  )
}
