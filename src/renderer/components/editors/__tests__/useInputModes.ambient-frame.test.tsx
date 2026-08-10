// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useState } from 'react'
import { renderHook, act } from '@testing-library/react'
import { useInputModes, type UseInputModesOptions } from '../useInputModes'
import { POLL_INTERVAL } from '../matrix-utils'
import { deserialize } from '../../../../shared/keycodes/keycodes'

const mockTypingAnalyticsEvent = vi.fn<(event: unknown) => Promise<void>>()
const mockTypingAnalyticsFlush = vi.fn<(uid: string) => Promise<void>>()
const mockTypingRunLogSave = vi.fn<(uid: string, log: unknown) => Promise<{ success: boolean }>>()
const mockTypingRunLogList = vi.fn<(uid: string) => Promise<{ success: boolean; entries: [] }>>()
const mockTypingRunLogGet = vi.fn<(uid: string, runId: string) => Promise<{ success: boolean }>>()

function installVialApi(): void {
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsEvent: mockTypingAnalyticsEvent,
      typingAnalyticsFlush: mockTypingAnalyticsFlush,
      typingRunLogSave: mockTypingRunLogSave,
      typingRunLogList: mockTypingRunLogList,
      typingRunLogGet: mockTypingRunLogGet,
    },
    writable: true,
    configurable: true,
  })
}

beforeEach(() => {
  mockTypingAnalyticsEvent.mockReset().mockResolvedValue(undefined)
  mockTypingAnalyticsFlush.mockReset().mockResolvedValue(undefined)
  mockTypingRunLogSave.mockReset().mockResolvedValue({ success: true })
  mockTypingRunLogList.mockReset().mockResolvedValue({ success: true, entries: [] })
  mockTypingRunLogGet.mockReset().mockResolvedValue({ success: false })
  installVialApi()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Flushes pending microtasks (the emitAnalyticsEvent chain, async word-list
 *  loads, etc.) without advancing fake timers — mirrors the sibling
 *  analytics/run-log test files' own helper. */
async function flushMicrotasks(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve()
    }
  })
}

/** A single-cell (1 row, 1 col) matrix state: `[1]` reports it pressed,
 *  `[0]` reports it released — see parseMatrixState (matrix-utils.ts). */
function pressedFrame(): number[] {
  return [1]
}
function releasedFrame(): number[] {
  return [0]
}

function buildKeymap(): Map<string, number> {
  const m = new Map<string, number>()
  m.set('0,0,0', 0x04) // KC_A
  return m
}

/** A momentary-layer key (MO(1)) at (0,0) — pressing it would normally
 *  latch effectiveLayer to 1 (see MatrixLayerLatch), letting the
 *  ambient-suppression tests prove the state write is actually skipped
 *  rather than merely coincidentally absent. */
function buildLayerSwitchKeymap(): Map<string, number> {
  const m = new Map<string, number>()
  m.set('0,0,0', deserialize('MO(1)'))
  return m
}

const sampleKeyboard = {
  uid: '0xAABB',
  vendorId: 0xFEED,
  productId: 0x0000,
  productName: 'Pipette Keyboard',
}

/** Renders useInputModes with fake timers already installed (module-level
 *  polling needs setTimeout control) — callers advance them explicitly. */
function renderAmbient(overrides: Partial<UseInputModesOptions>) {
  vi.useFakeTimers()
  return renderHook(() => useInputModes({
    rows: 1,
    cols: 1,
    keymap: buildKeymap(),
    unlocked: true,
    typingTestMode: false,
    typingRecordKeyboard: sampleKeyboard,
    ...overrides,
  }))
}

describe('useInputModes — ambient frame supply (REC on, no test, no Key Tester)', () => {
  it('feeds polling-driven frames through onAmbientFrame into per-minute matrix analytics, untagged', async () => {
    const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())
    renderAmbient({ getMatrixState, typingRecordEnabled: true })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
    })
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'matrix', row: 0, col: 0, keyboard: sampleKeyboard }),
    )
    // Untagged REC input — no typingTest dimension, unlike a running
    // editor test's own matrix events.
    const [event] = mockTypingAnalyticsEvent.mock.calls[0] as [Record<string, unknown>]
    expect(event.typingTest).toBeUndefined()
  })

  it('does not feed ambient frames while REC is off', async () => {
    const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())
    renderAmbient({ getMatrixState, typingRecordEnabled: false })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 3)
    })
    await flushMicrotasks()

    // Polling itself never even starts (useMatrixTester's own gate), so
    // getMatrixState is never called and nothing reaches analytics.
    expect(getMatrixState).not.toHaveBeenCalled()
    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('records per-minute matrix analytics regardless of window focus (focus only gates the raw run-log path)', async () => {
    const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())
    const { result } = renderAmbient({ getMatrixState, typingRecordEnabled: true })

    // Explicitly unfocus — a real user alt-tabbed away from the app while
    // the keyboard keeps sending matrix state over HID.
    act(() => {
      result.current.typingTest.setWindowFocused(false)
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
    })
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'matrix', row: 0, col: 0 }),
    )
  })

  it('never registers an ambient frame with the run-log recorder, even with consent granted and the window focused', async () => {
    const getMatrixState = vi.fn()
      .mockResolvedValueOnce(pressedFrame())
      .mockResolvedValueOnce(releasedFrame())
      .mockResolvedValue(releasedFrame())
    const { result } = renderAmbient({
      getMatrixState,
      typingRecordEnabled: true,
      recordingConsentAccepted: true,
    })
    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 2)
    })
    await flushMicrotasks()

    // The per-minute pipeline received the press/release pair (proving
    // frames really flowed), but runLogLabelRef stays null outside a
    // typing test (typingTestMode is false throughout this suite), so
    // noteRegistration never buffers anything to save.
    expect(mockTypingAnalyticsEvent).toHaveBeenCalled()
    expect(mockTypingRunLogSave).not.toHaveBeenCalled()
  })

  it('does not update the effectiveLayer indicator for an ambient frame, even one that would otherwise latch a layer', async () => {
    const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())
    const { result } = renderAmbient({
      getMatrixState,
      keymap: buildLayerSwitchKeymap(),
      typingRecordEnabled: true,
    })
    expect(result.current.typingTest.effectiveLayer).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 2)
    })
    await flushMicrotasks()

    // The press was processed (analytics still fires — layer resolution
    // itself is not skipped, only the indicator's own state write is) —
    // but effectiveLayer must not have moved off its initial value.
    expect(mockTypingAnalyticsEvent).toHaveBeenCalled()
    expect(result.current.typingTest.effectiveLayer).toBe(0)
  })
})

describe('useInputModes — frame-supply exclusivity across an ambient <-> typing-test switch', () => {
  it('stops feeding via onAmbientFrame once a typing test starts, without double-feeding a key that stayed held through the switch', async () => {
    // A controlled-prop harness: typingTestMode is owned by useState here,
    // synced from onTypingTestModeChange the same way the real caller
    // (KeymapEditor/App) owns it — needed so entering the test via
    // handleTypingTestToggle (which calls enterMatrixMode + hands back
    // onTypingTestModeChange(true) in the same commit) actually flips the
    // prop this hook reads, not just its own internal matrixMode state.
    const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())
    // A stable Map reference — built once, outside the renderHook callback.
    // A fresh Map every render would retrigger useInputModes's own
    // "reset matrix press-edge tracking" effect (keyed on keymap identity)
    // on every re-render, wiping prevPressedRef and turning the held key
    // back into a "fresh" press each time — not what this test means to
    // exercise.
    const stableKeymap = buildKeymap()
    vi.useFakeTimers()
    const { result } = renderHook(() => {
      const [typingTestMode, setTypingTestMode] = useState(false)
      return useInputModes({
        rows: 1,
        cols: 1,
        keymap: stableKeymap,
        getMatrixState,
        unlocked: true,
        typingTestMode,
        onTypingTestModeChange: setTypingTestMode,
        typingTestViewOnly: true,
        typingRecordKeyboard: sampleKeyboard,
        typingRecordEnabled: true,
      })
    })

    // Ambient phase: the key is pressed and held; one frame is enough to
    // register the press edge via onAmbientFrame.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
    })
    await flushMicrotasks()
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // Enter the typing test while the same key is still held — this flips
    // matrixMode (enterMatrixMode) and typingTestMode (via the harness'
    // onTypingTestModeChange) together, in the same commit.
    await act(async () => {
      result.current.handleTypingTestToggle()
    })
    await flushMicrotasks()
    expect(result.current.matrixMode).toBe(true)

    // The switch itself produces ZERO additional events — no phantom
    // release, no double-count: useMatrixTester's enterMatrixMode (called
    // by beginTypingTest) seeds pressedKeys/everPressedKeys from its last
    // ambient frame in the same commit as the matrixMode flip, so the
    // state-driven effect's first post-switch firing reads a pressedKeys
    // value that already matches processMatrixFrame's own prevPressedRef
    // (which the ambient phase had already advanced to the held key) —
    // matrixFrameEdges sees no edges at all. The held key stays counted
    // exactly once across the whole switch.
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)
    const kinds = mockTypingAnalyticsEvent.mock.calls.map((call) => (call[0] as { kind: string }).kind)
    expect(kinds).toEqual(['matrix'])

    // Further polling, now purely on the Key Tester path (onAmbientFrame
    // is unreachable — matrixMode is true), must NOT keep re-reporting
    // the still-held key: prevPressedRef already reflects it from the
    // seeded state above, so no further growth for the rest of the hold.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 3)
    })
    await flushMicrotasks()
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)
  })
})

describe('useInputModes — drain-then-flush on unmount', () => {
  it('flushes the session once on unmount when REC was still active', async () => {
    const { unmount } = renderAmbient({ typingRecordEnabled: true })
    expect(mockTypingAnalyticsFlush).not.toHaveBeenCalled()

    act(() => {
      unmount()
    })
    await flushMicrotasks()

    expect(mockTypingAnalyticsFlush).toHaveBeenCalledTimes(1)
    expect(mockTypingAnalyticsFlush).toHaveBeenCalledWith(sampleKeyboard.uid)
  })

  it('does not double-flush when REC was already toggled off before unmount', async () => {
    const { rerender, unmount } = renderHook(
      ({ typingRecordEnabled }: { typingRecordEnabled: boolean }) => {
        vi.useFakeTimers()
        return useInputModes({
          rows: 1,
          cols: 1,
          keymap: buildKeymap(),
          unlocked: true,
          typingTestMode: false,
          typingRecordKeyboard: sampleKeyboard,
          typingRecordEnabled,
        })
      },
      { initialProps: { typingRecordEnabled: true } },
    )

    // REC-off effect flushes once already.
    rerender({ typingRecordEnabled: false })
    await flushMicrotasks()
    expect(mockTypingAnalyticsFlush).toHaveBeenCalledTimes(1)

    // Unmounting afterward must not flush a second time for the same
    // (already-closed) session.
    act(() => {
      unmount()
    })
    await flushMicrotasks()
    expect(mockTypingAnalyticsFlush).toHaveBeenCalledTimes(1)
  })

  it('does not flush on unmount when there is no keyboard uid available', async () => {
    const { unmount } = renderAmbient({ typingRecordEnabled: true, typingRecordKeyboard: undefined })

    act(() => {
      unmount()
    })
    await flushMicrotasks()

    expect(mockTypingAnalyticsFlush).not.toHaveBeenCalled()
  })

  it('emits a still-pending masked (LT/MT) press as a hold on unmount, instead of silently discarding it', async () => {
    // A regression pin for the drain-vs-dispose ordering bug: the unmount
    // drain effect must run BEFORE useTypingTestMatrix's own queue-dispose
    // cleanup, or this held key's still-unresolved press is emptied out of
    // the queue by dispose() (which discards without emitting) before the
    // drain ever gets a chance to finalize and ship it.
    const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())
    const ltKeymap = new Map<string, number>()
    ltKeymap.set('0,0,0', deserialize('LT(1,KC_A)'))
    const { unmount } = renderAmbient({ getMatrixState, keymap: ltKeymap, typingRecordEnabled: true })

    // One ambient frame presses the masked key. No release edge follows and
    // the tap/hold deadline timer never fires (fake timers aren't advanced
    // again) — so it is still unresolved, sitting in the queue, at unmount.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
    })
    await flushMicrotasks()
    mockTypingAnalyticsEvent.mockClear()

    act(() => {
      unmount()
    })
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'matrix', action: 'hold', row: 0, col: 0 }),
    )
    expect(mockTypingAnalyticsFlush).toHaveBeenCalledTimes(1)
  })
})
