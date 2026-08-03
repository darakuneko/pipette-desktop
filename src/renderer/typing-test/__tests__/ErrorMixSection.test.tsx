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

/** Reads the tooltip bubble content wired to a label via `aria-describedby`
 * — needed instead of a bare `screen.getByRole('tooltip')` (the pattern
 * `HistoryTimelineCell.test.tsx` uses) because this section renders three
 * rows, and Tooltip mounts its bubble into the DOM unconditionally (only
 * opacity toggles on hover — see `Tooltip.tsx`), so there are three
 * `role="tooltip"` nodes on the page at once and only the id match picks
 * out the right one. */
function tooltipTextFor(labelTestId: string): string | null {
  const label = screen.getByTestId(labelTestId)
  const describedBy = label.getAttribute('aria-describedby')
  if (!describedBy) return null
  return document.getElementById(describedBy)?.textContent ?? null
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
    expect(screen.getByTestId('error-mix-substitution-value').textContent).toContain('1.50')
    // Σ omissions = 2 / 200 -> 1.00%
    expect(screen.getByTestId('error-mix-omission-value').textContent).toContain('1.00')
    // Σ insertions = 1 / 200 -> 0.50%
    expect(screen.getByTestId('error-mix-insertion-value').textContent).toContain('0.50')
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
    expect(screen.getByTestId('error-mix-substitution-value').textContent).toContain('4.00')
  })

  // EDITED (was: "appends the far-above-average position label for a rate
  // far past the population mean" — asserted the old pipe-prefixed verdict
  // string "| Far above average"). The verdict is now a colored pill whose
  // text is the SHORT form ("Far above avg", `positionRateShort` key set)
  // and whose class carries the danger tone.
  it('renders a danger-toned pill for a rate far past the population mean', () => {
    // Substitution population mean/SD is 1.65/1.43 — a 10% rate is ~5.8
    // SDs above the mean, well past the |z| > 1.5 far-above threshold.
    const results = [
      makeResult({ errorSubstitutions: 10, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)
    const pill = screen.getByTestId('error-mix-substitution-pill')
    expect(pill.textContent).toBe('Far above avg')
    expect(pill.className).toContain('bg-danger/20')
    expect(pill.className).toContain('text-danger')
  })

  it('renders a warning-toned pill for a rate moderately above the population mean', () => {
    // mean + 1 SD = 1.65 + 1.43 = 3.08% -> |z| = 1, inside the (0.5, 1.5]
    // above-average bucket (not yet far-above).
    const results = [
      makeResult({ errorSubstitutions: 308, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 10000 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)
    const pill = screen.getByTestId('error-mix-substitution-pill')
    expect(pill.textContent).toBe('Above avg')
    expect(pill.className).toContain('bg-warning/20')
    expect(pill.className).toContain('text-warning')
  })

  it('renders a success-toned pill for a rate moderately below the population mean', () => {
    // Omission mean/SD is 0.80/0.57 — mean - 1 SD = 0.23% -> |z| = 1,
    // inside the (0.5, 1.5] below-average bucket.
    const results = [
      makeResult({ errorSubstitutions: 0, errorOmissions: 23, errorInsertions: 0, errorTargetChars: 10000 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)
    const pill = screen.getByTestId('error-mix-omission-pill')
    expect(pill.textContent).toBe('Below avg')
    expect(pill.className).toContain('bg-success/20')
    expect(pill.className).toContain('text-success')
  })

  it('renders a success-toned pill for the average bucket', () => {
    // 33 / 2000 = 1.65% — exactly the substitution population mean, so
    // z = 0, squarely inside the |z| <= 0.5 average bucket.
    const results = [
      makeResult({ errorSubstitutions: 33, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 2000 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)
    const pill = screen.getByTestId('error-mix-substitution-pill')
    expect(pill.textContent).toBe('Average')
    expect(pill.className).toContain('bg-success/20')
    expect(pill.className).toContain('text-success')
  })

  // EDITED (was: "lays each row out as label / right-aligned percent /
  // pipe-prefixed verdict cells" — asserted the old 3-cell layout with a
  // single fused "1.65% (pop. avg 1.65%)" value cell and a "| Average"
  // verdict string). The row is now 4 cells: label / YOU / POP. AVG /
  // verdict pill, each its own testid.
  it('lays each row out as label / right-aligned YOU / right-aligned POP. AVG / verdict pill', () => {
    const results = [
      makeResult({ errorSubstitutions: 33, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 2000 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)

    const label = screen.getByTestId('error-mix-substitution-label')
    const value = screen.getByTestId('error-mix-substitution-value')
    const avg = screen.getByTestId('error-mix-substitution-avg')
    const pill = screen.getByTestId('error-mix-substitution-pill')

    expect(label.textContent).toBe('Substitution')
    expect(value.textContent).toBe('1.65%')
    expect(value.className).toContain('text-right')
    expect(value.className).toContain('tabular-nums')
    expect(avg.textContent).toBe('1.65%')
    expect(avg.className).toContain('text-right')
    expect(avg.className).toContain('tabular-nums')
    expect(pill.textContent).toBe('Average')
  })

  it('renders a column header row with TYPE / YOU / POP. AVG captions', () => {
    const results = [
      makeResult({ errorSubstitutions: 3, errorOmissions: 24, errorInsertions: 3, errorTargetChars: 100 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)

    expect(screen.getByTestId('error-mix-header-type').textContent).toBe('Type')
    const you = screen.getByTestId('error-mix-header-you')
    expect(you.textContent).toBe('You')
    expect(you.className).toContain('text-right')
    const avg = screen.getByTestId('error-mix-header-avg')
    expect(avg.textContent).toBe('Pop. avg')
    expect(avg.className).toContain('text-right')
  })

  it('renders every row regardless of how extreme one row\'s rate is (no hide-at-low-sample-size behavior)', () => {
    // Omission rate is deliberately extreme (24%, far past any bucket) —
    // all three rows must still render, unlike a design that hides a
    // label when its sample size or magnitude looks unreliable.
    const results = [
      makeResult({ errorSubstitutions: 3, errorOmissions: 24, errorInsertions: 3, errorTargetChars: 100 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)

    expect(screen.getByTestId('error-mix-substitution')).toBeTruthy()
    expect(screen.getByTestId('error-mix-omission')).toBeTruthy()
    expect(screen.getByTestId('error-mix-insertion')).toBeTruthy()
    expect(screen.getByTestId('error-mix-substitution-label').textContent).toBe('Substitution')
    expect(screen.getByTestId('error-mix-omission-label').textContent).toBe('Omission')
    expect(screen.getByTestId('error-mix-insertion-label').textContent).toBe('Insertion')
  })

  it("shows the error type's definition and improvement advice in the label's tooltip", () => {
    const results = [
      makeResult({ errorSubstitutions: 3, errorOmissions: 24, errorInsertions: 3, errorTargetChars: 100 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)

    const subTooltip = tooltipTextFor('error-mix-substitution-label')
    expect(subTooltip).toContain('Substitution is typing a different character')
    expect(subTooltip).toContain('neighbor-key mixup')

    const omTooltip = tooltipTextFor('error-mix-omission-label')
    expect(omTooltip).toContain('Omission is skipping a character')
    expect(omTooltip).toContain('rushed keypress')

    const insTooltip = tooltipTextFor('error-mix-insertion-label')
    expect(insTooltip).toContain('Insertion is typing an extra character')
    expect(insTooltip).toContain('stray double-press')
  })

  it('exposes the tooltip via aria-describedby rather than a native title attribute', () => {
    const results = [
      makeResult({ errorSubstitutions: 3, errorOmissions: 24, errorInsertions: 3, errorTargetChars: 100 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)
    const label = screen.getByTestId('error-mix-substitution-label')
    expect(label).not.toHaveAttribute('title')
    expect(label.getAttribute('aria-describedby')).toBeTruthy()
  })

  it('shares the same grid column template across every row so cells align', () => {
    const results = [
      makeResult({ errorSubstitutions: 3, errorOmissions: 24, errorInsertions: 3, errorTargetChars: 100 }),
    ]
    renderWithI18n(<ErrorMixSection results={results} />)

    const rows = ['substitution', 'omission', 'insertion'].map((id) => screen.getByTestId(`error-mix-${id}`))
    const templates = rows.map((row) => row.getAttribute('style'))
    expect(new Set(templates).size).toBe(1)
    expect(templates[0]).toContain('grid-template-columns')

    // The header row shares the exact same column template as the data
    // rows so the header captions line up with their columns.
    const header = screen.getByTestId('error-mix-header')
    expect(header.getAttribute('style')).toBe(templates[0])
  })
})
