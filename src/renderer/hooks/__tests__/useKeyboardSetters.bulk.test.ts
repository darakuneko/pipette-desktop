// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type React from 'react'
import { useKeyboardSetters } from '../useKeyboardSetters'
import { emptyState, BulkKeyWriteError } from '../keyboard-types'
import type { BootGuardRef, KeyboardState } from '../keyboard-types'
import { useKeyboard } from '../useKeyboard'
import type { KeyboardDefinition } from '../../../shared/types/protocol'

const QK_BOOT_V6 = 0x7c00
const UNLOCKED = { unlocked: true, inProgress: false, keys: [] }
const LOCKED = { unlocked: false, inProgress: false, keys: [] }

const mockSetKeycode = vi.fn<() => Promise<void>>()

beforeEach(() => {
  mockSetKeycode.mockReset()
  mockSetKeycode.mockResolvedValue(undefined)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = {
    setKeycode: mockSetKeycode,
    setEncoder: vi.fn().mockResolvedValue(undefined),
  }
})

/** Mirrors `useKeyboard`'s own `stateRef.current = state` sync, so
 *  `setKeysBulk`'s ref reads see whatever the recorded `setState` last
 *  committed — the same contract the real hook provides. */
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

/** Runs a rejecting `setKeysBulk` inside `act` and hands back what it threw. */
async function catchWrite(write: () => Promise<void>): Promise<unknown> {
  let caught: unknown
  await act(async () => {
    try {
      await write()
    } catch (err) {
      caught = err
    }
  })
  return caught
}

describe('useKeyboardSetters — setKeysBulk (non-dummy, unlocked)', () => {
  it('all entries succeed: keymap reflects every entry', async () => {
    const env = setup({ unlockStatus: UNLOCKED })
    const { result } = renderSetters(env)

    await act(async () => {
      await result.current.setKeysBulk([
        { layer: 0, row: 0, col: 0, keycode: 4 },
        { layer: 0, row: 0, col: 1, keycode: 5 },
        { layer: 0, row: 0, col: 2, keycode: 6 },
      ])
    })

    expect(mockSetKeycode).toHaveBeenCalledTimes(3)
    expect(env.stateRef.current.keymap.get('0,0,0')).toBe(4)
    expect(env.stateRef.current.keymap.get('0,0,1')).toBe(5)
    expect(env.stateRef.current.keymap.get('0,0,2')).toBe(6)
    expect(env.bumpActivity).toHaveBeenCalledTimes(1)
  })

  it('failure at entry 2 of 3: appliedCount 1, cause is the original error, only entry 1 lands in state', async () => {
    const env = setup({ unlockStatus: UNLOCKED })
    const { result } = renderSetters(env)
    const original = new Error('transport dropped')
    mockSetKeycode
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(original)

    const caught = await catchWrite(() => result.current.setKeysBulk([
      { layer: 0, row: 0, col: 0, keycode: 4 },
      { layer: 0, row: 0, col: 1, keycode: 5 },
      { layer: 0, row: 0, col: 2, keycode: 6 },
    ]))

    expect(caught).toBeInstanceOf(BulkKeyWriteError)
    const err = caught as BulkKeyWriteError
    expect(err.appliedCount).toBe(1)
    expect(err.cause).toBe(original)
    expect(err.message).toBe(original.message)
    expect(env.stateRef.current.keymap.get('0,0,0')).toBe(4)
    expect(env.stateRef.current.keymap.has('0,0,1')).toBe(false)
    expect(env.stateRef.current.keymap.has('0,0,2')).toBe(false)
    expect(env.bumpActivity).toHaveBeenCalledTimes(1)
  })

  it('failure at entry 1 of 3: appliedCount 0, state untouched', async () => {
    const env = setup({ unlockStatus: UNLOCKED })
    const { result } = renderSetters(env)
    const original = new Error('transport dropped')
    mockSetKeycode.mockRejectedValueOnce(original)

    const caught = await catchWrite(() => result.current.setKeysBulk([
      { layer: 0, row: 0, col: 0, keycode: 4 },
      { layer: 0, row: 0, col: 1, keycode: 5 },
    ]))

    expect(caught).toBeInstanceOf(BulkKeyWriteError)
    expect((caught as BulkKeyWriteError).appliedCount).toBe(0)
    expect(env.stateRef.current.keymap.size).toBe(0)
    expect(env.bumpActivity).not.toHaveBeenCalled()
  })

  it('empty entries: no-op', async () => {
    const env = setup({ unlockStatus: UNLOCKED })
    const { result } = renderSetters(env)

    await act(async () => {
      await result.current.setKeysBulk([])
    })

    expect(mockSetKeycode).not.toHaveBeenCalled()
    expect(env.bumpActivity).not.toHaveBeenCalled()
  })
})

describe('useKeyboardSetters — setKeysBulk preflight unlock (non-dummy, locked)', () => {
  it('a reset keycode while locked waits for unlock before any setKeycode call', async () => {
    const env = setup({ unlockStatus: LOCKED })
    const { result } = renderSetters(env)

    const callOrder: string[] = []
    env.bootGuardRef.current.onUnlock = vi.fn(() => { callOrder.push('onUnlock') })
    env.waitForUnlock.mockImplementation(async () => { callOrder.push('waitForUnlock'); await Promise.resolve() })
    mockSetKeycode.mockImplementation(async () => { callOrder.push('setKeycode') })

    await act(async () => {
      await result.current.setKeysBulk([
        { layer: 0, row: 0, col: 0, keycode: 4 },
        { layer: 0, row: 0, col: 1, keycode: QK_BOOT_V6 },
      ])
    })

    expect(callOrder).toEqual(['onUnlock', 'waitForUnlock', 'setKeycode', 'setKeycode'])
    expect(env.stateRef.current.keymap.get('0,0,0')).toBe(4)
    expect(env.stateRef.current.keymap.get('0,0,1')).toBe(QK_BOOT_V6)
  })

  it('unlock cancelled: zero setKeycode calls, state untouched, appliedCount 0', async () => {
    const env = setup({ unlockStatus: LOCKED })
    const { result } = renderSetters(env)
    const cancelled = new Error('Unlock cancelled')
    env.waitForUnlock.mockRejectedValue(cancelled)

    const caught = await catchWrite(() => result.current.setKeysBulk([
      { layer: 0, row: 0, col: 0, keycode: 4 },
      { layer: 0, row: 0, col: 1, keycode: QK_BOOT_V6 },
    ]))

    expect(mockSetKeycode).not.toHaveBeenCalled()
    expect(caught).toBeInstanceOf(BulkKeyWriteError)
    expect((caught as BulkKeyWriteError).appliedCount).toBe(0)
    expect((caught as BulkKeyWriteError).cause).toBe(cancelled)
    expect(env.stateRef.current.keymap.size).toBe(0)
    expect(env.bumpActivity).not.toHaveBeenCalled()
  })

  it('no reset keycode among entries while locked: no unlock wait, writes proceed', async () => {
    const env = setup({ unlockStatus: LOCKED })
    const { result } = renderSetters(env)

    await act(async () => {
      await result.current.setKeysBulk([
        { layer: 0, row: 0, col: 0, keycode: 4 },
        { layer: 0, row: 0, col: 1, keycode: 5 },
      ])
    })

    expect(env.waitForUnlock).not.toHaveBeenCalled()
    expect(env.bootGuardRef.current.onUnlock).not.toHaveBeenCalled()
    expect(mockSetKeycode).toHaveBeenCalledTimes(2)
  })
})

// isDummy path (regression) — driven through the full `useKeyboard()` hook
// via `loadDummy` since dummy mode is only reachable that way.
const dummyDefinition: KeyboardDefinition = {
  name: 'Test 2x2',
  matrix: { rows: 1, cols: 2 },
  layouts: { keymap: [['0,0', '0,1']] },
}

describe('useKeyboardSetters — setKeysBulk (isDummy)', () => {
  it('writes state without calling HID', async () => {
    const { result } = renderHook(() => useKeyboard())
    await act(async () => { result.current.loadDummy(dummyDefinition) })
    mockSetKeycode.mockClear()

    await act(async () => {
      await result.current.setKeysBulk([
        { layer: 0, row: 0, col: 0, keycode: 6 },
        { layer: 0, row: 0, col: 1, keycode: 7 },
      ])
    })

    expect(mockSetKeycode).not.toHaveBeenCalled()
    expect(result.current.keymap.get('0,0,0')).toBe(6)
    expect(result.current.keymap.get('0,0,1')).toBe(7)
  })
})
