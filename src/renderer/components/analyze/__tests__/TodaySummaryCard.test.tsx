// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Smoke tests for the Today summary card. The card receives `daily`
// and `today` straight from SummaryView, so the suite drives each
// branch (matching row, no row, zero activeMs guard) by handing in
// fixtures directly — no Date.now stubbing or IPC mock needed.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TodaySummaryCard } from '../TodaySummaryCard'
import { toLocalDate } from '../analyze-streak-goal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

const FIXED_NOW_MS = new Date(2026, 3, 27, 12, 0, 0).getTime() // 2026-04-27 12:00 local
const TODAY = toLocalDate(FIXED_NOW_MS)

function statText(): string {
  return screen.getByTestId('analyze-today-summary').textContent ?? ''
}

describe('TodaySummaryCard', () => {
  it('shows formatted keystrokes / WPM / active duration when today has data', () => {
    render(
      <TodaySummaryCard
        daily={[
          { date: TODAY, keystrokes: 12_000, activeMs: 1_800_000 },
          { date: '2026-04-20', keystrokes: 5, activeMs: 60_000 },
        ]}
        today={TODAY}
      />,
    )
    expect(screen.getByTestId('analyze-today-summary')).toBeInTheDocument()
    // 12,000 keystrokes over 30 minutes → 80 WPM.
    expect(statText()).toContain('12,000')
    expect(statText()).toContain('80.0')
  })

  it('falls back to em-dashes when today has no entry', () => {
    render(
      <TodaySummaryCard
        daily={[{ date: '2026-04-20', keystrokes: 5, activeMs: 60_000 }]}
        today={TODAY}
      />,
    )
    // Three em-dashes, one per stat (the unit / label strings stay even
    // when the value is empty so we look for the actual `—` glyph).
    expect((statText().match(/—/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('keeps em-dashes when activeMs is zero (avoids /0 in WPM)', () => {
    // Edge case: a row with keystrokes but no activeMs should not emit
    // `Infinity` or NaN. computeWpm guards on activeMs <= 0.
    render(
      <TodaySummaryCard
        daily={[{ date: TODAY, keystrokes: 100, activeMs: 0 }]}
        today={TODAY}
      />,
    )
    const text = statText()
    // keystrokes value still renders (100), WPM falls back to em-dash,
    // active duration falls back to em-dash.
    expect(text).toContain('100')
    expect((text.match(/—/g) ?? []).length).toBeGreaterThanOrEqual(2)
  })
})
