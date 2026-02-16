// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useAutoLock } from '../useAutoLock'

describe('useAutoLock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not call onLock when unlocked is false', () => {
    const onLock = vi.fn()
    renderHook(() => useAutoLock({
      unlocked: false,
      autoLockMinutes: 10,
      activityCounter: 0,
      onLock,
    }))

    vi.advanceTimersByTime(10 * 60_000 + 1000)
    expect(onLock).not.toHaveBeenCalled()
  })

  it('calls onLock after autoLockMinutes when unlocked', () => {
    const onLock = vi.fn()
    renderHook(() => useAutoLock({
      unlocked: true,
      autoLockMinutes: 10,
      activityCounter: 0,
      onLock,
    }))

    vi.advanceTimersByTime(10 * 60_000 - 1)
    expect(onLock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2)
    expect(onLock).toHaveBeenCalledOnce()
  })

  it('resets timer when activityCounter changes', () => {
    const onLock = vi.fn()
    const { rerender } = renderHook(
      ({ activityCounter }) => useAutoLock({
        unlocked: true,
        autoLockMinutes: 10,
        activityCounter,
        onLock,
      }),
      { initialProps: { activityCounter: 0 } },
    )

    // Advance most of the way
    vi.advanceTimersByTime(9 * 60_000)
    expect(onLock).not.toHaveBeenCalled()

    // Bump activity — resets the timer
    rerender({ activityCounter: 1 })

    // Advance past original timeout
    vi.advanceTimersByTime(2 * 60_000)
    expect(onLock).not.toHaveBeenCalled()

    // Now advance full new timeout
    vi.advanceTimersByTime(8 * 60_000 + 1)
    expect(onLock).toHaveBeenCalledOnce()
  })

  it('clears timer when unlocked becomes false', () => {
    const onLock = vi.fn()
    const { rerender } = renderHook(
      ({ unlocked }) => useAutoLock({
        unlocked,
        autoLockMinutes: 10,
        activityCounter: 0,
        onLock,
      }),
      { initialProps: { unlocked: true } },
    )

    vi.advanceTimersByTime(5 * 60_000)
    rerender({ unlocked: false })

    vi.advanceTimersByTime(10 * 60_000)
    expect(onLock).not.toHaveBeenCalled()
  })

  it('uses updated autoLockMinutes value', () => {
    const onLock = vi.fn()
    const { rerender } = renderHook(
      ({ minutes }) => useAutoLock({
        unlocked: true,
        autoLockMinutes: minutes,
        activityCounter: 0,
        onLock,
      }),
      { initialProps: { minutes: 10 } },
    )

    // Change to 20 minutes
    rerender({ minutes: 20 })

    vi.advanceTimersByTime(10 * 60_000)
    expect(onLock).not.toHaveBeenCalled()

    vi.advanceTimersByTime(10 * 60_000 + 1)
    expect(onLock).toHaveBeenCalledOnce()
  })

  it('does not call onLock while suspended', () => {
    const onLock = vi.fn()
    renderHook(() => useAutoLock({
      unlocked: true,
      autoLockMinutes: 10,
      activityCounter: 0,
      suspended: true,
      onLock,
    }))

    vi.advanceTimersByTime(10 * 60_000 + 1000)
    expect(onLock).not.toHaveBeenCalled()
  })

  it('resumes timer when suspended becomes false', () => {
    const onLock = vi.fn()
    const { rerender } = renderHook(
      ({ suspended }) => useAutoLock({
        unlocked: true,
        autoLockMinutes: 10,
        activityCounter: 0,
        suspended,
        onLock,
      }),
      { initialProps: { suspended: true } },
    )

    vi.advanceTimersByTime(10 * 60_000)
    expect(onLock).not.toHaveBeenCalled()

    rerender({ suspended: false })

    vi.advanceTimersByTime(10 * 60_000 + 1)
    expect(onLock).toHaveBeenCalledOnce()
  })
})
