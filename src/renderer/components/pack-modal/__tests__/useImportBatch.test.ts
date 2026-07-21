// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { useImportBatch, type CollectedImportBatch } from '../useImportBatch'
import type { UseImportPlacementResult } from '../useImportPlacement'

interface FakeMeta {
  id: string
  name: string
  hubPostId?: string
}

// Mirrors the modal tests' fake `t`: surfaces the toolbar summary's
// success/failure counts (and the interpolated `name`) without a real
// i18next pluralization pipeline.
const t = ((key: string, params?: Record<string, unknown>) => {
  if (params && 'success' in params && 'failure' in params) {
    return `${key}:${String(params.count)}:${String(params.success)}:${String(params.failure)}`
  }
  if (params && 'name' in params) return `${key}:${String(params.name)}`
  return key
}) as unknown as TFunction

function makePlacement(): UseImportPlacementResult {
  return {
    feedback: null,
    snapshotBeforeIds: () => new Set(),
    snapshotEntries: () => ({ entries: [], direction: 'asc' }),
    place: vi.fn().mockResolvedValue(undefined),
    placeMany: vi.fn().mockResolvedValue(undefined),
  }
}

describe('useImportBatch', () => {
  it('a batch that collapses to one result: hub-syncs, places, sets lastResult, and fires onCollapsedToOne — no toolbar summary', async () => {
    const placement = makePlacement()
    const setLastResult = vi.fn()
    const setActionError = vi.fn()
    const onCollapsedToOne = vi.fn()
    const hubSync = vi.fn().mockResolvedValue({ success: true })
    const collectResults = vi.fn().mockResolvedValue({
      successes: [{ fileName: 'alpha.json', meta: { id: 'a', name: 'Alpha', hubPostId: 'hp1' } }],
      notSavedFailures: [],
      snapshot: { entries: [], direction: 'asc' },
    } satisfies CollectedImportBatch<FakeMeta>)

    const { result } = renderHook(() => useImportBatch<FakeMeta>({
      open: true,
      placement,
      setLastResult,
      setActionError,
      t,
      collectResults,
      hubSync,
      onCollapsedToOne,
    }))

    await act(async () => { await result.current.runImport() })

    expect(hubSync).toHaveBeenCalledWith({ id: 'a', name: 'Alpha', hubPostId: 'hp1' })
    // Third arg is the pre-dedupe original success count (1 here) — see
    // the P1 fix note: it drives `placeMany`'s own scroll suppression
    // and must never be inferred from the deduped `results` array.
    expect(placement.placeMany).toHaveBeenCalledWith(
      [{ id: 'a', name: 'Alpha' }],
      { entries: [], direction: 'asc' },
      1,
    )
    expect(setLastResult).toHaveBeenCalledWith([{ id: 'a', kind: 'success', message: 'common.synced' }])
    expect(onCollapsedToOne).toHaveBeenCalledWith({ id: 'a', name: 'Alpha', hubPostId: 'hp1' })
    expect(setActionError).toHaveBeenCalledWith(null)
    // Below the 2-file threshold — the per-name `placement.feedback`
    // text (not exercised by this hook) is what the modal shows instead.
    expect(result.current.importSummary).toBeNull()
    expect(result.current.importing).toBe(false)
  })

  it('dedupes same-id results keeping the last file for placement/hub-sync, but the summary and scroll signal still use the original pre-dedupe count', async () => {
    const placement = makePlacement()
    const setLastResult = vi.fn()
    const onCollapsedToOne = vi.fn()
    const collectResults = vi.fn().mockResolvedValue({
      successes: [
        { fileName: 'first.json', meta: { id: 'x', name: 'First' } },
        // Same id as above (e.g. same name auto-overwrite) — only this
        // later outcome should survive in `deduped`.
        { fileName: 'second.json', meta: { id: 'x', name: 'Second' } },
        { fileName: 'third.json', meta: { id: 'y', name: 'Third' } },
      ],
      notSavedFailures: [],
      snapshot: { entries: [], direction: 'asc' },
    } satisfies CollectedImportBatch<FakeMeta>)

    const { result } = renderHook(() => useImportBatch<FakeMeta>({
      open: true,
      placement,
      setLastResult,
      setActionError: vi.fn(),
      t,
      collectResults,
      onCollapsedToOne,
    }))

    await act(async () => { await result.current.runImport() })

    // Placement/reorder still operates on the deduped, one-per-id list
    // — but the 3rd arg (originalCount) is 3, the true pre-dedupe file
    // count, not `deduped.length` (2).
    expect(placement.placeMany).toHaveBeenCalledWith(
      [{ id: 'x', name: 'Second' }, { id: 'y', name: 'Third' }],
      { entries: [], direction: 'asc' },
      3,
    )
    expect(setLastResult).toHaveBeenCalledWith([
      { id: 'x', kind: 'success', message: 'common.saved' },
      { id: 'y', kind: 'success', message: 'common.saved' },
    ])
    expect(onCollapsedToOne).not.toHaveBeenCalled()
    // 3 successes (pre-dedupe), 0 failures — not "2:2:0" from
    // `deduped.length`.
    expect(result.current.importSummary).toBe('common.importSummary:3:3:0')
  })

  it('P1-a regression: two files that both overwrite the SAME existing pack still read as a genuine 2-file batch — summary shown, no auto-select, scroll suppressed via originalCount', async () => {
    const placement = makePlacement()
    const setLastResult = vi.fn()
    const onCollapsedToOne = vi.fn()
    const collectResults = vi.fn().mockResolvedValue({
      // Both files independently overwrite the same pre-existing id 'x'
      // — 2 real, successful saves that just happen to dedupe to 1
      // placed entry.
      successes: [
        { fileName: 'first.json', meta: { id: 'x', name: 'Existing' } },
        { fileName: 'second.json', meta: { id: 'x', name: 'Existing' } },
      ],
      notSavedFailures: [],
      snapshot: { entries: [], direction: 'asc' },
    } satisfies CollectedImportBatch<FakeMeta>)

    const { result } = renderHook(() => useImportBatch<FakeMeta>({
      open: true,
      placement,
      setLastResult,
      setActionError: vi.fn(),
      t,
      collectResults,
      onCollapsedToOne,
    }))

    await act(async () => { await result.current.runImport() })

    // `deduped` is a single entry, but originalCount (3rd arg) is 2 —
    // this is what makes `placeMany` suppress the scroll it would
    // otherwise do for a lone result.
    expect(placement.placeMany).toHaveBeenCalledWith(
      [{ id: 'x', name: 'Existing' }],
      { entries: [], direction: 'asc' },
      2,
    )
    // No single "the" import to activate — a 2-file batch, even one
    // that collapses to one id, must not auto-select.
    expect(onCollapsedToOne).not.toHaveBeenCalled()
    // success 2, failure 0 — never "success 1" from `deduped.length`.
    expect(result.current.importSummary).toBe('common.importSummary:2:2:0')
  })

  it('re-entrancy: a second call while a batch is in flight does not run collectResults again', async () => {
    let resolveCollect!: (value: CollectedImportBatch<FakeMeta> | null) => void
    const collectResults = vi.fn(() => new Promise<CollectedImportBatch<FakeMeta> | null>((resolve) => { resolveCollect = resolve }))
    const placement = makePlacement()

    const { result } = renderHook(() => useImportBatch<FakeMeta>({
      open: true,
      placement,
      setLastResult: vi.fn(),
      setActionError: vi.fn(),
      t,
      collectResults,
    }))

    let firstCall!: Promise<void>
    let secondCall!: Promise<void>
    act(() => {
      firstCall = result.current.runImport()
      secondCall = result.current.runImport()
    })
    expect(result.current.importing).toBe(true)
    expect(collectResults).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCollect(null)
      await firstCall
      await secondCall
    })
    expect(result.current.importing).toBe(false)
  })

  it('a canceled/empty batch (collectResults returns null) is a no-op: no placement, no lastResult, no summary', async () => {
    const placement = makePlacement()
    const setLastResult = vi.fn()
    const setActionError = vi.fn()
    const collectResults = vi.fn().mockResolvedValue(null)

    const { result } = renderHook(() => useImportBatch<FakeMeta>({
      open: true,
      placement,
      setLastResult,
      setActionError,
      t,
      collectResults,
    }))

    await act(async () => { await result.current.runImport() })

    expect(placement.placeMany).not.toHaveBeenCalled()
    // Only the "clear previous state" call at the start of the batch —
    // never called again with an actual result.
    expect(setLastResult).toHaveBeenCalledTimes(1)
    expect(setLastResult).toHaveBeenCalledWith(null)
    expect(result.current.importSummary).toBeNull()
    expect(result.current.importing).toBe(false)
  })

  it('splits failures: a hub-sync failure still counts toward the summary\'s success total, but lands in the error banner, not the headline', async () => {
    const placement = makePlacement()
    const setActionError = vi.fn()
    const hubSync = vi.fn().mockResolvedValue({ success: false, error: 'network down' })
    const collectResults = vi.fn().mockResolvedValue({
      successes: [{ fileName: 'good.json', meta: { id: 'g', name: 'Good', hubPostId: 'hp' } }],
      notSavedFailures: [{ fileName: 'bad.json', reason: 'parse error' }],
      snapshot: { entries: [], direction: 'asc' },
    } satisfies CollectedImportBatch<FakeMeta>)

    const { result } = renderHook(() => useImportBatch<FakeMeta>({
      open: true,
      placement,
      setLastResult: vi.fn(),
      setActionError,
      t,
      collectResults,
      hubSync,
    }))

    await act(async () => { await result.current.runImport() })

    // 1 saved (the hub-sync failure doesn't reduce this — the file
    // itself landed on disk) + 1 not-saved (the parse failure).
    expect(result.current.importSummary).toBe('common.importSummary:2:1:1')
    const banner = setActionError.mock.calls.at(-1)?.[0] as string
    expect(banner).toContain('bad.json')
    expect(banner).toContain('parse error')
    expect(banner).toContain('good.json')
    expect(banner).toContain('network down')
  })

  it('a meta with no hubPostId never invokes hubSync, even when one is provided', async () => {
    const placement = makePlacement()
    const hubSync = vi.fn()
    const collectResults = vi.fn().mockResolvedValue({
      successes: [{ fileName: 'a.json', meta: { id: 'a', name: 'Alpha' } }],
      notSavedFailures: [],
      snapshot: { entries: [], direction: 'asc' },
    } satisfies CollectedImportBatch<FakeMeta>)

    const { result } = renderHook(() => useImportBatch<FakeMeta>({
      open: true,
      placement,
      setLastResult: vi.fn(),
      setActionError: vi.fn(),
      t,
      collectResults,
      hubSync,
    }))

    await act(async () => { await result.current.runImport() })

    expect(hubSync).not.toHaveBeenCalled()
  })

  it('clears the toolbar summary immediately on close, mirroring useImportPlacement\'s own open-gated resets', async () => {
    const placement = makePlacement()
    const collectResults = vi.fn().mockResolvedValue({
      successes: [
        { fileName: 'a.json', meta: { id: 'a', name: 'Alpha' } },
        { fileName: 'b.json', meta: { id: 'b', name: 'Bravo' } },
      ],
      notSavedFailures: [],
      snapshot: { entries: [], direction: 'asc' },
    } satisfies CollectedImportBatch<FakeMeta>)

    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => useImportBatch<FakeMeta>({
        open,
        placement,
        setLastResult: vi.fn(),
        setActionError: vi.fn(),
        t,
        collectResults,
      }),
      { initialProps: { open: true } },
    )

    await act(async () => { await result.current.runImport() })
    expect(result.current.importSummary).toBe('common.importSummary:2:2:0')

    act(() => { rerender({ open: false }) })
    expect(result.current.importSummary).toBeNull()
  })

  describe('hub-sync pacing', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('adds no delay when nothing in the batch has a hubPostId (zero hub-syncs)', async () => {
      vi.useFakeTimers()
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      const placement = makePlacement()
      const hubSync = vi.fn().mockResolvedValue({ success: true })
      const collectResults = vi.fn().mockResolvedValue({
        successes: [
          { fileName: 'a.json', meta: { id: 'a', name: 'A' } },
          { fileName: 'b.json', meta: { id: 'b', name: 'B' } },
        ],
        notSavedFailures: [],
        snapshot: { entries: [], direction: 'asc' },
      } satisfies CollectedImportBatch<FakeMeta>)

      const { result } = renderHook(() => useImportBatch<FakeMeta>({
        open: true,
        placement,
        setLastResult: vi.fn(),
        setActionError: vi.fn(),
        t,
        collectResults,
        hubSync,
      }))

      await act(async () => {
        const p = result.current.runImport()
        await vi.runAllTimersAsync()
        await p
      })

      expect(hubSync).not.toHaveBeenCalled()
      expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 1100)).toHaveLength(0)
    })

    it('adds no delay for a batch that hub-syncs exactly once', async () => {
      vi.useFakeTimers()
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      const placement = makePlacement()
      const hubSync = vi.fn().mockResolvedValue({ success: true })
      const collectResults = vi.fn().mockResolvedValue({
        successes: [{ fileName: 'a.json', meta: { id: 'a', name: 'A', hubPostId: 'hp-a' } }],
        notSavedFailures: [],
        snapshot: { entries: [], direction: 'asc' },
      } satisfies CollectedImportBatch<FakeMeta>)

      const { result } = renderHook(() => useImportBatch<FakeMeta>({
        open: true,
        placement,
        setLastResult: vi.fn(),
        setActionError: vi.fn(),
        t,
        collectResults,
        hubSync,
      }))

      await act(async () => {
        const p = result.current.runImport()
        await vi.runAllTimersAsync()
        await p
      })

      expect(hubSync).toHaveBeenCalledTimes(1)
      expect(setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 1100)).toHaveLength(0)
    })

    it('spaces three consecutive hub-syncs by 1100ms each, with no delay before the first or after the last', async () => {
      vi.useFakeTimers()
      const placement = makePlacement()
      const hubSync = vi.fn().mockResolvedValue({ success: true })
      const collectResults = vi.fn().mockResolvedValue({
        successes: [
          { fileName: 'a.json', meta: { id: 'a', name: 'A', hubPostId: 'hp-a' } },
          { fileName: 'b.json', meta: { id: 'b', name: 'B', hubPostId: 'hp-b' } },
          { fileName: 'c.json', meta: { id: 'c', name: 'C', hubPostId: 'hp-c' } },
        ],
        notSavedFailures: [],
        snapshot: { entries: [], direction: 'asc' },
      } satisfies CollectedImportBatch<FakeMeta>)

      const { result } = renderHook(() => useImportBatch<FakeMeta>({
        open: true,
        placement,
        setLastResult: vi.fn(),
        setActionError: vi.fn(),
        t,
        collectResults,
        hubSync,
      }))

      let runPromise!: Promise<void>
      await act(async () => {
        runPromise = result.current.runImport()
        // Let collectResults resolve and the first, undelayed hub-sync
        // fire — no timer has been scheduled yet at this point.
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(hubSync).toHaveBeenCalledTimes(1)

      // Just under the delay window: the second hub-sync must not have
      // fired yet.
      await act(async () => { await vi.advanceTimersByTimeAsync(1099) })
      expect(hubSync).toHaveBeenCalledTimes(1)

      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(hubSync).toHaveBeenCalledTimes(2)

      await act(async () => { await vi.advanceTimersByTimeAsync(1099) })
      expect(hubSync).toHaveBeenCalledTimes(2)

      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(hubSync).toHaveBeenCalledTimes(3)

      await act(async () => { await runPromise })
      expect(result.current.importing).toBe(false)
    })
  })
})
