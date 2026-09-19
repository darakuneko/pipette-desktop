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

describe('useKeyboardSetters — setKeysBulk (non-dummy, unlocked)', () => {
  it('all entries succeed: keymap reflects every entry', async () => {
    const env = setup({ unlockStatus: { unlocked: true, inProgress: false, keys: [] } })
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
    const env = setup({ unlockStatus: { unlocked: true, inProgress: false, keys: [] } })
    const { result } = renderSetters(env)
    const original = new Error('transport dropped')
    mockSetKeycode
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(original)

    let caught: unknown
    await act(async () => {
      try {
        await result.current.setKeysBulk([
          { layer: 0, row: 0, col: 0, keycode: 4 },
          { layer: 0, row: 0, col: 1, keycode: 5 },
          { layer: 0, row: 0, col: 2, keycode: 6 },
        ])
      } catch (err) {
        caught = err
      }
    })

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
    const env = setup({ unlockStatus: { unlocked: true, inProgress: false, keys: [] } })
    const { result } = renderSetters(env)
    const original = new Error('transport dropped')
    mockSetKeycode.mockRejectedValueOnce(original)

    let caught: unknown
    await act(async () => {
      try {
        await result.current.setKeysBulk([
          { layer: 0, row: 0, col: 0, keycode: 4 },
          { layer: 0, row: 0, col: 1, keycode: 5 },
        ])
      } catch (err) {
        caught = err
      }
    })

    expect(caught).toBeInstanceOf(BulkKeyWriteError)
    expect((caught as BulkKeyWriteError).appliedCount).toBe(0)
    expect(env.stateRef.current.keymap.size).toBe(0)
    expect(env.bumpActivity).not.toHaveBeenCalled()
  })

  it('empty entries: no-op', async () => {
    const env = setup({ unlockStatus: { unlocked: true, inProgress: false, keys: [] } })
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
    const env = setup({ unlockStatus: { unlocked: false, inProgress: false, keys: [] } })
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
    const env = setup({ unlockStatus: { unlocked: false, inProgress: false, keys: [] } })
    const { result } = renderSetters(env)
    const cancelled = new Error('Unlock cancelled')
    env.waitForUnlock.mockRejectedValue(cancelled)

    let caught: unknown
    await act(async () => {
      try {
        await result.current.setKeysBulk([
          { layer: 0, row: 0, col: 0, keycode: 4 },
          { layer: 0, row: 0, col: 1, keycode: QK_BOOT_V6 },
        ])
      } catch (err) {
        caught = err
      }
    })

    expect(mockSetKeycode).not.toHaveBeenCalled()
    expect(caught).toBeInstanceOf(BulkKeyWriteError)
    expect((caught as BulkKeyWriteError).appliedCount).toBe(0)
    expect((caught as BulkKeyWriteError).cause).toBe(cancelled)
    expect(env.stateRef.current.keymap.size).toBe(0)
    expect(env.bumpActivity).not.toHaveBeenCalled()
  })

  it('no reset keycode among entries while locked: no unlock wait, writes proceed', async () => {
    const env = setup({ unlockStatus: { unlocked: false, inProgress: false, keys: [] } })
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
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).vialAPI = {
      setKeycode: mockSetKeycode,
      setEncoder: vi.fn().mockResolvedValue(undefined),
      setLayoutOptions: vi.fn().mockResolvedValue(undefined),
      setMacroBuffer: vi.fn().mockResolvedValue(undefined),
      setTapDance: vi.fn().mockResolvedValue(undefined),
      setCombo: vi.fn().mockResolvedValue(undefined),
      setKeyOverride: vi.fn().mockResolvedValue(undefined),
      setAltRepeatKey: vi.fn().mockResolvedValue(undefined),
      getProtocolVersion: vi.fn().mockResolvedValue(12),
      getVialProtocolVersion: vi.fn().mockResolvedValue(9),
      getVialUID: vi.fn().mockResolvedValue('0000000000000001'),
      getVialDefinitionSize: vi.fn().mockResolvedValue(0),
      getVialDefinition: vi.fn().mockResolvedValue(new Uint8Array()),
      getLayerCount: vi.fn().mockResolvedValue(2),
      getKeycode: vi.fn().mockResolvedValue(0),
      getEncoder: vi.fn().mockResolvedValue(0),
      getLayoutOptions: vi.fn().mockResolvedValue(0),
      getMacroCount: vi.fn().mockResolvedValue(0),
      getMacroBufferSize: vi.fn().mockResolvedValue(0),
      getMacroBuffer: vi.fn().mockResolvedValue([]),
      getDynamicEntryCounts: vi.fn().mockResolvedValue({ tapDance: 0, combo: 0, keyOverride: 0, altRepeatKey: 0, featureFlags: 0 }),
      getTapDance: vi.fn().mockResolvedValue({ onTap: 0, onHold: 0, onDoubleTap: 0, onTapHold: 0, tappingTerm: 200 }),
      getCombo: vi.fn().mockResolvedValue({ keys: [0, 0, 0, 0], keycode: 0 }),
      getKeyOverride: vi.fn().mockResolvedValue({ trigger: 0, replacement: 0, layers: 0xffff, triggerMods: 0, negMods: 0, supMods: 0, options: 0 }),
      getAltRepeatKey: vi.fn().mockResolvedValue({ source: 0, replacement: 0 }),
      getUnlockStatus: vi.fn().mockResolvedValue({ unlocked: false, inProgress: false, keys: [] }),
      unlockStart: vi.fn().mockResolvedValue(undefined),
      unlockPoll: vi.fn().mockResolvedValue({ unlocked: false, inProgress: false }),
      getMatrixState: vi.fn().mockResolvedValue(new Uint8Array()),
    }
  })

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
