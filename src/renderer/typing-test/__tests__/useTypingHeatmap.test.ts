// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useTypingHeatmap, TYPING_HEATMAP_POLL_MS, TYPING_HEATMAP_DEFAULT_WINDOW_MIN } from '../useTypingHeatmap'
import type { TypingHeatmapByCell } from '../../../shared/types/typing-analytics'

const DEFAULT_WINDOW_MS = TYPING_HEATMAP_DEFAULT_WINDOW_MIN * 60 * 1_000
const DEFAULT_TAU_MS = DEFAULT_WINDOW_MS / 5

type HeatmapFn = (uid: string, layer: number, sinceMs: number) => Promise<TypingHeatmapByCell>

function installVialApi(fn: HeatmapFn): void {
  ;(globalThis as unknown as { window: { vialAPI: { typingAnalyticsGetMatrixHeatmap: HeatmapFn } } })
    .window = { vialAPI: { typingAnalyticsGetMatrixHeatmap: fn } }
}

function cell(total: number, tap = 0, hold = 0): { total: number; tap: number; hold: number } {
  return { total, tap, hold }
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
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
    expect(api).not.toHaveBeenCalled()
  })

  it('fetches the full window on bootstrap', async () => {
    const api = vi.fn<HeatmapFn>().mockResolvedValue({ '1,2': cell(5, 3, 2) })
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    await act(async () => { await flushPromises() })

    // Bootstrap sample is anchored at "now" with weight 1, so the
    // counter equals the raw bootstrap totals.
    expect(result.current.cells?.get('1,2')).toEqual(cell(5, 3, 2))
    expect(result.current.maxTotal).toBe(5)
    const [, , sinceMs] = api.mock.calls[0]
    expect(Date.now() - (sinceMs as number)).toBeCloseTo(DEFAULT_WINDOW_MS, -2)
  })

  it('decays in-window samples but holds the absolute peak so the colour fades', async () => {
    const api = vi.fn<HeatmapFn>().mockResolvedValue({ '1,2': cell(10) })
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    await act(async () => { await flushPromises() })
    expect(result.current.cells?.get('1,2')?.total).toBe(10)
    expect(result.current.maxTotal).toBe(10)

    await act(async () => {
      vi.advanceTimersByTime(TYPING_HEATMAP_POLL_MS)
      await flushPromises()
    })

    // Bootstrap sample is now 5 s old, no new delta arrived (raw total
    // unchanged → delta 0). Counter = 10 · exp(-5000·ln2/τ).
    const weight = Math.exp(-TYPING_HEATMAP_POLL_MS * Math.LN2 / DEFAULT_TAU_MS)
    expect(result.current.cells?.get('1,2')?.total).toBeCloseTo(10 * weight, 4)
    // Peak doesn't decay → ratio drops, colour fades.
    expect(result.current.maxTotal).toBe(10)
  })

  it('drops expired samples after the window passes', async () => {
    // 1-min window so the test runs in a few "ticks". Initial sample
    // expires after windowMs; with no later input the counter goes to 0.
    const oneMinWindowMs = 60 * 1_000
    const api = vi.fn<HeatmapFn>().mockResolvedValue({ '1,2': cell(7) })
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({
      uid: '0xAABB', layer: 0, enabled: true, windowMs: oneMinWindowMs,
    }))
    await act(async () => { await flushPromises() })
    expect(result.current.cells?.get('1,2')?.total).toBe(7)

    // Advance just past the window. Bootstrap sample should drop.
    await act(async () => {
      vi.advanceTimersByTime(oneMinWindowMs + TYPING_HEATMAP_POLL_MS)
      await flushPromises()
    })

    expect(result.current.cells?.get('1,2')).toBeUndefined()
  })

  it('adds a fresh delta as a new in-window sample (no minute-bucket double counting)', async () => {
    const api = vi.fn<HeatmapFn>()
      .mockResolvedValueOnce({ '1,2': cell(5) })   // bootstrap
      .mockResolvedValueOnce({ '1,2': cell(12) })  // poll: 7 new hits
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    await act(async () => { await flushPromises() })

    await act(async () => {
      vi.advanceTimersByTime(TYPING_HEATMAP_POLL_MS)
      await flushPromises()
    })

    // Bootstrap sample (5 hits, age 5 s) decays a touch; new sample
    // (delta 7, age 0) contributes its full undecayed weight.
    const w5 = Math.exp(-TYPING_HEATMAP_POLL_MS * Math.LN2 / DEFAULT_TAU_MS)
    const expected = 5 * w5 + 7 * 1
    expect(result.current.cells?.get('1,2')?.total).toBeCloseTo(expected, 4)
  })

  it('treats a key that rolled out of the fetch window as reset on re-appearance', async () => {
    // Bootstrap sees 10. Mid-poll the key falls out of the fetch
    // (raw total → 0). When it reappears with 2, the hook must treat
    // the 2 as a fresh delta, not compare it against the stale peak.
    const api = vi.fn<HeatmapFn>()
      .mockResolvedValueOnce({ '1,2': cell(10) })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ '1,2': cell(2) })
    installVialApi(api)

    const { result } = renderHook(() => useTypingHeatmap({ uid: '0xAABB', layer: 0, enabled: true }))
    await act(async () => { await flushPromises() })

    await act(async () => {
      vi.advanceTimersByTime(TYPING_HEATMAP_POLL_MS)
      await flushPromises()
    })
    await act(async () => {
      vi.advanceTimersByTime(TYPING_HEATMAP_POLL_MS)
      await flushPromises()
    })

    // Three samples in the buffer:
    //   tsMs=0   delta=10 (bootstrap), now age = 2·POLL_MS
    //   tsMs=POLL delta from {}, dropped (no positive delta)
    //   tsMs=2·POLL delta=2, now age 0
    const w10 = Math.exp(-2 * TYPING_HEATMAP_POLL_MS * Math.LN2 / DEFAULT_TAU_MS)
    const expected = 10 * w10 + 2
    expect(result.current.cells?.get('1,2')?.total).toBeCloseTo(expected, 4)
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
