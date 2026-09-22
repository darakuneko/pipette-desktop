// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// Covers two things `applyVilFile` does on every restore:
//  - the `keymapRestoreSeq` bump — the single signal App.tsx's
//    restore-cleanup effect watches for. Snapshot/layout-store restore and
//    `.vil` import both converge on this function, so proving the bump
//    fires here covers both call sites without needing App.tsx's own
//    harness.
//  - QMK settings restore only applying qsids the connected firmware
//    supports, and keeping local state in sync with what was actually
//    written to the device.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useState, useRef } from 'react'
import { useKeyboardPersistence } from '../useKeyboardPersistence'
import { emptyState } from '../keyboard-types'
import type { KeyboardState, BootGuardRef } from '../keyboard-types'
import { VALID_VIL, MODIFIED_VIL } from './fixtures/valid-vil'

/** A `window.vialAPI` stub covering the 9 HID-write methods `applyVilFile`
 *  calls, each defaulting to a no-op success — the shape every test below
 *  needs regardless of which specific method it's exercising. Pass
 *  `overrides` for the methods a test needs to observe or fail. */
function stubVialAPI(overrides?: Partial<typeof window.vialAPI>): typeof window.vialAPI {
  return {
    setKeycode: vi.fn(async () => {}),
    setEncoder: vi.fn(async () => {}),
    setMacroBuffer: vi.fn(async () => {}),
    setLayoutOptions: vi.fn(async () => {}),
    setTapDance: vi.fn(async () => {}),
    setCombo: vi.fn(async () => {}),
    setKeyOverride: vi.fn(async () => {}),
    setAltRepeatKey: vi.fn(async () => {}),
    qmkSettingsSet: vi.fn(async () => {}),
    ...overrides,
  } as unknown as typeof window.vialAPI
}

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
    window.vialAPI = stubVialAPI({ qmkSettingsSet })

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

// applyVilFile's backup-before-write / rollback-on-failure behavior for a
// real (non-dummy) device. Each test installs its own window.vialAPI mock
// since the write sequence itself — and where it's made to fail — is the
// point under test.
describe('applyVilFile HID backup and rollback', () => {
  const originalVialAPI = window.vialAPI

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    window.vialAPI = originalVialAPI
  })

  function baseHidState(overrides?: Partial<KeyboardState>): Partial<KeyboardState> {
    return {
      isDummy: false,
      unlockStatus: { unlocked: true, inProgress: false, keys: [] },
      supportedQsids: new Set([1, 2]),
      // parsedMacros: [] sidesteps splitMacroBuffer/deserializeMacro entirely
      // for serialize()'s macroJson field — irrelevant to these tests, which
      // only care about the raw macroBuffer array passed to setMacroBuffer.
      parsedMacros: [],
      ...overrides,
    }
  }

  it('B1: a fully successful apply returns { ok: true } and updates state', async () => {
    const setKeycode = vi.fn(async () => {})
    window.vialAPI = stubVialAPI({ setKeycode })

    const { result } = renderHook(() => useHarness(baseHidState()))

    let applyResult: Awaited<ReturnType<typeof result.current.applyVilFile>> | undefined
    await act(async () => {
      applyResult = await result.current.applyVilFile(VALID_VIL)
    })

    expect(applyResult).toEqual({ ok: true })
    expect(setKeycode).toHaveBeenCalledWith(0, 0, 0, 0x4f)
    expect(result.current.state.keymap.get('0,0,0')).toBe(0x4f)
    expect(result.current.state.keymapRestoreSeq).toBe(1)
  })

  it('B2: a mid-apply setKeycode failure rewrites the backup keymap and reports rolledBack: true, leaving state unchanged', async () => {
    const setKeycode = vi.fn(async (_layer: number, row: number, col: number) => {
      // Fails on the 5th distinct keymap entry (layer 0, row 1, col 5 —
      // VALID_VIL's keycode for '0,1,5') so the first four keys and the
      // rollback's own (single) backup key are all still observable.
      if (row === 1 && col === 5) throw new Error('device write failed')
    })
    window.vialAPI = stubVialAPI({ setKeycode })

    const { result } = renderHook(() =>
      useHarness(baseHidState({
        keymap: new Map([['0,0,0', 5]]),
        macroBufferSize: 0,
      })),
    )

    let applyResult: Awaited<ReturnType<typeof result.current.applyVilFile>> | undefined
    await act(async () => {
      applyResult = await result.current.applyVilFile(VALID_VIL)
    })

    expect(applyResult).toEqual({ ok: false, rolledBack: true })
    // The rollback writes the pre-apply backup value back — the last
    // setKeycode call must be the backup's own (0,0,0) -> 5, not anything
    // from VALID_VIL.
    const lastCall = setKeycode.mock.calls[setKeycode.mock.calls.length - 1]
    expect(lastCall).toEqual([0, 0, 0, 5])
    // Local state was never updated — the failed apply must not leave the
    // screen claiming a keymap the device doesn't actually hold.
    expect(result.current.state.keymap.get('0,0,0')).toBe(5)
    expect(result.current.state.keymapRestoreSeq).toBe(0)
  })

  it('B3: a failure during rollback itself reports rolledBack: false and still leaves state unchanged', async () => {
    const setKeycode = vi.fn(async () => { throw new Error('apply failed') })
    const setLayoutOptions = vi.fn(async () => { throw new Error('rollback failed') })
    window.vialAPI = stubVialAPI({ setKeycode, setLayoutOptions })

    const { result } = renderHook(() =>
      useHarness(baseHidState({ macroBufferSize: 0 })),
    )

    let applyResult: Awaited<ReturnType<typeof result.current.applyVilFile>> | undefined
    await act(async () => {
      applyResult = await result.current.applyVilFile(VALID_VIL)
    })

    expect(applyResult).toEqual({ ok: false, rolledBack: false })
    expect(result.current.state.keymapRestoreSeq).toBe(0)
  })

  it('B4: rollback pads a shorter backup macro buffer with zeros up to macroBufferSize', async () => {
    const setKeycode = vi.fn(async () => { throw new Error('apply failed') })
    const setMacroBuffer = vi.fn(async () => {})
    window.vialAPI = stubVialAPI({ setKeycode, setMacroBuffer })

    const { result } = renderHook(() =>
      useHarness(baseHidState({
        macroBuffer: [1, 2, 3],
        macroBufferSize: 6,
      })),
    )

    await act(async () => {
      await result.current.applyVilFile(VALID_VIL)
    })

    expect(setMacroBuffer).toHaveBeenCalledWith([1, 2, 3, 0, 0, 0])
  })

  it('F7: rollback still pads to the macroBufferSize captured before the first write, even if state changes mid-apply', async () => {
    let capturedStateRef: { current: KeyboardState } | undefined
    const setMacroBuffer = vi.fn(async () => {})
    // The apply's first write (setKeycode) reaches directly into the
    // harness's stateRef and shrinks macroBufferSize before it fails —
    // simulating a disconnect resetting state partway through, after the
    // backup should already have captured the pre-apply value. Mutating
    // the ref directly (rather than going through setState) sidesteps
    // React's update-flush timing, which otherwise makes this race hard
    // to reproduce deterministically in a test.
    const setKeycode = vi.fn(async () => {
      if (capturedStateRef) capturedStateRef.current = { ...capturedStateRef.current, macroBufferSize: 0 }
      throw new Error('device write failed')
    })
    window.vialAPI = stubVialAPI({ setKeycode, setMacroBuffer })

    function useHarnessWithRefAccess(initial?: Partial<KeyboardState>) {
      const [state, setState] = useState<KeyboardState>({ ...emptyState(), isDummy: true, ...initial })
      const stateRef = useRef(state)
      stateRef.current = state
      capturedStateRef = stateRef
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

    const { result } = renderHook(() =>
      useHarnessWithRefAccess(baseHidState({
        macroBuffer: [1, 2, 3],
        macroBufferSize: 6,
      })),
    )

    await act(async () => {
      await result.current.applyVilFile(VALID_VIL)
    })

    // Even though macroBufferSize was reset to 0 by the time the catch
    // block would have read stateRef.current, the rollback must still pad
    // to 6 (the value captured alongside the backup, before any write).
    expect(setMacroBuffer).toHaveBeenCalledWith([1, 2, 3, 0, 0, 0])
  })

  it('B4b: rollback does not write macros at all when macroBufferSize is 0', async () => {
    const setKeycode = vi.fn(async () => { throw new Error('apply failed') })
    const setMacroBuffer = vi.fn(async () => {})
    window.vialAPI = stubVialAPI({ setKeycode, setMacroBuffer })

    const { result } = renderHook(() =>
      useHarness(baseHidState({
        macroBuffer: [],
        macroBufferSize: 0,
      })),
    )

    await act(async () => {
      await result.current.applyVilFile(VALID_VIL)
    })

    expect(setMacroBuffer).not.toHaveBeenCalled()
  })

  it('B5: a dummy/file-mode device never touches HID and still returns { ok: true }', async () => {
    const setKeycode = vi.fn(async () => {})
    window.vialAPI = stubVialAPI({ setKeycode })

    const { result } = renderHook(() => useHarness({ isDummy: true }))

    let applyResult: Awaited<ReturnType<typeof result.current.applyVilFile>> | undefined
    await act(async () => {
      applyResult = await result.current.applyVilFile(VALID_VIL)
    })

    expect(applyResult).toEqual({ ok: true })
    expect(setKeycode).not.toHaveBeenCalled()
    expect(result.current.state.keymap.get('0,0,0')).toBe(0x4f)
  })

  it('a restored file with an empty macro array skips the macro write and leaves state\'s macro fields untouched', async () => {
    const setKeycode = vi.fn(async () => {})
    const setMacroBuffer = vi.fn(async () => {})
    window.vialAPI = stubVialAPI({ setKeycode, setMacroBuffer })

    const previousMacros = [1, 2, 3]
    const previousParsedMacros = [[{ type: 'text', text: 'hi' }]] as unknown as KeyboardState['parsedMacros']
    const { result } = renderHook(() =>
      useHarness(baseHidState({
        macroBuffer: previousMacros,
        macroBufferSize: 3,
        parsedMacros: previousParsedMacros,
      })),
    )

    await act(async () => {
      await result.current.applyVilFile({ ...VALID_VIL, macros: [] })
    })

    expect(setMacroBuffer).not.toHaveBeenCalled()
    expect(result.current.state.macroBuffer).toBe(previousMacros)
    expect(result.current.state.parsedMacros).toBe(previousParsedMacros)
    // Everything else in the file is still applied as normal.
    expect(result.current.state.keymap.get('0,0,0')).toBe(0x4f)
  })

  it('a restored file with a non-empty macro array still writes and updates state (regression)', async () => {
    const setKeycode = vi.fn(async () => {})
    const setMacroBuffer = vi.fn(async () => {})
    window.vialAPI = stubVialAPI({ setKeycode, setMacroBuffer })

    const { result } = renderHook(() =>
      useHarness(baseHidState({
        macroBuffer: [9, 9],
        macroBufferSize: 2,
        parsedMacros: [],
      })),
    )

    await act(async () => {
      await result.current.applyVilFile(VALID_VIL)
    })

    expect(setMacroBuffer).toHaveBeenCalledWith(VALID_VIL.macros)
    expect(result.current.state.macroBuffer).toEqual(VALID_VIL.macros)
  })
})
