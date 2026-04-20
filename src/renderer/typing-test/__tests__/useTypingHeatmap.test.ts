// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingHeatmap, TYPING_HEATMAP_POLL_MS, TYPING_HEATMAP_DEFAULT_HALF_LIFE_MIN } from '../useTypingHeatmap'

const DEFAULT_HALF_LIFE_MS = TYPING_HEATMAP_DEFAULT_HALF_LIFE_MIN * 60 * 1_000
const BOOTSTRAP_SPAN_MS = DEFAULT_HALF_LIFE_MS * 5
import type { TypingHeatmapByCell } from '../../../shared/types/typing-analytics'

// Minimal vialAPI surface — only the heatmap call is exercised here.
type HeatmapFn = (uid: string, layer: number, sinceMs: number) => Promise<TypingHeatmapByCell>

function installVialApi(fn: HeatmapFn): void {
  ;(globalThis as unknown as { window: { vialAPI: { typingAnalyticsGetMatrixHeatmap: HeatmapFn } } })
    .window = { vialAPI: { typingAnalyticsGetMatrixHeatmap: fn } }
}

function cell(total: number, tap = 0, hold = 0): { total: number; tap: number; hold: number } {
  return { total, tap, hold }
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

    expect(result.current.cells).toBeNull()
    expect(result.current.maxTotal).toBe(0)
    expect(result.current.maxTap).toBe(0)
    expect(result.current.maxHold).toBe(0)
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

  it('fetches immediately on enable and populates cells + separate maxes', async () => {
    const api = vi.fn<HeatmapFn>().mockResolvedValue({
      '1,2': cell(5, 3, 2),
      '3,4': cell(2, 1, 1),
    })
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    await act(async () => { await flushPromises() })

    expect(result.current.cells?.get('1,2')).toEqual(cell(5, 3, 2))
    expect(result.current.maxTotal).toBe(5)
    expect(result.current.maxTap).toBe(3)
    expect(result.current.maxHold).toBe(2)
    expect(api).toHaveBeenCalledTimes(1)
    const [, , sinceMs] = api.mock.calls[0]
    // Bootstrap span is 5 half-lives so the EMA converges on the first
    // poll; the test asserts the contract, not a magic number.
    expect(Date.now() - (sinceMs as number)).toBeCloseTo(BOOTSTRAP_SPAN_MS, -2)
  })

  it('refetches on the poll interval and accumulates via EMA decay', async () => {
    const api = vi.fn<HeatmapFn>()
      .mockResolvedValueOnce({ '1,2': cell(5) })
      .mockResolvedValueOnce({ '1,2': cell(12) })
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    await act(async () => { await flushPromises() })
    expect(result.current.cells?.get('1,2')?.total).toBe(5)

    await act(async () => {
      vi.advanceTimersByTime(TYPING_HEATMAP_POLL_MS)
      await flushPromises()
    })
    // After one poll interval: previous counter decays by
    // exp(-pollMs·ln2/τ) and the newly observed hits add on top. This
    // is the core property the EMA refactor is supposed to preserve.
    const decay = Math.exp(-TYPING_HEATMAP_POLL_MS * Math.LN2 / DEFAULT_HALF_LIFE_MS)
    const expected = 5 * decay + 12
    expect(result.current.cells?.get('1,2')?.total).toBeCloseTo(expected, 4)
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('refetches immediately when uid or layer changes', async () => {
    const api = vi.fn<HeatmapFn>()
      .mockResolvedValueOnce({ '1,1': cell(1) })
      .mockResolvedValueOnce({ '2,2': cell(3) })
    installVialApi(api)

    const { result, rerender } = renderHook(
      (props: { uid: string; layer: number; enabled: boolean }) => useTypingHeatmap(props),
      { initialProps: { uid: '0xAABB', layer: 0, enabled: true } },
    )
    await act(async () => { await flushPromises() })
    expect(result.current.cells?.get('1,1')?.total).toBe(1)

    rerender({ uid: '0xAABB', layer: 1, enabled: true })
    await act(async () => { await flushPromises() })

    expect(result.current.cells?.get('2,2')?.total).toBe(3)
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('clears the overlay when enabled flips back to false', async () => {
    const api = vi.fn<HeatmapFn>().mockResolvedValue({ '1,2': cell(5) })
    installVialApi(api)

    const { result, rerender } = renderHook(
      (props: { uid: string; layer: number; enabled: boolean }) => useTypingHeatmap(props),
      { initialProps: { uid: '0xAABB', layer: 0, enabled: true } },
    )
    await act(async () => { await flushPromises() })
    expect(result.current.cells?.get('1,2')?.total).toBe(5)

    rerender({ uid: '0xAABB', layer: 0, enabled: false })
    await act(async () => { await flushPromises() })

    expect(result.current.cells).toBeNull()
    expect(result.current.maxTotal).toBe(0)
    expect(result.current.maxTap).toBe(0)
    expect(result.current.maxHold).toBe(0)
  })

  it('keeps the last good snapshot when a poll fails', async () => {
    const api = vi.fn<HeatmapFn>()
      .mockResolvedValueOnce({ '1,2': cell(5) })
      .mockRejectedValueOnce(new Error('ipc down'))
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    await act(async () => { await flushPromises() })
    expect(result.current.cells?.get('1,2')?.total).toBe(5)

    await act(async () => {
      vi.advanceTimersByTime(TYPING_HEATMAP_POLL_MS)
      await flushPromises()
    })

    expect(result.current.cells?.get('1,2')?.total).toBe(5)
  })

  it('does not set state after unmount', async () => {
    let resolveFetch: ((v: TypingHeatmapByCell) => void) | null = null
    const api = vi.fn<HeatmapFn>().mockImplementationOnce(
      () => new Promise((resolve) => { resolveFetch = resolve }),
    )
    installVialApi(api)

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { unmount } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    unmount()
    resolveFetch?.({ '1,2': cell(99) })
    await act(async () => { await Promise.resolve() })

    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })
})
