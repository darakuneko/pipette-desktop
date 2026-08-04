// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
//
// FLAG (coordinator-requested layout changes, cumulative history):
//  1. This file originally tested a bar-ranking presentation
//     (`mistake-rank-${key}` rows, a width%-based bar). Rewritten once to
//     the intermediate column-table presentation (`missed-table-row-*`/
//     `missed-table-header*` testids).
//  2. Rewritten again for internal scroll + no top-N cap (the "caps the
//     ranking at 15 entries" test became "renders EVERY entry").
//  3. THIS REWRITE: the column-table gave way to the approved bar-graph
//     mockup (MissedTable, mistake-summary.tsx) — every row/cell
//     assertion below was updated to the bar-graph's own shape (a
//     `-typed` cell with "→ chars" instead of "chars: count", a
//     `-bar`/`-bar-movedon`/`-bar-corrected` triad instead of a separate
//     `-movedon` cell). The aggregation (sum `mistakes` across results,
//     sort DESC/key ASC) and empty-state behavior are unchanged, just
//     re-asserted against the new DOM shape.
//
// New coverage below (not present before any rewrite): the row list
// renders with per-key detail (bar split + typed chars) once
// `typingRunLogGet` resolves, and a per-log fetch error is skipped
// without breaking the rest of the list — see
// use-mistake-ranking-details.test.ts for the merge logic's own unit
// tests, independent of any component mount.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { MistakeRankingSection } from '../MistakeRankingSection'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../../shared/types/typing-run-log'

function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: new Date().toISOString(),
    wpm: 60,
    accuracy: 95,
    wordCount: 30,
    correctChars: 100,
    incorrectChars: 5,
    durationSeconds: 30,
    mode: 'words',
    mode2: 30,
    ...overrides,
  }
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

/** `[data-testid^="missed-table-row-"]` also matches each row's own cell
 *  spans/divs (`-word`/`-count`/`-typed`/`-bar`/`-bar-movedon`/
 *  `-bar-corrected`), which share the same prefix — this keeps only the
 *  row CONTAINERS, i.e. testids of the exact form
 *  `missed-table-row-<key>` with no further dash-suffix (every key used
 *  in this file is dash-free, so this is unambiguous). */
function rowContainers(scope: HTMLElement): Element[] {
  return Array.from(scope.querySelectorAll('[data-testid^="missed-table-row-"]'))
    .filter((el) => /^missed-table-row-[^-]+$/.test(el.getAttribute('data-testid') ?? ''))
}

const originalVialAPI = window.vialAPI

beforeEach(() => {
  window.vialAPI = { ...originalVialAPI } as typeof window.vialAPI
})

describe('MistakeRankingSection', () => {
  it('renders nothing when there are no results at all', () => {
    const { container } = renderWithI18n(<MistakeRankingSection results={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the empty state when there are results but none recorded mistakes', () => {
    renderWithI18n(<MistakeRankingSection results={[makeResult({ mistakes: undefined })]} />)
    expect(screen.getByTestId('typing-test-mistake-ranking')).toBeTruthy()
    expect(screen.getByText(/no mistakes/i)).toBeTruthy()
    expect(screen.queryByTestId(/^missed-table-row-/)).toBeNull()
  })

  it('aggregates the same key across multiple results and sums the counts, in the shared bar-graph shape', () => {
    const results = [
      makeResult({ mistakes: { shi: 2, a: 1 } }),
      makeResult({ mistakes: { shi: 3 } }),
    ]
    renderWithI18n(<MistakeRankingSection results={results} />)
    const shiRow = screen.getByTestId('missed-table-row-shi')
    expect(within(shiRow).getByTestId('missed-table-row-shi-count').textContent).toBe('5')
    const aRow = screen.getByTestId('missed-table-row-a')
    expect(within(aRow).getByTestId('missed-table-row-a-count').textContent).toBe('1')
    // No log/uid supplied — counts only, no per-key detail yet: typed
    // cell empty, bar entirely gray (unknown split).
    expect(within(shiRow).getByTestId('missed-table-row-shi-typed').textContent).toBe('—')
    expect(within(shiRow).getByTestId('missed-table-row-shi-bar-movedon').style.width).toBe('0%')
    expect(within(shiRow).getByTestId('missed-table-row-shi-bar-corrected').style.width).toBe('100%')
  })

  it('sorts by count DESC then key ASC', () => {
    const results = [makeResult({ mistakes: { b: 3, a: 3, c: 5 } })]
    renderWithI18n(<MistakeRankingSection results={results} />)
    const rows = rowContainers(screen.getByTestId('typing-test-mistake-ranking'))
    const keys = rows.map((r) => r.getAttribute('data-testid'))
    expect(keys).toEqual(['missed-table-row-c', 'missed-table-row-a', 'missed-table-row-b'])
  })

  it('normalizes bar width to the list\'s own max count', () => {
    const results = [makeResult({ mistakes: { c: 5, a: 3, b: 3 } })]
    renderWithI18n(<MistakeRankingSection results={results} />)
    const barC = screen.getByTestId('missed-table-row-c-bar').firstElementChild as HTMLElement
    const barA = screen.getByTestId('missed-table-row-a-bar').firstElementChild as HTMLElement
    expect(barC.style.width).toBe('100%')
    expect(barA.style.width).toBe('60%') // 3/5
  })

  it('renders EVERY entry — no top-N cap, reachable via the shared row list\'s own internal scroll', () => {
    const mistakes: Record<string, number> = {}
    for (let i = 0; i < 20; i++) mistakes[`k${String(i).padStart(2, '0')}`] = 20 - i
    renderWithI18n(<MistakeRankingSection results={[makeResult({ mistakes })]} />)
    const rows = rowContainers(screen.getByTestId('typing-test-mistake-ranking'))
    expect(rows.length).toBe(20)
    expect(screen.getByTestId('missed-table-row-k00')).toBeTruthy()
    expect(screen.getByTestId('missed-table-row-k19')).toBeTruthy()
  })

  it('handles a result with an empty mistakes object without crashing', () => {
    renderWithI18n(<MistakeRankingSection results={[makeResult({ mistakes: {} })]} />)
    expect(screen.getByTestId('typing-test-mistake-ranking')).toBeTruthy()
    expect(screen.getByText(/no mistakes/i)).toBeTruthy()
  })

  it('uses the "Most missed" heading, not the single-run "Missed" heading', () => {
    renderWithI18n(<MistakeRankingSection results={[makeResult({ mistakes: { a: 1 } })]} />)
    expect(screen.getByText('Most missed')).toBeInTheDocument()
  })

  describe('per-key detail from run logs (uid + availableRunIds)', () => {
    function makeLog(overrides: Partial<RunKeystrokeLog> = {}): RunKeystrokeLog {
      return {
        runId: 'run-1', uid: 'kb-1', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 5000,
        mode: 'words', language: 'english', words: [], ...overrides,
      }
    }

    it('fetches only runIds that are both referenced by a result AND present in availableRunIds, then populates the typed-chars cell and bar split', async () => {
      const getLog = vi.fn().mockResolvedValue({
        success: true,
        data: makeLog({
          runId: 'run-1',
          words: [{
            index: 0, display: 'hi', typed: 'xi', correct: false,
            keystrokes: [{ pressMs: 0, keycode: 0, row: 0, col: 0, correct: false, expectedChar: 'h', typedChar: 'x', mistakeKey: 'h' }],
          }],
        }),
      })
      window.vialAPI = { ...window.vialAPI, typingRunLogGet: getLog } as typeof window.vialAPI

      const results = [makeResult({ mistakes: { h: 1 }, runId: 'run-1' })]
      renderWithI18n(
        <MistakeRankingSection results={results} uid="kb-1" availableRunIds={new Set(['run-1', 'run-unrelated'])} />,
      )

      await waitFor(() => {
        expect(screen.getByTestId('missed-table-row-h-typed').textContent).toBe('→ x')
      })
      expect(getLog).toHaveBeenCalledTimes(1)
      expect(getLog).toHaveBeenCalledWith('kb-1', 'run-1')
    })

    it('a result whose runId has no saved log (not in availableRunIds) contributes counts only — no fetch, no detail', async () => {
      const getLog = vi.fn().mockResolvedValue({ success: true, data: makeLog() })
      window.vialAPI = { ...window.vialAPI, typingRunLogGet: getLog } as typeof window.vialAPI

      const results = [makeResult({ mistakes: { h: 1 }, runId: 'run-no-log' })]
      renderWithI18n(<MistakeRankingSection results={results} uid="kb-1" availableRunIds={new Set()} />)

      const row = screen.getByTestId('missed-table-row-h')
      expect(within(row).getByTestId('missed-table-row-h-typed').textContent).toBe('—')
      expect(getLog).not.toHaveBeenCalled()
    })

    it('skips a run whose log fetch rejects, without breaking the rest of the list', async () => {
      const getLog = vi.fn()
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValueOnce({
          success: true,
          data: makeLog({
            runId: 'run-2',
            words: [{
              index: 0, display: 'ab', typed: 'ab', correct: true,
              keystrokes: [{ pressMs: 0, keycode: 0, row: 0, col: 0, correct: false, expectedChar: 'a', typedChar: 'z', mistakeKey: 'a' }],
            }],
          }),
        })
      window.vialAPI = { ...window.vialAPI, typingRunLogGet: getLog } as typeof window.vialAPI

      const results = [
        makeResult({ mistakes: { h: 1 }, runId: 'run-1' }),
        makeResult({ mistakes: { a: 1 }, runId: 'run-2' }),
      ]
      renderWithI18n(
        <MistakeRankingSection results={results} uid="kb-1" availableRunIds={new Set(['run-1', 'run-2'])} />,
      )

      await waitFor(() => {
        expect(screen.getByTestId('missed-table-row-a-typed').textContent).toBe('→ z')
      })
      // The rejected run's own row still renders (from `mistakes`), just
      // with no detail — the failure never surfaced as a crash or a
      // missing row.
      expect(screen.getByTestId('missed-table-row-h-typed').textContent).toBe('—')
    })

    it('does nothing (no fetch at all) when uid is undefined', () => {
      const getLog = vi.fn().mockResolvedValue({ success: true, data: makeLog() })
      window.vialAPI = { ...window.vialAPI, typingRunLogGet: getLog } as typeof window.vialAPI

      const results = [makeResult({ mistakes: { h: 1 }, runId: 'run-1' })]
      renderWithI18n(<MistakeRankingSection results={results} availableRunIds={new Set(['run-1'])} />)

      expect(getLog).not.toHaveBeenCalled()
    })
  })
})
