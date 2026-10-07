// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type React from 'react'
import { useKeyboardSetters } from '../useKeyboardSetters'
import { emptyState } from '../keyboard-types'
import type { BootGuardRef, KeyboardState } from '../keyboard-types'

function setup(initial: Partial<KeyboardState>) {
  const stateRef = { current: { ...emptyState(), ...initial } } as React.MutableRefObject<KeyboardState>
  const committed: { state: KeyboardState } = { state: stateRef.current }
  // Records commits without writing `stateRef`, the way a queued React
  // update leaves it until the next render.
  const setState = vi.fn((updater: KeyboardState | ((s: KeyboardState) => KeyboardState)) => {
    committed.state = typeof updater === 'function'
      ? (updater as (s: KeyboardState) => KeyboardState)(committed.state)
      : updater
  })
  const save = vi.fn<(names: string[]) => void>()
  const saveLayerNamesRef = { current: save } as React.MutableRefObject<((names: string[]) => void) | null>
  const bootGuardRef = { current: { onUnlock: vi.fn() } } as React.MutableRefObject<BootGuardRef>
  const { result } = renderHook(() => useKeyboardSetters(
    setState, stateRef, vi.fn(), saveLayerNamesRef, bootGuardRef, vi.fn().mockResolvedValue(undefined),
  ))
  return { result, stateRef, committed, setState, save }
}

describe('replaceLayerNamesFromSync', () => {
  it('replaces the names, padded to the layer count, without saving', () => {
    const env = setup({ uid: 'UID1', layers: 3, layerNames: ['Base', '', ''] })
    act(() => { env.result.current.replaceLayerNamesFromSync('UID1', ['Base', 'Nav']) })

    expect(env.committed.state.layerNames).toEqual(['Base', 'Nav', ''])
    expect(env.save).not.toHaveBeenCalled()
  })

  it('ignores names for another keyboard and unchanged names', () => {
    const env = setup({ uid: 'UID1', layers: 2, layerNames: ['Base', 'Nav'] })
    act(() => {
      env.result.current.replaceLayerNamesFromSync('UID2', ['X', 'Y'])
      env.result.current.replaceLayerNamesFromSync('UID1', ['Base', 'Nav'])
    })
    expect(env.setState).not.toHaveBeenCalled()
  })

  it('lets a rename before the next render start from the reloaded names', () => {
    const env = setup({ uid: 'UID1', layers: 3, layerNames: ['Base', '', ''] })
    act(() => {
      env.result.current.replaceLayerNamesFromSync('UID1', ['Base', 'Nav', ''])
      env.result.current.setLayerName(2, 'Sym')
    })

    expect(env.save).toHaveBeenCalledWith(['Base', 'Nav', 'Sym'])
    expect(env.committed.state.layerNames).toEqual(['Base', 'Nav', 'Sym'])
  })
})
