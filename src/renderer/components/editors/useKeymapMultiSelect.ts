// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo, useRef } from 'react'

export interface UseKeymapMultiSelectOptions {
  /** Ref that tracks whether a single key or encoder is currently selected.
   *  Using a ref avoids a circular dependency: multiSelect is created before
   *  the selection-handlers hook that owns selectedKey/selectedEncoder. */
  hasActiveSingleSelectionRef: React.RefObject<boolean>
}

/** A picker selection: expanded index -> keycode number. */
export type PickerSelection = Map<number, number>

export interface UseKeymapMultiSelectReturn {
  multiSelectedKeys: Set<string>
  setMultiSelectedKeys: React.Dispatch<React.SetStateAction<Set<string>>>
  selectionAnchor: { row: number; col: number } | null
  setSelectionAnchor: React.Dispatch<React.SetStateAction<{ row: number; col: number } | null>>
  selectionSourcePane: 'primary' | 'secondary' | null
  setSelectionSourcePane: React.Dispatch<React.SetStateAction<'primary' | 'secondary' | null>>
  selectionMode: 'ctrl' | 'shift'
  setSelectionMode: React.Dispatch<React.SetStateAction<'ctrl' | 'shift'>>
  /** Map of selected indices -> keycode numbers (ordered by index). */
  pickerSelected: PickerSelection
  /** Derived set of selected indices for fast .has() checks. */
  pickerSelectedIndices: Set<number>
  clearMultiSelection: () => void
  clearPickerSelection: () => void
  /**
   * Handle Ctrl+click / Shift+click on a picker keycode.
   * @param index - position in the tab's expanded keycode list
   * @param keycode - the keycode number at that position
   * @param event - modifier key state
   * @param tabKeycodeNumbers - ordered keycode numbers for the current tab (expanded, for Shift range fill)
   */
  handlePickerMultiSelect: (
    index: number,
    keycode: number,
    event: { ctrlKey: boolean; shiftKey: boolean },
    tabKeycodeNumbers: number[],
  ) => void
}

const EMPTY_MAP: PickerSelection = new Map()
const EMPTY_INDICES: Set<number> = new Set()

export function useKeymapMultiSelect({
  hasActiveSingleSelectionRef,
}: UseKeymapMultiSelectOptions): UseKeymapMultiSelectReturn {
  const [multiSelectedKeys, setMultiSelectedKeys] = useState<Set<string>>(new Set())
  const [selectionAnchor, setSelectionAnchor] = useState<{ row: number; col: number } | null>(null)
  const [selectionSourcePane, setSelectionSourcePane] = useState<'primary' | 'secondary' | null>(null)
  const [selectionMode, setSelectionMode] = useState<'ctrl' | 'shift'>('ctrl')

  const [pickerSelected, setPickerSelected] = useState<PickerSelection>(EMPTY_MAP)
  const [pickerAnchorIndex, setPickerAnchorIndex] = useState<number | null>(null)

  const pickerSelectedIndices = useMemo(
    () => pickerSelected.size === 0 ? EMPTY_INDICES : new Set(pickerSelected.keys()),
    [pickerSelected],
  )

  /** Clear multi-selection only if non-empty (avoids unnecessary re-renders). */
  const clearMultiSelection = useCallback(() => {
    setMultiSelectedKeys((prev) => prev.size === 0 ? prev : new Set())
    setSelectionAnchor(null)
    setSelectionSourcePane(null)
  }, [])

  const clearPickerSelection = useCallback(() => {
    setPickerSelected((prev) => prev.size === 0 ? prev : EMPTY_MAP)
    setPickerAnchorIndex(null)
  }, [])

  // Mirror pickerAnchorIndex into a ref so handlePickerMultiSelect can read
  // the latest value without listing it as a dependency (avoids stale closure).
  const pickerAnchorRef = useRef<number | null>(null)
  pickerAnchorRef.current = pickerAnchorIndex

  const handlePickerMultiSelect = useCallback(
    (
      index: number,
      keycode: number,
      event: { ctrlKey: boolean; shiftKey: boolean },
      tabKeycodeNumbers: number[],
    ) => {

      setMultiSelectedKeys((prev) => prev.size === 0 ? prev : new Set())
      setSelectionAnchor(null)
      setSelectionSourcePane(null)

      if (!event.ctrlKey && !event.shiftKey) {
        // Single click: clear previous, select only this key
        setPickerSelected(new Map([[index, keycode]]))
        setPickerAnchorIndex(index)
      } else if (event.ctrlKey) {
        setPickerSelected((prev) => {
          const next = new Map(prev)
          if (next.has(index)) {
            next.delete(index)
          } else {
            next.set(index, keycode)
          }
          return next
        })
        setPickerAnchorIndex(index)
      } else if (event.shiftKey) {
        const anchor = pickerAnchorRef.current
        if (anchor == null) {
          // No anchor yet: select just the clicked item and set anchor
          setPickerSelected(new Map([[index, keycode]]))
          setPickerAnchorIndex(index)
          return
        }
        const start = Math.min(anchor, index)
        const end = Math.max(anchor, index)

        const range = new Map<number, number>()
        for (let i = start; i <= end; i++) {
          if (i >= tabKeycodeNumbers.length) continue
          range.set(i, tabKeycodeNumbers[i])
        }
        setPickerSelected(range)
      }
    },
    [hasActiveSingleSelectionRef],
  )

  return {
    multiSelectedKeys,
    setMultiSelectedKeys,
    selectionAnchor,
    setSelectionAnchor,
    selectionSourcePane,
    setSelectionSourcePane,
    selectionMode,
    setSelectionMode,
    pickerSelected,
    pickerSelectedIndices,
    clearMultiSelection,
    clearPickerSelection,
    handlePickerMultiSelect,
  }
}
