// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useNameSort, compareNames } from '../useNameSort'

describe('compareNames', () => {
  it('is locale-aware and case-insensitive (sensitivity: base)', () => {
    expect(compareNames('beta', 'Alpha')).toBeGreaterThan(0)
    expect(compareNames('alpha', 'ALPHA')).toBe(0)
  })
})

describe('useNameSort', () => {
  it('seeds internally so the very first click applies ascending', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result } = renderHook(() => useNameSort({ reorder, onError: vi.fn() }))
    await act(async () => {
      await result.current.toggle([{ id: 'b', name: 'Beta' }, { id: 'a', name: 'Alpha' }])
    })
    expect(reorder).toHaveBeenCalledWith(['a', 'b'])
    expect(result.current.direction).toBe('asc')
  })

  it('first click sorts ascending by name and persists via reorder', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result } = renderHook(() => useNameSort({ reorder, onError: vi.fn() }))
    const entries = [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }, { id: 'm', name: 'Mu' }]

    await act(async () => { await result.current.toggle(entries) })

    expect(reorder).toHaveBeenCalledWith(['a', 'm', 'z'])
    expect(result.current.direction).toBe('asc')
  })

  it('second click reverses to descending', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result } = renderHook(() => useNameSort({ reorder, onError: vi.fn() }))
    const entries = [{ id: 'z', name: 'Zeta' }, { id: 'a', name: 'Alpha' }, { id: 'm', name: 'Mu' }]

    await act(async () => { await result.current.toggle(entries) })
    await act(async () => { await result.current.toggle(entries) })

    expect(reorder).toHaveBeenLastCalledWith(['z', 'm', 'a'])
    expect(result.current.direction).toBe('desc')
  })

  it('third click flips back to ascending', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result } = renderHook(() => useNameSort({ reorder, onError: vi.fn() }))
    const entries = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]

    await act(async () => { await result.current.toggle(entries) })
    await act(async () => { await result.current.toggle(entries) })
    await act(async () => { await result.current.toggle(entries) })

    expect(result.current.direction).toBe('asc')
    expect(reorder).toHaveBeenLastCalledWith(['a', 'b'])
  })

  it('surfaces the error via onError when reorder fails', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: false, error: 'boom' })
    const onError = vi.fn()
    const { result } = renderHook(() => useNameSort({ reorder, onError }))

    await act(async () => { await result.current.toggle([{ id: 'a', name: 'Alpha' }]) })

    expect(onError).toHaveBeenCalledWith('boom')
  })

  it('is case-insensitive and locale-aware (sensitivity: base)', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result } = renderHook(() => useNameSort({ reorder, onError: vi.fn() }))
    const entries = [{ id: 'upper', name: 'ZETA' }, { id: 'lower', name: 'alpha' }]

    await act(async () => { await result.current.toggle(entries) })

    expect(reorder).toHaveBeenCalledWith(['lower', 'upper'])
  })
})
