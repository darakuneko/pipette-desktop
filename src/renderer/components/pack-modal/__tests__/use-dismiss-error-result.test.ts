// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useState } from 'react'
import { useDismissErrorResult } from '../use-dismiss-error-result'
import { ERROR_DISMISS_MS } from '../../ui/DismissibleError'
import type { PackActionResult } from '../pack-modal-types'

type Result = PackActionResult | PackActionResult[] | null

function renderWithState(initial: Result) {
  return renderHook(() => {
    const [lastResult, setLastResult] = useState<Result>(initial)
    useDismissErrorResult(lastResult, setLastResult)
    return { lastResult, setLastResult }
  })
}

const error = (id: string, message = 'failed'): PackActionResult => ({ id, kind: 'error', message })
const success = (id: string, message = 'saved'): PackActionResult => ({ id, kind: 'success', message })

describe('useDismissErrorResult', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('clears a single error after ERROR_DISMISS_MS, not before', () => {
    const { result } = renderWithState(error('a'))
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS - 100) })
    expect(result.current.lastResult).toEqual(error('a'))
    act(() => { vi.advanceTimersByTime(100) })
    expect(result.current.lastResult).toBeNull()
  })

  it('never clears a success result', () => {
    const ok = success('a')
    const { result } = renderWithState(ok)
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS * 3) })
    expect(result.current.lastResult).toBe(ok)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('removes only the error entries from a mixed array', () => {
    const { result } = renderWithState([success('a'), error('b'), success('c')])
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS) })
    expect(result.current.lastResult).toEqual([success('a'), success('c')])
  })

  it('clears an all-error array to null', () => {
    const { result } = renderWithState([error('a'), error('b')])
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS) })
    expect(result.current.lastResult).toBeNull()
  })

  it('leaves a success-only array untouched', () => {
    const list = [success('a'), success('b')]
    const { result } = renderWithState(list)
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS) })
    expect(result.current.lastResult).toBe(list)
  })

  it('cancels the timer when the error is replaced by null', () => {
    const { result } = renderWithState(error('a'))
    act(() => { result.current.setLastResult(null) })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels the timer when the error is replaced by a success', () => {
    const { result } = renderWithState(error('a'))
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS - 1000) })
    const ok = success('a')
    act(() => { result.current.setLastResult(ok) })
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS) })
    expect(result.current.lastResult).toBe(ok)
  })

  it('restarts the timer for a new object with the same message', () => {
    const { result } = renderWithState(error('a'))
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS - 1000) })
    act(() => { result.current.setLastResult(error('a')) })
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current.lastResult).toEqual(error('a'))
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS - 1000) })
    expect(result.current.lastResult).toBeNull()
  })

  it('gives a replaced error result its own full lifetime', () => {
    const { result } = renderWithState(error('a', 'first'))
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS / 2) })
    const newer = error('b', 'second')
    act(() => { result.current.setLastResult(newer) })
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS / 2) })
    expect(result.current.lastResult).toBe(newer)
    act(() => { vi.advanceTimersByTime(ERROR_DISMISS_MS / 2) })
    expect(result.current.lastResult).toBeNull()
  })

  it('clears its timer on unmount', () => {
    const { unmount } = renderWithState(error('a'))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(vi.getTimerCount()).toBe(0)
  })
})
