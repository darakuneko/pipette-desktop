// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { TypingTestHistory } from '../TypingTestHistory'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

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

describe('TypingTestHistory', () => {
  it('shows no results message when empty', () => {
    renderWithI18n(<TypingTestHistory results={[]} />)
    expect(screen.getByText(/no results/i)).toBeTruthy()
  })

  it('shows stats summary with results', () => {
    const results = [
      makeResult({ wpm: 80 }),
      makeResult({ wpm: 60 }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)
    // Best WPM should be 80 (appears in stats and possibly in table)
    expect(screen.getAllByText('80').length).toBeGreaterThan(0)
  })

  it('shows results table', () => {
    const results = [
      makeResult({ wpm: 80, isPb: true }),
      makeResult({ wpm: 60 }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)
    const history = screen.getByTestId('typing-test-history')
    expect(history.querySelector('table')).toBeTruthy()
    // Header shows PB text, cell shows trophy icon
    expect(screen.getAllByText('PB').length).toBeGreaterThanOrEqual(1) // header
    const svgs = history.querySelectorAll('svg[aria-label="PB"]')
    expect(svgs.length).toBe(1) // cell trophy icon
  })

  it('filters by mode when clicking filter buttons', () => {
    const results = [
      makeResult({ wpm: 80, mode: 'words', mode2: 30 }),
      makeResult({ wpm: 90, mode: 'time', mode2: 60 }),
      makeResult({ wpm: 70, mode: 'quote', mode2: 'short' }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)

    // Default is 'all', all three should show
    expect(screen.getAllByText('80').length).toBeGreaterThan(0)
    expect(screen.getAllByText('90').length).toBeGreaterThan(0)
    expect(screen.getAllByText('70').length).toBeGreaterThan(0)

    // Click 'words' filter
    fireEvent.click(screen.getByTestId('history-filter-words'))
    expect(screen.getAllByText('80').length).toBeGreaterThan(0)
    expect(screen.queryByText('90')).toBeNull()
    expect(screen.queryByText('70')).toBeNull()

    // Click 'time' filter
    fireEvent.click(screen.getByTestId('history-filter-time'))
    expect(screen.queryByText('80')).toBeNull()
    expect(screen.getAllByText('90').length).toBeGreaterThan(0)

    // Click 'all' to reset
    fireEvent.click(screen.getByTestId('history-filter-all'))
    expect(screen.getAllByText('80').length).toBeGreaterThan(0)
    expect(screen.getAllByText('90').length).toBeGreaterThan(0)
    expect(screen.getAllByText('70').length).toBeGreaterThan(0)
  })

  it('sorts by WPM when clicking header', () => {
    const results = [
      makeResult({ wpm: 60, date: '2025-01-03T00:00:00Z' }),
      makeResult({ wpm: 90, date: '2025-01-02T00:00:00Z' }),
      makeResult({ wpm: 75, date: '2025-01-01T00:00:00Z' }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)

    const rows = () => {
      const history = screen.getByTestId('typing-test-history')
      const trs = history.querySelectorAll('tbody tr')
      return Array.from(trs).map((tr) => {
        const cells = tr.querySelectorAll('td')
        return Number(cells[1].textContent)
      })
    }

    // Default sort is date desc (most recent first) → 60, 90, 75
    expect(rows()).toEqual([60, 90, 75])

    // Click WPM header button → sort by WPM desc
    const wpmButton = screen.getByRole('button', { name: /WPM/i })
    fireEvent.click(wpmButton)
    expect(rows()).toEqual([90, 75, 60])

    // Click again → sort by WPM asc
    fireEvent.click(wpmButton)
    expect(rows()).toEqual([60, 75, 90])
  })

  it('sets aria-sort on active sort column', () => {
    const results = [makeResult({ wpm: 60 })]
    renderWithI18n(<TypingTestHistory results={results} />)

    const history = screen.getByTestId('typing-test-history')
    const headers = history.querySelectorAll('th[aria-sort]')

    // Date header should be 'descending' by default
    const dateHeader = Array.from(headers).find((h) => h.getAttribute('aria-sort') === 'descending')
    expect(dateHeader).toBeTruthy()

    // Other sortable headers should be 'none'
    const noneHeaders = Array.from(headers).filter((h) => h.getAttribute('aria-sort') === 'none')
    expect(noneHeaders.length).toBe(4) // wpm, accuracy, mode, duration
  })

  it('computes stats from filtered data', () => {
    const results = [
      makeResult({ wpm: 100, mode: 'words' }),
      makeResult({ wpm: 50, mode: 'time' }),
    ]
    renderWithI18n(<TypingTestHistory results={results} />)

    // Filter to words only
    fireEvent.click(screen.getByTestId('history-filter-words'))

    // Stats should reflect only words results (best=100, tests=1)
    expect(screen.getAllByText('100').length).toBeGreaterThan(0)
    // totalTests = 1 (only one words result after filtering)
    expect(screen.getAllByText('1').length).toBeGreaterThan(0)
  })

  it('shows export button and calls onExportCsv with CSV data', () => {
    const onExportCsv = vi.fn()
    const results = [
      makeResult({ wpm: 80, date: '2025-01-01T00:00:00Z', mode: 'words', mode2: 30 }),
    ]
    renderWithI18n(<TypingTestHistory results={results} onExportCsv={onExportCsv} />)

    const exportBtn = screen.getByTestId('history-export-csv')
    expect(exportBtn).toBeTruthy()

    fireEvent.click(exportBtn)
    expect(onExportCsv).toHaveBeenCalledTimes(1)

    const csv = onExportCsv.mock.calls[0][0] as string
    expect(csv).toContain('date,wpm,accuracy')
    expect(csv).toContain('2025-01-01T00:00:00Z')
    expect(csv).toContain('80')
  })

  it('does not show export button when onExportCsv is not provided', () => {
    renderWithI18n(<TypingTestHistory results={[makeResult()]} />)
    expect(screen.queryByTestId('history-export-csv')).toBeNull()
  })
})
