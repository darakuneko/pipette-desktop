// SPDX-License-Identifier: GPL-2.0-or-later

import { useState, useCallback, useMemo, useRef } from 'react'
import type { Keycode } from '../../../shared/keycodes/keycodes'

export interface UseKeymapMultiSelectOptions {
  /** Ref that tracks whether a single key or encoder is currently selected.
   *  Using a ref avoids a circular dependency: multiSelect is created before
   *  the selection-handlers hook that owns selectedKey/selectedEncoder. */
  hasActiveSingleSelectionRef: React.RefObject<boolean>
}

export interface UseKeymapMultiSelectReturn {
  multiSelectedKeys: Set<string>
  setMultiSelectedKeys: React.Dispatch<React.SetStateAction<Set<string>>>
  selectionAnchor: { row: number; col: number } | null
  setSelectionAnchor: React.Dispatch<React.SetStateAction<{ row: number; col: number } | null>>
  selectionSourcePane: 'primary' | 'secondary' | null
  setSelectionSourcePane: React.Dispatch<React.SetStateAction<'primary' | 'secondary' | null>>
  selectionMode: 'ctrl' | 'shift'
  setSelectionMode: React.Dispatch<React.SetStateAction<'ctrl' | 'shift'>>
  pickerSelectedKeycodes: Keycode[]
  setPickerSelectedKeycodes: React.Dispatch<React.SetStateAction<Keycode[]>>
  pickerSelectedSet: Set<string>
  clearMultiSelection: () => void
  clearPickerSelection: () => void
  handlePickerMultiSelect: (kc: Keycode, event: { ctrlKey: boolean; shiftKey: boolean }, tabKeycodes: Keycode[]) => void
}

export function useKeymapMultiSelect({
  hasActiveSingleSelectionRef,
}: UseKeymapMultiSelectOptions): UseKeymapMultiSelectReturn {
  const [multiSelectedKeys, setMultiSelectedKeys] = useState<Set<string>>(new Set())
  const [selectionAnchor, setSelectionAnchor] = useState<{ row: number; col: number } | null>(null)
  const [selectionSourcePane, setSelectionSourcePane] = useState<'primary' | 'secondary' | null>(null)
  const [selectionMode, setSelectionMode] = useState<'ctrl' | 'shift'>('ctrl')

  const [pickerSelectedKeycodes, setPickerSelectedKeycodes] = useState<Keycode[]>([])
  const [pickerAnchor, setPickerAnchor] = useState<string | null>(null)

  const pickerSelectedSet = useMemo(
    () => new Set(pickerSelectedKeycodes.map((kc) => kc.qmkId)),
    [pickerSelectedKeycodes],
  )

  /** Clear multi-selection only if non-empty (avoids unnecessary re-renders). */
  const clearMultiSelection = useCallback(() => {
    setMultiSelectedKeys((prev) => prev.size === 0 ? prev : new Set())
    setSelectionAnchor(null)
    setSelectionSourcePane(null)
  }, [])

  const clearPickerSelection = useCallback(() => {
    setPickerSelectedKeycodes((prev) => prev.length === 0 ? prev : [])
    setPickerAnchor(null)
  }, [])

  // Mirror pickerAnchor into a ref so handlePickerMultiSelect can read
  // the latest value without listing it as a dependency (avoids stale closure).
  const pickerAnchorRef = useRef<string | null>(null)
  pickerAnchorRef.current = pickerAnchor

  const handlePickerMultiSelect = useCallback(
    (kc: Keycode, event: { ctrlKey: boolean; shiftKey: boolean }, tabKeycodes: Keycode[]) => {
      if (hasActiveSingleSelectionRef.current) return

      setMultiSelectedKeys((prev) => prev.size === 0 ? prev : new Set())
      setSelectionAnchor(null)
      setSelectionSourcePane(null)

      if (event.ctrlKey) {
        setPickerSelectedKeycodes((prev) => {
          const exists = prev.some((k) => k.qmkId === kc.qmkId)
          return exists ? prev.filter((k) => k.qmkId !== kc.qmkId) : [...prev, kc]
        })
        setPickerAnchor(kc.qmkId)
      } else if (event.shiftKey) {
        const anchor = pickerAnchorRef.current
        if (!anchor) {
          // No anchor yet: select just the clicked keycode and set anchor
          setPickerSelectedKeycodes([kc])
          setPickerAnchor(kc.qmkId)
          return
        }
        const anchorIdx = tabKeycodes.findIndex((k) => k.qmkId === anchor)
        const currentIdx = tabKeycodes.findIndex((k) => k.qmkId === kc.qmkId)
        if (anchorIdx >= 0 && currentIdx >= 0) {
          const start = Math.min(anchorIdx, currentIdx)
          const end = Math.max(anchorIdx, currentIdx)
          // Replace entire selection with the range in tab (display) order
          setPickerSelectedKeycodes(tabKeycodes.slice(start, end + 1))
        }
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
    pickerSelectedKeycodes,
    setPickerSelectedKeycodes,
    pickerSelectedSet,
    clearMultiSelection,
    clearPickerSelection,
    handlePickerMultiSelect,
  }
}
