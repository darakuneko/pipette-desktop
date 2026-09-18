// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Covers two things `applyVilFile` does on every restore:
//  - the `keymapRestoreSeq` bump — the single signal App.tsx's
//    restore-cleanup effect watches for (Plan-qwerty-select-no-rewrite
//    §snapshot/.vil 復元時のクリーンアップ, D1). Snapshot/layout-store
//    restore and `.vil` import both converge on this function, so proving
//    the bump fires here covers both call sites without needing App.tsx's
//    own harness.
//  - QMK settings restore only applying qsids the connected firmware
//    supports, and keeping local state in sync with what was actually
//    written to the device.

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

  it('reset() (disconnect) carries the counter forward instead of zeroing it, so it does not look like a fresh restore to consumers watching for a change', async () => {
    const { result } = renderHook(() => useHarness())

    await act(async () => {
      await result.current.applyVilFile(VALID_VIL)
    })
    expect(result.current.state.keymapRestoreSeq).toBe(1)

    act(() => {
      result.current.reset()
    })
    expect(result.current.state.keymapRestoreSeq).toBe(1)
    // Everything else is wiped back to the empty-state defaults.
    expect(result.current.state.keymap.size).toBe(0)
  })
})

describe('applyVilFile qmk settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips qmk settings qsids the connected firmware does not report as supported (HID path), and only stores the applied qsid in local state', async () => {
    const originalVialAPI = window.vialAPI
    const qmkSettingsSet = vi.fn(async () => {})
    window.vialAPI = {
      setKeycode: vi.fn(async () => {}),
      setEncoder: vi.fn(async () => {}),
      setMacroBuffer: vi.fn(async () => {}),
      setLayoutOptions: vi.fn(async () => {}),
      setTapDance: vi.fn(async () => {}),
      setCombo: vi.fn(async () => {}),
      setKeyOverride: vi.fn(async () => {}),
      setAltRepeatKey: vi.fn(async () => {}),
      qmkSettingsSet,
    } as unknown as typeof window.vialAPI

    try {
      // VALID_VIL carries qsids '1' and '2'; only qsid 1 is reported as
      // supported by the (mocked) connected keyboard.
      const { result } = renderHook(() =>
        useHarness({
          isDummy: false,
          supportedQsids: new Set([1]),
          unlockStatus: { unlocked: true, inProgress: false, keys: [] },
        }),
      )

      await act(async () => {
        await result.current.applyVilFile(VALID_VIL)
      })

      expect(qmkSettingsSet).toHaveBeenCalledTimes(1)
      expect(qmkSettingsSet).toHaveBeenCalledWith(1, [0])

      // qsid 2 was never written to the device, so it must not be claimed
      // by local state either — otherwise serialize()/resolveTappingTerm
      // would report a value the device never accepted.
      expect(result.current.state.qmkSettingsValues).toEqual({ '1': [0] })
      expect(result.current.state.qmkSettingsValues).not.toHaveProperty('2')
    } finally {
      window.vialAPI = originalVialAPI
    }
  })
})
