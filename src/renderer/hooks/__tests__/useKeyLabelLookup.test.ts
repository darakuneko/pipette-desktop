// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// useKeyLabelLookup's returned object must change identity once a lazy
// `ensure(id)` resolves into the cache (or on a store-change event) —
// its members are stable `useCallback`s over a ref, so a downstream
// consumer that memoizes on THIS object (or a callback derived from it,
// e.g. `useDevicePrefs`'s `remapLabel`/`isRemapped`) would otherwise not
// recompute even though calling a member directly already returns the
// fresh data. `version` in the returned `useMemo`'s deps is
// what drives that identity change (see useKeyLabelLookup.ts), while
// staying stable across ordinary renders.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useKeyLabelLookup } from '../useKeyLabelLookup'
import type { KeyLabelRecord, KeyLabelStoreResult } from '../../../shared/types/key-label-store'

const mockKeyLabelStoreGet = vi.fn<(id: string) => Promise<KeyLabelStoreResult<KeyLabelRecord>>>()

beforeEach(() => {
  mockKeyLabelStoreGet.mockReset()
  Object.defineProperty(window, 'vialAPI', {
    value: { keyLabelStoreGet: mockKeyLabelStoreGet },
    writable: true,
    configurable: true,
  })
})

describe('useKeyLabelLookup — returned object identity', () => {
  it('is stable across a render that touches nothing this hook owns', () => {
    const { result, rerender } = renderHook(() => useKeyLabelLookup())
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })

  it('changes identity once ensure(id) resolves a fetched pack into the cache', async () => {
    let resolveGet!: (value: KeyLabelStoreResult<KeyLabelRecord>) => void
    mockKeyLabelStoreGet.mockReturnValue(new Promise((resolve) => { resolveGet = resolve }))

    const { result } = renderHook(() => useKeyLabelLookup())
    const before = result.current
    expect(before.getMap('custom-pack')).toBeUndefined()

    let ensurePromise!: Promise<void>
    act(() => {
      ensurePromise = result.current.ensure('custom-pack')
    })

    // Fetch still pending — identity (and data) unchanged.
    expect(result.current).toBe(before)
    expect(result.current.getMap('custom-pack')).toBeUndefined()

    await act(async () => {
      resolveGet({
        success: true,
        data: { meta: { id: 'custom-pack', name: 'Custom', filename: 'x', savedAt: '', updatedAt: '' }, data: { name: 'Custom', map: { KC_A: 'Custom A' } } },
      })
      await ensurePromise
    })

    // Fetch resolved — identity changed AND the fresh map is visible.
    expect(result.current).not.toBe(before)
    expect(result.current.getMap('custom-pack')).toEqual({ KC_A: 'Custom A' })
  })

  it('does not change identity again on the next unrelated render after a resolved fetch', async () => {
    mockKeyLabelStoreGet.mockResolvedValue({
      success: true,
      data: { meta: { id: 'custom-pack', name: 'Custom', filename: 'x', savedAt: '', updatedAt: '' }, data: { name: 'Custom', map: { KC_A: 'Custom A' } } },
    })

    const { result, rerender } = renderHook(() => useKeyLabelLookup())
    await act(async () => {
      await result.current.ensure('custom-pack')
    })
    const afterFetch = result.current
    rerender()
    expect(result.current).toBe(afterFetch)
  })

  it('changes identity on a store-change event even without an in-flight ensure()', () => {
    const { result } = renderHook(() => useKeyLabelLookup())
    const before = result.current
    act(() => {
      window.dispatchEvent(new Event('pipette:key-labels-changed'))
    })
    expect(result.current).not.toBe(before)
  })
})
