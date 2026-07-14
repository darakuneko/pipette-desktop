// SPDX-License-Identifier: GPL-2.0-or-later

// Wires `useViewMatrixMode`'s bare on/off + selection state into the
// keymap editor: entry/exit gating (forces the matrix tester off, clears
// selection), per-key click handling while the mode is active, the panel's
// Row/Col axis edits, and the per-key legend/collision-color overlay drawn
// on the primary pane.

import { useCallback, useMemo } from 'react'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { posKey } from '../../../shared/kle/pos-key'
import type { KleKey, KeyboardLayout } from '../../../shared/kle/types'
import type { ViewMatrixCell } from '../../../shared/types/pipette-settings'
import { KEY_DUPLICATE_COLOR } from '../keyboard/constants'
import { applyViewMatrixAxisToSelection, effectiveViewPos } from './view-matrix'
import { useViewMatrixMode, type UseViewMatrixModeReturn } from './useViewMatrixMode'

export interface UseViewMatrixEditingOptions {
  layout: KeyboardLayout | null
  viewMatrix?: Record<string, ViewMatrixCell>
  onViewMatrixChange?: (next: Record<string, ViewMatrixCell> | undefined) => void
  rows?: number
  cols?: number
  selectableKeys: KleKey[]
  matrixMode: boolean
  handleMatrixToggle: () => void
  handleDeselect: () => void
  handleKeycodeSelect: (kc: Keycode) => Promise<void>
}

export interface UseViewMatrixEditingReturn {
  viewMatrixMode: UseViewMatrixModeReturn
  handleToggleViewMatrixMode: () => void
  handleViewMatrixKeyClick: (key: KleKey, maskClicked: boolean, event?: { ctrlKey: boolean; shiftKey: boolean }) => void
  viewMatrixSelectedPositions: { row: number; col: number }[]
  viewMatrixEffectiveSingle: { row: number; col: number } | null
  handleViewMatrixAxisChange: (axis: 'row' | 'col', value: number) => void
  viewMatrixAxisOptionCount: number
  viewMatrixLabelOverrides: Map<string, { outer: string; inner: string; masked: boolean }> | undefined
  viewMatrixDuplicateKeyColors: Map<string, string> | undefined
  /** Keycode palette selection is a no-op while the mode is active — see
   *  the no-op wrapper below. */
  gatedHandleKeycodeSelect: (kc: Keycode) => void
}

export function useViewMatrixEditing({
  layout, viewMatrix, onViewMatrixChange, rows, cols, selectableKeys,
  matrixMode, handleMatrixToggle, handleDeselect, handleKeycodeSelect,
}: UseViewMatrixEditingOptions): UseViewMatrixEditingReturn {
  const viewMatrixMode = useViewMatrixMode()

  // --- View Matrix mode: entry/exit + per-key gating ---
  // Entering the mode forces the matrix (Key Tester) tool off and clears
  // any lingering selection so the blank R/C legend view starts clean.
  const handleToggleViewMatrixMode = useCallback(() => {
    if (!viewMatrixMode.active) {
      if (matrixMode) handleMatrixToggle()
      handleDeselect()
    }
    viewMatrixMode.toggle()
    // Depend on the stable members, not the wrapper object (a fresh
    // literal every render) — the object identity would churn this
    // callback per render.
  }, [viewMatrixMode.active, viewMatrixMode.toggle, matrixMode, handleMatrixToggle, handleDeselect])

  // Clicking a key in the mode selects it for the panel's Row/Col selects
  // — encoders and decals have no physical row/col to override, so they
  // stay inert (unaffected) rather than gaining a click handler. Ctrl/Cmd
  // toggles the key in/out of a multi-selection, Shift extends a
  // contiguous range (mirrors the normal-mode keymap multi-select's
  // modifier conventions — see `useKeymapMultiSelect`).
  const handleViewMatrixKeyClick = useCallback((
    key: KleKey,
    _maskClicked: boolean,
    event?: { ctrlKey: boolean; shiftKey: boolean },
  ) => {
    if (key.decal || key.encoderIdx >= 0) return
    if (event?.ctrlKey) { viewMatrixMode.toggleKeySelection(key.row, key.col); return }
    if (event?.shiftKey) { viewMatrixMode.extendSelection(key.row, key.col, selectableKeys); return }
    viewMatrixMode.selectKey(key.row, key.col)
    // The hook's setters are useCallback-stable; depending on the wrapper
    // object would defeat KeyboardWidget's memo on every render while the
    // mode is active (80+ KeyWidget re-renders).
  }, [viewMatrixMode.toggleKeySelection, viewMatrixMode.extendSelection, viewMatrixMode.selectKey, selectableKeys])

  // Physical positions of the currently selected keys, parsed from the
  // hook's "row,col" string set into the shape `applyViewMatrixAxisToSelection`
  // expects.
  const viewMatrixSelectedPositions = useMemo(() => [...viewMatrixMode.selectedKeys].map((pos) => {
    const [row, col] = pos.split(',').map(Number)
    return { row, col }
  }), [viewMatrixMode.selectedKeys])

  // Effective position of the single selected key — null with 0 or 2+ keys
  // selected, where the panel's selects show a blank placeholder instead
  // since a multi-selection's members may not share the same position.
  const viewMatrixEffectiveSingle = useMemo(() => {
    if (viewMatrixSelectedPositions.length !== 1) return null
    const { row, col } = viewMatrixSelectedPositions[0]
    return effectiveViewPos(viewMatrix, row, col)
  }, [viewMatrixSelectedPositions, viewMatrix])

  // Row/Col select handler — a single selected key writes just that key's
  // override; 2+ selected keys bulk-apply the axis across the whole
  // selection in one `onViewMatrixChange` write, each key keeping its own
  // value on the other axis (see `applyViewMatrixAxisToSelection`).
  const handleViewMatrixAxisChange = useCallback((axis: 'row' | 'col', value: number) => {
    if (viewMatrixSelectedPositions.length === 0) return
    onViewMatrixChange?.(applyViewMatrixAxisToSelection(viewMatrix, viewMatrixSelectedPositions, axis, value))
  }, [viewMatrixSelectedPositions, viewMatrix, onViewMatrixChange])

  // View positions are logical, not physical — they only need to sort keys
  // into a 2D grid, not mirror the firmware's electrical matrix. Direct-pin
  // keyboards declare degenerate physical matrices (1×N or N×1, one row/col
  // per GPIO pin with no real electrical grid), so capping each select to
  // its own physical dimension would collapse one axis to a single option
  // and make 2D view ordering impossible. Both selects therefore share the
  // same option count: the larger of the two physical dimensions.
  const viewMatrixAxisOptionCount = Math.max(rows ?? 0, cols ?? 0)

  // One pass over the layout builds both mode legend artifacts — they
  // share the same inputs and always recompute together: the per-key R/C
  // label override showing each non-decal, non-encoder key's effective
  // position, and the fill colour map that flags keys whose effective
  // position collides with another key's (the Auto Move order between
  // colliding keys is ambiguous until resolved). The collision grouping
  // happens in this same loop (rather than a second pass over the keys)
  // so `effectiveViewPos` is computed once per key.
  const { viewMatrixLabelOverrides, viewMatrixDuplicateKeyColors } = useMemo(() => {
    if (!viewMatrixMode.active || !layout) {
      return { viewMatrixLabelOverrides: undefined, viewMatrixDuplicateKeyColors: undefined }
    }
    const overrides = new Map<string, { outer: string; inner: string; masked: boolean }>()
    // Effective position -> physical "row,col" keys resolving to it, used
    // below to find every key involved in a collision (group size > 1).
    const groups = new Map<string, string[]>()
    for (const key of layout.keys) {
      if (key.decal || key.encoderIdx >= 0) continue
      const physPos = posKey(key.row, key.col)
      const effective = effectiveViewPos(viewMatrix, key.row, key.col)
      overrides.set(physPos, { outer: `R ${effective.row}\nC ${effective.col}`, inner: '', masked: false })
      const effPos = posKey(effective.row, effective.col)
      const group = groups.get(effPos)
      if (group) group.push(physPos)
      else groups.set(effPos, [physPos])
    }
    const duplicateKeyColors = new Map<string, string>()
    for (const group of groups.values()) {
      if (group.length <= 1) continue
      for (const physPos of group) duplicateKeyColors.set(physPos, KEY_DUPLICATE_COLOR)
    }
    return {
      viewMatrixLabelOverrides: overrides,
      viewMatrixDuplicateKeyColors: duplicateKeyColors.size > 0 ? duplicateKeyColors : undefined,
    }
  }, [viewMatrixMode.active, layout, viewMatrix])

  // Keycode palette selection is a no-op while in the mode — nothing is
  // ever selected (selectedKey/selectedEncoder stay null), so this mostly
  // guards TD/Macro tile clicks, which otherwise still open their modals.
  const noopKeycodeSelect = useCallback(() => {}, [])
  const gatedHandleKeycodeSelect = viewMatrixMode.active ? noopKeycodeSelect : handleKeycodeSelect

  return {
    viewMatrixMode, handleToggleViewMatrixMode, handleViewMatrixKeyClick,
    viewMatrixSelectedPositions, viewMatrixEffectiveSingle, handleViewMatrixAxisChange,
    viewMatrixAxisOptionCount, viewMatrixLabelOverrides, viewMatrixDuplicateKeyColors,
    gatedHandleKeycodeSelect,
  }
}
