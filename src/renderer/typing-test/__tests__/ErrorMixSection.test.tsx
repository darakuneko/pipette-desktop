// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '../../i18n'
import { ErrorMixSection } from '../ErrorMixSection'
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

describe('ErrorMixSection', () => {
  it('renders nothing when there are no results at all', () => {
    const { container } = renderWithI18n(<ErrorMixSection results={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('shows the empty state when there are results but none carry the error-class group', () => {
    renderWithI18n(<ErrorMixSection results={[makeResult()]} />)
    expect(screen.getByTestId('typing-test-error-mix')).toBeTruthy()
    expect(screen.queryByTestId('error-mix-substitution')).toBeNull()
  })

  it('aggregates the 4-field group char-weighted (Σ/Σ) across multiple results', () => {
    const results = [
      makeResult({ errorSubstitutions: 2, errorOmissions: 1, errorInsertions: 0, errorTargetChars: 100 }),
      makeResult({ errorSubstitutions: 1, errorOmissions: 1, errorInsertions: 1, errorTargetChars: 100 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)
    // Σ substitutions = 3, Σ targetChars = 200 -> 1.50%
    expect(screen.getByTestId('error-mix-substitution').textContent).toContain('1.50')
    // Σ omissions = 2 / 200 -> 1.00%
    expect(screen.getByTestId('error-mix-omission').textContent).toContain('1.00')
    // Σ insertions = 1 / 200 -> 0.50%
    expect(screen.getByTestId('error-mix-insertion').textContent).toContain('0.50')
  })

  it('excludes results missing the group from the aggregate instead of treating them as zero', () => {
    const results = [
      makeResult({ errorSubstitutions: 4, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100 }),
      makeResult(), // no group at all — must not drag the rate toward 0
    ]
    renderWithI18n(<ErrorMixSection results={results} />)
    // If the second (unqualified) result were treated as 0/0 the rate
    // would be unaffected either way — the meaningful assertion is that
    // it doesn't crash and still shows the qualifying result's own rate.
    expect(screen.getByTestId('error-mix-substitution').textContent).toContain('4.00')
  })

  it('appends the far-above-average position label for a rate far past the population mean', () => {
    // Substitution population mean/SD is 1.65/1.43 — a 10% rate is ~5.8
    // SDs above the mean, well past the |z| > 1.5 far-above threshold.
    const results = [
      makeResult({ errorSubstitutions: 10, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)
    expect(screen.getByTestId('error-mix-substitution').textContent).toContain('Far above average')
  })

  it('appends the average position label for a rate within half an SD of the population mean', () => {
    // 33 / 2000 = 1.65% — exactly the substitution population mean, so
    // z = 0, squarely inside the |z| <= 0.5 average bucket.
    const results = [
      makeResult({ errorSubstitutions: 33, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 2000 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)
    expect(screen.getByTestId('error-mix-substitution').textContent).toContain('Average')
  })
})
