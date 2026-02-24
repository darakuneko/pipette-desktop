// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMaskedKeycodeSelection } from '../useMaskedKeycodeSelection'
import { resolve, deserialize, recreateKeyboardKeycodes } from '../../../shared/keycodes/keycodes'
import type { Keycode } from '../../../shared/keycodes/keycodes'
import { keycodesV6 } from '../../../shared/keycodes/keycodes-v6'

beforeEach(() => {
  recreateKeyboardKeycodes({
    vialProtocol: 6,
    layers: 4,
    macroCount: 0,
    tapDanceCount: 0,
    customKeycodes: null,
    midi: '',
    supportedFeatures: new Set(),
  })
})

// Build a minimal Keycode-like object for the hook without constructor side effects
function fakeKeycode(qmkId: string, masked = false): Keycode {
  return { qmkId, label: qmkId, masked, alias: [qmkId], hidden: false } as Keycode
}

describe('useMaskedKeycodeSelection', () => {
  it('passes normal (non-masked) keycode through without auto-commit', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('KC_A'))
    })

    expect(onUpdate).toHaveBeenCalledWith(deserialize('KC_A'))
    // Normal keys no longer auto-commit — user must call confirm()
    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.activeMask).toBeNull()
    expect(result.current.maskOnly).toBe(false)
    expect(result.current.lmMode).toBe(false)
    expect(result.current.editingPart).toBeNull()

    // Explicit confirm
    act(() => {
      result.current.confirm()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('enters two-step mode for masked keycode (step 1 writes mask and does not commit)', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })

    expect(onUpdate).toHaveBeenCalledWith(deserialize('LSFT(kc)'))
    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.activeMask).toBe(deserialize('LSFT(kc)'))
    expect(result.current.maskOnly).toBe(true)
    expect(result.current.lmMode).toBe(false)
    expect(result.current.editingPart).toBe('inner')
  })

  it('builds final keycode from LSFT mask + basic key (step 2) without auto-commit', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })
    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('KC_A'))
    })

    const mask = deserialize('LSFT(kc)')
    const inner = deserialize('KC_A')
    expect(onUpdate).toHaveBeenLastCalledWith((mask & 0xff00) | (inner & 0x00ff))
    // Step 2 no longer auto-commits — user must call confirm()
    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.activeMask).not.toBeNull()
    expect(result.current.editingPart).toBe('inner')

    // Explicit confirm
    act(() => {
      result.current.confirm()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(result.current.activeMask).toBeNull()
    expect(result.current.editingPart).toBeNull()
  })

  it('builds final keycode for LT mask', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LT0(kc)', true))
    })
    expect(result.current.maskOnly).toBe(true)
    expect(result.current.lmMode).toBe(false)

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('KC_B'))
    })

    const mask = deserialize('LT0(kc)')
    const inner = deserialize('KC_B')
    expect(onUpdate).toHaveBeenLastCalledWith((mask & 0xff00) | (inner & 0x00ff))
    expect(onCommit).not.toHaveBeenCalled()

    act(() => {
      result.current.confirm()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('builds final keycode for LM mask using QMK_LM_MASK', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LM0(kc)', true))
    })
    expect(result.current.lmMode).toBe(true)
    expect(result.current.maskOnly).toBe(false)

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('MOD_LCTL'))
    })

    const mask = deserialize('LM0(kc)')
    const modMask = resolve('QMK_LM_MASK')
    const modCode = keycodesV6.kc.MOD_LCTL
    expect(onUpdate).toHaveBeenLastCalledWith((mask & ~modMask) | (modCode & modMask))
    expect(onCommit).not.toHaveBeenCalled()

    act(() => {
      result.current.confirm()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('builds final keycode for ModTap (LCTL_T) mask', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LCTL_T(kc)', true))
    })
    expect(result.current.maskOnly).toBe(true)

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('KC_A'))
    })

    const mask = deserialize('LCTL_T(kc)')
    const inner = deserialize('KC_A')
    expect(onUpdate).toHaveBeenLastCalledWith((mask & 0xff00) | (inner & 0x00ff))
    expect(onCommit).not.toHaveBeenCalled()

    act(() => {
      result.current.confirm()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('builds final keycode for SH_T (Swap Hands Tap) mask', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('SH_T(kc)', true))
    })
    expect(result.current.maskOnly).toBe(true)

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('KC_A'))
    })

    const mask = deserialize('SH_T(kc)')
    const inner = deserialize('KC_A')
    expect(onUpdate).toHaveBeenLastCalledWith((mask & 0xff00) | (inner & 0x00ff))
    expect(onCommit).not.toHaveBeenCalled()

    act(() => {
      result.current.confirm()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  it('clears activeMask when resetKey changes (no initialValue)', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result, rerender } = renderHook(
      ({ resetKey }) => useMaskedKeycodeSelection({ onUpdate, onCommit, resetKey }),
      { initialProps: { resetKey: 'field1' as unknown } },
    )

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })
    expect(result.current.activeMask).not.toBeNull()

    rerender({ resetKey: 'field2' })
    expect(result.current.activeMask).toBeNull()
    expect(result.current.editingPart).toBeNull()
  })

  it('clears activeMask when clearMask is called', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })
    expect(result.current.activeMask).not.toBeNull()

    act(() => {
      result.current.clearMask()
    })
    expect(result.current.activeMask).toBeNull()
    expect(result.current.editingPart).toBeNull()
  })

  it('does not reset mask state when onUpdate returns false for normal key', () => {
    const onUpdate = vi.fn().mockReturnValue(false)
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('KC_A'))
    })

    expect(onUpdate).toHaveBeenCalledWith(deserialize('KC_A'))
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('does not enter mask mode when onUpdate returns false for masked keycode', () => {
    const onUpdate = vi.fn().mockReturnValue(false)
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })

    expect(onUpdate).toHaveBeenCalledWith(deserialize('LSFT(kc)'))
    expect(result.current.activeMask).toBeNull()
    expect(result.current.maskOnly).toBe(false)
  })

  // --- New tests for initialValue auto-detection ---

  it('auto-detects masked initialValue and enters inner editing', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    // LSFT(KC_A) = LSFT mask | KC_A
    const lsftA = (deserialize('LSFT(kc)') & 0xff00) | (deserialize('KC_A') & 0x00ff)
    const { result } = renderHook(() =>
      useMaskedKeycodeSelection({
        onUpdate,
        onCommit,
        resetKey: 'field1',
        initialValue: lsftA,
      }),
    )

    expect(result.current.activeMask).toBe(lsftA)
    expect(result.current.editingPart).toBe('inner')
    expect(result.current.maskOnly).toBe(true)
  })

  it('does not auto-detect non-masked initialValue', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useMaskedKeycodeSelection({
        onUpdate,
        onCommit,
        resetKey: 'field1',
        initialValue: deserialize('KC_A'),
      }),
    )

    expect(result.current.activeMask).toBeNull()
    expect(result.current.editingPart).toBeNull()
  })

  it('does not auto-detect when initialValue is 0', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() =>
      useMaskedKeycodeSelection({
        onUpdate,
        onCommit,
        resetKey: 'field1',
        initialValue: 0,
      }),
    )

    expect(result.current.activeMask).toBeNull()
    expect(result.current.editingPart).toBeNull()
  })

  // --- setEditingPart tests ---

  it('setEditingPart switches to outer editing', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })
    expect(result.current.editingPart).toBe('inner')
    expect(result.current.maskOnly).toBe(true)

    act(() => {
      result.current.setEditingPart('outer')
    })
    expect(result.current.editingPart).toBe('outer')
    // When editing outer, maskOnly/lmMode should be false (show all keycodes)
    expect(result.current.maskOnly).toBe(false)
    expect(result.current.lmMode).toBe(false)
  })

  it('setEditingPart switches back to inner editing', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })
    act(() => {
      result.current.setEditingPart('outer')
    })
    expect(result.current.editingPart).toBe('outer')

    act(() => {
      result.current.setEditingPart('inner')
    })
    expect(result.current.editingPart).toBe('inner')
    expect(result.current.maskOnly).toBe(true)
  })

  // --- Outer editing behavior ---

  it('outer editing: selecting masked keycode updates mask and switches to inner', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    // Enter mask mode with LSFT
    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })
    // Switch to outer editing
    act(() => {
      result.current.setEditingPart('outer')
    })
    // Select a different mask (LT0)
    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LT0(kc)', true))
    })

    expect(onUpdate).toHaveBeenLastCalledWith(deserialize('LT0(kc)'))
    expect(result.current.activeMask).toBe(deserialize('LT0(kc)'))
    expect(result.current.editingPart).toBe('inner')
  })

  it('outer editing: selecting normal keycode replaces value without auto-commit', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    // Enter mask mode with LSFT
    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })
    // Switch to outer editing
    act(() => {
      result.current.setEditingPart('outer')
    })
    // Select a normal key — should exit mask mode but not auto-commit
    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('KC_A'))
    })

    expect(onUpdate).toHaveBeenLastCalledWith(deserialize('KC_A'))
    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.activeMask).toBeNull()
    expect(result.current.editingPart).toBeNull()

    // Explicit confirm
    act(() => {
      result.current.confirm()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
  })

  // --- Veto regression tests ---

  it('does not reset mask state when onUpdate returns false for normal key during outer editing', () => {
    const onUpdate = vi.fn().mockReturnValue(false)
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    // Enter mask mode
    onUpdate.mockReturnValueOnce(undefined)
    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })
    expect(result.current.activeMask).not.toBeNull()

    // Switch to outer editing
    act(() => {
      result.current.setEditingPart('outer')
    })

    // Try to select a normal key with veto
    onUpdate.mockReturnValue(false)
    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('KC_A'))
    })

    // Mask state should be preserved since update was vetoed
    expect(onCommit).not.toHaveBeenCalled()
    expect(result.current.activeMask).not.toBeNull()
    expect(result.current.editingPart).toBe('outer')
  })

  // --- enterMaskMode tests ---

  it('enterMaskMode sets mask and editing part, skipping auto-detection on next resetKey', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const lsftA = (deserialize('LSFT(kc)') & 0xff00) | (deserialize('KC_A') & 0x00ff)
    const { result, rerender } = renderHook(
      ({ resetKey, initialValue }: { resetKey: unknown; initialValue?: number }) =>
        useMaskedKeycodeSelection({ onUpdate, onCommit, resetKey, initialValue }),
      { initialProps: { resetKey: null as unknown, initialValue: undefined as number | undefined } },
    )

    // Manually enter mask mode with 'outer' part before selecting a field
    act(() => {
      result.current.enterMaskMode(lsftA, 'outer')
    })
    expect(result.current.activeMask).toBe(lsftA)
    expect(result.current.editingPart).toBe('outer')

    // Simulate field selection (resetKey change) — should NOT override the manual state
    rerender({ resetKey: 'field1', initialValue: lsftA })
    expect(result.current.activeMask).toBe(lsftA)
    expect(result.current.editingPart).toBe('outer')
  })

  it('enterMaskMode with inner part enters inner editing directly', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const lt0A = deserialize('LT0(kc)') | (deserialize('KC_A') & 0x00ff)
    const { result, rerender } = renderHook(
      ({ resetKey, initialValue }: { resetKey: unknown; initialValue?: number }) =>
        useMaskedKeycodeSelection({ onUpdate, onCommit, resetKey, initialValue }),
      { initialProps: { resetKey: null as unknown, initialValue: undefined as number | undefined } },
    )

    act(() => {
      result.current.enterMaskMode(lt0A, 'inner')
    })

    rerender({ resetKey: 'field1', initialValue: lt0A })
    expect(result.current.activeMask).toBe(lt0A)
    expect(result.current.editingPart).toBe('inner')
    expect(result.current.maskOnly).toBe(true)
  })

  it('auto-detection resumes after enterMaskMode is consumed', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const lsftA = (deserialize('LSFT(kc)') & 0xff00) | (deserialize('KC_A') & 0x00ff)
    const { result, rerender } = renderHook(
      ({ resetKey, initialValue }: { resetKey: unknown; initialValue?: number }) =>
        useMaskedKeycodeSelection({ onUpdate, onCommit, resetKey, initialValue }),
      { initialProps: { resetKey: null as unknown, initialValue: undefined as number | undefined } },
    )

    // Use enterMaskMode and consume it with first resetKey change
    act(() => {
      result.current.enterMaskMode(lsftA, 'outer')
    })
    rerender({ resetKey: 'field1', initialValue: lsftA })
    expect(result.current.editingPart).toBe('outer') // manual override

    // Second resetKey change should use normal auto-detection (defaults to 'inner')
    rerender({ resetKey: 'field2', initialValue: lsftA })
    expect(result.current.editingPart).toBe('inner') // auto-detected
  })

  // --- confirm() tests ---

  it('confirm() calls onCommit and resets state', () => {
    const onUpdate = vi.fn()
    const onCommit = vi.fn()
    const { result } = renderHook(() => useMaskedKeycodeSelection({ onUpdate, onCommit }))

    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('LSFT(kc)', true))
    })
    act(() => {
      result.current.handleKeycodeSelect(fakeKeycode('KC_A'))
    })
    expect(onCommit).not.toHaveBeenCalled()

    act(() => {
      result.current.confirm()
    })
    expect(onCommit).toHaveBeenCalledTimes(1)
    expect(result.current.activeMask).toBeNull()
    expect(result.current.editingPart).toBeNull()
    expect(result.current.maskOnly).toBe(false)
  })
})
