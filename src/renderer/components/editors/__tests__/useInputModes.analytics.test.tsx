// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInputModes } from '../useInputModes'
import { deserialize } from '../../../../shared/keycodes/keycodes'

const mockTypingAnalyticsEvent = vi.fn<(event: unknown) => Promise<void>>()
const mockTypingAnalyticsFlush = vi.fn<(uid: string) => Promise<void>>()

beforeEach(() => {
  mockTypingAnalyticsEvent.mockReset()
  mockTypingAnalyticsFlush.mockReset()
  mockTypingAnalyticsEvent.mockResolvedValue(undefined)
  mockTypingAnalyticsFlush.mockResolvedValue(undefined)
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsEvent: mockTypingAnalyticsEvent,
      typingAnalyticsFlush: mockTypingAnalyticsFlush,
    },
    writable: true,
    configurable: true,
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function buildKeymap(): Map<string, number> {
  // layer 0: (0,0) = 0x04 (KC_A basic keycode value)
  const m = new Map<string, number>()
  m.set('0,0,0', 0x04)
  return m
}

/** A thumb tap-hold key at (0, 0) — LT1(KC_SPACE) — and a plain letter at
 *  (0, 1). Pressing the thumb key alone leaves it unresolved (queued,
 *  nothing emitted) until it releases, times out at the tapping term, or
 *  resetMatrixPressTracking drains it directly. */
function buildMaskedKeymap(): Map<string, number> {
  const m = new Map<string, number>()
  m.set('0,0,0', deserialize('LT1(KC_SPACE)'))
  m.set('0,0,1', deserialize('KC_A'))
  return m
}

const sampleKeyboard = {
  uid: '0xAABB',
  vendorId: 0xFEED,
  productId: 0x0000,
  productName: 'Pipette Keyboard',
}

function renderUseInputModes(overrides: Partial<Parameters<typeof useInputModes>[0]>) {
  return renderHook(() => useInputModes({
    rows: 1,
    cols: 1,
    keymap: buildKeymap(),
    typingTestMode: true,
    typingTestViewOnly: true,
    typingRecordKeyboard: sampleKeyboard,
    ...overrides,
  }))
}

describe('useInputModes — typing analytics dispatch', () => {
  it('dispatches a matrix event with the active keyboard attached', () => {
    const { result } = renderUseInputModes({ typingRecordEnabled: true })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'matrix', row: 0, col: 0, keyboard: sampleKeyboard }),
    )
  })

  it('does not dispatch analytics events when recording is disabled', () => {
    const { result } = renderUseInputModes({ typingRecordEnabled: false })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('does not tag editor-test keystrokes before the test is running', () => {
    // Entering the test view auto-starts a countdown on the default config,
    // so a press made before the run starts must NOT be recorded — otherwise
    // it lands as a phantom material (e.g. `words (english)`) for a run that
    // never completes. The editor path (REC off) drops it entirely.
    const { result } = renderUseInputModes({
      typingRecordEnabled: false,
      typingTestViewOnly: false,
    })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('tags editor-test keystrokes once the test is running, with REC off', () => {
    // The editor test path is independent of the REC toggle: a running test
    // feeds analytics tagged with its typing_test label. Use 'time' mode so
    // the first key starts the run without auto-finishing on an empty word
    // list (words/quote auto-finish; time does not).
    const { result } = renderUseInputModes({
      typingRecordEnabled: false,
      typingTestViewOnly: false,
      savedTypingTestConfig: { mode: 'time', duration: 30, punctuation: false, numbers: false },
    })

    // jsdom reports the window as unfocused, which gates key events out, so
    // mark it focused before typing.
    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })
    // A printable key transitions waiting -> running (this first char emits
    // while still 'waiting', so it's not tagged); subsequent frames run.
    act(() => {
      result.current.typingTest.processKeyEvent('a', false, false, false)
    })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'matrix', keyboard: sampleKeyboard, typingTest: expect.any(String) }),
    )
  })

  it('does not dispatch when the active keyboard is unknown', () => {
    const { result } = renderUseInputModes({
      typingRecordEnabled: true,
      typingRecordKeyboard: undefined,
    })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('resets press-edge tracking so the next ON toggle re-emits held keys', () => {
    const { result, rerender } = renderHook(
      ({ typingRecordEnabled }: { typingRecordEnabled: boolean }) => useInputModes({
        rows: 1,
        cols: 1,
        keymap: buildKeymap(),
        typingTestMode: true,
        typingTestViewOnly: true,
        typingRecordKeyboard: sampleKeyboard,
        typingRecordEnabled,
      }),
      { initialProps: { typingRecordEnabled: true } },
    )

    // Record ON → first press edge emits.
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // Record OFF → further frames are dropped.
    rerender({ typingRecordEnabled: false })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // Record ON again → the reset effect clears prevPressed, so the same held
    // key is treated as a new edge and emitted.
    rerender({ typingRecordEnabled: true })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(2)
  })

  it('calls typingAnalyticsFlush when recording transitions from on to off, after the drain lands', async () => {
    const { rerender } = renderHook(
      ({ typingRecordEnabled }: { typingRecordEnabled: boolean }) => useInputModes({
        rows: 1,
        cols: 1,
        keymap: buildKeymap(),
        typingTestMode: true,
        typingTestViewOnly: true,
        typingRecordKeyboard: sampleKeyboard,
        typingRecordEnabled,
      }),
      { initialProps: { typingRecordEnabled: true } },
    )

    expect(mockTypingAnalyticsFlush).not.toHaveBeenCalled()

    rerender({ typingRecordEnabled: false })

    // The flush is now requested only after resetMatrixPressTracking's
    // drain promise resolves (blocker: an unawaited flush could otherwise
    // be serviced before a drained event lands in main) — that resolution
    // is a microtask, so it isn't visible until the queue drains.
    expect(mockTypingAnalyticsFlush).not.toHaveBeenCalled()
    await act(async () => {
      await Promise.resolve()
    })

    expect(mockTypingAnalyticsFlush).toHaveBeenCalledTimes(1)
    expect(mockTypingAnalyticsFlush).toHaveBeenCalledWith(sampleKeyboard.uid)
  })

  it('does not request the flush until a still in-flight drained event settles in main', async () => {
    // Regression for the blocker: main's ingestEvent does a real await
    // (resolveScope) before an event reaches its minute buffer. If the
    // flush were requested while that await is still pending, it could be
    // serviced first, landing the drained event in a fresh buffer entry
    // after the session it belonged to was already finalized. Simulate
    // that in-flight await by holding typingAnalyticsEvent's promise open
    // until the test resolves it explicitly.
    let resolveEvent: (() => void) | undefined
    mockTypingAnalyticsEvent.mockImplementation(() => new Promise((resolve) => {
      resolveEvent = resolve
    }))
    const keymap = buildMaskedKeymap()

    const { result, rerender } = renderHook(
      ({ typingRecordEnabled }: { typingRecordEnabled: boolean }) => useInputModes({
        rows: 1,
        cols: 2,
        keymap,
        typingTestMode: true,
        typingTestViewOnly: true,
        typingRecordKeyboard: sampleKeyboard,
        typingRecordEnabled,
      }),
      { initialProps: { typingRecordEnabled: true } },
    )

    // Thumb key pressed and left unresolved — sitting in the queue.
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
    })
    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()

    // Recording stops mid-hold: the drain finalizes the press and calls
    // typingAnalyticsEvent, but that call's own promise is still pending.
    rerender({ typingRecordEnabled: false })
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(mockTypingAnalyticsFlush).not.toHaveBeenCalled()

    // Letting microtasks drain without resolving the event must NOT let
    // the flush through — it is chained behind the drain, not the
    // recordingActive transition alone.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockTypingAnalyticsFlush).not.toHaveBeenCalled()

    // Only once the drained event actually settles may the flush fire.
    resolveEvent?.()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(mockTypingAnalyticsFlush).toHaveBeenCalledTimes(1)
  })

  it('swallows IPC rejection silently (fire-and-forget)', async () => {
    mockTypingAnalyticsEvent.mockRejectedValueOnce(new Error('ipc down'))
    const handler = vi.fn()
    process.on('unhandledRejection', handler)

    const { result } = renderUseInputModes({ typingRecordEnabled: true })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    await new Promise((resolve) => setImmediate(resolve))

    process.off('unhandledRejection', handler)
    expect(handler).not.toHaveBeenCalled()
  })
})

// A matrix event can now sit in useTypingTest's ordering queue for up to
// the tapping term (queued behind an unresolved masked press) before it
// reaches the sink. These cover that the gate/tag decision is pinned to
// press time — the moment recordingActiveRef/testLabelRef/testRunIdRef
// were read to authorize the press — and is never revisited once the
// event is actually flushed, however much the live state has since moved.
describe('useInputModes — analytics gate/tag survive the ordering queue', () => {
  it('still delivers an unresolved masked press (as hold) and the ordinary key queued behind it when recording stops mid-hold', () => {
    const keymap = buildMaskedKeymap()
    const { result, rerender } = renderHook(
      ({ typingRecordEnabled }: { typingRecordEnabled: boolean }) => useInputModes({
        rows: 1,
        cols: 2,
        keymap,
        typingTestMode: true,
        typingTestViewOnly: true,
        typingRecordKeyboard: sampleKeyboard,
        typingRecordEnabled,
      }),
      { initialProps: { typingRecordEnabled: true } },
    )

    // Thumb key (masked tap-hold) pressed first — unresolved, so nothing
    // is emitted yet; it sits at the head of the ordering queue.
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
    })
    // A normal key rolls in behind it before the thumb key resolves — it
    // must queue rather than emit, to preserve press order.
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0', '0,1']), keymap)
    })
    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()

    // Recording stops while the masked press is still unresolved. Both
    // queued events were authorized when they were pressed (recording was
    // on then) and must still reach the sink, in press order — dropping
    // them here would be strictly worse than not queueing at all.
    rerender({ typingRecordEnabled: false })

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(2)
    expect(mockTypingAnalyticsEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'matrix', row: 0, col: 0, action: 'hold', keyboard: sampleKeyboard,
    }))
    expect(mockTypingAnalyticsEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'matrix', row: 0, col: 1, keyboard: sampleKeyboard,
    }))
  })

  it("keeps a running test's label and run id when the press is flushed after the test view is exited", () => {
    const keymap = buildMaskedKeymap()
    const { result, rerender } = renderHook(
      ({ typingTestViewOnly }: { typingTestViewOnly: boolean }) => useInputModes({
        rows: 1,
        cols: 2,
        keymap,
        typingTestMode: true,
        typingTestViewOnly,
        typingRecordKeyboard: sampleKeyboard,
        typingRecordEnabled: false,
        savedTypingTestConfig: { mode: 'time', duration: 30, punctuation: false, numbers: false },
      }),
      { initialProps: { typingTestViewOnly: false } },
    )

    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })
    // First char transitions waiting -> running (untagged, per existing
    // coverage above); the test is now the active, tagged input source.
    act(() => {
      result.current.typingTest.processKeyEvent('a', false, false, false)
    })
    const runId = result.current.typingTest.state.runId

    // The thumb key is pressed while the test is running and tagged — this
    // is the moment its context must be captured; it stays unresolved.
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
    })
    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()

    // The editor test view is exited before the press resolves. testLabelRef
    // now reads null (this is no longer the tagged editor-test source) —
    // that must not retroactively strip or drop this already-queued press.
    rerender({ typingTestViewOnly: true })

    // A quick release classifies it as a tap and flushes the queue.
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(), keymap)
    })

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'matrix', row: 0, col: 0, action: 'tap', runId, typingTest: expect.any(String),
    }))
  })
})

describe('useInputModes — tray keystroke counter', () => {
  it('counts an authorized matrix press at press time, once — before it resolves and again not when it does', () => {
    const keymap = buildMaskedKeymap()
    const onRecKeystroke = vi.fn()
    const { result } = renderUseInputModes({ typingRecordEnabled: true, keymap, onRecKeystroke })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
    })
    // Not yet resolved — still queued, nothing shipped to analytics — but
    // the tray count must not lag behind the physical press by the tapping
    // term, so it already fired.
    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
    expect(onRecKeystroke).toHaveBeenCalledTimes(1)

    // The release resolves and flushes the queued event; the counter must
    // not fire a second time for the same press.
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(), keymap)
    })
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(onRecKeystroke).toHaveBeenCalledTimes(1)
  })

  it('does not count a press that is not authorized (recording disabled)', () => {
    const onRecKeystroke = vi.fn()
    const { result } = renderUseInputModes({ typingRecordEnabled: false, onRecKeystroke })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
    expect(onRecKeystroke).not.toHaveBeenCalled()
  })

  it('does not count a tagged editor-test keystroke (only untagged REC input counts)', () => {
    const onRecKeystroke = vi.fn()
    const { result } = renderUseInputModes({
      typingRecordEnabled: false,
      typingTestViewOnly: false,
      onRecKeystroke,
      savedTypingTestConfig: { mode: 'time', duration: 30, punctuation: false, numbers: false },
    })

    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })
    act(() => {
      result.current.typingTest.processKeyEvent('a', false, false, false)
    })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({ typingTest: expect.any(String) }))
    expect(onRecKeystroke).not.toHaveBeenCalled()
  })
})
