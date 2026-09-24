// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useCallback } from 'react'
import { useLatestRef } from '../use-latest-ref'

describe('useLatestRef', () => {
  it('holds the initial value after mount', () => {
    const { result } = renderHook(() => useLatestRef(1))
    expect(result.current.current).toBe(1)
  })

  it('keeps one ref object and reflects the latest value after each render', () => {
    const { result, rerender } = renderHook(({ v }) => useLatestRef(v), { initialProps: { v: 'a' } })
    const ref = result.current
    rerender({ v: 'b' })
    expect(result.current).toBe(ref)
    expect(ref.current).toBe('b')
  })

  it('lets a callback with no data deps keep its identity and read current values', () => {
    const { result, rerender } = renderHook(({ v }) => {
      const ref = useLatestRef(v)
      return useCallback(() => ref.current, [ref])
    }, { initialProps: { v: 1 } })
    const read = result.current
    rerender({ v: 2 })
    expect(result.current).toBe(read)
    expect(read()).toBe(2)
  })
})
