// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Covers `useRunLabels` as the single owner of run labeling: the
// four-tier `labelFor` fallback (History name → History date →
// run-row firstMs → raw id) and the lazy-fetch contract (`uid = null`
// skips the History fetch, no `query` skips the run-rows fetch).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { PipetteSettings } from '../../../shared/types/pipette-settings'
import { useRunLabels, formatRunDateLabel, type RunLabelsQuery, type RunRow } from '../useRunLabels'

const getSpy = vi.fn<(uid: string) => Promise<PipetteSettings | null>>()
const runsSpy = vi.fn<(
  uid: string, fromMs: number, toMs: number, scope: string, materials: string[],
) => Promise<RunRow[]>>()

Object.defineProperty(window, 'vialAPI', {
  value: {
    pipetteSettingsGet: (uid: string) => getSpy(uid),
    typingAnalyticsListTypingTestRunsForRange: (
      uid: string, fromMs: number, toMs: number, scope: string, materials: string[],
    ) => runsSpy(uid, fromMs, toMs, scope, materials),
  },
  writable: true,
})

const NAMED_DATE = '2026-01-01T00:00:00'
const UNNAMED_DATE = '2026-02-03T04:05:00'
const ROW_FIRST_MS = Date.UTC(2026, 3, 1, 9, 30)

const SETTINGS = {
  _rev: 1,
  keyboardLayout: 'qwerty',
  autoAdvance: true,
  layerNames: [],
  typingTestResults: [
    { date: NAMED_DATE, runId: 'run-named', name: 'My best run', wpm: 80, accuracy: 99, wordCount: 50, correctChars: 400, incorrectChars: 4, durationSeconds: 60 },
    { date: UNNAMED_DATE, runId: 'run-unnamed', name: '', wpm: 70, accuracy: 98, wordCount: 45, correctChars: 350, incorrectChars: 7, durationSeconds: 60 },
  ],
} as PipetteSettings

const QUERY: RunLabelsQuery = {
  range: { fromMs: 0, toMs: 10_000 },
  deviceScopes: ['own'],
  materialScopes: ['words (english)'],
}

describe('useRunLabels', () => {
  beforeEach(() => {
    getSpy.mockReset().mockResolvedValue(SETTINGS)
    runsSpy.mockReset().mockResolvedValue([
      { runId: 'run-unnamed', firstMs: 1111 },
      { runId: 'run-historyless', firstMs: ROW_FIRST_MS },
    ])
  })

  it('resolves labels through the four-tier fallback', async () => {
    const { result } = renderHook(() => useRunLabels('uid-a', QUERY))
    await waitFor(() => expect(result.current.runs.length).toBe(2))

    // Tier 1: History entry with a saved name.
    expect(result.current.labelFor('run-named')).toBe('My best run')
    // Tier 2: unnamed History entry → its saved date, formatted (wins
    // over the run row's firstMs).
    expect(result.current.labelFor('run-unnamed')).toBe(formatRunDateLabel(UNNAMED_DATE))
    // Tier 3: no History entry, but a run row exists → firstMs stamp.
    expect(result.current.labelFor('run-historyless')).toBe(formatRunDateLabel(ROW_FIRST_MS))
    // Tier 4: nothing known → the raw id.
    expect(result.current.labelFor('run-unknown')).toBe('run-unknown')
  })

  it('exposes the fetched run rows for option lists', async () => {
    const { result } = renderHook(() => useRunLabels('uid-a', QUERY))
    await waitFor(() => expect(result.current.runs.length).toBe(2))
    expect(runsSpy).toHaveBeenCalledWith('uid-a', 0, 10_000, 'own', ['words (english)'])
    expect(result.current.runs[1]).toEqual({ runId: 'run-historyless', firstMs: ROW_FIRST_MS })
  })

  it('skips both fetches when uid is null', async () => {
    const { result } = renderHook(() => useRunLabels(null, QUERY))
    // Debounce window — give the (absent) rows fetch a chance to fire.
    await new Promise((r) => setTimeout(r, 200))
    expect(getSpy).not.toHaveBeenCalled()
    expect(runsSpy).not.toHaveBeenCalled()
    expect(result.current.runs).toEqual([])
    expect(result.current.labelFor('anything')).toBe('anything')
  })

  it('skips the run-rows fetch when no query is passed (History tiers still work)', async () => {
    const { result } = renderHook(() => useRunLabels('uid-a'))
    await waitFor(() => expect(result.current.labelFor('run-named')).toBe('My best run'))
    await new Promise((r) => setTimeout(r, 200))
    expect(runsSpy).not.toHaveBeenCalled()
    // Without run rows, tier 3 is unavailable — history-less ids fall to tier 4.
    expect(result.current.labelFor('run-historyless')).toBe('run-historyless')
  })

  it('falls back to empty labels when the settings fetch rejects', async () => {
    getSpy.mockRejectedValue(new Error('read failed'))
    const { result } = renderHook(() => useRunLabels('uid-a', QUERY))
    await waitFor(() => expect(result.current.runs.length).toBe(2))
    // Tier 3 still works off the run rows; tier 1/2 degrade to tier 4.
    expect(result.current.labelFor('run-historyless')).toBe(formatRunDateLabel(ROW_FIRST_MS))
    expect(result.current.labelFor('run-named')).toBe('run-named')
  })
})
