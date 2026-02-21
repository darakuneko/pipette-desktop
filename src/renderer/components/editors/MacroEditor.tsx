// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { MacroActionItem } from './MacroActionItem'
import { MacroRecorder } from './MacroRecorder'
import { MacroTextEditor } from './MacroTextEditor'
import { TabbedKeycodes } from '../keycodes/TabbedKeycodes'
import { KeyPopover } from '../keycodes/KeyPopover'
import type { MacroAction } from '../../../preload/macro'
import {
  deserializeAllMacros,
  serializeAllMacros,
  serializeMacro,
  macroActionsToJson,
  jsonToMacroActions,
  isValidMacroText,
} from '../../../preload/macro'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { deserialize } from '../../../shared/keycodes/keycodes'
import { useUnlockGate } from '../../hooks/useUnlockGate'
import { useFavoriteStore } from '../../hooks/useFavoriteStore'
import { FavoriteStoreModal } from './FavoriteStoreModal'

interface Props {
  macroCount: number
  macroBufferSize: number
  macroBuffer: number[]
  vialProtocol: number
  onSaveMacros: (buffer: number[]) => Promise<void>
  onClose?: () => void
  initialMacro?: number
  unlocked?: boolean
  onUnlock?: () => void
  isDummy?: boolean
}

function parseMacroBuffer(
  buffer: number[],
  protocol: number,
  count: number,
): MacroAction[][] {
  const parsed = deserializeAllMacros(buffer, protocol, count)
  while (parsed.length < count) {
    parsed.push([])
  }
  return parsed
}

const KC_TRNS = 1
const KC_NO = 0

type KeycodeAction = Extract<MacroAction, { type: 'tap' | 'down' | 'up' }>

function isKeycodeAction(action: MacroAction): action is KeycodeAction {
  return action.type === 'tap' || action.type === 'down' || action.type === 'up'
}

export function MacroEditor({
  macroCount,
  macroBufferSize,
  macroBuffer,
  vialProtocol,
  onSaveMacros,
  onClose,
  initialMacro,
  unlocked,
  onUnlock,
  isDummy,
}: Props) {
  const { t } = useTranslation()
  const { guardAll, clearPending } = useUnlockGate({ unlocked, onUnlock })
  const [activeMacro, setActiveMacro] = useState(initialMacro ?? 0)
  const favStore = useFavoriteStore({
    favoriteType: 'macro',
    serialize: () => JSON.parse(macroActionsToJson(currentActions)),
    apply: (data) => {
      const loaded = jsonToMacroActions(JSON.stringify(data))
      if (!loaded) throw new Error('Invalid macro data')
      updateActions(loaded)
    },
    enabled: !isDummy,
  })

  // Sync active macro when initialMacro changes (e.g. modal re-opened with different index)
  useEffect(() => {
    setActiveMacro(initialMacro ?? 0)
  }, [initialMacro])

  // Clear selection state when switching macros to avoid stale indices
  useEffect(() => {
    setSelectedKey(null)
    setPopoverState(null)
  }, [activeMacro])

  const [dirty, setDirty] = useState(false)

  const [macros, setMacros] = useState<MacroAction[][]>(() =>
    parseMacroBuffer(macroBuffer, vialProtocol, macroCount),
  )
  const macrosRef = useRef(macros)
  macrosRef.current = macros

  const currentActions = macros[activeMacro] ?? []

  // Selection state for keycode editing
  const [selectedKey, setSelectedKey] = useState<{ actionIndex: number; keycodeIndex: number } | null>(null)
  const [popoverState, setPopoverState] = useState<{ actionIndex: number; keycodeIndex: number; anchorRect: DOMRect } | null>(null)
  const [showTextEditor, setShowTextEditor] = useState(false)

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
    [activeMacro, clearPending],
  )

  const handleRecordComplete = useCallback(
    (recorded: MacroAction[]) => {
      if (recorded.length > 0) {
        updateActions([...currentActions, ...recorded])
      }
    },
    [currentActions, updateActions],
  )

  const handleAddAction = useCallback(() => {
    const newAction: MacroAction = { type: 'text', text: '' }
    updateActions([...currentActions, newAction])
  }, [currentActions, updateActions])

  const handleChange = useCallback(
    (index: number, action: MacroAction) => {
      const updated = [...currentActions]
      updated[index] = action
      updateActions(updated)
    },
    [currentActions, updateActions],
  )

  const handleDelete = useCallback(
    (index: number) => {
      updateActions(currentActions.filter((_, i) => i !== index))
    },
    [currentActions, updateActions],
  )

  const handleMoveUp = useCallback(
    (index: number) => {
      if (index === 0) return
      const updated = [...currentActions]
      ;[updated[index - 1], updated[index]] = [updated[index], updated[index - 1]]
      updateActions(updated)
    },
    [currentActions, updateActions],
  )

  const handleMoveDown = useCallback(
    (index: number) => {
      if (index >= currentActions.length - 1) return
      const updated = [...currentActions]
      ;[updated[index], updated[index + 1]] = [updated[index + 1], updated[index]]
      updateActions(updated)
    },
    [currentActions, updateActions],
  )

  const handleSave = useCallback(async () => {
    await guardAll(async () => {
      const buffer = serializeAllMacros(macrosRef.current, vialProtocol)
      await onSaveMacros(buffer)
      setDirty(false)
      onClose?.()
    })
  }, [vialProtocol, onSaveMacros, guardAll, onClose])

  const handleRevert = useCallback(() => {
    clearPending()
    setSelectedKey(null)
    setPopoverState(null)
    setMacros(parseMacroBuffer(macroBuffer, vialProtocol, macroCount))
    setDirty(false)
  }, [macroBuffer, vialProtocol, macroCount, clearPending])

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

  // --- Keycode selection handlers ---

  /** Update keycodes for a specific action without clearing selectedKey. */
  const setKeycodeAt = useCallback(
    (actionIndex: number, newKeycodes: number[]) => {
      clearPending()
      setMacros((prev) => {
        const updated = [...prev]
        const actions = [...(updated[activeMacro] ?? [])]
        const action = actions[actionIndex]
        if (isKeycodeAction(action)) {
          actions[actionIndex] = { ...action, keycodes: newKeycodes }
        }
        updated[activeMacro] = actions
        return updated
      })
      setDirty(true)
    },
    [activeMacro, clearPending],
  )

  const handleKeycodeClick = useCallback(
    (actionIndex: number, keycodeIndex: number) => {
      setSelectedKey({ actionIndex, keycodeIndex })
    },
    [],
  )

  const handleKeycodeDoubleClick = useCallback(
    (actionIndex: number, keycodeIndex: number, rect: DOMRect) => {
      setPopoverState({ actionIndex, keycodeIndex, anchorRect: rect })
    },
    [],
  )

  const handleKeycodeAdd = useCallback(
    (actionIndex: number) => {
      const action = currentActions[actionIndex]
      if (isKeycodeAction(action)) {
        setKeycodeAt(actionIndex, [...action.keycodes, KC_TRNS])
      }
    },
    [currentActions, setKeycodeAt],
  )

  const handleKeycodeSelect = useCallback(
    (kc: Keycode) => {
      if (!selectedKey) return
      const code = deserialize(kc.qmkId)
      const action = currentActions[selectedKey.actionIndex]
      if (!isKeycodeAction(action)) return

      if (code === KC_NO) {
        // Delete this keycode, but keep at least one
        if (action.keycodes.length <= 1) return
        setKeycodeAt(selectedKey.actionIndex, action.keycodes.filter((_, i) => i !== selectedKey.keycodeIndex))
      } else {
        const newKeycodes = [...action.keycodes]
        newKeycodes[selectedKey.keycodeIndex] = code
        setKeycodeAt(selectedKey.actionIndex, newKeycodes)
      }
      setSelectedKey(null)
    },
    [selectedKey, currentActions, setKeycodeAt],
  )

  const handlePopoverKeycodeSelect = useCallback(
    (kc: Keycode) => {
      if (!popoverState) return
      const action = currentActions[popoverState.actionIndex]
      if (!isKeycodeAction(action)) return

      const newKeycodes = [...action.keycodes]
      newKeycodes[popoverState.keycodeIndex] = deserialize(kc.qmkId)
      setKeycodeAt(popoverState.actionIndex, newKeycodes)
      setPopoverState(null)
      setSelectedKey(null)
    },
    [popoverState, currentActions, setKeycodeAt],
  )

  const handlePopoverRawKeycodeSelect = useCallback(
    (code: number) => {
      if (!popoverState) return
      const action = currentActions[popoverState.actionIndex]
      if (!isKeycodeAction(action)) return

      const newKeycodes = [...action.keycodes]
      newKeycodes[popoverState.keycodeIndex] = code
      setKeycodeAt(popoverState.actionIndex, newKeycodes)
      setPopoverState(null)
      setSelectedKey(null)
    },
    [popoverState, currentActions, setKeycodeAt],
  )

  const closePopover = useCallback(() => {
    setPopoverState(null)
  }, [])

  const handleTextEditorApply = useCallback(
    (actions: MacroAction[]) => {
      updateActions(actions)
      setShowTextEditor(false)
    },
    [updateActions],
  )

  const pickerRef = useRef<HTMLDivElement>(null)

  // Close picker when clicking outside of it.
  // Uses click (not mousedown) so the DOM hasn't re-rendered yet when the
  // event processes — the modal's stopPropagation still covers the area and
  // prevents the backdrop from receiving the event.
  useEffect(() => {
    if (!selectedKey) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node | null
      if (!target) return
      if (pickerRef.current?.contains(target)) return
      // Resolve to Element for text node targets (e.g. spans inside buttons)
      const el = target instanceof Element ? target : target.parentElement
      if (el?.closest('[data-testid="keycode-field"]')) return
      setSelectedKey(null)
    }
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [selectedKey])

  const popoverKeycode = (() => {
    if (!popoverState) return 0
    const action = currentActions[popoverState.actionIndex]
    return isKeycodeAction(action) ? action.keycodes[popoverState.keycodeIndex] ?? 0 : 0
  })()

  return (
    <div className="flex flex-col gap-3" data-testid="editor-macro">
      <div className="text-xs text-content-muted" data-testid="macro-memory">
        {t('editor.macro.memoryUsage', {
          used: memoryUsed,
          total: macroBufferSize,
        })}
      </div>

      <div className="space-y-1" data-testid="macro-action-list">
        {currentActions.map((action, i) => (
          <MacroActionItem
            key={i}
            action={action}
            index={i}
            onChange={handleChange}
            onDelete={handleDelete}
            onMoveUp={handleMoveUp}
            onMoveDown={handleMoveDown}
            isFirst={i === 0}
            isLast={i === currentActions.length - 1}
            selectedKeycodeIndex={selectedKey?.actionIndex === i ? selectedKey.keycodeIndex : null}
            onKeycodeClick={(ki) => handleKeycodeClick(i, ki)}
            onKeycodeDoubleClick={(ki, rect) => handleKeycodeDoubleClick(i, ki, rect)}
            onKeycodeAdd={() => handleKeycodeAdd(i)}
          />
        ))}
      </div>

      {selectedKey !== null && (
        <div ref={pickerRef}>
          <TabbedKeycodes
            onKeycodeSelect={handleKeycodeSelect}
            onClose={() => setSelectedKey(null)}
          />
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="macro-add-action"
          className="rounded bg-surface-dim px-3 py-1.5 text-sm hover:bg-surface-raised"
          onClick={handleAddAction}
        >
          {t('editor.macro.addAction')}
        </button>
        <MacroRecorder onRecordComplete={handleRecordComplete} />
        <button
          type="button"
          data-testid="macro-text-editor-btn"
          className="rounded bg-surface-dim px-3 py-1.5 text-sm hover:bg-surface-raised"
          onClick={() => setShowTextEditor(true)}
        >
          {t('editor.macro.textEditor')}
        </button>
        {!isDummy && (
          <button
            type="button"
            data-testid="macro-fav-btn"
            className="rounded bg-warning px-3 py-1.5 text-sm text-black hover:bg-warning/80"
            onClick={favStore.openModal}
          >
            {t('favoriteStore.button')}
          </button>
        )}
        <div className="flex-1" />
        <button
          type="button"
          data-testid="macro-revert"
          className="rounded border border-edge px-3 py-1.5 text-sm hover:bg-surface-dim disabled:opacity-50"
          onClick={handleRevert}
          disabled={!dirty}
        >
          {t('common.revert')}
        </button>
        <button
          type="button"
          data-testid="macro-save"
          className="rounded bg-accent px-3 py-1.5 text-sm text-content-inverse hover:bg-accent-hover disabled:opacity-50"
          onClick={handleSave}
          disabled={!dirty || hasInvalidText}
        >
          {t('common.save')}
        </button>
      </div>

      {popoverState !== null && (
        <KeyPopover
          anchorRect={popoverState.anchorRect}
          currentKeycode={popoverKeycode}
          onKeycodeSelect={handlePopoverKeycodeSelect}
          onRawKeycodeSelect={handlePopoverRawKeycodeSelect}
          onClose={closePopover}
        />
      )}

      {showTextEditor && (
        <MacroTextEditor
          initialJson={macroActionsToJson(currentActions)}
          onApply={handleTextEditorApply}
          onClose={() => setShowTextEditor(false)}
        />
      )}

      {favStore.showModal && (
        <FavoriteStoreModal
          favoriteType="macro"
          entries={favStore.entries}
          loading={favStore.loading}
          saving={favStore.saving}
          canSave={currentActions.length > 0}
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
          onClose={favStore.closeModal}
        />
      )}
    </div>
  )
}
