// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useNameSort, compareNames, detectSortState } from '../useNameSort'

describe('compareNames', () => {
  it('is locale-aware and case-insensitive (sensitivity: base)', () => {
    expect(compareNames('beta', 'Alpha')).toBeGreaterThan(0)
    expect(compareNames('alpha', 'ALPHA')).toBe(0)
  })
})

describe('detectSortState (state-detection matrix)', () => {
  it('detects asc for a list already in ascending name order', () => {
    const entries = [{ id: 'a', name: 'Alpha' }, { id: 'm', name: 'Mu' }, { id: 'z', name: 'Zeta' }]
    expect(detectSortState(entries)).toBe('asc')
  })

  it('detects desc for a list already in descending name order', () => {
    const entries = [{ id: 'z', name: 'Zeta' }, { id: 'm', name: 'Mu' }, { id: 'a', name: 'Alpha' }]
    expect(detectSortState(entries)).toBe('desc')
  })

  it('detects free for a shuffled list matching neither order', () => {
    const entries = [{ id: 'm', name: 'Mu' }, { id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }]
    expect(detectSortState(entries)).toBe('free')
  })

  it('detects free for an empty list', () => {
    expect(detectSortState([])).toBe('free')
  })

  it('detects free for a single-item list (0-1 items → free per spec)', () => {
    expect(detectSortState([{ id: 'a', name: 'Alpha' }])).toBe('free')
  })

  it('is case-insensitive/locale-aware when detecting order, matching compareNames', () => {
    const entries = [{ id: 'lower', name: 'alpha' }, { id: 'upper', name: 'ZETA' }]
    expect(detectSortState(entries)).toBe('asc')
  })
})

describe('useNameSort', () => {
  it('derives "asc" on open when the list is already ascending, and does not re-derive on later entries changes while still open', () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const entries = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
    const { result, rerender } = renderHook(
      ({ entries }) => useNameSort({ open: true, ready: true, entries, reorder, onError: vi.fn() }),
      { initialProps: { entries } },
    )
    expect(result.current.direction).toBe('asc')

    // A later entries change (e.g. a new import) must NOT re-trigger
    // detection while still in the same open session — direction stays
    // whatever it currently is (still 'asc' here) regardless of the
    // new list's actual order.
    rerender({ entries: [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }] })
    expect(result.current.direction).toBe('asc')
  })

  it('derives "desc" on open when the list is already descending', () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const entries = [{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }]
    const { result } = renderHook(() => useNameSort({ open: true, ready: true, entries, reorder, onError: vi.fn() }))
    expect(result.current.direction).toBe('desc')
  })

  it('derives "free" for a shuffled list, and the first click applies ascending', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const entries = [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }, { id: 'm', name: 'Mu' }]
    const { result } = renderHook(() => useNameSort({ open: true, ready: true, entries, reorder, onError: vi.fn() }))
    expect(result.current.direction).toBe('free')

    await act(async () => { await result.current.toggle(entries) })

    expect(reorder).toHaveBeenCalledWith(['a', 'm', 'z'])
    expect(result.current.direction).toBe('asc')
  })

  it('re-derives fresh when the modal is closed and reopened', () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const ascEntries = [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zeta' }]
    const shuffled = [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }, { id: 'm', name: 'Mu' }]
    const { result, rerender } = renderHook(
      ({ open, entries }) => useNameSort({ open, ready: true, entries, reorder, onError: vi.fn() }),
      { initialProps: { open: true, entries: ascEntries } },
    )
    expect(result.current.direction).toBe('asc')

    rerender({ open: false, entries: ascEntries })
    rerender({ open: true, entries: shuffled })
    expect(result.current.direction).toBe('free')
  })

  describe('ready gating (P2: empty-latch on open)', () => {
    it('does not latch a detection from an empty pre-load list — derives once real data arrives', () => {
      const reorder = vi.fn().mockResolvedValue({ success: true })
      const loaded = [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zeta' }]
      const { result, rerender } = renderHook(
        ({ ready, entries }) => useNameSort({ open: true, ready, entries, reorder, onError: vi.fn() }),
        { initialProps: { ready: false, entries: [] as { id: string; name: string }[] } },
      )
      // Mounted open before the store's async metas load resolved —
      // must NOT latch 'free' from this transient empty list.
      expect(result.current.direction).toBe('free')

      rerender({ ready: true, entries: loaded })
      expect(result.current.direction).toBe('asc')

      // Once latched (ready && open both true), later entries changes
      // still must not re-trigger detection, same as the plain open-gating case.
      rerender({ ready: true, entries: [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }] })
      expect(result.current.direction).toBe('asc')
    })

    it('a genuinely empty *loaded* store still derives free, not a further-deferred state', () => {
      const reorder = vi.fn().mockResolvedValue({ success: true })
      const { result, rerender } = renderHook(
        ({ ready, entries }) => useNameSort({ open: true, ready, entries, reorder, onError: vi.fn() }),
        { initialProps: { ready: false, entries: [] as { id: string; name: string }[] } },
      )
      rerender({ ready: true, entries: [] })
      expect(result.current.direction).toBe('free')
    })

    it('close then reopen re-derives even when the reopen races ready again', () => {
      const reorder = vi.fn().mockResolvedValue({ success: true })
      const loaded = [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zeta' }]
      const { result, rerender } = renderHook(
        ({ open, ready, entries }) => useNameSort({ open, ready, entries, reorder, onError: vi.fn() }),
        { initialProps: { open: true, ready: true, entries: loaded } },
      )
      expect(result.current.direction).toBe('asc')

      rerender({ open: false, ready: true, entries: loaded })
      // Reopens before the (new keyboard's) store has reloaded. Not yet
      // ready, so the latch does not re-arm: `direction` is simply
      // whatever it last was (stale 'asc') until real data arrives —
      // there is no list to show yet either, so nothing user-visible
      // reads this transient value.
      rerender({ open: true, ready: false, entries: [] })
      expect(result.current.direction).toBe('asc')

      rerender({ open: true, ready: true, entries: [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }] })
      expect(result.current.direction).toBe('desc')
    })
  })

  it('second click reverses to descending', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const entries = [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }, { id: 'm', name: 'Mu' }]
    const { result } = renderHook(() => useNameSort({ open: true, ready: true, entries, reorder, onError: vi.fn() }))

    await act(async () => { await result.current.toggle(entries) })
    await act(async () => { await result.current.toggle(entries) })

    expect(reorder).toHaveBeenLastCalledWith(['z', 'm', 'a'])
    expect(result.current.direction).toBe('desc')
  })

  it('third click flips back to ascending', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    // A shuffled list so the open-derived state is 'free', keeping this
    // test's "third click" framing meaningful (asc → desc → asc).
    const entries = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }, { id: 'c', name: 'Cee' }]
    const shuffled = [entries[1], entries[2], entries[0]]
    const { result } = renderHook(() => useNameSort({ open: true, ready: true, entries: shuffled, reorder, onError: vi.fn() }))
    expect(result.current.direction).toBe('free')

    await act(async () => { await result.current.toggle(entries) })
    await act(async () => { await result.current.toggle(entries) })
    await act(async () => { await result.current.toggle(entries) })

    expect(result.current.direction).toBe('asc')
    expect(reorder).toHaveBeenLastCalledWith(['a', 'b', 'c'])
  })

  it('markFree switches the state to free directly, with no click path back to it', () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const entries = [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zeta' }]
    const { result } = renderHook(() => useNameSort({ open: true, ready: true, entries, reorder, onError: vi.fn() }))
    expect(result.current.direction).toBe('asc')

    act(() => { result.current.markFree() })
    expect(result.current.direction).toBe('free')
  })

  it('surfaces the error via onError when reorder fails', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: false, error: 'boom' })
    const onError = vi.fn()
    const entries = [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zeta' }]
    const { result } = renderHook(() => useNameSort({ open: true, ready: true, entries, reorder, onError }))

    await act(async () => { await result.current.toggle(entries) })

    expect(onError).toHaveBeenCalledWith('boom')
  })

  it('is case-insensitive and locale-aware (sensitivity: base) when toggling', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const entries = [{ id: 'upper', name: 'ZETA' }, { id: 'lower', name: 'alpha' }]
    const { result } = renderHook(() => useNameSort({ open: true, ready: true, entries, reorder, onError: vi.fn() }))

    await act(async () => { await result.current.toggle(entries) })

    expect(reorder).toHaveBeenCalledWith(['lower', 'upper'])
  })
})
