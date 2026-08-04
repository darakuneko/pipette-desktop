// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { mergeMissedDetails, useAggregatedMissedDetails } from '../use-mistake-ranking-details'
import type { MissedCharDetail } from '../missed-details'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../../shared/types/typing-run-log'

function detail(typedCounts: Record<string, number>, movedOnCount = 0): MissedCharDetail {
  return { typedCounts, movedOnCount }
}

describe('mergeMissedDetails', () => {
  it('sums typedCounts and movedOnCount for a key present in every map', () => {
    const a = new Map([['h', detail({ x: 2 }, 1)]])
    const b = new Map([['h', detail({ x: 1, y: 3 }, 2)]])
    const merged = mergeMissedDetails([a, b])
    expect(merged.get('h')).toEqual({ typedCounts: { x: 3, y: 3 }, movedOnCount: 3 })
  })

  it('a key present in only ONE of the maps carries through unchanged (missing log contributes nothing, not zero-fill)', () => {
    const a = new Map([['h', detail({ x: 2 }, 1)], ['e', detail({ z: 1 }, 0)]])
    const b = new Map([['h', detail({ x: 1 }, 0)]])
    const merged = mergeMissedDetails([a, b])
    expect(merged.get('h')).toEqual({ typedCounts: { x: 3 }, movedOnCount: 1 })
    expect(merged.get('e')).toEqual({ typedCounts: { z: 1 }, movedOnCount: 0 })
  })

  it('merges zero maps into an empty map', () => {
    expect(mergeMissedDetails([]).size).toBe(0)
  })

  it('merges a single map unchanged', () => {
    const a = new Map([['h', detail({ x: 1 }, 2)]])
    const merged = mergeMissedDetails([a])
    expect(merged.get('h')).toEqual({ typedCounts: { x: 1 }, movedOnCount: 2 })
    // Independent object — mutating the merge result must not mutate the input.
    merged.get('h')!.movedOnCount = 99
    expect(a.get('h')!.movedOnCount).toBe(2)
  })

  it('an empty per-run map (e.g. charCorrelationUnavailable bailout) contributes nothing', () => {
    const a = new Map([['h', detail({ x: 1 })]])
    const empty = new Map<string, MissedCharDetail>()
    const merged = mergeMissedDetails([a, empty])
    expect(merged.size).toBe(1)
    expect(merged.get('h')).toEqual({ typedCounts: { x: 1 }, movedOnCount: 0 })
  })
})

describe('useAggregatedMissedDetails', () => {
  const originalVialAPI = window.vialAPI

  beforeEach(() => {
    window.vialAPI = { ...originalVialAPI } as typeof window.vialAPI
  })

  function makeLog(overrides: Partial<RunKeystrokeLog> = {}): RunKeystrokeLog {
    return {
      runId: 'run-1', uid: 'kb-1', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 5000,
      mode: 'words', language: 'english', words: [], ...overrides,
    }
  }

  function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
    return {
      date: '2026-01-01T00:00:00.000Z', wpm: 60, accuracy: 95, wordCount: 10,
      correctChars: 50, incorrectChars: 2, durationSeconds: 10, ...overrides,
    }
  }

  it('returns an empty map (no fetch) when uid is undefined', () => {
    const getLog = vi.fn()
    window.vialAPI = { ...window.vialAPI, typingRunLogGet: getLog } as typeof window.vialAPI
    const { result } = renderHook(() => useAggregatedMissedDetails(undefined, [], new Set()))
    expect(result.current.size).toBe(0)
    expect(getLog).not.toHaveBeenCalled()
  })

  it('merges two logs\' details once both fetches resolve', async () => {
    const getLog = vi.fn((uid: string, runId: string) => {
      if (runId === 'run-1') {
        return Promise.resolve({
          success: true,
          data: makeLog({
            runId: 'run-1',
            words: [{
              index: 0, display: 'hi', typed: 'xi', correct: false,
              keystrokes: [{ pressMs: 0, keycode: 0, row: 0, col: 0, correct: false, expectedChar: 'h', typedChar: 'x', mistakeKey: 'h' }],
            }],
          }),
        })
      }
      return Promise.resolve({
        success: true,
        data: makeLog({
          runId: 'run-2',
          words: [{
            index: 0, display: 'hi', typed: 'yi', correct: false,
            keystrokes: [{ pressMs: 0, keycode: 0, row: 0, col: 0, correct: false, expectedChar: 'h', typedChar: 'y', mistakeKey: 'h' }],
          }],
        }),
      })
    })
    window.vialAPI = { ...window.vialAPI, typingRunLogGet: getLog } as typeof window.vialAPI

    const results = [
      makeResult({ runId: 'run-1' }),
      makeResult({ runId: 'run-2' }),
    ]
    const { result } = renderHook(() => useAggregatedMissedDetails('kb-1', results, new Set(['run-1', 'run-2'])))

    await waitFor(() => expect(result.current.get('h')?.typedCounts).toEqual({ x: 1, y: 1 }))
  })

  it('a result whose runId is missing from availableRunIds is simply skipped — counts-only, no fetch', () => {
    const getLog = vi.fn()
    window.vialAPI = { ...window.vialAPI, typingRunLogGet: getLog } as typeof window.vialAPI

    const results = [makeResult({ runId: 'run-not-available' })]
    const { result } = renderHook(() => useAggregatedMissedDetails('kb-1', results, new Set()))

    expect(result.current.size).toBe(0)
    expect(getLog).not.toHaveBeenCalled()
  })

  it('does not refetch a runId already in the cache on a re-render with the same results', async () => {
    const getLog = vi.fn().mockResolvedValue({ success: true, data: makeLog({ runId: 'run-1' }) })
    window.vialAPI = { ...window.vialAPI, typingRunLogGet: getLog } as typeof window.vialAPI

    const results = [makeResult({ runId: 'run-1' })]
    const { result, rerender } = renderHook(
      ({ r }: { r: TypingTestResult[] }) => useAggregatedMissedDetails('kb-1', r, new Set(['run-1'])),
      { initialProps: { r: results } },
    )

    await waitFor(() => expect(getLog).toHaveBeenCalledTimes(1))
    rerender({ r: [...results] }) // a NEW array, same runId content
    rerender({ r: [...results] })
    expect(result.current).toBeDefined()
    expect(getLog).toHaveBeenCalledTimes(1)
  })
})
