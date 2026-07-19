// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useDragReorder } from '../useDragReorder'

describe('useDragReorder', () => {
  it('starts with no drag order override', () => {
    const { result } = renderHook(() => useDragReorder({
      ids: ['a', 'b', 'c'],
      reorder: vi.fn().mockResolvedValue({ success: true }),
      onError: vi.fn(),
    }))
    expect(result.current.dragOrder).toBeNull()
  })

  it('drag start seeds the override with the baseline ids', () => {
    const { result } = renderHook(() => useDragReorder({
      ids: ['a', 'b', 'c'],
      reorder: vi.fn().mockResolvedValue({ success: true }),
      onError: vi.fn(),
    }))
    act(() => { result.current.onDragStart('a') })
    expect(result.current.dragOrder).toEqual(['a', 'b', 'c'])
  })

  it('drag over moves the dragged id to the hovered position', () => {
    const { result } = renderHook(() => useDragReorder({
      ids: ['a', 'b', 'c'],
      reorder: vi.fn().mockResolvedValue({ success: true }),
      onError: vi.fn(),
    }))
    act(() => { result.current.onDragStart('a') })
    act(() => { result.current.onDragOver('c') })
    expect(result.current.dragOrder).toEqual(['b', 'c', 'a'])
  })

  it('drag end persists the final order via `reorder`, clears the override, and resolves true', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: true })
    const { result } = renderHook(() => useDragReorder({ ids: ['a', 'b', 'c'], reorder, onError: vi.fn() }))
    act(() => { result.current.onDragStart('a') })
    act(() => { result.current.onDragOver('c') })

    let moved: boolean | undefined
    await act(async () => { moved = await result.current.onDragEnd() })

    expect(reorder).toHaveBeenCalledWith(['b', 'c', 'a'])
    expect(result.current.dragOrder).toBeNull()
    expect(moved).toBe(true)
  })

  it('surfaces the error via onError when reorder fails, still clears the override, and resolves false', async () => {
    const reorder = vi.fn().mockResolvedValue({ success: false, error: 'nope' })
    const onError = vi.fn()
    const { result } = renderHook(() => useDragReorder({ ids: ['a', 'b'], reorder, onError }))
    act(() => { result.current.onDragStart('a') })
    act(() => { result.current.onDragOver('b') })

    let moved: boolean | undefined
    await act(async () => { moved = await result.current.onDragEnd() })

    expect(onError).toHaveBeenCalledWith('nope')
    expect(result.current.dragOrder).toBeNull()
    expect(moved).toBe(false)
  })

  it('drag end without a preceding drag is a no-op and resolves false', async () => {
    const reorder = vi.fn()
    const { result } = renderHook(() => useDragReorder({ ids: ['a', 'b'], reorder, onError: vi.fn() }))
    let moved: boolean | undefined
    await act(async () => { moved = await result.current.onDragEnd() })
    expect(reorder).not.toHaveBeenCalled()
    expect(moved).toBe(false)
  })
})
