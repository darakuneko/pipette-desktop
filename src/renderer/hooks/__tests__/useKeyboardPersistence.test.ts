// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Focuses on `applyVilFile`'s `keymapRestoreSeq` bump — the single signal
// App.tsx's restore-cleanup effect watches for (Plan-qwerty-select-no-rewrite
// §snapshot/.vil 復元時のクリーンアップ, D1). Snapshot/layout-store restore
// and `.vil` import both converge on this function, so proving the bump
// fires here covers both call sites without needing App.tsx's own harness.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useState, useRef } from 'react'
import { useKeyboardPersistence } from '../useKeyboardPersistence'
import { emptyState } from '../keyboard-types'
import type { KeyboardState, BootGuardRef } from '../keyboard-types'
import { VALID_VIL, MODIFIED_VIL } from './fixtures/valid-vil'

function useHarness(initial?: Partial<KeyboardState>) {
  const [state, setState] = useState<KeyboardState>({ ...emptyState(), isDummy: true, ...initial })
  const stateRef = useRef(state)
  stateRef.current = state
  const qmkSettingsBaselineRef = useRef<Record<string, number[]>>({})
  const saveLayerNamesRef = useRef<((names: string[]) => void) | null>(null)
  const bootGuardRef = useRef<BootGuardRef>({ onUnlock: null })
  const waitForUnlock = vi.fn(async () => {})
  const bumpActivity = vi.fn()

  const persistence = useKeyboardPersistence(
    setState,
    { stateRef, qmkSettingsBaselineRef, saveLayerNamesRef },
    bumpActivity,
    bootGuardRef,
    waitForUnlock,
  )

  return { state, ...persistence }
}

describe('useKeyboardPersistence — applyVilFile keymapRestoreSeq bump', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts at 0 and increments by exactly 1 on a successful restore', async () => {
    const { result } = renderHook(() => useHarness())
    expect(result.current.state.keymapRestoreSeq).toBe(0)

    await act(async () => {
      await result.current.applyVilFile(VALID_VIL)
    })

    expect(result.current.state.keymapRestoreSeq).toBe(1)
  })

  it('increments once per restore across repeated calls (.vil import and layout-store/snapshot restore both funnel through here)', async () => {
    const { result } = renderHook(() => useHarness())

    await act(async () => {
      await result.current.applyVilFile(VALID_VIL)
    })
    expect(result.current.state.keymapRestoreSeq).toBe(1)

    await act(async () => {
      await result.current.applyVilFile(MODIFIED_VIL)
    })
    expect(result.current.state.keymapRestoreSeq).toBe(2)
  })

  it('applies the keymap/encoder layout from the restored file alongside the bump', async () => {
    const { result } = renderHook(() => useHarness())

    await act(async () => {
      await result.current.applyVilFile(VALID_VIL)
    })

    expect(result.current.state.keymap.get('0,0,0')).toBe(0x4f)
    expect(result.current.state.encoderLayout.get('0,0,0')).toBe(0x81)
    expect(result.current.state.keymapRestoreSeq).toBe(1)
  })
})
