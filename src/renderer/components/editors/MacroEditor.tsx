// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { MacroActionItem, defaultAction, type ActionType } from './MacroActionItem'
import { MacroRecorder } from './MacroRecorder'
import { MacroTextEditor } from './MacroTextEditor'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import {
  type MacroAction,
  serializeAllMacros,
  serializeMacro,
  macroActionsToJson,
  jsonToMacroActions,
  isValidMacroText,
} from '../../../preload/macro'
import type { TapDanceEntry } from '../../../shared/types/protocol'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import { useConfirmAction } from '../../hooks/useConfirmAction'
import { useEscapeClose } from '../../hooks/useEscapeClose'
import { useFavoriteStore } from '../../hooks/useFavoriteStore'
import { useMacroKeycodeSelection } from '../../hooks/useMacroKeycodeSelection'
import { ConfirmButton } from './ConfirmButton'
import { FavoriteStoreContent } from './FavoriteStoreContent'
import type { FavHubEntryResult } from './FavoriteHubActions'
import type { BasicViewType, SplitKeyMode } from '../../../shared/types/app-config'
import { parseMacroBuffer, isKeycodeAction, normalizeMacros, normalizeMacroActions } from './macro-editor-utils'

interface Props {
  macroCount: number
  macroBufferSize: number
  macroBuffer: number[]
  vialProtocol: number
  onSaveMacros: (buffer: number[], parsedMacros?: MacroAction[][]) => Promise<void>
  parsedMacros?: MacroAction[][] | null
  onClose?: () => void
  initialMacro?: number
  unlocked?: boolean
  onUnlock?: () => void
  isDummy?: boolean
  onEditingChange?: (editing: boolean) => void
  onRecordingChange?: (recording: boolean) => void
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
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
  autoAdvance?: boolean
  splitKeyMode?: SplitKeyMode
  basicViewType?: BasicViewType
  layers?: number
}

export function MacroEditor({
  macroCount,
  macroBufferSize,
  macroBuffer,
  vialProtocol,
  onSaveMacros,
  parsedMacros: parsedMacrosProp,
  onClose,
  initialMacro,
  unlocked,
  onUnlock,
  isDummy,
  onEditingChange,
  onRecordingChange,
  tapDanceEntries,
  deserializedMacros,
  hubOrigin,
  hubNeedsDisplayName,
  hubUploading,
  hubUploadResult,
  onUploadToHub,
  onUpdateOnHub,
  onRemoveFromHub,
  onRenameOnHub,
  quickSelect,
  autoAdvance,
  splitKeyMode,
  basicViewType,
  layers,
}: Props) {
  const { t } = useTranslation()
  const { guardAll, clearPending } = useUnlockGate({ unlocked, onUnlock })
  const [activeMacro, setActiveMacro] = useState(initialMacro ?? 0)
  const [dirty, setDirty] = useState(false)
  const [showTextEditor, setShowTextEditor] = useState(false)
  const [isRecording, setIsRecording] = useState(false)

  useEffect(() => {
    onRecordingChange?.(isRecording)
  }, [isRecording, onRecordingChange])

  const [macros, setMacros] = useState<MacroAction[][]>(() =>
    parsedMacrosProp ?? parseMacroBuffer(macroBuffer, vialProtocol, macroCount),
  )
  const macrosRef = useRef(macros)
  macrosRef.current = macros

  const currentActions = macros[activeMacro] ?? []

  const favStore = useFavoriteStore({
    favoriteType: 'macro',
    serialize: () => JSON.parse(macroActionsToJson(normalizeMacroActions(currentActions))),
    apply: (data) => {
      const loaded = jsonToMacroActions(JSON.stringify(data))
      if (!loaded) throw new Error('Invalid macro data')
      updateActions(loaded)
    },
    enabled: !isDummy,
    vialProtocol,
  })

  // Sync active macro when initialMacro changes (e.g. modal re-opened with different index)
  useEffect(() => {
    setActiveMacro(initialMacro ?? 0)
  }, [initialMacro])

  useEffect(() => {
    if (!isDummy) {
      favStore.refreshEntries()
    }
  }, [isDummy, favStore.refreshEntries])

  const {
    selectedKey,
    setSelectedKey,
    setPopoverState,
    isEditing,
    maskedSelection,
    tabContentOverride,
    pickerRef,
    popoverState,
    popoverKeycode,
    handleKeycodeClick,
    handleKeycodeDoubleClick,
    handleKeycodeAdd,
    handleKeycodeDelete,
    handleMaskPartClick,
    applyPopoverKeycode,
    handlePopoverKeycodeSelect,
    closePopover,
    revertAndDeselect,
    commitAndDeselect,
    beginAddAction,
    hasPendingEdit,
    isExistingEdit,
  } = useMacroKeycodeSelection({
    currentActions,
    activeMacro,
    setMacros,
    setDirty,
    clearPending,
    onEditingChange,
    tapDanceEntries,
    deserializedMacros,
    quickSelect,
    autoAdvance,
  })

  // Guarded so MacroModal's ESC handler takes over outside edit mode and during recording.
  useEscapeClose(revertAndDeselect, isEditing && !isRecording)

  const updateActions = useCallback(
    (newActions: MacroAction[]) => {
      clearPending()
      setSelectedKey(null)
      setPopoverState(null)
      setMacros((prev) => {
        const updated = [...prev]
        updated[activeMacro] = newActions
        return updated
      })
      setDirty(true)
    },
    [activeMacro, clearPending, setSelectedKey, setPopoverState],
  )

  const handleRecordComplete = useCallback(
    (recorded: MacroAction[]) => {
      if (recorded.length > 0) {
        updateActions([...currentActions, ...recorded])
      }
    },
    [currentActions, updateActions],
  )

  const handleAddActionType = useCallback(
    (type: ActionType) => {
      if (isRecording) return
      beginAddAction(defaultAction(type))
    },
    [isRecording, beginAddAction],
  )

  const handleChange = useCallback(
    (index: number, action: MacroAction) => {
      const updated = [...currentActions]
      updated[index] = action
      updateActions(updated)
    },
    [currentActions, updateActions],
  )

  const handleKeycodeAddWithPopover = useCallback(
    (actionIndex: number, rect: DOMRect) => {
      if (isRecording) return
      const action = currentActions[actionIndex]
      if (!isKeycodeAction(action)) return
      handleKeycodeAdd(actionIndex)
      setPopoverState({ actionIndex, keycodeIndex: action.keycodes.length, anchorRect: rect })
    },
    [isRecording, currentActions, handleKeycodeAdd, setPopoverState],
  )

  const handleEditClick = useCallback(
    (index: number, keycodeIndex: number) => {
      if (isRecording) return
      handleKeycodeClick(index, keycodeIndex)
    },
    [isRecording, handleKeycodeClick],
  )

  const handleDelete = useCallback(
    (index: number) => {
      updateActions(currentActions.filter((_, i) => i !== index))
    },
    [currentActions, updateActions],
  )

  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

  const handleDragStart = useCallback((index: number) => {
    setDragIndex(index)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault()
    setDragOverIndex(index)
  }, [])

  const handleDrop = useCallback(
    (index: number) => {
      if (dragIndex === null || dragIndex === index) return
      const updated = [...currentActions]
      const [moved] = updated.splice(dragIndex, 1)
      updated.splice(index, 0, moved)
      updateActions(updated)
    },
    [dragIndex, currentActions, updateActions],
  )

  const handleDragEnd = useCallback(() => {
    setDragIndex(null)
    setDragOverIndex(null)
  }, [])

  const handleSave = useCallback(async () => {
    await guardAll(async () => {
      const current = normalizeMacros(macrosRef.current)
      const buffer = serializeAllMacros(current, vialProtocol)
      await onSaveMacros(buffer, current)
      setDirty(false)
      onClose?.()
    })
  }, [vialProtocol, onSaveMacros, guardAll, onClose])

  const clearAction = useConfirmAction(useCallback(() => {
    updateActions([])
  }, [updateActions]))

  const revertAction = useConfirmAction(useCallback(() => {
    clearPending()
    setSelectedKey(null)
    setPopoverState(null)
    setMacros(parseMacroBuffer(macroBuffer, vialProtocol, macroCount))
    setDirty(false)
  }, [macroBuffer, vialProtocol, macroCount, clearPending, setSelectedKey, setPopoverState]))

  // Edit-mode Revert (per-slot) — confirms like the list-level Revert but
  // only rolls back the in-flight picker edit via revertAndDeselect.
  const editRevertAction = useConfirmAction(revertAndDeselect)

  // Enter in the picker commits the staged edit and exits edit mode,
  // mirroring the Save button's enabled state so an empty commit can't
  // sneak through.
  const pickerEnterCommit = useCallback(() => {
    if (isEditing && !isRecording && hasPendingEdit) commitAndDeselect()
  }, [isEditing, isRecording, hasPendingEdit, commitAndDeselect])

  // Clear selection state when switching macros to avoid stale indices
  useEffect(() => {
    setSelectedKey(null)
    setPopoverState(null)
    clearAction.reset()
    revertAction.reset()
    editRevertAction.reset()
  }, [activeMacro])

  const memoryUsed = useMemo(() => {
    let total = 0
    for (const macro of macros) {
      total += serializeMacro(macro, vialProtocol).length + 1 // +1 for NUL terminator
    }
    return total
  }, [macros, vialProtocol])

  const hasInvalidText = useMemo(
    () => macros.some((macro) =>
      macro.some((a) => a.type === 'text' && !isValidMacroText(a.text)),
    ),
    [macros],
  )

  const handleTextEditorApply = useCallback(
    (actions: MacroAction[]) => {
      updateActions(actions)
      setShowTextEditor(false)
    },
    [updateActions],
  )

  return (
    <>
      <div className="flex-1 flex flex-col min-h-0" data-testid="editor-macro">
        {/* Fixed header: memory + action buttons */}
          <div className={`shrink-0 px-6 pt-2 pb-3 flex items-center gap-2 ${isEditing ? 'hidden' : ''}`}>
            <span className="text-xs text-content-muted" data-testid="macro-memory">
              {t('editor.macro.memoryUsage', {
                used: memoryUsed,
                total: macroBufferSize,
              })}
            </span>
            <div className="flex-1" />
            <select
              data-testid="macro-add-action"
              className="rounded bg-surface-dim px-2.5 py-1 text-xs hover:bg-surface-raised disabled:opacity-50"
              value=""
              disabled={isRecording}
              onChange={(e) => {
                if (e.target.value) handleAddActionType(e.target.value as ActionType)
                e.target.value = ''
              }}
            >
              <option value="" disabled>{t('editor.macro.addAction')}</option>
              <option value="text">{t('editor.macro.text')}</option>
              <option value="tap">{t('editor.macro.tap')}</option>
              <option value="down">{t('editor.macro.down')}</option>
              <option value="up">{t('editor.macro.up')}</option>
              <option value="delay">{t('editor.macro.delay')}</option>
            </select>
            <MacroRecorder onRecordComplete={handleRecordComplete} onRecordingChange={setIsRecording} />
            <button
              type="button"
              data-testid="macro-text-editor-btn"
              className="rounded bg-surface-dim px-2.5 py-1 text-xs hover:bg-surface-raised disabled:opacity-50"
              disabled={isRecording}
              onClick={() => setShowTextEditor(true)}
            >
              {t('editor.macro.textEditor')}
            </button>
          </div>

        {/* Action list: shrink-0 in edit mode, scrollable in list mode */}
        <div className={`px-6 pb-3 ${isEditing ? 'shrink-0 pt-6' : 'flex-1 overflow-y-auto'}`}>
          <div className="space-y-1" data-testid="macro-action-list">
            {currentActions.map((action, i) => {
              const isSelectedAction = selectedKey?.actionIndex === i
              if (isEditing && !isSelectedAction) return null
              return (
                <MacroActionItem
                  key={i}
                  action={action}
                  index={i}
                  onChange={handleChange}
                  onDelete={handleDelete}
                  onDragStart={() => handleDragStart(i)}
                  onDragOver={(e) => handleDragOver(e, i)}
                  onDrop={() => handleDrop(i)}
                  onDragEnd={handleDragEnd}
                  dropIndicator={dragOverIndex === i && dragIndex !== null && dragIndex !== i ? (dragIndex < i ? 'below' : 'above') : null}
                  selectedKeycodeIndex={isSelectedAction ? selectedKey.keycodeIndex : null}
                  selectedMaskPart={isSelectedAction && maskedSelection.editingPart === 'inner'}
                  onKeycodeClick={(ki) => handleKeycodeClick(i, ki)}
                  onKeycodeDoubleClick={(ki, rect) => handleKeycodeDoubleClick(i, ki, rect)}
                  onKeycodeAdd={() => handleKeycodeAdd(i)}
                  onKeycodeAddDoubleClick={(rect) => handleKeycodeAddWithPopover(i, rect)}
                  onKeycodeDelete={(ki) => handleKeycodeDelete(i, ki)}
                  onEditClick={(ki) => handleEditClick(i, ki)}
                  onMaskPartClick={(ki, part) => handleMaskPartClick(i, ki, part)}
                  focusMode={isEditing}
                  onCloseEdit={isEditing ? revertAndDeselect : undefined}
                  disabled={isRecording}
                />
              )
            })}
          </div>
        </div>

        {/* Picker: shrink to content in edit mode so the Save footer sits close
             to the keypicker content; list mode keeps the action list area
             hidden via the sibling container. */}
        <div ref={pickerRef} className={`overflow-y-auto px-6 pb-6 ${isEditing ? 'shrink-0' : 'hidden'}`}>
          <TabbedKeycodes
            onKeycodeSelect={maskedSelection.pickerSelect}
            onConfirm={pickerEnterCommit}
            maskOnly={maskedSelection.maskOnly}
            lmMode={maskedSelection.lmMode}
            tabContentOverride={tabContentOverride}
            splitKeyMode={splitKeyMode}
            basicViewType={basicViewType}
          />
        </div>

        {/* Fixed footer: Clear / Revert (list mode only) / Save (always visible) */}
          <div data-macro-footer="true" className="shrink-0 px-6 py-3">
            <div className="flex justify-end gap-2">
              {!isEditing && (
                <>
                  <ConfirmButton
                    testId="macro-clear"
                    confirming={clearAction.confirming}
                    onClick={() => { revertAction.reset(); clearAction.trigger() }}
                    labelKey="common.clear"
                    confirmLabelKey="common.confirmClear"
                    disabled={isRecording}
                  />
                  <ConfirmButton
                    testId="macro-revert"
                    confirming={revertAction.confirming}
                    onClick={() => { clearAction.reset(); revertAction.trigger() }}
                    labelKey="common.revert"
                    confirmLabelKey="common.confirmRevert"
                    disabled={isRecording}
                  />
                </>
              )}
              {isEditing && isExistingEdit && (
                <ConfirmButton
                  testId="macro-edit-revert"
                  confirming={editRevertAction.confirming}
                  onClick={editRevertAction.trigger}
                  labelKey="common.revert"
                  confirmLabelKey="common.confirmRevert"
                  disabled={isRecording || !hasPendingEdit}
                />
              )}
              <button
                type="button"
                data-testid="macro-save"
                className="rounded bg-accent px-4 py-2 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
                onClick={isEditing ? commitAndDeselect : handleSave}
                disabled={isEditing
                  ? (isRecording || !hasPendingEdit)
                  : (!dirty || hasInvalidText || isRecording)}
              >
                {t('common.save')}
              </button>
            </div>
          </div>

        {popoverState !== null && (() => {
          const action = currentActions[popoverState.actionIndex]
          const isVirtualSlot = isKeycodeAction(action) && popoverState.keycodeIndex >= action.keycodes.length
          return (
            <KeyPopover
              anchorRect={popoverState.anchorRect}
              currentKeycode={popoverKeycode}
              emptyInitial={isVirtualSlot}
              layers={layers}
              onKeycodeSelect={handlePopoverKeycodeSelect}
              onRawKeycodeSelect={applyPopoverKeycode}
              onClose={closePopover}
              onConfirm={() => { closePopover(); maskedSelection.clearMask() }}
              quickSelect={quickSelect}
            />
          )
        })()}

        {showTextEditor && (
          <MacroTextEditor
            initialJson={macroActionsToJson(currentActions)}
            onApply={handleTextEditorApply}
            onClose={() => setShowTextEditor(false)}
          />
        )}
      </div>

      {!isDummy && (
        <div
          className={`w-[456px] shrink-0 flex flex-col ${isEditing ? 'hidden' : isRecording ? 'invisible' : ''}`}
          data-testid="macro-favorites-panel"
        >
          <FavoriteStoreContent
            entries={favStore.entries}
            loading={favStore.loading}
            saving={favStore.saving}
            canSave={currentActions.length > 0 && !hasInvalidText}
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
      )}
    </>
  )
}
