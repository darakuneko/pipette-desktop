// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useState } from 'react'
import { useMacroKeycodeSelection } from '../useMacroKeycodeSelection'
import { recreateKeyboardKeycodes, deserialize } from '../../../shared/keycodes/keycodes'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import type { MacroAction } from '../../../preload/macro'

beforeEach(() => {
  recreateKeyboardKeycodes({
    vialProtocol: 6,
    layers: 4,
    macroCount: 4,
    tapDanceCount: 0,
    customKeycodes: null,
    midi: '',
    supportedFeatures: new Set(),
  })
})

function fakeKey(qmkId: string): Keycode {
  return { qmkId, label: qmkId, masked: false, alias: [qmkId], hidden: false } as Keycode
}

function tap(keycodes: number[]): MacroAction {
  return { type: 'tap', keycodes }
}

function useTestHarness(initial: MacroAction[][], autoAdvance = false) {
  const [macros, setMacros] = useState<MacroAction[][]>(initial)
  const selection = useMacroKeycodeSelection({
    currentActions: macros[0] ?? [],
    activeMacro: 0,
    setMacros,
    setDirty: vi.fn(),
    clearPending: vi.fn(),
    autoAdvance,
  })
  return { macros, setMacros, selection }
}

describe('useMacroKeycodeSelection revert/commit', () => {
  it('revertAndDeselect restores original keycodes after a picker pick', () => {
    const orig = [deserialize('KC_T'), deserialize('KC_T'), deserialize('KC_T'), deserialize('KC_Y')]
    const { result } = renderHook(() => useTestHarness([[tap(orig)]]))

    act(() => { result.current.selection.handleKeycodeClick(0, 3) })
    act(() => { result.current.selection.maskedSelection.pickerSelect(fakeKey('KC_W')) })
    expect(result.current.macros[0][0]).toEqual(
      tap([...orig.slice(0, 3), deserialize('KC_W')]),
    )

    act(() => { result.current.selection.revertAndDeselect() })
    expect(result.current.macros[0][0]).toEqual(tap(orig))
    expect(result.current.selection.selectedKey).toBeNull()
  })

  it('commitAndDeselect preserves the picked keycode', () => {
    const orig = [deserialize('KC_T'), deserialize('KC_Y')]
    const { result } = renderHook(() => useTestHarness([[tap(orig)]]))

    act(() => { result.current.selection.handleKeycodeClick(0, 1) })
    act(() => { result.current.selection.maskedSelection.pickerSelect(fakeKey('KC_W')) })

    act(() => { result.current.selection.commitAndDeselect() })
    expect(result.current.macros[0][0]).toEqual(tap([orig[0], deserialize('KC_W')]))
    expect(result.current.selection.selectedKey).toBeNull()
  })

  it('revertAndDeselect drops a virtual slot added via handleKeycodeAdd + pick', () => {
    const orig = [deserialize('KC_T'), deserialize('KC_T'), deserialize('KC_T')]
    const { result } = renderHook(() => useTestHarness([[tap(orig)]]))

    act(() => { result.current.selection.handleKeycodeAdd(0) })
    act(() => { result.current.selection.maskedSelection.pickerSelect(fakeKey('KC_W')) })
    expect(result.current.macros[0][0]).toEqual(tap([...orig, deserialize('KC_W')]))

    act(() => { result.current.selection.revertAndDeselect() })
    expect(result.current.macros[0][0]).toEqual(tap(orig))
  })

  it('revertAndDeselect after beginAddAction removes the newly-added action entirely', () => {
    const orig: MacroAction[] = [tap([deserialize('KC_T')])]
    const { result } = renderHook(() => useTestHarness([orig]))

    act(() => { result.current.selection.beginAddAction(tap([0])) })
    expect(result.current.macros[0]).toHaveLength(2)
    act(() => { result.current.selection.maskedSelection.pickerSelect(fakeKey('KC_R')) })
    expect(result.current.macros[0][1]).toEqual(tap([deserialize('KC_R')]))

    act(() => { result.current.selection.revertAndDeselect() })
    expect(result.current.macros[0]).toEqual(orig)
  })

  it('commitAndDeselect after beginAddAction keeps the newly-added action', () => {
    const orig: MacroAction[] = [tap([deserialize('KC_T')])]
    const { result } = renderHook(() => useTestHarness([orig]))

    act(() => { result.current.selection.beginAddAction(tap([0])) })
    act(() => { result.current.selection.maskedSelection.pickerSelect(fakeKey('KC_R')) })
    act(() => { result.current.selection.commitAndDeselect() })

    expect(result.current.macros[0]).toEqual([orig[0], tap([deserialize('KC_R')])])
  })

  it('hasPendingEdit tracks whether currentActions differs from the snapshot', () => {
    const orig = [deserialize('KC_T'), deserialize('KC_Y')]
    const { result } = renderHook(() => useTestHarness([[tap(orig)]]))

    expect(result.current.selection.hasPendingEdit).toBe(false)

    act(() => { result.current.selection.handleKeycodeClick(0, 1) })
    expect(result.current.selection.hasPendingEdit).toBe(false)

    act(() => { result.current.selection.maskedSelection.pickerSelect(fakeKey('KC_W')) })
    expect(result.current.selection.hasPendingEdit).toBe(true)

    act(() => { result.current.selection.revertAndDeselect() })
    expect(result.current.selection.hasPendingEdit).toBe(false)
  })

  it('isExistingEdit is true for an existing-slot edit and false for beginAddAction', () => {
    const orig: MacroAction[] = [tap([deserialize('KC_T')])]
    const { result } = renderHook(() => useTestHarness([orig]))

    act(() => { result.current.selection.handleKeycodeClick(0, 0) })
    expect(result.current.selection.isExistingEdit).toBe(true)
    act(() => { result.current.selection.commitAndDeselect() })

    act(() => { result.current.selection.beginAddAction(tap([0])) })
    expect(result.current.selection.isExistingEdit).toBe(false)
  })

  it('externally clearing selectedKey invalidates the snapshot (no stale revert)', () => {
    const orig = [deserialize('KC_T'), deserialize('KC_Y')]
    const { result } = renderHook(() => useTestHarness([[tap(orig)]]))

    act(() => { result.current.selection.handleKeycodeClick(0, 1) })
    act(() => { result.current.selection.maskedSelection.pickerSelect(fakeKey('KC_W')) })

    // Simulate an external commit path (e.g. updateActions / revertAction)
    // that clears selectedKey without going through commitAndDeselect.
    act(() => { result.current.selection.setSelectedKey(null) })

    // A later revertAndDeselect must not resurrect the pre-edit keycodes.
    const afterExternalClear = result.current.macros[0][0]
    act(() => { result.current.selection.revertAndDeselect() })
    expect(result.current.macros[0][0]).toEqual(afterExternalClear)
  })

  it('revertAndDeselect after autoAdvance picks restores the full original array', () => {
    const orig = [deserialize('KC_A'), deserialize('KC_B'), deserialize('KC_C'), deserialize('KC_D')]
    const { result } = renderHook(() => useTestHarness([[tap(orig)]], /* autoAdvance */ true))

    act(() => { result.current.selection.handleKeycodeClick(0, 1) })
    act(() => { result.current.selection.maskedSelection.pickerSelect(fakeKey('KC_X')) })
    act(() => { result.current.selection.maskedSelection.pickerSelect(fakeKey('KC_Y')) })
    expect(result.current.macros[0][0]).toEqual(tap([
      orig[0], deserialize('KC_X'), deserialize('KC_Y'), orig[3],
    ]))

    act(() => { result.current.selection.revertAndDeselect() })
    expect(result.current.macros[0][0]).toEqual(tap(orig))
  })
})
