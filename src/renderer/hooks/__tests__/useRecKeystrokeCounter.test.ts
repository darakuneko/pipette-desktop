// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRecKeystrokeCounter } from '../useRecKeystrokeCounter'

describe('useRecKeystrokeCounter', () => {
  it('starts at zero', () => {
    const { result } = renderHook(() => useRecKeystrokeCounter(false))
    expect(result.current.getCount()).toBe(0)
  })

  it('increments the count', () => {
    const { result } = renderHook(() => useRecKeystrokeCounter(true))
    act(() => {
      result.current.increment()
      result.current.increment()
      result.current.increment()
    })
    expect(result.current.getCount()).toBe(3)
  })

  it('resets to zero on the recording OFF→ON edge', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useRecKeystrokeCounter(active),
      { initialProps: { active: false } },
    )

    act(() => {
      result.current.increment()
      result.current.increment()
    })
    expect(result.current.getCount()).toBe(2)

    // Turning off does not itself reset — only the OFF→ON edge does.
    rerender({ active: false })
    expect(result.current.getCount()).toBe(2)

    rerender({ active: true })
    expect(result.current.getCount()).toBe(0)
  })

  it('does not reset while already active (no edge)', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useRecKeystrokeCounter(active),
      { initialProps: { active: true } },
    )

    act(() => {
      result.current.increment()
    })
    expect(result.current.getCount()).toBe(1)

    rerender({ active: true })
    expect(result.current.getCount()).toBe(1)
  })
})
