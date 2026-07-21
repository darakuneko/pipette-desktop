// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
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
    expect(placement.placeMany).toHaveBeenCalledWith(
      [{ id: 'a', name: 'Alpha' }],
      { entries: [], direction: 'asc' },
    )
    expect(setLastResult).toHaveBeenCalledWith([{ id: 'a', kind: 'success', message: 'common.synced' }])
    expect(onCollapsedToOne).toHaveBeenCalledWith({ id: 'a', name: 'Alpha', hubPostId: 'hp1' })
    expect(setActionError).toHaveBeenCalledWith(null)
    // Below the 2-file threshold — the per-name `placement.feedback`
    // text (not exercised by this hook) is what the modal shows instead.
    expect(result.current.importSummary).toBeNull()
    expect(result.current.importing).toBe(false)
  })

  it('dedupes same-id results keeping the last file, shows the 2+ batch summary, and skips onCollapsedToOne', async () => {
    const placement = makePlacement()
    const setLastResult = vi.fn()
    const onCollapsedToOne = vi.fn()
    const collectResults = vi.fn().mockResolvedValue({
      successes: [
        { fileName: 'first.json', meta: { id: 'x', name: 'First' } },
        // Same id as above (e.g. same name auto-overwrite) — only this
        // later outcome should survive.
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

    expect(placement.placeMany).toHaveBeenCalledWith(
      [{ id: 'x', name: 'Second' }, { id: 'y', name: 'Third' }],
      { entries: [], direction: 'asc' },
    )
    expect(setLastResult).toHaveBeenCalledWith([
      { id: 'x', kind: 'success', message: 'common.saved' },
      { id: 'y', kind: 'success', message: 'common.saved' },
    ])
    expect(onCollapsedToOne).not.toHaveBeenCalled()
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
})
