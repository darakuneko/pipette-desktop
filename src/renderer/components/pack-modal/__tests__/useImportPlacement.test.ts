// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import '../../../i18n'
import { useImportPlacement } from '../useImportPlacement'

describe('useImportPlacement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('places a new entry at its sorted position and shows "Imported" feedback', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const onReorderError = vi.fn()
    const { result } = renderHook(() => useImportPlacement({
      open: true,
      entries: [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zeta' }],
      direction: 'asc',
      reorder,
      rowTestidPrefix: 'test-packs',
      onReorderError,
    }))

    await act(async () => {
      const beforeIds = result.current.snapshotBeforeIds()
      await result.current.place({ id: 'm', name: 'Mu' }, { beforeIds })
    })

    expect(reorder).toHaveBeenCalledWith(['a', 'm', 'z'])
    expect(onReorderError).not.toHaveBeenCalled()
    expect(result.current.feedback).toBe('Imported Mu')
  })

  it('treats an id already present in beforeIds as an overwrite: no reorder, "Updated" feedback', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result } = renderHook(() => useImportPlacement({
      open: true,
      entries: [{ id: 'a', name: 'Alpha' }],
      direction: 'asc',
      reorder,
      rowTestidPrefix: 'test-packs',
      onReorderError: vi.fn(),
    }))

    await act(async () => {
      const beforeIds = result.current.snapshotBeforeIds()
      await result.current.place({ id: 'a', name: 'Alpha' }, { beforeIds })
    })

    expect(reorder).not.toHaveBeenCalled()
    expect(result.current.feedback).toBe('Updated Alpha')
  })

  it('alwaysInsert skips the overwrite check regardless of beforeIds (Key Labels Hub download)', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result } = renderHook(() => useImportPlacement({
      open: true,
      entries: [{ id: 'a', name: 'Alpha' }],
      direction: 'asc',
      reorder,
      rowTestidPrefix: 'test-packs',
      onReorderError: vi.fn(),
    }))

    // Note: no snapshotBeforeIds() call at all — matches Key Labels'
    // Hub download call site. `q` is a brand-new id, distinct from the
    // pre-existing `a` — alwaysInsert never needs to consult beforeIds.
    await act(async () => {
      await result.current.place({ id: 'q', name: 'Quebec' }, { alwaysInsert: true })
    })

    expect(reorder).toHaveBeenCalledWith(['a', 'q'])
    expect(result.current.feedback).toBe('Imported Quebec')
  })

  it('a free (unsorted) direction skips reorder entirely but still places feedback', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result } = renderHook(() => useImportPlacement({
      open: true,
      entries: [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }],
      direction: 'free',
      reorder,
      rowTestidPrefix: 'test-packs',
      onReorderError: vi.fn(),
    }))

    await act(async () => {
      await result.current.place({ id: 'm', name: 'Mu' }, { alwaysInsert: true })
    })

    expect(reorder).not.toHaveBeenCalled()
    expect(result.current.feedback).toBe('Imported Mu')
  })

  it('P2 (theme DL bug): a failed reorder surfaces onReorderError but still shows "Imported" feedback', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: false, error: 'disk full' })
    const onReorderError = vi.fn()
    const { result } = renderHook(() => useImportPlacement({
      open: true,
      entries: [{ id: 'a', name: 'Alpha' }],
      direction: 'asc',
      reorder,
      rowTestidPrefix: 'test-packs',
      onReorderError,
    }))

    await act(async () => {
      const beforeIds = result.current.snapshotBeforeIds()
      await result.current.place({ id: 'z', name: 'Zeta' }, { beforeIds })
    })

    expect(onReorderError).toHaveBeenCalledWith('disk full')
    // The import/download itself succeeded — only its position failed
    // to persist. Coherent behavior is to still greet the user with
    // "Imported", with the error surfaced alongside via the caller's
    // own actionError channel (onReorderError), not by suppressing this.
    expect(result.current.feedback).toBe('Imported Zeta')
  })

  it('P1 race: a second rapid placement computes its order against the first\'s already-settled insert, not a stale list', async () => {
    let resolveFirstReorder!: (value: { success: boolean }) => void
    const reorder = vi.fn()
      .mockImplementationOnce(() => new Promise<{ success: boolean }>((resolve) => { resolveFirstReorder = resolve }))
      .mockResolvedValueOnce({ success: true })
    const onReorderError = vi.fn()

    const { result, rerender } = renderHook(
      ({ entries }: { entries: { id: string; name: string }[] }) => useImportPlacement({
        open: true,
        entries,
        direction: 'asc',
        reorder,
        rowTestidPrefix: 'test-packs',
        onReorderError,
      }),
      { initialProps: { entries: [{ id: 'a', name: 'Alpha' }] } },
    )

    let placeB!: Promise<void>
    let placeC!: Promise<void>
    await act(async () => {
      placeB = result.current.place({ id: 'b', name: 'Bravo' }, { beforeIds: new Set(['a']) })
      placeC = result.current.place({ id: 'c', name: 'Charlie' }, { beforeIds: new Set(['a']) })
      // Let B's queued `run()` actually start (it's a microtask hop off
      // `queueRef.current.then(...)`) so it reaches its `await
      // reorder(...)` call and captures `resolveFirstReorder` below.
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resolveFirstReorder).toBeDefined()

    // B's reorder call is in flight, computed against entries=['a'].
    // Simulate the store applying it and the caller re-rendering with
    // the refreshed list — this must be what C's turn (still queued
    // behind B) reads, not the ['a'] snapshot from when place() for C
    // was originally called.
    act(() => { rerender({ entries: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Bravo' }] }) })

    await act(async () => {
      resolveFirstReorder({ success: true })
      await placeB
      await placeC
    })

    expect(reorder).toHaveBeenNthCalledWith(1, ['a', 'b'])
    // Without the fix, this would compute from the stale ['a'] list and
    // persist ['a', 'c'] — silently dropping 'b' from the order (reorder
    // is a full-list replacement, not a merge).
    expect(reorder).toHaveBeenNthCalledWith(2, ['a', 'b', 'c'])
    expect(onReorderError).not.toHaveBeenCalled()
  })

  it('P2 close race: a placement resolving after close does not show feedback, even on reopen', async () => {
    let resolveReorder!: (value: { success: boolean }) => void
    const reorder = vi.fn().mockImplementation(() => new Promise<{ success: boolean }>((resolve) => { resolveReorder = resolve }))

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useImportPlacement({
        open,
        entries: [{ id: 'a', name: 'Alpha' }],
        direction: 'asc',
        reorder,
        rowTestidPrefix: 'test-packs',
        onReorderError: vi.fn(),
      }),
      { initialProps: { open: true } },
    )

    let placement!: Promise<void>
    await act(async () => {
      const beforeIds = result.current.snapshotBeforeIds()
      placement = result.current.place({ id: 'z', name: 'Zeta' }, { beforeIds })
      // Let the queued `run()` reach its `await reorder(...)` call so
      // it captures `resolveReorder` below.
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(resolveReorder).toBeDefined()

    // Modal closes while the reorder is still in flight.
    act(() => { rerender({ open: false }) })
    expect(result.current.feedback).toBeNull()

    await act(async () => {
      resolveReorder({ success: true })
      await placement
    })
    // Resolved after close: no feedback resurrected.
    expect(result.current.feedback).toBeNull()

    // Reopen — still nothing stale to show.
    act(() => { rerender({ open: true }) })
    expect(result.current.feedback).toBeNull()
  })

  it('clears feedback and cancels the auto-clear timer immediately on close', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useImportPlacement({
        open,
        entries: [{ id: 'a', name: 'Alpha' }],
        direction: 'asc',
        reorder,
        rowTestidPrefix: 'test-packs',
        onReorderError: vi.fn(),
      }),
      { initialProps: { open: true } },
    )

    await act(async () => {
      const beforeIds = result.current.snapshotBeforeIds()
      await result.current.place({ id: 'z', name: 'Zeta' }, { beforeIds })
    })
    expect(result.current.feedback).toBe('Imported Zeta')

    act(() => { rerender({ open: false }) })
    expect(result.current.feedback).toBeNull()

    // The pending auto-clear timer must not fire into anything after
    // close (nothing to assert on directly beyond it not throwing /
    // not resurrecting stale state once reopened without a new import).
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    act(() => { rerender({ open: true }) })
    expect(result.current.feedback).toBeNull()
  })

  it('auto-clears feedback after the timeout while still open', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result } = renderHook(() => useImportPlacement({
      open: true,
      entries: [{ id: 'a', name: 'Alpha' }],
      direction: 'asc',
      reorder,
      rowTestidPrefix: 'test-packs',
      onReorderError: vi.fn(),
    }))

    await act(async () => {
      const beforeIds = result.current.snapshotBeforeIds()
      await result.current.place({ id: 'z', name: 'Zeta' }, { beforeIds })
    })
    expect(result.current.feedback).toBe('Imported Zeta')

    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(result.current.feedback).toBeNull()
  })
})
