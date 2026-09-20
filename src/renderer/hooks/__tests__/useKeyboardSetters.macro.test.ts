// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type React from 'react'
import { useKeyboardSetters } from '../useKeyboardSetters'
import { emptyState } from '../keyboard-types'
import type { BootGuardRef, KeyboardState } from '../keyboard-types'
import { useKeyboard } from '../useKeyboard'
import type { KeyboardDefinition } from '../../../shared/types/protocol'

const mockSetMacroBuffer = vi.fn<(data: number[]) => Promise<void>>()

beforeEach(() => {
  mockSetMacroBuffer.mockReset()
  mockSetMacroBuffer.mockResolvedValue(undefined)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = {
    setMacroBuffer: mockSetMacroBuffer,
  }
})

/** Mirrors `useKeyboard`'s own `stateRef.current = state` sync — see
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

/** Waits for every pending microtask to flush, without relying on a fixed
 *  number of `await Promise.resolve()` chains lining up with the
 *  implementation's own await count. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('useKeyboardSetters — setMacroBuffer (non-dummy)', () => {
  it('1: a successful write calls setMacroBuffer once and updates state', async () => {
    const env = setup({ macroBuffer: [9, 9], macroBufferSize: 2 })
    const { result } = renderSetters(env)

    await act(async () => {
      await result.current.setMacroBuffer([1, 2, 3])
    })

    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(1)
    expect(mockSetMacroBuffer).toHaveBeenCalledWith([1, 2, 3])
    expect(env.stateRef.current.macroBuffer).toEqual([1, 2, 3])
    expect(env.bumpActivity).toHaveBeenCalledTimes(1)
  })

  it('2: a failed write is followed by a single write-back of the previous buffer zero-padded to macroBufferSize, then rethrows the original error and leaves state unchanged', async () => {
    const env = setup({ macroBuffer: [5, 6], macroBufferSize: 4 })
    const { result } = renderSetters(env)
    const original = new Error('write failed')
    mockSetMacroBuffer
      .mockRejectedValueOnce(original)
      .mockResolvedValueOnce(undefined)

    let caught: unknown
    await act(async () => {
      try {
        await result.current.setMacroBuffer([1, 2, 3, 4])
      } catch (err) {
        caught = err
      }
    })

    expect(caught).toBe(original)
    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(2)
    expect(mockSetMacroBuffer).toHaveBeenNthCalledWith(2, [5, 6, 0, 0])
    expect(env.stateRef.current.macroBuffer).toEqual([5, 6])
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
    let secondStarted = false

    await act(async () => {
      const firstCall = result.current.setMacroBuffer([1, 1]).catch((err) => { firstCaught = err })
      const secondCall = result.current.setMacroBuffer([2, 2]).then(() => { secondStarted = true })

      await flush()
      // The first call's own write and its write-back have both been
      // issued (2 calls) — the write-back is the one still pending.
      expect(mockSetMacroBuffer).toHaveBeenCalledTimes(2)
      expect(secondStarted).toBe(false)

      resolveWriteBack()
      await firstCall
      await secondCall
    })

    expect(firstCaught).toBe(original)
    expect(mockSetMacroBuffer).toHaveBeenCalledTimes(3)
    expect(mockSetMacroBuffer).toHaveBeenNthCalledWith(3, [2, 2])
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
