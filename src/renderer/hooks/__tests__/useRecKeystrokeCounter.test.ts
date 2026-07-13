// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRecKeystrokeCounter } from '../useRecKeystrokeCounter'

describe('useRecKeystrokeCounter', () => {
  it('starts at zero', () => {
    const { result } = renderHook(() => useRecKeystrokeCounter(false))
    expect(result.current.getCount()).toBe(0)
    expect(result.current.getKpm()).toBe(0)
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

  describe('getKpm — rolling 60-second window', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('counts keystrokes made within the last 60 seconds', () => {
      const { result } = renderHook(() => useRecKeystrokeCounter(true))
      act(() => {
        result.current.increment()
        result.current.increment()
        result.current.increment()
      })
      expect(result.current.getKpm()).toBe(3)
    })

    it('drops keystrokes older than 60 seconds on read', () => {
      const { result } = renderHook(() => useRecKeystrokeCounter(true))
      act(() => {
        result.current.increment()
        result.current.increment()
      })
      expect(result.current.getKpm()).toBe(2)

      act(() => {
        vi.advanceTimersByTime(61_000)
      })
      expect(result.current.getKpm()).toBe(0)
    })

    it('counts only the entries still within the window when ages are mixed', () => {
      const { result } = renderHook(() => useRecKeystrokeCounter(true))

      // Two keystrokes now, then advance 50s, then two more.
      act(() => {
        result.current.increment()
        result.current.increment()
      })
      act(() => {
        vi.advanceTimersByTime(50_000)
      })
      act(() => {
        result.current.increment()
        result.current.increment()
      })
      // All four are still within 60s of "now" at this point.
      expect(result.current.getKpm()).toBe(4)

      // Advance another 11s (61s total since the first two) — those two
      // age out, the later two remain.
      act(() => {
        vi.advanceTimersByTime(11_000)
      })
      expect(result.current.getKpm()).toBe(2)
    })

    it('resets the KPM buffer on the recording OFF→ON edge', () => {
      const { result, rerender } = renderHook(
        ({ active }) => useRecKeystrokeCounter(active),
        { initialProps: { active: false } },
      )

      act(() => {
        result.current.increment()
        result.current.increment()
      })
      expect(result.current.getKpm()).toBe(2)

      rerender({ active: false })
      expect(result.current.getKpm()).toBe(2)

      rerender({ active: true })
      expect(result.current.getKpm()).toBe(0)
    })
  })
})
