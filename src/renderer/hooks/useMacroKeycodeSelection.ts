// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react'
import { type MacroAction } from '../../preload/macro'
import { type Keycode, deserialize } from '../../shared/keycodes/keycodes'
import type { TapDanceEntry } from '../../shared/types/protocol'
import { useMaskedKeycodeSelection } from './useMaskedKeycodeSelection'
import { useTileContentOverride } from './useTileContentOverride'
import { KC_TRNS, KC_NO, isKeycodeAction } from '../components/editors/macro-editor-utils'

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
      if (isKeycodeAction(action)) {
        setKeycodeAt(actionIndex, [...action.keycodes, KC_TRNS])
      }
    },
    [currentActions, setKeycodeAt],
  )

  const macroInitialValue = (() => {
    if (!selectedKey) return undefined
    const action = currentActions[selectedKey.actionIndex]
    return isKeycodeAction(action)
      ? action.keycodes[selectedKey.keycodeIndex]
      : undefined
  })()

  const maskedSelection = useMaskedKeycodeSelection({
    onUpdate(code: number) {
      if (!selectedKey) return false
      const action = currentActions[selectedKey.actionIndex]
      if (!isKeycodeAction(action)) return false

      if (code === KC_NO) {
        // Delete this keycode, but keep at least one
        if (action.keycodes.length <= 1) return false
        setKeycodeAt(
          selectedKey.actionIndex,
          action.keycodes.filter((_, i) => i !== selectedKey.keycodeIndex),
        )
      } else {
        const newKeycodes = [...action.keycodes]
        newKeycodes[selectedKey.keycodeIndex] = code
        setKeycodeAt(selectedKey.actionIndex, newKeycodes)
      }
    },
    onCommit() {
      setSelectedKey(null)
    },
    resetKey: selectedKey,
    initialValue: macroInitialValue,
    quickSelect,
  })

  const tabContentOverride = useTileContentOverride(
    tapDanceEntries,
    deserializedMacros,
    maskedSelection.handleKeycodeSelect,
  )

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
    if (selectedKey) {
      const action = currentActions[selectedKey.actionIndex]
      if (
        isKeycodeAction(action) &&
        action.keycodes[selectedKey.keycodeIndex] !== preEditValueRef.current
      ) {
        const newKeycodes = [...action.keycodes]
        newKeycodes[selectedKey.keycodeIndex] = preEditValueRef.current
        setKeycodeAt(selectedKey.actionIndex, newKeycodes)
      }
    }
    maskedSelection.clearMask()
    setSelectedKey(null)
  }, [selectedKey, currentActions, setKeycodeAt, maskedSelection.clearMask])

  // Close picker when clicking outside of it.
  useEffect(() => {
    if (!isEditing) return
    function handler(e: MouseEvent): void {
      const target = e.target as Node | null
      if (!target) return
      if (pickerRef.current?.contains(target)) return
      // Resolve to Element for text node targets (e.g. spans inside buttons)
      const el = target instanceof Element ? target : target.parentElement
      if (el?.closest('[data-testid="keycode-field"]')) return
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
    handleMaskPartClick,
    applyPopoverKeycode,
    handlePopoverKeycodeSelect,
    closePopover,
    revertAndDeselect,
  }
}
