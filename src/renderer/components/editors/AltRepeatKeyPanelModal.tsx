// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { AltRepeatKeyEntry, TapDanceEntry } from '../../../shared/types/protocol'
import { AltRepeatKeyOptions } from '../../../shared/types/protocol'
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
import { ModifierPicker } from './ModifierPicker'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import { FavoriteStoreContent } from './FavoriteStoreContent'
import type { FavHubEntryResult } from './FavoriteHubActions'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'

interface Props {
  entries: AltRepeatKeyEntry[]
  onSetEntry: (index: number, entry: AltRepeatKeyEntry) => Promise<void>
  initialIndex: number
  unlocked?: boolean
  onUnlock?: () => void
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
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

type KeycodeFieldName = 'lastKey' | 'altKey'

const keycodeFields: { key: KeycodeFieldName; labelKey: string }[] = [
  { key: 'lastKey', labelKey: 'editor.altRepeatKey.lastKey' },
  { key: 'altKey', labelKey: 'editor.altRepeatKey.altKey' },
]

// Pre-compute option entries from the numeric enum (filter out reverse mappings)
const optionEntries = Object.entries(AltRepeatKeyOptions).filter(
  (pair): pair is [string, number] => typeof pair[1] === 'number',
)


function isConfigured(entry: AltRepeatKeyEntry): boolean {
  return entry.lastKey !== 0
}

export function AltRepeatKeyPanelModal({
  entries,
  onSetEntry,
  initialIndex,
  unlocked,
  onUnlock,
  tapDanceEntries,
  deserializedMacros,
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
  const [editedEntry, setEditedEntry] = useState<AltRepeatKeyEntry | null>(null)
  const [selectedField, setSelectedField] = useState<KeycodeFieldName | null>(null)
  const [popoverState, setPopoverState] = useState<{ field: KeycodeFieldName; anchorRect: DOMRect } | null>(null)
  const preEditValueRef = useRef<number>(0)

  const favStore = useFavoriteStore({
    favoriteType: 'altRepeatKey',
    serialize: () => editedEntry,
    apply: (data) => setEditedEntry(data as AltRepeatKeyEntry),
  })

  const clearAction = useConfirmAction(useCallback(() => {
    setEditedEntry((prev) => prev ? {
      lastKey: 0, altKey: 0, allowedMods: 0, options: 0, enabled: false,
    } : prev)
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
    const codes = [editedEntry.lastKey, editedEntry.altKey]
    await guard(codes, async () => {
      await onSetEntry(selectedIndex, editedEntry)
      handleClose()
    })
  }, [selectedIndex, editedEntry, onSetEntry, guard, handleClose])

  const updateEntry = useCallback((field: KeycodeFieldName, code: number) => {
    setEditedEntry((prev) => {
      if (!prev) return prev
      const next = { ...prev, [field]: code }
      if (!isConfigured(next)) next.enabled = false
      return next
    })
  }, [])

  const updateField = useCallback((field: KeycodeFieldName, code: number) => {
    updateEntry(field, code)
  }, [updateEntry])

  const maskedSelection = useMaskedKeycodeSelection({
    onUpdate(code: number) {
      if (!selectedField) return false
      updateEntry(selectedField, code)
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

  const handleToggleEnabled = useCallback(() => {
    setEditedEntry((prev) => prev ? { ...prev, enabled: !prev.enabled } : prev)
  }, [])

  const handleToggleOption = useCallback((flag: number) => {
    setEditedEntry((prev) => prev ? { ...prev, options: prev.options ^ flag } : prev)
  }, [])

  const canEnable = editedEntry !== null && isConfigured(editedEntry)

  const hasChanges =
    editedEntry !== null &&
    JSON.stringify(entries[selectedIndex]) !== JSON.stringify(editedEntry)

  const headerTitle = t('editor.altRepeatKey.editTitle', { index: selectedIndex })

  function renderBody(): React.ReactNode {
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden" data-testid="editor-alt-repeat-key">
        {/* Left panel: detail editor */}
        <div className="flex-1 flex flex-col min-h-0">
          <div className={`flex-1 overflow-y-auto px-6 pb-6 ${selectedField ? 'pt-6' : ''}`}>
            {editedEntry && (
              <>
                <div className="space-y-2">
                  {!selectedField && (
                    <div className="flex items-center gap-3">
                      <label className="min-w-[140px] text-sm text-content">
                        {t('editor.altRepeatKey.enabled')}
                      </label>
                      <input
                        type="checkbox"
                        data-testid="ar-enabled"
                        checked={editedEntry.enabled}
                        onChange={handleToggleEnabled}
                        disabled={!canEnable}
                        className="h-4 w-4"
                      />
                    </div>
                  )}
                  {keycodeFields.map(({ key, labelKey }) => {
                    if (selectedField && selectedField !== key) return null
                    return (
                      <div key={key} className="flex items-center gap-3">
                        <label className="min-w-[140px] text-sm text-content">{t(labelKey)}</label>
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
                          label={t(labelKey)}
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
                  <div className="mt-2 space-y-2" data-testid="ar-advanced-fields">
                    <ModifierPicker
                      value={editedEntry.allowedMods}
                      onChange={(v) => setEditedEntry((prev) => prev ? { ...prev, allowedMods: v } : prev)}
                      label={t('editor.altRepeatKey.allowedMods')}
                      horizontal
                    />
                    <div className="flex items-start gap-3">
                      <label className="min-w-[140px] pt-0.5 text-sm font-medium">
                        {t('editor.altRepeatKey.options')}
                      </label>
                      <div className="space-y-1">
                        {optionEntries.map(([name, flag]) => (
                          <label key={name} className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={(editedEntry.options & flag) !== 0}
                              onChange={() => handleToggleOption(flag)}
                              className="h-4 w-4"
                            />
                            <span className="text-sm">{name}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {!selectedField && (
                  <div className="flex justify-end gap-2 pt-4">
                    <ConfirmButton
                      testId="ar-modal-clear"
                      confirming={clearAction.confirming}
                      onClick={() => { revertAction.reset(); clearAction.trigger() }}
                      labelKey="common.clear"
                      confirmLabelKey="common.confirmClear"
                    />
                    <ConfirmButton
                      testId="ar-modal-revert"
                      confirming={revertAction.confirming}
                      onClick={() => { clearAction.reset(); revertAction.trigger() }}
                      labelKey="common.revert"
                      confirmLabelKey="common.confirmRevert"
                    />
                    <button
                      type="button"
                      data-testid="ar-modal-save"
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
          data-testid="ar-favorites-panel"
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
      data-testid="ar-modal-backdrop"
      onClick={handleClose}
    >
      <div
        className="overflow-hidden rounded-lg bg-surface-alt shadow-xl w-[1050px] max-w-[95vw] h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {!selectedField && (
          <div className="flex items-center justify-between shrink-0 px-6 pt-6 pb-4">
            <h3 className="text-lg font-semibold">{headerTitle}</h3>
            <ModalCloseButton testid="ar-modal-close" onClick={handleClose} />
          </div>
        )}

        {renderBody()}
      </div>
    </div>
  )
}
