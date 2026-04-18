// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingHeatmap, TYPING_HEATMAP_POLL_MS, TYPING_HEATMAP_WINDOW_MS } from '../useTypingHeatmap'

// Minimal vialAPI surface — only the heatmap call is exercised here.
type HeatmapFn = (uid: string, layer: number, sinceMs: number) => Promise<Record<string, number>>

function installVialApi(fn: HeatmapFn): void {
  ;(globalThis as unknown as { window: { vialAPI: { typingAnalyticsGetMatrixHeatmap: HeatmapFn } } })
    .window = { vialAPI: { typingAnalyticsGetMatrixHeatmap: fn } }
}

/** Flush every pending microtask + promise callback. Repeated loops
 * let the hook's `async fetchOnce` resolve through its `await` chain
 * even under fake timers (where queueMicrotask does not auto-run). */
async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

describe('useTypingHeatmap', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-18T10:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stays null when disabled (record off)', async () => {
    const api = vi.fn<HeatmapFn>().mockResolvedValue({})
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: false }))
    await act(async () => { await Promise.resolve() })

    expect(result.current.intensityByCell).toBeNull()
    expect(result.current.maxCount).toBe(0)
    expect(api).not.toHaveBeenCalled()
  })

  it('does not call the IPC until uid + layer are both resolved', async () => {
    const api = vi.fn<HeatmapFn>().mockResolvedValue({})
    installVialApi(api)

    const { rerender } = renderHook(
      (props: { uid: string | null; layer: number | null; enabled: boolean }) => useTypingHeatmap(props),
      { initialProps: { uid: null, layer: null, enabled: true } },
    )
    await act(async () => { await Promise.resolve() })
    expect(api).not.toHaveBeenCalled()

    rerender({ uid: null, layer: 0, enabled: true })
    await act(async () => { await Promise.resolve() })
    expect(api).not.toHaveBeenCalled()

    rerender({ uid: '0xAABB', layer: 0, enabled: true })
    await act(async () => { await Promise.resolve() })
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('fetches immediately on enable and populates intensity + max', async () => {
    const api = vi.fn<HeatmapFn>().mockResolvedValue({ '1,2': 5, '3,4': 2 })
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    await act(async () => { await flushPromises() })

    expect(result.current.intensityByCell?.get('1,2')).toBe(5)
    expect(result.current.maxCount).toBe(5)
    expect(api).toHaveBeenCalledTimes(1)
    const [, , sinceMs] = api.mock.calls[0]
    // sinceMs == now - 1h; tolerate a tick of slop.
    expect(Date.now() - (sinceMs as number)).toBeCloseTo(TYPING_HEATMAP_WINDOW_MS, -2)
  })

  it('refetches on the poll interval', async () => {
    const api = vi.fn<HeatmapFn>()
      .mockResolvedValueOnce({ '1,2': 5 })
      .mockResolvedValueOnce({ '1,2': 12 })
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    await act(async () => { await flushPromises() })
    expect(result.current.intensityByCell?.get('1,2')).toBe(5)

    await act(async () => {
      vi.advanceTimersByTime(TYPING_HEATMAP_POLL_MS)
      await flushPromises()
    })
    expect(result.current.intensityByCell?.get('1,2')).toBe(12)
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('refetches immediately when uid or layer changes', async () => {
    const api = vi.fn<HeatmapFn>()
      .mockResolvedValueOnce({ '1,1': 1 })
      .mockResolvedValueOnce({ '2,2': 3 })
    installVialApi(api)

    const { result, rerender } = renderHook(
      (props: { uid: string; layer: number; enabled: boolean }) => useTypingHeatmap(props),
      { initialProps: { uid: '0xAABB', layer: 0, enabled: true } },
    )
    await act(async () => { await flushPromises() })
    expect(result.current.intensityByCell?.get('1,1')).toBe(1)

    rerender({ uid: '0xAABB', layer: 1, enabled: true })
    await act(async () => { await flushPromises() })

    expect(result.current.intensityByCell?.get('2,2')).toBe(3)
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('clears the overlay when enabled flips back to false', async () => {
    const api = vi.fn<HeatmapFn>().mockResolvedValue({ '1,2': 5 })
    installVialApi(api)

    const { result, rerender } = renderHook(
      (props: { uid: string; layer: number; enabled: boolean }) => useTypingHeatmap(props),
      { initialProps: { uid: '0xAABB', layer: 0, enabled: true } },
    )
    await act(async () => { await flushPromises() })
    expect(result.current.intensityByCell?.get('1,2')).toBe(5)

    rerender({ uid: '0xAABB', layer: 0, enabled: false })
    await act(async () => { await flushPromises() })

    expect(result.current.intensityByCell).toBeNull()
    expect(result.current.maxCount).toBe(0)
  })

  it('keeps the last good snapshot when a poll fails', async () => {
    const api = vi.fn<HeatmapFn>()
      .mockResolvedValueOnce({ '1,2': 5 })
      .mockRejectedValueOnce(new Error('ipc down'))
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    await act(async () => { await flushPromises() })
    expect(result.current.intensityByCell?.get('1,2')).toBe(5)

    await act(async () => {
      vi.advanceTimersByTime(TYPING_HEATMAP_POLL_MS)
      await flushPromises()
    })

    // Second fetch rejected — snapshot from the first still visible.
    expect(result.current.intensityByCell?.get('1,2')).toBe(5)
  })

  it('does not set state after unmount', async () => {
    let resolveFetch: ((v: Record<string, number>) => void) | null = null
    const api = vi.fn<HeatmapFn>().mockImplementationOnce(
      () => new Promise((resolve) => { resolveFetch = resolve }),
    )
    installVialApi(api)

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    unmount()
    // Resolve after unmount; the hook must swallow the callback.
    resolveFetch?.({ '1,2': 99 })
    await act(async () => { await Promise.resolve() })

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
