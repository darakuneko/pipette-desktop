// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Covers the speed cell's population-benchmark subline only — the
// classifier boundary logic itself is covered by
// analyze-typing-profile.test.ts and analyze-benchmark.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { TypingProfileCard } from '../TypingProfileCard'
import { SPEED_MIN_KEYSTROKES } from '../analyze-typing-profile'
import type { TypingDailySummary } from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

Object.defineProperty(window, 'vialAPI', {
  value: {
    typingAnalyticsGetBigramAggregateForRange: () => Promise.resolve({ view: 'top', entries: [], truncated: false }),
    typingAnalyticsListMinuteStatsLocal: () => Promise.resolve([]),
  },
  writable: true,
  configurable: true,
})

const today = '2026-01-30'

function renderCard(daily: ReadonlyArray<TypingDailySummary>): void {
  render(
    <TypingProfileCard
      uid="0xAABB"
      deviceScope="own"
      appScopes={[]}
      typingTestScopes={[]}
      runIdScopes={[]}
      daily={daily}
      today={today}
      snapshot={null}
      fingerOverrides={{}}
    />,
  )
}

describe('TypingProfileCard benchmark subline', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the population line when the speed bucket is known', async () => {
    // Well over SPEED_MIN_KEYSTROKES with activeMs tuned for a plausible
    // WPM (keystrokes / 5 * 60000 / activeMs) — the exact position label
    // isn't asserted here, only that the benchmark subline appears.
    const daily: TypingDailySummary[] = [
      { date: today, keystrokes: SPEED_MIN_KEYSTROKES * 3, activeMs: 600_000 },
    ]
    renderCard(daily)
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
    })
    // The benchmark subline is plain text split across sibling text nodes
    // (label · position), not its own element, so assert on the card's
    // combined text content rather than a single getByText match.
    expect(grid!.textContent).toContain('analyze.benchmark.populationAverage')
  })

  it('shows nothing new when the speed bucket is unknown (insufficient data)', async () => {
    renderCard([])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
    })
    expect(grid!.textContent).not.toContain('analyze.benchmark.populationAverage')
  })
})
