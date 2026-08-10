// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMatrixTester } from '../use-matrix-tester'
import { POLL_INTERVAL } from '../matrix-utils'

/** Flushes the microtask queue so a `getMatrixState().then(...)` chain that
 *  already settled gets to resolve before assertions run. */
async function flushMicrotasks(rounds = 5): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await Promise.resolve()
  })
}

/** A controllable single-key matrix state: 1 row, 1 col. `[1]` reports the
 *  one key pressed, `[0]` reports it released (see parseMatrixState). */
function pressedFrame(): number[] {
  return [1]
}
function releasedFrame(): number[] {
  return [0]
}

function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('useMatrixTester polling', () => {
  it('does not poll while locked, even with matrixMode or recordingActive requested', async () => {
    vi.useFakeTimers()
    try {
      const getMatrixState = vi.fn().mockResolvedValue(releasedFrame())
      renderHook(() =>
        useMatrixTester({
          rows: 1,
          cols: 1,
          getMatrixState,
          unlocked: false,
          recordingActive: true,
        }),
      )

      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 3)
      })

      expect(getMatrixState).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ambient mode (recordingActive, matrixMode false) routes frames to onAmbientFrame without updating pressedKeys/everPressedKeys state', async () => {
    vi.useFakeTimers()
    try {
      const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())
      const onAmbientFrame = vi.fn()
      let renderCount = 0

      const { result } = renderHook(() => {
        renderCount++
        return useMatrixTester({
          rows: 1,
          cols: 1,
          getMatrixState,
          unlocked: true,
          recordingActive: true,
          onAmbientFrame,
        })
      })

      await flushMicrotasks()

      expect(onAmbientFrame).toHaveBeenCalledWith(new Set(['0,0']))
      // Ambient-only polling must not drive setPressedKeys/setEverPressedKeys
      // -- that would re-render the whole editor on every 20ms poll tick.
      expect(result.current.pressedKeys.size).toBe(0)
      expect(result.current.everPressedKeys.size).toBe(0)

      // Advance a few more ticks -- still no state-driven re-render.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL * 3)
      })
      await flushMicrotasks()

      expect(onAmbientFrame.mock.calls.length).toBeGreaterThan(1)
      expect(result.current.pressedKeys.size).toBe(0)
      expect(renderCount).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('matrixMode polling drives pressedKeys/everPressedKeys state and never calls onAmbientFrame', async () => {
    vi.useFakeTimers()
    try {
      const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())
      const onAmbientFrame = vi.fn()

      const { result } = renderHook(() =>
        useMatrixTester({
          rows: 1,
          cols: 1,
          getMatrixState,
          unlocked: true,
          onAmbientFrame,
        }),
      )

      act(() => {
        result.current.enterMatrixMode()
      })

      await flushMicrotasks()

      expect(result.current.pressedKeys).toEqual(new Set(['0,0']))
      expect(result.current.everPressedKeys).toEqual(new Set(['0,0']))
      expect(onAmbientFrame).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a key already held when polling starts is reported as pressed on the very first frame (no debounce/edge-detection)', async () => {
    vi.useFakeTimers()
    try {
      const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())

      const { result } = renderHook(() =>
        useMatrixTester({
          rows: 1,
          cols: 1,
          getMatrixState,
          unlocked: true,
        }),
      )

      act(() => {
        result.current.enterMatrixMode()
      })

      // Only flush the first frame's promise -- no timer advance yet.
      await flushMicrotasks()

      expect(result.current.pressedKeys).toEqual(new Set(['0,0']))
      expect(result.current.everPressedKeys).toEqual(new Set(['0,0']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('discards a stale in-flight poll on rapid recordingActive off->on and does not spawn a second concurrent loop', async () => {
    vi.useFakeTimers()
    try {
      const deferreds: Array<{ resolve: (value: number[]) => void }> = []
      const getMatrixState = vi.fn(() => {
        const d = createDeferred<number[]>()
        deferreds.push(d)
        return d.promise
      })
      const onAmbientFrame = vi.fn()

      const { rerender } = renderHook(
        ({ recordingActive }: { recordingActive: boolean }) =>
          useMatrixTester({
            rows: 1,
            cols: 1,
            getMatrixState,
            unlocked: true,
            recordingActive,
            onAmbientFrame,
          }),
        { initialProps: { recordingActive: true } },
      )

      expect(getMatrixState).toHaveBeenCalledTimes(1)

      // Toggle off then back on while the first getMatrixState() call is
      // still pending -- this is the REC off->on race the generation token
      // guards against.
      await act(async () => {
        rerender({ recordingActive: false })
      })
      await act(async () => {
        rerender({ recordingActive: true })
      })

      expect(getMatrixState).toHaveBeenCalledTimes(2)

      // Resolve the stale first call: it must be discarded silently, not
      // reschedule its own follow-up poll.
      await act(async () => {
        deferreds[0].resolve(releasedFrame())
        await Promise.resolve()
        await Promise.resolve()
      })
      expect(getMatrixState).toHaveBeenCalledTimes(2)

      // Resolve the live (second) call: this is the one that should own
      // scheduling of the next poll tick.
      await act(async () => {
        deferreds[1].resolve(releasedFrame())
        await Promise.resolve()
        await Promise.resolve()
      })

      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL)
      })

      // Exactly one additional call from the single live loop -- if the
      // stale poll had rescheduled itself, this would be 4.
      expect(getMatrixState).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('seeds pressedKeys/everPressedKeys from the last ambient frame the instant enterMatrixMode runs, in the same commit as the mode flip', async () => {
    vi.useFakeTimers()
    try {
      const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())

      const { result } = renderHook(() =>
        useMatrixTester({
          rows: 1,
          cols: 1,
          getMatrixState,
          unlocked: true,
          recordingActive: true,
        }),
      )

      // Ambient phase: the key is observed held, but matrixMode is still
      // false so pressedKeys/everPressedKeys stay untouched.
      await flushMicrotasks()
      expect(result.current.pressedKeys.size).toBe(0)
      expect(result.current.everPressedKeys.size).toBe(0)

      act(() => {
        result.current.enterMatrixMode()
      })

      // Seeded synchronously -- no need to wait for the next poll tick.
      expect(result.current.matrixMode).toBe(true)
      expect(result.current.pressedKeys).toEqual(new Set(['0,0']))
      expect(result.current.everPressedKeys).toEqual(new Set(['0,0']))
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not seed a stale ambient frame once REC has turned off before matrixMode is entered', async () => {
    vi.useFakeTimers()
    try {
      const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())

      const { result, rerender } = renderHook(
        ({ recordingActive }: { recordingActive: boolean }) =>
          useMatrixTester({ rows: 1, cols: 1, getMatrixState, unlocked: true, recordingActive }),
        { initialProps: { recordingActive: true } },
      )

      // Ambient frame observed while REC is still on.
      await flushMicrotasks()

      // REC turns off before Key Tester is ever opened -- the pending seed
      // must be cleared, not carried into a later, unrelated session.
      await act(async () => {
        rerender({ recordingActive: false })
      })

      act(() => {
        result.current.enterMatrixMode()
      })

      expect(result.current.pressedKeys.size).toBe(0)
      expect(result.current.everPressedKeys.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not seed a stale ambient frame once the keyboard locks before matrixMode is entered', async () => {
    vi.useFakeTimers()
    try {
      const getMatrixState = vi.fn().mockResolvedValue(pressedFrame())

      const { result, rerender } = renderHook(
        ({ unlocked }: { unlocked: boolean }) =>
          useMatrixTester({ rows: 1, cols: 1, getMatrixState, unlocked, recordingActive: true }),
        { initialProps: { unlocked: true } },
      )

      await flushMicrotasks()

      await act(async () => {
        rerender({ unlocked: false })
      })

      act(() => {
        result.current.enterMatrixMode()
      })

      expect(result.current.pressedKeys.size).toBe(0)
      expect(result.current.everPressedKeys.size).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
