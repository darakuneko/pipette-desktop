// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSharedHoverBubble, SHARED_BUBBLE_OPEN_DELAY_MS } from '../use-shared-hover-bubble'

describe('useSharedHoverBubble', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('starts with no target shown', () => {
    const { result } = renderHook(() => useSharedHoverBubble<string>())
    expect(result.current.target).toBeNull()
  })

  it('delays showing the target by SHARED_BUBBLE_OPEN_DELAY_MS', () => {
    const { result } = renderHook(() => useSharedHoverBubble<string>())
    act(() => result.current.show('a'))
    expect(result.current.target).toBeNull()
    act(() => vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS - 1))
    expect(result.current.target).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.target).toBe('a')
  })

  it('hides instantly, with no delay', () => {
    const { result } = renderHook(() => useSharedHoverBubble<string>())
    act(() => result.current.show('a'))
    act(() => vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS))
    expect(result.current.target).toBe('a')
    act(() => result.current.hide())
    expect(result.current.target).toBeNull()
  })

  it('restarts the timer when show is called again before it fires (moving between adjacent targets)', () => {
    const { result } = renderHook(() => useSharedHoverBubble<string>())
    act(() => result.current.show('a'))
    act(() => vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS - 1))
    act(() => result.current.show('b'))
    act(() => vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS - 1))
    expect(result.current.target).toBeNull()
    act(() => vi.advanceTimersByTime(1))
    expect(result.current.target).toBe('b')
  })

  it('cancels a pending show when hide is called first', () => {
    const { result } = renderHook(() => useSharedHoverBubble<string>())
    act(() => result.current.show('a'))
    act(() => result.current.hide())
    act(() => vi.advanceTimersByTime(SHARED_BUBBLE_OPEN_DELAY_MS))
    expect(result.current.target).toBeNull()
  })
})
