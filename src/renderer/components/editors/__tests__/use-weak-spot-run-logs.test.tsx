// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

// The uid's available-run-id index (availableRunIdsRef) must be re-fetched
// whenever `results.length` changes, not just on a `uid` change — see the
// first effect's own doc comment (use-weak-spot-run-logs.ts) for why
// `results.length` is the invalidation signal. Otherwise a run saved
// LATER in the same session (no remount of the hook's owner in between)
// could never enter `availableRunIdsRef`, and its runId would forever
// fail the second effect's `available.has(runId)` gate, even though a
// real log for it exists on disk.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWeakSpotRunLogs } from '../use-weak-spot-run-logs'
import type { TypingTestResult } from '../../../../shared/types/pipette-settings'
import type { RunKeystrokeLog, RunLogMeta } from '../../../../shared/types/typing-run-log'

const mockTypingRunLogList = vi.fn<(uid: string) => Promise<{ success: boolean; entries?: RunLogMeta[] }>>()
const mockTypingRunLogGet = vi.fn<(uid: string, runId: string) => Promise<{ success: boolean; data?: RunKeystrokeLog }>>()

let emitSyncUnit: ((syncUnit: string) => void) | null = null
const mockSyncOnUnitApplied = vi.fn((cb: (syncUnit: string) => void) => {
  emitSyncUnit = cb
  return () => undefined
})

function installVialApi(): void {
  Object.defineProperty(window, 'vialAPI', {
    value: {
      typingRunLogList: mockTypingRunLogList,
      typingRunLogGet: mockTypingRunLogGet,
      syncOnUnitApplied: mockSyncOnUnitApplied,
    },
    writable: true,
    configurable: true,
  })
}

function meta(id: string): RunLogMeta {
  return { id, startedAt: '2026-01-01T00:00:00.000Z', filename: `${id}.json`, savedAt: '2026-01-01T00:00:00.000Z' }
}

function stubLog(runId: string): RunKeystrokeLog {
  return {
    runId, uid: 'u1', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 1000,
    mode: 'words', language: 'english', words: [],
  }
}

function result(runId: string): TypingTestResult {
  return {
    date: '2026-01-01T00:00:00.000Z', runId, wpm: 50, accuracy: 95, wordCount: 10,
    correctChars: 40, incorrectChars: 2, durationSeconds: 10, mode: 'words', mode2: 10, language: 'english',
  }
}

beforeEach(() => {
  mockTypingRunLogList.mockReset()
  mockTypingRunLogGet.mockReset().mockImplementation((_uid, runId) => Promise.resolve({ success: true, data: stubLog(runId) }))
  installVialApi()
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function flushMicrotasks(rounds = 10): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i++) await Promise.resolve()
  })
}

describe('useWeakSpotRunLogs — re-fetches the availability index when results grows', () => {
  it('a run saved later in the same session (no remount) is fetched once its runId enters the index, without re-fetching an already-cached runId\'s log', async () => {
    // First index snapshot only knows about r1 (mirrors the store's real
    // state at that point in time — r2 doesn't exist on disk yet).
    mockTypingRunLogList.mockResolvedValueOnce({ success: true, entries: [meta('r1')] })

    const { result: hookResult, rerender } = renderHook(
      ({ results }: { results: TypingTestResult[] }) => useWeakSpotRunLogs('u1', results),
      { initialProps: { results: [result('r1')] } },
    )
    await flushMicrotasks()

    expect(mockTypingRunLogList).toHaveBeenCalledTimes(1)
    expect(mockTypingRunLogGet).toHaveBeenCalledTimes(1)
    expect(mockTypingRunLogGet).toHaveBeenCalledWith('u1', 'r1')
    expect(hookResult.current.has('r1')).toBe(true)
    expect(hookResult.current.has('r2')).toBe(false)

    // A new result (r2) arrives — the store's real index now includes it.
    mockTypingRunLogList.mockResolvedValueOnce({ success: true, entries: [meta('r1'), meta('r2')] })
    rerender({ results: [result('r1'), result('r2')] })
    await flushMicrotasks()

    // The index was re-fetched (results.length changed)...
    expect(mockTypingRunLogList).toHaveBeenCalledTimes(2)
    // ...and only the NEW runId's log was fetched — r1's cached payload
    // was reused, not re-requested.
    expect(mockTypingRunLogGet).toHaveBeenCalledTimes(2) // still exactly 2 total, not 3 — r1's log was reused, not re-fetched
    expect(mockTypingRunLogGet).toHaveBeenCalledWith('u1', 'r2')
    expect(hookResult.current.has('r1')).toBe(true)
    expect(hookResult.current.has('r2')).toBe(true)
  })

  it('does not re-fetch the index when results is rerendered with the same length', async () => {
    mockTypingRunLogList.mockResolvedValue({ success: true, entries: [meta('r1')] })

    const { rerender } = renderHook(
      ({ results }: { results: TypingTestResult[] }) => useWeakSpotRunLogs('u1', results),
      { initialProps: { results: [result('r1')] } },
    )
    await flushMicrotasks()
    expect(mockTypingRunLogList).toHaveBeenCalledTimes(1)

    // A brand-new array instance with the SAME length/content (e.g. the
    // call site's `typingTestHistory ?? []` fallback minting a fresh
    // array on every render) must not trigger another index fetch.
    rerender({ results: [result('r1')] })
    await flushMicrotasks()
    expect(mockTypingRunLogList).toHaveBeenCalledTimes(1)
  })

  it('re-fetches the index on a uid change even when results.length stays the same', async () => {
    mockTypingRunLogList.mockResolvedValue({ success: true, entries: [meta('r1')] })

    const { rerender } = renderHook(
      ({ uid, results }: { uid: string; results: TypingTestResult[] }) => useWeakSpotRunLogs(uid, results),
      { initialProps: { uid: 'u1', results: [result('r1')] } },
    )
    await flushMicrotasks()
    expect(mockTypingRunLogList).toHaveBeenCalledTimes(1)

    rerender({ uid: 'u2', results: [result('r1')] })
    await flushMicrotasks()
    expect(mockTypingRunLogList).toHaveBeenCalledTimes(2)
    expect(mockTypingRunLogList).toHaveBeenLastCalledWith('u2')
  })
})

describe('useWeakSpotRunLogs — sync merge of the keyboard\'s run logs', () => {
  function logWith(runId: string, durationMs: number): RunKeystrokeLog {
    return { ...stubLog(runId), durationMs }
  }

  it('re-fetches cached logs and null misses on its own uid\'s runs unit, and drops evicted logs', async () => {
    mockTypingRunLogList.mockResolvedValue({ success: true, entries: [meta('r1'), meta('r2'), meta('r3')] })
    mockTypingRunLogGet.mockImplementation((_uid, runId) =>
      Promise.resolve(runId === 'r2' ? { success: false } : { success: true, data: logWith(runId, 1000) }))

    const { result: hookResult } = renderHook(() => useWeakSpotRunLogs('u1', [result('r1'), result('r2'), result('r3')]))
    await flushMicrotasks()
    expect(hookResult.current.get('r1')?.durationMs).toBe(1000)
    expect(hookResult.current.has('r2')).toBe(false)
    expect(mockTypingRunLogGet).toHaveBeenCalledTimes(3)

    // The merge evicted r3, brought r2's log in and rewrote r1's.
    mockTypingRunLogList.mockResolvedValue({ success: true, entries: [meta('r1'), meta('r2')] })
    mockTypingRunLogGet.mockReset().mockImplementation((_uid, runId) => Promise.resolve({ success: true, data: logWith(runId, 2000) }))
    act(() => { emitSyncUnit?.('keyboards/u1/runs') })
    await flushMicrotasks()

    expect(mockTypingRunLogGet.mock.calls.map(([, id]) => id).sort()).toEqual(['r1', 'r2'])
    expect(hookResult.current.get('r1')?.durationMs).toBe(2000)
    expect(hookResult.current.get('r2')?.durationMs).toBe(2000)
    expect(hookResult.current.has('r3')).toBe(false)
  })

  it('ignores another keyboard\'s runs unit', async () => {
    mockTypingRunLogList.mockResolvedValue({ success: true, entries: [meta('r1')] })
    renderHook(() => useWeakSpotRunLogs('u1', [result('r1')]))
    await flushMicrotasks()
    expect(mockTypingRunLogList).toHaveBeenCalledTimes(1)
    expect(mockTypingRunLogGet).toHaveBeenCalledTimes(1)

    act(() => { emitSyncUnit?.('keyboards/u2/runs') })
    await flushMicrotasks()
    expect(mockTypingRunLogList).toHaveBeenCalledTimes(1)
    expect(mockTypingRunLogGet).toHaveBeenCalledTimes(1)
  })

  it('a read started before the merge does not land in the cache', async () => {
    mockTypingRunLogList.mockResolvedValueOnce({ success: true, entries: [meta('r1')] })
    let resolveOld: (v: { success: boolean; data?: RunKeystrokeLog }) => void = () => undefined
    mockTypingRunLogGet.mockImplementationOnce(() => new Promise((r) => { resolveOld = r }))

    const { result: hookResult } = renderHook(() => useWeakSpotRunLogs('u1', [result('r1')]))
    await flushMicrotasks()
    expect(mockTypingRunLogGet).toHaveBeenCalledTimes(1)

    // The merge lands while the first read is pending; hold the index re-read.
    let resolveList: (v: { success: boolean; entries?: RunLogMeta[] }) => void = () => undefined
    mockTypingRunLogList.mockImplementationOnce(() => new Promise((r) => { resolveList = r }))
    act(() => { emitSyncUnit?.('keyboards/u1/runs') })
    await flushMicrotasks()

    resolveOld({ success: true, data: logWith('r1', 1000) })
    await flushMicrotasks()
    expect(hookResult.current.has('r1')).toBe(false)

    mockTypingRunLogGet.mockImplementation((_uid, runId) => Promise.resolve({ success: true, data: logWith(runId, 2000) }))
    resolveList({ success: true, entries: [meta('r1')] })
    await flushMicrotasks()
    expect(mockTypingRunLogGet).toHaveBeenCalledTimes(2)
    expect(hookResult.current.get('r1')?.durationMs).toBe(2000)
  })
})
