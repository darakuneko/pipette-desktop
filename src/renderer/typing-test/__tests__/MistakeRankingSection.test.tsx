// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { MistakeRankingSection } from '../MistakeRankingSection'
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

describe('MistakeRankingSection', () => {
  it('renders nothing when there are no results at all', () => {
    const { container } = renderWithI18n(<MistakeRankingSection results={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the empty state when there are results but none recorded mistakes', () => {
    renderWithI18n(<MistakeRankingSection results={[makeResult({ mistakes: undefined })]} />)
    expect(screen.getByTestId('typing-test-mistake-ranking')).toBeTruthy()
    expect(screen.getByText(/no mistakes/i)).toBeTruthy()
    expect(screen.queryByTestId(/^mistake-rank-/)).toBeNull()
  })

  it('aggregates the same key across multiple results and sums the counts', () => {
    const results = [
      makeResult({ mistakes: { shi: 2, a: 1 } }),
      makeResult({ mistakes: { shi: 3 } }),
    ]
    renderWithI18n(<MistakeRankingSection results={results} />)
    const shiRow = screen.getByTestId('mistake-rank-shi')
    expect(shiRow.textContent).toContain('5')
    const aRow = screen.getByTestId('mistake-rank-a')
    expect(aRow.textContent).toContain('1')
  })

  it('sorts by count DESC then key ASC', () => {
    const results = [
      makeResult({ mistakes: { b: 3, a: 3, c: 5 } }),
    ]
    renderWithI18n(<MistakeRankingSection results={results} />)
    const rows = screen.getByTestId('typing-test-mistake-ranking').querySelectorAll('[data-testid^="mistake-rank-"]')
    const keys = Array.from(rows).map((r) => r.getAttribute('data-testid'))
    expect(keys).toEqual(['mistake-rank-c', 'mistake-rank-a', 'mistake-rank-b'])
  })

  it('caps the ranking at the top 15 entries', () => {
    const mistakes: Record<string, number> = {}
    for (let i = 0; i < 20; i++) mistakes[`k${String(i).padStart(2, '0')}`] = 20 - i
    renderWithI18n(<MistakeRankingSection results={[makeResult({ mistakes })]} />)
    const rows = screen.getByTestId('typing-test-mistake-ranking').querySelectorAll('[data-testid^="mistake-rank-"]')
    expect(rows.length).toBe(15)
    // Highest counts (k00..k14) should be the ones kept.
    expect(screen.getByTestId('mistake-rank-k00')).toBeTruthy()
    expect(screen.queryByTestId('mistake-rank-k15')).toBeNull()
  })

  it('handles a result with an empty mistakes object without crashing', () => {
    renderWithI18n(<MistakeRankingSection results={[makeResult({ mistakes: {} })]} />)
    expect(screen.getByTestId('typing-test-mistake-ranking')).toBeTruthy()
    expect(screen.getByText(/no mistakes/i)).toBeTruthy()
  })
})
