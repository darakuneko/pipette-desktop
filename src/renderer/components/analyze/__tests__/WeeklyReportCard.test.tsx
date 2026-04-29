// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// UI smoke for the Weekly Report card. The aggregation logic is
// covered by `analyze-weekly-report.test.ts`; here we only verify the
// card forwards delta formatting and the empty-context fallback.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { WeeklyReportCard } from '../WeeklyReportCard'
import { toLocalDate } from '../analyze-streak-goal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
    i18n: { language: 'en' },
  }),
}))

const FIXED_NOW_MS = new Date(2026, 3, 27, 12, 0, 0).getTime()
const TODAY = toLocalDate(FIXED_NOW_MS)

function text(): string {
  return screen.getByTestId('analyze-weekly-report').textContent ?? ''
}

describe('WeeklyReportCard', () => {
  it('renders all three stats with deltas when both windows have enough data', () => {
    render(
      <WeeklyReportCard
        daily={[
          { date: TODAY, keystrokes: 5_000, activeMs: 1_800_000 },
          { date: '2026-04-20', keystrokes: 4_000, activeMs: 1_800_000 },
        ]}
        today={TODAY}
      />,
    )
    expect(screen.getByTestId('analyze-weekly-report')).toBeInTheDocument()
    // Current keystrokes = 5,000 (toLocaleString → "5,000").
    expect(text()).toContain('5,000')
    // Delta key is invoked (not the insufficient variant).
    expect(text()).toContain('analyze.summary.weeklyReport.delta:')
    expect(text()).not.toContain('deltaInsufficient')
  })

  it('falls back to deltaInsufficient when previous period has too few keystrokes', () => {
    render(
      <WeeklyReportCard
        daily={[
          { date: TODAY, keystrokes: 5_000, activeMs: 1_800_000 },
          { date: '2026-04-20', keystrokes: 5, activeMs: 60_000 },
        ]}
        today={TODAY}
      />,
    )
    expect(text()).toContain('deltaInsufficient')
  })

  it('shows zero values when daily is empty', () => {
    render(<WeeklyReportCard daily={[]} today={TODAY} />)
    // Current keystrokes = 0, active days = 0 — both must be visible.
    expect(text()).toContain('0')
    // WPM falls back to em-dash since keystrokes / activeMs both zero.
    expect(text()).toContain('—')
  })
})
