// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { AccuracyTrendChart } from '../AccuracyTrendChart'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'

function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: '2026-06-20T00:00:00.000Z',
    wpm: 60,
    accuracy: 95,
    wordCount: 30,
    correctChars: 300,
    incorrectChars: 5,
    durationSeconds: 30,
    mode: 'words',
    mode2: 30,
    language: 'english',
    ...overrides,
  }
}

function renderWithI18n(ui: React.ReactElement) {
  return render(<I18nextProvider i18n={i18n}>{ui}</I18nextProvider>)
}

describe('AccuracyTrendChart', () => {
  it('renders nothing with fewer than 2 results', () => {
    const { container } = renderWithI18n(<AccuracyTrendChart results={[makeResult()]} />)
    expect(container.querySelector('[data-testid="accuracy-trend-chart"]')).toBeNull()
  })

  it('renders nothing with zero results', () => {
    const { container } = renderWithI18n(<AccuracyTrendChart results={[]} />)
    expect(container.querySelector('[data-testid="accuracy-trend-chart"]')).toBeNull()
  })

  it('renders the chart container for 2+ results', () => {
    const results = [
      makeResult({ date: '2026-06-18T00:00:00.000Z', accuracy: 90 }),
      makeResult({ date: '2026-06-19T00:00:00.000Z', accuracy: 95 }),
    ]
    renderWithI18n(<AccuracyTrendChart results={results} />)
    expect(screen.getByTestId('accuracy-trend-chart')).toBeTruthy()
  })

  it('renders regardless of the input ordering (sorts internally by date)', () => {
    const results = [
      makeResult({ date: '2026-06-20T00:00:00.000Z', accuracy: 92 }),
      makeResult({ date: '2026-06-18T00:00:00.000Z', accuracy: 88 }),
      makeResult({ date: '2026-06-19T00:00:00.000Z', accuracy: 90 }),
    ]
    renderWithI18n(<AccuracyTrendChart results={results} />)
    expect(screen.getByTestId('accuracy-trend-chart')).toBeTruthy()
  })
})
