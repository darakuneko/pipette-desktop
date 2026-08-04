// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useInputModes } from '../useInputModes'
import { deserialize } from '../../../../shared/keycodes/keycodes'

const mockTypingAnalyticsEvent = vi.fn<(event: unknown) => Promise<void>>()
const mockTypingAnalyticsFlush = vi.fn<(uid: string) => Promise<void>>()

/** Whether `matrix-release` events reach `mockTypingAnalyticsEvent` at all
 *  — see {@link installVialApi}. Reset to the default (excluded) every
 *  test by beforeEach; opt in per-test with `installVialApi({ includeReleases: true })`. */
let includeMatrixReleaseEvents = false

/** (Re)installs the mocked `vialAPI` used by useInputModes. Mirrors
 *  useTypingTest.test.ts's `analyticsOptions` filtering: `matrix-release`
 *  events are excluded from `mockTypingAnalyticsEvent` by default so every
 *  pre-existing assertion in this file (exact call counts, nth-call
 *  content) keeps meaning what it meant before release events existed,
 *  regardless of whether a given test happens to advance the clock
 *  between a press and its release. Tests that specifically cover
 *  release/duration wiring opt in explicitly instead of relying on
 *  incidental zero-duration suppression (a frozen clock still produces
 *  durationMs === 0, which the tracker itself discards, but this filter
 *  no longer depends on that coincidence). Excluded releases resolve
 *  immediately — the IPC call still "happens", it's just not observed by
 *  the mock callers assert against. */
function installVialApi(options?: { includeReleases?: boolean }): void {
  includeMatrixReleaseEvents = options?.includeReleases ?? false
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingAnalyticsEvent: (event: unknown) => {
        const kind = (event as { kind?: string } | null)?.kind
        if (kind === 'matrix-release' && !includeMatrixReleaseEvents) return Promise.resolve()
        return mockTypingAnalyticsEvent(event)
      },
      typingAnalyticsFlush: mockTypingAnalyticsFlush,
    },
    writable: true,
    configurable: true,
  })
}

beforeEach(() => {
  mockTypingAnalyticsEvent.mockReset()
  mockTypingAnalyticsFlush.mockReset()
  mockTypingAnalyticsEvent.mockResolvedValue(undefined)
  mockTypingAnalyticsFlush.mockResolvedValue(undefined)
  installVialApi()
  // Fake ONLY Date (not setTimeout/setImmediate — several tests below rely
  // on those firing for real via flushMicrotasks). Deterministic durations
  // are still needed for the release-wiring tests (see "matrix-release IPC
  // wiring" below), which advance the clock explicitly with
  // vi.setSystemTime() between a press and its release.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** emitAnalyticsEvent now chains every call behind chainRef.current (see
 *  useInputModes.ts) — each emit reaches the mocked IPC only after the
 *  chain's antecedent settles, and a burst of same-tick emits (e.g. a
 *  forced drain flushing several queued presses) stacks one link's worth
 *  of `.then().catch()` hops per emit. The exact number of microtask
 *  ticks that takes isn't worth hand-deriving per call site, so this
 *  loops generously — harmless overshoot for a short, already-settled
 *  chain, and reliably enough for a several-link one. Chains gated on a
 *  deliberately-unresolved mock (see the in-flight-drain test) still
 *  never settle no matter how many rounds run, so this cannot mask a
 *  premature flush. */
async function flushMicrotasks(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve()
    }
  })
}

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
  it('dispatches a matrix event with the active keyboard attached', async () => {
    const { result } = renderUseInputModes({ typingRecordEnabled: true })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    await flushMicrotasks()

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

  it('does not tag editor-test keystrokes before the test is running', async () => {
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
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('does not tag (or even send) a per-minute analytics event for a press made while genuinely armed-waiting (gate split: P2 restored)', async () => {
    // Distinct from the "pristine, never-restarted" case above: this
    // scenario has ALREADY gone through the mount-time config-sync effect
    // (flushed below), so `runLogLabelRef` (the run-log's own, broader
    // tag — see useInputModes.ts) reads non-null here — status is
    // genuinely-armed 'waiting', not the untouched pristine value. The
    // per-minute analytics pipeline must still see nothing at all: no
    // per-minute pre-start cutoff would otherwise let a modifier/no-op
    // press during armed-waiting leak into the heatmap (codex safety
    // review P2) — testLabelRef (this pipeline's OWN, narrower tag) stays
    // 'running'-only regardless of runLogLabelRef.
    const { result } = renderHook(() => useInputModes({
      rows: 1,
      cols: 1,
      keymap: buildKeymap(),
      typingTestMode: true,
      typingTestViewOnly: false,
      typingRecordKeyboard: sampleKeyboard,
      typingRecordEnabled: false,
      savedTypingTestConfig: { mode: 'time', duration: 30, punctuation: false, numbers: false },
    }))
    await flushMicrotasks()
    expect(result.current.typingTest.state.status).toBe('waiting')

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(), buildKeymap())
    })
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).not.toHaveBeenCalled()
  })

  it('tags editor-test keystrokes once the test is running, with REC off', async () => {
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
    await flushMicrotasks()

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

  it('resets press-edge tracking so the next ON toggle re-emits held keys', async () => {
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
    await flushMicrotasks()
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // Record OFF → further frames are dropped.
    rerender({ typingRecordEnabled: false })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    await flushMicrotasks()
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // Record ON again → the reset effect clears prevPressed, so the same held
    // key is treated as a new edge and emitted.
    rerender({ typingRecordEnabled: true })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    await flushMicrotasks()
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
    // One microtask lets emitAnalyticsEvent's chainRef link actually reach
    // the (still-pending) mocked IPC call.
    rerender({ typingRecordEnabled: false })
    await flushMicrotasks()
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

  it('does not request the flush until an ordinary (non-queued) in-flight matrix event settles', async () => {
    // Distinct from the drained-event regression above: an ordinary key on
    // an empty queue never enters MatrixAnalyticsQueue at all (see its
    // pushResolved caller in useTypingTest) — it calls emitAnalyticsEvent
    // straight away and pendingDrainRef's drain sees nothing to wait on.
    // The flush must still wait for it via chainRef, not just via the
    // drain.
    let resolveEvent: (() => void) | undefined
    mockTypingAnalyticsEvent.mockImplementation(() => new Promise((resolve) => {
      resolveEvent = resolve
    }))

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

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    await flushMicrotasks()
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // The queue was empty when recording stops, so the drain itself
    // resolves quickly — the still-pending IPC call is what must gate
    // the flush.
    rerender({ typingRecordEnabled: false })
    await flushMicrotasks()
    expect(mockTypingAnalyticsFlush).not.toHaveBeenCalled()

    resolveEvent?.()
    await flushMicrotasks()
    expect(mockTypingAnalyticsFlush).toHaveBeenCalledTimes(1)
  })

  it('sends events strictly serially — a second emit does not reach the IPC before the first settles', async () => {
    const resolvers: Array<() => void> = []
    mockTypingAnalyticsEvent.mockImplementation(() => new Promise((resolve) => {
      resolvers.push(resolve)
    }))
    const { result } = renderUseInputModes({ typingRecordEnabled: true })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    await flushMicrotasks()
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // Release then press again — a second, independent ordinary press
    // while the first's IPC promise is still unresolved.
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(), buildKeymap())
    })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    await flushMicrotasks()

    // The second event must not have reached the mock yet — it is chained
    // behind the first, whose promise is still pending.
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // Resolving the first lets the second proceed.
    resolvers[0]?.()
    await flushMicrotasks()
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(2)
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

  it('recovers after a rejected event — a later emit still reaches the IPC', async () => {
    // Regression guard: emitAnalyticsEvent's chain is
    // `chainRef.current.then(...).catch(() => {})` — the per-link .catch
    // is what keeps a rejection from propagating into chainRef.current
    // itself. If a future edit dropped that .catch, the first link's
    // rejection would permanently wedge chainRef.current in a rejected
    // state, and every later .then() (including this test's second emit,
    // and both flush sites) would never run again.
    mockTypingAnalyticsEvent.mockRejectedValueOnce(new Error('ipc down'))
    const { result } = renderUseInputModes({ typingRecordEnabled: true })

    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    await flushMicrotasks()
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    // Release then press again — a second, independent press chained
    // behind the first's now-rejected link.
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(), buildKeymap())
    })
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), buildKeymap())
    })
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(2)
  })
})

describe('useInputModes — test-finish flush gating', () => {
  it('does not request the flush until the finishing keystroke\'s in-flight event settles', async () => {
    // Mirrors the record-off regression above for the OTHER flush site:
    // the test-finish effect also chains its flush behind
    // resetMatrixPressTracking() and chainRef.current (see useInputModes.ts),
    // so a still in-flight analytics IPC for the very keystroke that
    // finished the run must gate the flush the same way.
    // Stable across renders (computed once, outside the renderHook
    // callback), matching the actual caller's usage: a fresh Map/config
    // literal every render (fine for other tests here, which never await
    // microtasks mid-run) would let the "feed matrix frames" and config-sync
    // effects re-fire on every render once passive effects get a chance to
    // flush, which regenerates a brand-new run mid-word.
    const onSaveTypingTestResult = vi.fn()
    const stableKeymap = buildKeymap()
    const stableConfig = { mode: 'words' as const, wordCount: 1, punctuation: false, numbers: false }
    const { result } = renderHook(() => useInputModes({
      rows: 1,
      cols: 1,
      keymap: stableKeymap,
      unlocked: true,
      typingTestMode: true,
      typingTestViewOnly: false,
      typingRecordKeyboard: sampleKeyboard,
      onSaveTypingTestResult,
      savedTypingTestConfig: stableConfig,
    }))

    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })

    // Type the whole word in one synchronous burst (no awaited microtasks
    // in between — see the note above) so the run completes in a single
    // pass instead of being disturbed mid-word. The word's last character
    // finishes it (a single-word list finishes immediately on completing
    // it, no trailing space needed); hold that last keystroke's IPC
    // promise open to simulate it still being in flight when the finish
    // effect requests the flush.
    const [word] = result.current.typingTest.state.words
    // Collected rather than a single overwritten variable: completing the
    // run may emit more than one event off the finishing keystroke, and
    // each mockImplementation call below creates its own promise.
    const pendingResolvers: Array<() => void> = []
    for (const char of word.slice(0, -1)) {
      act(() => {
        result.current.typingTest.processKeyEvent(char, false, false, false)
      })
    }
    mockTypingAnalyticsEvent.mockImplementation(() => new Promise((resolve) => {
      pendingResolvers.push(resolve)
    }))
    act(() => {
      result.current.typingTest.processKeyEvent(word.slice(-1), false, false, false)
    })
    expect(result.current.typingTest.state.status).toBe('finished')

    await flushMicrotasks()
    expect(mockTypingAnalyticsFlush).not.toHaveBeenCalled()

    // Drain in rounds rather than once: resolving a link can itself cause
    // the chain to reach the next still-pending mock call, adding a fresh
    // resolver to the array after this loop would otherwise have already
    // moved on.
    for (let i = 0; i < 20 && mockTypingAnalyticsFlush.mock.calls.length === 0; i++) {
      const resolvers = pendingResolvers.splice(0)
      for (const resolve of resolvers) resolve()
      await flushMicrotasks()
    }
    expect(mockTypingAnalyticsFlush).toHaveBeenCalledTimes(1)
    expect(mockTypingAnalyticsFlush).toHaveBeenCalledWith(sampleKeyboard.uid)
  })
})

// A matrix event can now sit in useTypingTest's ordering queue for up to
// the tapping term (queued behind an unresolved masked press) before it
// reaches the sink. These cover that the gate/tag decision is pinned to
// press time — the moment recordingActiveRef/testLabelRef/testRunIdRef
// were read to authorize the press — and is never revisited once the
// event is actually flushed, however much the live state has since moved.
describe('useInputModes — analytics gate/tag survive the ordering queue', () => {
  it('still delivers an unresolved masked press (as hold) and the ordinary key queued behind it when recording stops mid-hold', async () => {
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
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(2)
    expect(mockTypingAnalyticsEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'matrix', row: 0, col: 0, action: 'hold', keyboard: sampleKeyboard,
    }))
    expect(mockTypingAnalyticsEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'matrix', row: 0, col: 1, keyboard: sampleKeyboard,
    }))
  })

  it("keeps a running test's label and run id when the press is flushed after the test view is exited", async () => {
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
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'matrix', row: 0, col: 0, action: 'tap', runId, typingTest: expect.any(String),
    }))
  })
})

describe('useInputModes — tray keystroke counter', () => {
  it('counts an authorized matrix press at press time, once — before it resolves and again not when it does', async () => {
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
    await flushMicrotasks()
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

  it('does not count a tagged editor-test keystroke (only untagged REC input counts)', async () => {
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
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({ typingTest: expect.any(String) }))
    expect(onRecKeystroke).not.toHaveBeenCalled()
  })
})

// The `matrix-release` event travels through the exact same
// prepare/emit/chainRef pipeline as every other analytics event — these
// pin that it reaches the real IPC (typingAnalyticsEvent) with the same
// keyboard/typingTest/runId attachment as a `matrix` event, not just
// within useTypingTest's own in-memory sink (see useTypingTest.test.ts
// for the duration/overlap/hole semantics themselves).
describe('useInputModes — matrix-release IPC wiring', () => {
  it('ships a matrix-release event over IPC with the keyboard attached', async () => {
    installVialApi({ includeReleases: true })
    // A stable keymap reference (not a fresh buildKeymap() per render) —
    // useInputModes resets matrix press tracking whenever its `keymap`
    // prop identity changes, which would otherwise wipe the just-pressed
    // key's duration record before the release frame below looks it up.
    const keymap = buildKeymap()
    const { result } = renderUseInputModes({ typingRecordEnabled: true, keymap })

    const pressAt = new Date('2026-01-01T00:00:00.000Z')
    vi.setSystemTime(pressAt)
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
    })
    await flushMicrotasks()
    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date(pressAt.getTime() + 60))
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(), keymap)
    })
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledTimes(2)
    expect(mockTypingAnalyticsEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({
      kind: 'matrix-release', row: 0, col: 0, durationMs: 60, keyboard: sampleKeyboard,
    }))
  })

  it('tags a matrix-release event with the running test label and run id, like its matrix press', async () => {
    installVialApi({ includeReleases: true })
    const keymap = buildKeymap()
    const { result } = renderUseInputModes({
      typingRecordEnabled: false,
      typingTestViewOnly: false,
      keymap,
      savedTypingTestConfig: { mode: 'time', duration: 30, punctuation: false, numbers: false },
    })

    act(() => {
      result.current.typingTest.setWindowFocused(true)
    })
    act(() => {
      result.current.typingTest.processKeyEvent('a', false, false, false)
    })
    const runId = result.current.typingTest.state.runId

    const pressAt = new Date('2026-01-01T00:00:01.000Z')
    vi.setSystemTime(pressAt)
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(['0,0']), keymap)
    })
    await flushMicrotasks()

    vi.setSystemTime(new Date(pressAt.getTime() + 45))
    act(() => {
      result.current.typingTest.processMatrixFrame(new Set(), keymap)
    })
    await flushMicrotasks()

    expect(mockTypingAnalyticsEvent).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'matrix-release', row: 0, col: 0, durationMs: 45, runId, typingTest: expect.any(String),
    }))
  })
})
