// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { type MacroAction } from '../../preload/macro'
import { type Keycode, deserialize } from '../../shared/keycodes/keycodes'
import type { TapDanceEntry } from '../../shared/types/protocol'
import { useMaskedKeycodeSelection } from './useMaskedKeycodeSelection'
import { useTileContentOverride } from './useTileContentOverride'
import { isKeycodeAction } from '../components/editors/macro-editor-utils'

interface UseMacroKeycodeSelectionOptions {
  currentActions: MacroAction[]
  activeMacro: number
  setMacros: React.Dispatch<React.SetStateAction<MacroAction[][]>>
  setDirty: (dirty: boolean) => void
  clearPending: () => void
  onEditingChange?: (editing: boolean) => void
  tapDanceEntries?: TapDanceEntry[]
  deserializedMacros?: MacroAction[][]
  quickSelect?: boolean
  autoAdvance?: boolean
}

export function useMacroKeycodeSelection({
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
}: UseMacroKeycodeSelectionOptions) {
  const [selectedKey, setSelectedKey] = useState<{
    actionIndex: number
    keycodeIndex: number
  } | null>(null)
  const [popoverState, setPopoverState] = useState<{
    actionIndex: number
    keycodeIndex: number
    anchorRect: DOMRect
  } | null>(null)
  const preEditValueRef = useRef<number>(0)

  const isEditing = selectedKey !== null

  useLayoutEffect(() => {
    onEditingChange?.(isEditing)
  }, [isEditing, onEditingChange])

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
    [activeMacro, clearPending, setMacros, setDirty],
  )

  const handleKeycodeClick = useCallback(
    (actionIndex: number, keycodeIndex: number) => {
      const action = currentActions[actionIndex]
      if (isKeycodeAction(action)) {
        preEditValueRef.current = action.keycodes[keycodeIndex] ?? 0
      }
      setSelectedKey({ actionIndex, keycodeIndex })
    },
    [currentActions],
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
      if (!isKeycodeAction(action)) return
      preEditValueRef.current = 0
      setSelectedKey({ actionIndex, keycodeIndex: action.keycodes.length })
    },
    [currentActions],
  )

  const macroInitialValue = (() => {
    if (!selectedKey) return undefined
    const action = currentActions[selectedKey.actionIndex]
    return isKeycodeAction(action)
      ? action.keycodes[selectedKey.keycodeIndex]
      : undefined
  })()

  const handleKeycodeDelete = useCallback(
    (actionIndex: number, keycodeIndex: number) => {
      const action = currentActions[actionIndex]
      if (!isKeycodeAction(action)) return
      const newKeycodes = action.keycodes.filter((_, i) => i !== keycodeIndex)
      setKeycodeAt(actionIndex, newKeycodes)
      if (selectedKey?.actionIndex === actionIndex) {
        const nextIndex = keycodeIndex < selectedKey.keycodeIndex
          ? selectedKey.keycodeIndex - 1
          : Math.min(selectedKey.keycodeIndex, Math.max(newKeycodes.length - 1, 0))
        preEditValueRef.current = newKeycodes[nextIndex] ?? 0
        setSelectedKey({ actionIndex, keycodeIndex: nextIndex })
      }
    },
    [currentActions, setKeycodeAt, selectedKey],
  )

  const maskedSelection = useMaskedKeycodeSelection({
    onUpdate(code: number) {
      if (!selectedKey) return false
      const action = currentActions[selectedKey.actionIndex]
      if (!isKeycodeAction(action)) return false

      const newKeycodes = [...action.keycodes]
      if (selectedKey.keycodeIndex >= newKeycodes.length) {
        newKeycodes.push(code)
      } else {
        newKeycodes[selectedKey.keycodeIndex] = code
      }
      setKeycodeAt(selectedKey.actionIndex, newKeycodes)

      if (autoAdvance) {
        const nextIndex = selectedKey.keycodeIndex + 1
        preEditValueRef.current = newKeycodes[nextIndex] ?? 0
        setSelectedKey({ actionIndex: selectedKey.actionIndex, keycodeIndex: nextIndex })
      }
    },
    onCommit() {
      // In macro edit mode, picker commits (quickSelect click, double-click)
      // should not exit edit mode — user explicitly clicks × to close.
    },
    resetKey: selectedKey,
    initialValue: macroInitialValue,
    quickSelect,
  })

  // Tile picker uses pickerSelect/pickerDoubleClick so the quickSelect and
  // Enter-to-commit behavior matches regular keycode tiles. onCommit is a
  // no-op in macro mode, so double-click simply acts like another single-click.
  const tabContentOverride = useTileContentOverride({
    tapDanceEntries,
    deserializedMacros,
    onSelect: maskedSelection.pickerSelect,
    onDoubleClick: maskedSelection.pickerDoubleClick,
  })

  const handleMaskPartClick = useCallback(
    (actionIndex: number, keycodeIndex: number, part: 'outer' | 'inner') => {
      const action = currentActions[actionIndex]
      if (!isKeycodeAction(action)) return
      const code = action.keycodes[keycodeIndex]
      if (code == null) return
      preEditValueRef.current = code
      maskedSelection.enterMaskMode(code, part)
      setSelectedKey({ actionIndex, keycodeIndex })
    },
    [currentActions, maskedSelection.enterMaskMode],
  )

  const applyPopoverKeycode = useCallback(
    (code: number) => {
      if (!popoverState) return
      const action = currentActions[popoverState.actionIndex]
      if (!isKeycodeAction(action)) return

      const newKeycodes = [...action.keycodes]
      newKeycodes[popoverState.keycodeIndex] = code
      setKeycodeAt(popoverState.actionIndex, newKeycodes)
    },
    [popoverState, currentActions, setKeycodeAt],
  )

  const handlePopoverKeycodeSelect = useCallback(
    (kc: Keycode) => applyPopoverKeycode(deserialize(kc.qmkId)),
    [applyPopoverKeycode],
  )

  const closePopover = useCallback(() => {
    setPopoverState(null)
  }, [])

  const pickerRef = useRef<HTMLDivElement>(null)

  const revertAndDeselect = useCallback(() => {
    maskedSelection.clearMask()
    setSelectedKey(null)
  }, [maskedSelection.clearMask])

  // Close picker when clicking outside of it.
  useEffect(() => {
    if (!isEditing) return
    function handler(e: MouseEvent): void {
      const target = e.target as Node | null
      if (!target) return
      if (pickerRef.current?.contains(target)) return
      const el = target instanceof Element ? target : target.parentElement
      if (el?.closest('[data-testid="keycode-field"]')) return
      if (el?.closest('[data-testid="macro-action-list"]')) return
      if (el?.closest('[data-macro-footer]')) return
      if (el?.closest('[data-popover="key"]')) return
      revertAndDeselect()
    }
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [isEditing, revertAndDeselect])

  const popoverKeycode = (() => {
    if (!popoverState) return 0
    const action = currentActions[popoverState.actionIndex]
    return isKeycodeAction(action)
      ? action.keycodes[popoverState.keycodeIndex] ?? 0
      : 0
  })()

  return {
    selectedKey,
    setSelectedKey,
    popoverState,
    setPopoverState,
    preEditValueRef,
    isEditing,
    maskedSelection,
    tabContentOverride,
    pickerRef,
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
  }
}
