// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTrayStatus } from '../useTrayStatus'

let trayStatusUpdate: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  trayStatusUpdate = vi.fn().mockResolvedValue(undefined)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).vialAPI = { trayStatusUpdate }
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useTrayStatus', () => {
  it('sends immediately on mount', () => {
    renderHook(() => useTrayStatus({ keyboardName: 'GPK-63R', recording: false, getCount: () => 0, getKpm: () => 0 }))
    expect(trayStatusUpdate).toHaveBeenCalledTimes(1)
    expect(trayStatusUpdate).toHaveBeenCalledWith({ keyboardName: 'GPK-63R', recording: false, count: 0, kpm: 0 })
  })

  it('sends immediately when the keyboard name changes', () => {
    const { rerender } = renderHook(
      ({ keyboardName }) => useTrayStatus({ keyboardName, recording: false, getCount: () => 0, getKpm: () => 0 }),
      { initialProps: { keyboardName: null as string | null } },
    )
    expect(trayStatusUpdate).toHaveBeenCalledTimes(1)

    rerender({ keyboardName: 'GPK-63R' })
    expect(trayStatusUpdate).toHaveBeenCalledTimes(2)
    expect(trayStatusUpdate).toHaveBeenLastCalledWith({ keyboardName: 'GPK-63R', recording: false, count: 0, kpm: 0 })
  })

  it('sends immediately when recording changes', () => {
    const { rerender } = renderHook(
      ({ recording }) => useTrayStatus({ keyboardName: 'GPK-63R', recording, getCount: () => 0, getKpm: () => 0 }),
      { initialProps: { recording: false } },
    )
    expect(trayStatusUpdate).toHaveBeenCalledTimes(1)

    rerender({ recording: true })
    expect(trayStatusUpdate).toHaveBeenCalledTimes(2)
    expect(trayStatusUpdate).toHaveBeenLastCalledWith({ keyboardName: 'GPK-63R', recording: true, count: 0, kpm: 0 })
  })

  it('dedupes identical rerenders — no resend when nothing changed', () => {
    const { rerender } = renderHook(
      ({ keyboardName }) => useTrayStatus({ keyboardName, recording: false, getCount: () => 0, getKpm: () => 0 }),
      { initialProps: { keyboardName: 'GPK-63R' } },
    )
    expect(trayStatusUpdate).toHaveBeenCalledTimes(1)

    rerender({ keyboardName: 'GPK-63R' })
    expect(trayStatusUpdate).toHaveBeenCalledTimes(1)
  })

  it('throttles count-only movement to at most one send per second, trailing', () => {
    let count = 0
    renderHook(() => useTrayStatus({ keyboardName: 'GPK-63R', recording: true, getCount: () => count, getKpm: () => 0 }))
    expect(trayStatusUpdate).toHaveBeenCalledTimes(1)
    expect(trayStatusUpdate).toHaveBeenLastCalledWith({ keyboardName: 'GPK-63R', recording: true, count: 0, kpm: 0 })

    // Several "keystrokes" happen within the same second — no send yet.
    count = 5
    vi.advanceTimersByTime(400)
    count = 9
    vi.advanceTimersByTime(400)
    expect(trayStatusUpdate).toHaveBeenCalledTimes(1)

    // The trailing tick lands the latest value.
    vi.advanceTimersByTime(200)
    expect(trayStatusUpdate).toHaveBeenCalledTimes(2)
    expect(trayStatusUpdate).toHaveBeenLastCalledWith({ keyboardName: 'GPK-63R', recording: true, count: 9, kpm: 0 })

    // No further sends while the count stays put.
    vi.advanceTimersByTime(1000)
    expect(trayStatusUpdate).toHaveBeenCalledTimes(2)
  })

  it('throttles kpm-only movement the same way as count', () => {
    let kpm = 0
    renderHook(() => useTrayStatus({ keyboardName: 'GPK-63R', recording: true, getCount: () => 0, getKpm: () => kpm }))
    expect(trayStatusUpdate).toHaveBeenCalledTimes(1)

    kpm = 20
    vi.advanceTimersByTime(1000)
    expect(trayStatusUpdate).toHaveBeenCalledTimes(2)
    expect(trayStatusUpdate).toHaveBeenLastCalledWith({ keyboardName: 'GPK-63R', recording: true, count: 0, kpm: 20 })
  })

  it('does not poll the count/kpm getters while not recording', () => {
    const getCount = vi.fn().mockReturnValue(0)
    const getKpm = vi.fn().mockReturnValue(0)
    renderHook(() => useTrayStatus({ keyboardName: 'GPK-63R', recording: false, getCount, getKpm }))
    getCount.mockClear()
    getKpm.mockClear()

    vi.advanceTimersByTime(5000)
    expect(getCount).not.toHaveBeenCalled()
    expect(getKpm).not.toHaveBeenCalled()
    expect(trayStatusUpdate).toHaveBeenCalledTimes(1)
  })

  it('clears the pending interval timer on unmount', () => {
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')
    const { unmount } = renderHook(() => useTrayStatus({ keyboardName: 'GPK-63R', recording: true, getCount: () => 0, getKpm: () => 0 }))

    unmount()
    expect(clearIntervalSpy).toHaveBeenCalled()
  })
})
