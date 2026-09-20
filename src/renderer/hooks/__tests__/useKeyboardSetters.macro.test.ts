// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useState, useRef, useCallback } from 'react'
import type React from 'react'
import { useKeyboardSetters } from '../useKeyboardSetters'
import { emptyState } from '../keyboard-types'
import type { BootGuardRef, KeyboardState } from '../keyboard-types'
import { useKeyboard } from '../useKeyboard'
import type { KeyboardDefinition } from '../../../shared/types/protocol'
import { padMacroBuffer } from '../pad-macro-buffer'
import type { MacroAction } from '../../../preload/macro'

const mockSetMacroBuffer = vi.fn<(data: number[]) => Promise<void>>()

beforeEach(() => {
  mockSetMacroBuffer.mockReset()
  mockSetMacroBuffer.mockResolvedValue(undefined)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = {
    setMacroBuffer: mockSetMacroBuffer,
  }
})

/** Mirrors `useKeyboard`'s own `stateRef.current = state` sync in *value* —
 *  the fake `setState` below updates `stateRef.current` synchronously, in
 *  the same tick as the call that issued it. The real hook's ref only
 *  updates on the next React render, which lands a render (or more) later.
 *  Tests about what a queued call reads from `stateRef` *before* a render
 *  has happened need the real timing instead — see the
 *  "real render timing" describe block below, which drives
 *  `useKeyboardSetters` through an actual `useState`/`useRef` pair. See also
 *  useKeyboardSetters.bulk.test.ts for the same helper. */
function setup(initial: Partial<KeyboardState> = {}) {
  const stateRef = { current: { ...emptyState(), isDummy: false, ...initial } } as React.MutableRefObject<KeyboardState>
  const setState = vi.fn((updater: KeyboardState | ((s: KeyboardState) => KeyboardState)) => {
    stateRef.current = typeof updater === 'function'
      ? (updater as (s: KeyboardState) => KeyboardState)(stateRef.current)
      : updater
  })
  const bumpActivity = vi.fn()
  const saveLayerNamesRef = { current: null } as React.MutableRefObject<((names: string[]) => void) | null>
  const bootGuardRef = { current: { onUnlock: vi.fn() } } as React.MutableRefObject<BootGuardRef>
  const waitForUnlock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  return { stateRef, setState, bumpActivity, saveLayerNamesRef, bootGuardRef, waitForUnlock }
}

function renderSetters(env: ReturnType<typeof setup>) {
  return renderHook(() => useKeyboardSetters(
    env.setState, env.stateRef, env.bumpActivity, env.saveLayerNamesRef, env.bootGuardRef, env.waitForUnlock,
  ))
}

/** Yields a macrotask so every pending microtask has run — lets a test
 *  observe what has started so far without counting the implementation's
 *  own awaits. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useKeyboardSetters — setMacroBuffer (non-dummy)', () => {
  it('1: a successful write calls setMacroBuffer once and updates state', async () => {
    const env = setup({ macroBuffer: [9, 9], macroBufferSize: 2, parsedMacros: [[{ type: 'text', text: 'old' }]] })
    const { result } = renderSetters(env)
    const parsedMacros: MacroAction[][] = [[{ type: 'text', text: 'new' }]]

    await act(async () => {
      await result.current.setMacroBuffer([1, 2, 3], parsedMacros)
    })

    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(1)
    expect(mockSetMacroBuffer).toHaveBeenCalledWith([1, 2, 3])
    expect(env.stateRef.current.macroBuffer).toEqual([1, 2, 3])
    expect(env.stateRef.current.parsedMacros).toEqual(parsedMacros)
    expect(env.bumpActivity).toHaveBeenCalledTimes(1)
  })

  it('2: a failed write is followed by a single write-back of the previous buffer zero-padded to macroBufferSize, then rethrows the original error and leaves state unchanged', async () => {
    const originalParsedMacros: MacroAction[][] = [[{ type: 'text', text: 'kept' }]]
    const env = setup({ macroBuffer: [5, 6], macroBufferSize: 4, parsedMacros: originalParsedMacros })
    const { result } = renderSetters(env)
    const original = new Error('write failed')
    mockSetMacroBuffer
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce(undefined)

    let caught: unknown
    await act(async () => {
      try {
        await result.current.setMacroBuffer([1, 2, 3, 4], [[{ type: 'text', text: 'attempted' }]])
      } catch (err) {
        caught = err
      }
    })

    expect(caught).toBe(original)
    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(2)
    expect(mockSetMacroBuffer).toHaveBeenNthCalledWith(2, [5, 6, 0, 0])
    expect(env.stateRef.current.macroBuffer).toEqual([5, 6])
    expect(env.stateRef.current.parsedMacros).toBe(originalParsedMacros)
    expect(env.bumpActivity).not.toHaveBeenCalled()
  })

  it('3: a previous buffer longer than macroBufferSize is truncated (final byte forced to 0) before the write-back', async () => {
    const env = setup({ macroBuffer: [1, 2, 3, 4, 5], macroBufferSize: 3 })
    const { result } = renderSetters(env)
    const original = new Error('write failed')
    mockSetMacroBuffer
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce(undefined)

    await act(async () => {
      await result.current.setMacroBuffer([9, 9, 9]).catch(() => {})
    })

    expect(mockSetMacroBuffer).toHaveBeenNthCalledWith(2, [1, 2, 0])
  })

  it('4: a failing write-back is logged and swallowed — the original (first) error still rejects, no third call is made, state stays unchanged', async () => {
    const env = setup({ macroBuffer: [5, 6], macroBufferSize: 2 })
    const { result } = renderSetters(env)
    const original = new Error('write failed')
    const writeBackErr = new Error('write-back failed')
    mockSetMacroBuffer
      .mockRejectedValueOnce(original)
      .mockRejectedValueOnce(writeBackErr)
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    let caught: unknown
    await act(async () => {
      try {
        await result.current.setMacroBuffer([1, 2])
      } catch (err) {
        caught = err
      }
    })

    expect(caught).toBe(original)
    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(2)
    expect(env.stateRef.current.macroBuffer).toEqual([5, 6])
    expect(consoleErrorSpy).toHaveBeenCalled()
    consoleErrorSpy.mockRestore()
  })

  it('5: macroBufferSize 0 means a failed write is not followed by any write-back', async () => {
    const env = setup({ macroBuffer: [], macroBufferSize: 0 })
    const { result } = renderSetters(env)
    const original = new Error('write failed')
    mockSetMacroBuffer.mockRejectedValueOnce(original)

    let caught: unknown
    await act(async () => {
      try {
        await result.current.setMacroBuffer([1, 2])
      } catch (err) {
        caught = err
      }
    })

    expect(caught).toBe(original)
    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(1)
  })

  it('8: a second call\'s HID write does not start while the first is still pending, and starts once the first settles', async () => {
    const env = setup({ macroBuffer: [5, 6], macroBufferSize: 2 })
    const { result } = renderSetters(env)

    let resolveFirst!: () => void
    mockSetMacroBuffer.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    mockSetMacroBuffer.mockResolvedValueOnce(undefined)

    await act(async () => {
      const firstCall = result.current.setMacroBuffer([1, 1])
      const secondCall = result.current.setMacroBuffer([2, 2])

      await flush()
      expect(mockSetMacroBuffer).toHaveBeenCalledTimes(1)

      resolveFirst()
      await firstCall
      await secondCall
    })

    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(2)
    expect(mockSetMacroBuffer).toHaveBeenNthCalledWith(2, [2, 2])
  })

  it('a failing first call runs its write-back before the second call\'s write starts', async () => {
    const env = setup({ macroBuffer: [5, 6], macroBufferSize: 2 })
    const { result } = renderSetters(env)
    const original = new Error('write failed')

    let resolveWriteBack!: () => void
    mockSetMacroBuffer
      .mockRejectedValueOnce(original)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveWriteBack = resolve }))
      .mockResolvedValueOnce(undefined)

    let firstCaught: unknown
    let secondFinished = false

    await act(async () => {
      const firstCall = result.current.setMacroBuffer([1, 1]).catch((err) => { firstCaught = err })
      const secondCall = result.current.setMacroBuffer([2, 2]).then(() => { secondFinished = true })

      await flush()
      // The first call's own write and its write-back have both been
      // issued (2 calls) — the write-back is the one still pending.
      expect(mockSetMacroBuffer).toHaveBeenCalledTimes(2)
      expect(secondFinished).toBe(false)

      resolveWriteBack()
      await firstCall
      await secondCall
    })

    expect(firstCaught).toBe(original)
    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(3)
    expect(mockSetMacroBuffer).toHaveBeenNthCalledWith(3, [2, 2])
  })
})

/** Drives `useKeyboardSetters` through a real `useState`/`useRef` pair,
 *  wired exactly like `useKeyboard.ts` (`const stateRef = useRef(state);
 *  stateRef.current = state`, refreshed only on this component's own
 *  render). Unlike `setup()` above, `stateRef.current` here lags behind a
 *  `setState` call until React actually re-renders — the timing a queued
 *  macro save races against. */
function useRealStateHarness(initial: Partial<KeyboardState>) {
  const [state, setState] = useState<KeyboardState>(() => ({ ...emptyState(), isDummy: false, ...initial }))
  const stateRef = useRef(state)
  stateRef.current = state
  const bumpActivity = useCallback(() => {}, [])
  const saveLayerNamesRef = useRef<((names: string[]) => void) | null>(null)
  const bootGuardRef = useRef<BootGuardRef>({ onUnlock: null })
  const waitForUnlock = useCallback(() => Promise.resolve(), [])
  const setters = useKeyboardSetters(setState, stateRef, bumpActivity, saveLayerNamesRef, bootGuardRef, waitForUnlock)
  return { state, ...setters }
}

describe('useKeyboardSetters — setMacroBuffer (real render timing)', () => {
  it('a queued save that fails writes back the buffer the settled save ahead of it put on the device, not the pre-chain state', async () => {
    const { result } = renderHook(() => useRealStateHarness({ macroBuffer: [5, 6], macroBufferSize: 4 }))
    const secondWriteError = new Error('second write failed')

    let resolveFirst!: () => void
    mockSetMacroBuffer
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve })) // save 1's own write
      .mockRejectedValueOnce(secondWriteError) // save 2's own write
      .mockResolvedValueOnce(undefined) // save 2's write-back

    const firstParsedMacros: MacroAction[][] = [[{ type: 'text', text: 'first' }]]
    let secondCaught: unknown

    await act(async () => {
      const firstCall = result.current.setMacroBuffer([1, 1], firstParsedMacros)
      const secondCall = result.current.setMacroBuffer([2, 2], [[{ type: 'text', text: 'second' }]])
        .catch((err) => { secondCaught = err })

      // Lets save 1's queued write actually reach the mock (assigning
      // `resolveFirst`) without letting React re-render in between — no
      // state has changed yet, so there's nothing to flush into a render.
      await flush()
      resolveFirst()
      await firstCall
      await secondCall
    })

    expect(secondCaught).toBe(secondWriteError)
    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(3)
    // The write-back targets what save 1 actually put on the device — not
    // the buffer the device held before save 1 ever ran.
    expect(mockSetMacroBuffer).toHaveBeenNthCalledWith(3, padMacroBuffer([1, 1], 4))
    expect(result.current.state.macroBuffer).toEqual([1, 1])
    expect(result.current.state.parsedMacros).toEqual(firstParsedMacros)
  })

  it('when a settled save\'s own write-back succeeds, a save queued behind it that also fails writes back that restored buffer', async () => {
    const { result } = renderHook(() => useRealStateHarness({ macroBuffer: [5, 6], macroBufferSize: 2 }))
    const firstWriteError = new Error('first write failed')
    const secondWriteError = new Error('second write failed')

    let resolveFirstWriteBack!: () => void
    mockSetMacroBuffer
      .mockRejectedValueOnce(firstWriteError) // save 1's own write
      .mockImplementationOnce(() => new Promise((resolve) => { resolveFirstWriteBack = resolve })) // save 1's write-back
      .mockRejectedValueOnce(secondWriteError) // save 2's own write
      .mockResolvedValueOnce(undefined) // save 2's write-back

    let firstCaught: unknown
    let secondCaught: unknown

    await act(async () => {
      const firstCall = result.current.setMacroBuffer([1, 1]).catch((err) => { firstCaught = err })
      const secondCall = result.current.setMacroBuffer([2, 2]).catch((err) => { secondCaught = err })

      // Lets save 1's own write reject and its write-back reach the mock
      // (assigning `resolveFirstWriteBack`) before anything settles.
      await flush()
      resolveFirstWriteBack()
      await firstCall
      await secondCall
    })

    expect(firstCaught).toBe(firstWriteError)
    expect(secondCaught).toBe(secondWriteError)
    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(4)
    // Save 1's own write never landed, so its write-back restored the
    // pre-chain buffer — save 2's write-back restores that same buffer,
    // not the buffer save 2 tried and failed to write.
    expect(mockSetMacroBuffer).toHaveBeenNthCalledWith(4, padMacroBuffer([5, 6], 2))
    expect(result.current.state.macroBuffer).toEqual([5, 6])
  })
})

// isDummy path (regression) — driven through the full `useKeyboard()` hook
// via `loadDummy` since dummy mode is only reachable that way.
const dummyDefinition: KeyboardDefinition = {
  name: 'Test 2x2',
  matrix: { rows: 1, cols: 2 },
  layouts: { keymap: [['0,0', '0,1']] },
}

describe('useKeyboardSetters — setMacroBuffer (isDummy)', () => {
  it('6: writes state without calling HID', async () => {
    const { result } = renderHook(() => useKeyboard())
    await act(async () => { result.current.loadDummy(dummyDefinition) })
    mockSetMacroBuffer.mockClear()

    await act(async () => {
      await result.current.setMacroBuffer([3, 4])
    })

    expect(mockSetMacroBuffer).not.toHaveBeenCalled()
    expect(result.current.macroBuffer).toEqual([3, 4])
  })
})
