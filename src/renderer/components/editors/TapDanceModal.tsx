// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import { deserialize } from '../../../shared/keycodes/keycodes'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import type { MacroAction } from '../../../preload/macro'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { useFavoriteStore } from '../../hooks/useFavoriteStore'
import { useMaskedKeycodeSelection } from '../../hooks/useMaskedKeycodeSelection'
import { useTileContentOverride } from '../../hooks/useTileContentOverride'
import { ConfirmButton } from './ConfirmButton'
import { KeycodeField } from './KeycodeField'
import { MaskKeyPreview } from './MaskKeyPreview'
import { ModalCloseButton } from './ModalCloseButton'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import { FavoriteStoreContent } from './FavoriteStoreContent'

interface Props {
  index: number
  entry: TapDanceEntry
  onSave: (index: number, entry: TapDanceEntry) => Promise<void>
  onClose: () => void
  isDummy?: boolean
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
}

const TAPPING_TERM_MIN = 0
const TAPPING_TERM_MAX = 10000

type KeycodeFieldName = 'onTap' | 'onHold' | 'onDoubleTap' | 'onTapHold'

function isConfigured(entry: TapDanceEntry): boolean {
  return entry.onTap !== 0 || entry.onHold !== 0 || entry.onDoubleTap !== 0 || entry.onTapHold !== 0
}

const keycodeFields: { key: KeycodeFieldName; labelKey: string }[] = [
  { key: 'onTap', labelKey: 'editor.tapDance.onTap' },
  { key: 'onHold', labelKey: 'editor.tapDance.onHold' },
  { key: 'onDoubleTap', labelKey: 'editor.tapDance.onDoubleTap' },
  { key: 'onTapHold', labelKey: 'editor.tapDance.onTapHold' },
]

export function TapDanceModal({ index, entry, onSave, onClose, isDummy, tapDanceEntries, deserializedMacros }: Props) {
  const { t } = useTranslation()
  const [editedEntry, setEditedEntry] = useState<TapDanceEntry>(entry)
  const [selectedField, setSelectedField] = useState<KeycodeFieldName | null>(null)
  const [popoverState, setPopoverState] = useState<{ field: KeycodeFieldName; anchorRect: DOMRect } | null>(null)
  const preEditValueRef = useRef<number>(0)
  const favStore = useFavoriteStore({
    favoriteType: 'tapDance',
    serialize: () => editedEntry,
    apply: (data) => setEditedEntry(data as TapDanceEntry),
    enabled: !isDummy,
  })

  const clearAction = useConfirmAction(useCallback(() => {
    setEditedEntry({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 0 })
    setSelectedField(null)
    setPopoverState(null)
  }, []))

  const revertAction = useConfirmAction(useCallback(() => {
    setEditedEntry(entry)
    setSelectedField(null)
    setPopoverState(null)
  }, [entry]))

  useEffect(() => {
    setEditedEntry(entry)
    setSelectedField(null)
    setPopoverState(null)
    clearAction.reset()
    revertAction.reset()
  }, [entry])

  useEffect(() => {
    if (!isDummy) {
      favStore.refreshEntries()
    }
  }, [isDummy, favStore.refreshEntries])

  const hasChanges = JSON.stringify(entry) !== JSON.stringify(editedEntry)

  const handleTappingTermChange = (value: string) => {
    const parsed = Number(value)
    if (Number.isNaN(parsed)) return
    const numValue = Math.max(TAPPING_TERM_MIN, Math.min(TAPPING_TERM_MAX, parsed))
    setEditedEntry((prev) => ({ ...prev, tappingTerm: numValue }))
  }

  const maskedSelection = useMaskedKeycodeSelection({
    onUpdate(code: number) {
      if (!selectedField) return false
      setEditedEntry((prev) => ({ ...prev, [selectedField]: code }))
    },
    onCommit() {
      setPopoverState(null)
      setSelectedField(null)
    },
    resetKey: selectedField,
    initialValue: selectedField ? editedEntry[selectedField] : undefined,
  })

  const updateField = useCallback((field: KeycodeFieldName, code: number) => {
    setEditedEntry((prev) => ({ ...prev, [field]: code }))
    setPopoverState(null)
    setSelectedField(null)
  }, [])

  const handleFieldDoubleClick = useCallback(
    (field: KeycodeFieldName, rect: DOMRect) => {
      if (!selectedField) return
      setPopoverState({ field, anchorRect: rect })
    },
    [selectedField],
  )

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

  const tabContentOverride = useTileContentOverride(tapDanceEntries, deserializedMacros, maskedSelection.handleKeycodeSelect)

  const modalWidth = isDummy ? 'w-[900px]' : 'w-[1050px]'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      data-testid="td-modal-backdrop"
      onClick={onClose}
    >
      <div
        className={`rounded-lg bg-surface-alt shadow-xl ${modalWidth} max-w-[90vw] h-[80vh] flex flex-col overflow-hidden`}
        data-testid="td-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        {!selectedField && (
          <div className="px-6 pt-6 pb-4 flex items-center justify-between shrink-0">
            <h3 className="text-lg font-semibold">
              {t('editor.tapDance.editTitle', { index })}
            </h3>
            <ModalCloseButton testid="td-modal-close" onClick={onClose} />
          </div>
        )}

        {/* Split container */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Left panel: editor */}
          <div className="flex-1 overflow-y-auto px-6 pb-6">
            {selectedField && (
              <div className="pt-6" />
            )}

            <div className="space-y-2">
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
                    {selectedField === key && (
                      <MaskKeyPreview onConfirm={maskedSelection.confirm} />
                    )}
                  </div>
                )
              })}
              {!selectedField && (
                <div className="flex items-center gap-3">
                  <label className="min-w-[140px] text-sm text-content">
                    {t('editor.tapDance.tappingTerm')}
                  </label>
                  <input
                    type="number"
                    min={TAPPING_TERM_MIN}
                    max={TAPPING_TERM_MAX}
                    value={editedEntry.tappingTerm}
                    onChange={(e) => handleTappingTermChange(e.target.value)}
                    className="flex-1 rounded border border-edge px-2 py-1 text-sm"
                  />
                </div>
              )}
            </div>

            {selectedField && (
              <div className="mt-3">
                <TabbedKeycodes
                  onKeycodeSelect={maskedSelection.handleKeycodeSelect}
                  maskOnly={maskedSelection.maskOnly}
                  lmMode={maskedSelection.lmMode}
                  tabContentOverride={tabContentOverride}
                  onClose={() => {
                    if (selectedField) {
                      setEditedEntry((prev) => ({ ...prev, [selectedField]: preEditValueRef.current }))
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
              />
            )}

            {!selectedField && (
              <div className="flex justify-end gap-2 pt-4">
                <ConfirmButton
                  testId="td-modal-clear"
                  confirming={clearAction.confirming}
                  onClick={() => { revertAction.reset(); clearAction.trigger() }}
                  labelKey="common.clear"
                  confirmLabelKey="common.confirmClear"
                />
                <ConfirmButton
                  testId="td-modal-revert"
                  confirming={revertAction.confirming}
                  onClick={() => { clearAction.reset(); revertAction.trigger() }}
                  labelKey="common.revert"
                  confirmLabelKey="common.confirmRevert"
                />
                <button
                  type="button"
                  data-testid="td-modal-save"
                  className="rounded bg-accent px-4 py-2 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
                  disabled={!hasChanges}
                  onClick={() => onSave(index, editedEntry)}
                >
                  {t('common.save')}
                </button>
              </div>
            )}
          </div>

          {/* Right panel: favorites */}
          {!isDummy && (
            <div
              className={`w-[456px] shrink-0 flex flex-col ${selectedField ? 'hidden' : ''}`}
              data-testid="td-favorites-panel"
            >
              <FavoriteStoreContent
                entries={favStore.entries}
                loading={favStore.loading}
                saving={favStore.saving}
                canSave={isConfigured(editedEntry)}
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
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
