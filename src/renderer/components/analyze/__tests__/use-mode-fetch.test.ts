// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Pins useModeFetch's fetch-key-ref skip, cancelled guard, and
// null-ref-on-failure retry semantics — the exact behavior
// KeyHeatmapChart's Speed/Duration effects had before being collapsed
// into this shared hook.

import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useModeFetch } from '../use-mode-fetch'

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe('useModeFetch', () => {
  it('does not fetch while inactive, and reports loading: false (inactive is never a loading state)', () => {
    const fetcher = vi.fn().mockResolvedValue('data')
    const { result } = renderHook(() => useModeFetch(false, 'key-a', fetcher, 'empty'))
    expect(fetcher).not.toHaveBeenCalled()
    expect(result.current).toEqual({ data: 'empty', loading: false })
  })

  it('drops loading back to false when an active fetch is interrupted by going inactive', async () => {
    const first = deferred<string>()
    const fetcher = vi.fn().mockImplementationOnce(() => first.promise)
    const { rerender, result } = renderHook(
      ({ active, key }) => useModeFetch(active, key, fetcher, 'empty'),
      { initialProps: { active: true, key: 'key-a' } },
    )
    expect(result.current.loading).toBe(true)
    rerender({ active: false, key: 'key-a' })
    expect(result.current).toEqual({ data: 'empty', loading: false })
  })

  it('fetches once active, transitioning loading then populating data', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    const { result } = renderHook(() => useModeFetch(true, 'key-a', fetcher, 'empty'))
    expect(fetcher).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current).toEqual({ data: 'result', loading: false }))
  })

  it('skips refetching when key is unchanged across a rerender', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    const { result, rerender } = renderHook(
      ({ active, key }) => useModeFetch(active, key, fetcher, 'empty'),
      { initialProps: { active: true, key: 'key-a' } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ active: true, key: 'key-a' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refetches when key changes', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    const { rerender, result } = renderHook(
      ({ active, key }) => useModeFetch(active, key, fetcher, 'empty'),
      { initialProps: { active: true, key: 'key-a' } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ active: true, key: 'key-b' })
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  })

  it('does not refetch merely because the mode goes inactive then active again with the same key', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    const { rerender, result } = renderHook(
      ({ active, key }) => useModeFetch(active, key, fetcher, 'empty'),
      { initialProps: { active: true, key: 'key-a' } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ active: false, key: 'key-a' })
    rerender({ active: true, key: 'key-a' })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('resets to empty and nulls the cache key on failure, forcing a retry next time', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce('recovered')
    const { rerender, result } = renderHook(
      ({ active, key }) => useModeFetch(active, key, fetcher, 'empty'),
      { initialProps: { active: true, key: 'key-a' } },
    )
    await waitFor(() => expect(result.current).toEqual({ data: 'empty', loading: false }))
    // Bounce out and back in with the SAME key — a naive cache would
    // treat the failed key as still valid and skip the retry.
    rerender({ active: false, key: 'key-a' })
    rerender({ active: true, key: 'key-a' })
    await waitFor(() => expect(result.current).toEqual({ data: 'recovered', loading: false }))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('ignores a fetch that settles after the key has already moved on (cancelled guard)', async () => {
    const first = deferred<string>()
    const fetcher = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce('second-result')
    const { rerender, result } = renderHook(
      ({ active, key }) => useModeFetch(active, key, fetcher, 'empty'),
      { initialProps: { active: true, key: 'key-a' } },
    )
    expect(fetcher).toHaveBeenCalledTimes(1)
    // Move to a new key before the first fetch resolves.
    rerender({ active: true, key: 'key-b' })
    await waitFor(() => expect(result.current).toEqual({ data: 'second-result', loading: false }))
    // The stale first fetch resolving afterward must not clobber state.
    first.resolve('stale-result')
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).toEqual({ data: 'second-result', loading: false })
  })
})
