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
import type { TypingTestResult } from '../../../../shared/types/pipette-settings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
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

// typingTestResults is now a prop fetched once by AnalyzePane's own
// settings effect (sanitized via useDevicePrefs' isValidTypingTestResult/
// sanitizeTypingTestResult) and passed down through SummaryView, rather
// than this card issuing its own pipetteSettingsGet — see the KSPC cell
// doc comment in TypingProfileCard.tsx.
function renderCard(
  daily: ReadonlyArray<TypingDailySummary>,
  typingTestResults: TypingTestResult[] = [],
  scopes: { typingTestScopes?: string[]; runIdScopes?: string[] } = {},
): void {
  render(
    <TypingProfileCard
      uid="0xAABB"
      deviceScope="own"
      appScopes={[]}
      typingTestScopes={scopes.typingTestScopes ?? []}
      runIdScopes={scopes.runIdScopes ?? []}
      daily={daily}
      today={today}
      snapshot={null}
      fingerOverrides={{}}
      typingTestResults={typingTestResults}
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

function makeResult(overrides: Partial<TypingTestResult> & { date: string }): TypingTestResult {
  return {
    wpm: 50, accuracy: 95, wordCount: 10, correctChars: 50, incorrectChars: 2, durationSeconds: 30,
    ...overrides,
  }
}

describe('TypingProfileCard KSPC cell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the char-weighted aggregate across qualifying results, not a plain average of per-run ratios', async () => {
    // Run A: 6 keystrokes / 4 chars = 1.5. Run B: 10 keystrokes / 20 chars = 0.5.
    // Char-weighted: (6+10)/(4+20) = 16/24 = 0.666... A plain average of
    // ratios would give (1.5+0.5)/2 = 1.0 instead — this asserts the former.
    renderCard([], [
      makeResult({ date: today, kspcKeystrokes: 6, kspcChars: 4 }),
      makeResult({ date: today, kspcKeystrokes: 10, kspcChars: 20 }),
    ])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      expect(grid!.textContent).toContain('0.67')
    })
    expect(grid!.textContent).not.toContain('1.00')
  })

  it('excludes results outside the 30-day window', async () => {
    const outOfRange = '2020-01-01T00:00:00.000Z'
    renderCard([], [
      makeResult({ date: today, kspcKeystrokes: 6, kspcChars: 4 }),
      makeResult({ date: outOfRange, kspcKeystrokes: 1000, kspcChars: 1 }), // would wildly skew if included
    ])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      expect(grid!.textContent).toContain('1.50')
    })
  })

  it('excludes results missing the raw kspc fields (legacy results)', async () => {
    renderCard([], [
      makeResult({ date: today }), // no kspcKeystrokes/kspcChars — legacy
    ])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
    })
    expect(grid!.textContent).toContain('analyze.summary.profile.insufficient')
  })

  it('shows the insufficient-data state when there are no qualifying results at all', async () => {
    renderCard([])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
    })
    expect(grid!.textContent).toContain('analyze.summary.profile.insufficient')
  })

  it('shows the population-average subline with the shared unit-free key (not analyze.benchmark.populationAverage)', async () => {
    renderCard([], [makeResult({ date: today, kspcKeystrokes: 6, kspcChars: 4 })])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
    })
    expect(grid!.textContent).toContain('analyze.benchmark.populationAverageKspc')
  })

  it('includes the description key so a hover tooltip can be rendered', async () => {
    renderCard([], [makeResult({ date: today, kspcKeystrokes: 6, kspcChars: 4 })])
    await waitFor(() => {
      expect(screen.getByTestId('analyze-typing-profile')).toBeInTheDocument()
    })
    // The StatCard wraps its body in a Tooltip trigger whenever a
    // descriptionKey is present — assert the KSPC label rendered at all
    // (the tooltip content itself is only shown on hover/focus).
    expect(screen.getByText('analyze.summary.profile.kspcLabel')).toBeInTheDocument()
  })

  it('includes a result timestamped in the window\'s last 999ms (exclusive next-day-00:00 bound, not 23:59:59.000)', async () => {
    const late = new Date(`${today}T00:00:00`)
    late.setHours(23, 59, 59, 500)
    renderCard([], [
      makeResult({ date: late.toISOString(), kspcKeystrokes: 6, kspcChars: 4 }),
    ])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      expect(grid!.textContent).toContain('1.50')
    })
  })

  it('excludes romaji-input results from the aggregate (different KSPC unit than verbatim mode)', async () => {
    renderCard([], [
      makeResult({ date: today, kspcKeystrokes: 6, kspcChars: 4 }),
      // Would wildly skew the pool if pooled in — romaji KSPC measures
      // rejected/accepted keystrokes, not confirmed characters.
      makeResult({ date: today, kspcKeystrokes: 100, kspcChars: 10, romajiInput: true }),
    ])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      expect(grid!.textContent).toContain('1.50')
    })
  })

  it('honors typingTestScopes: only results whose recorded material label matches are included', async () => {
    renderCard([], [
      makeResult({ date: today, kspcKeystrokes: 6, kspcChars: 4, mode: 'words', language: 'english' }),
      // Different material — would skew the pool if the filter didn't apply.
      makeResult({ date: today, kspcKeystrokes: 100, kspcChars: 10, mode: 'time', language: 'english' }),
    ], { typingTestScopes: ['words (english)'] })
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      expect(grid!.textContent).toContain('1.50')
    })
  })

  it('honors runIdScopes: a result missing runId drops out when a run filter is active', async () => {
    renderCard([], [
      makeResult({ date: today, kspcKeystrokes: 6, kspcChars: 4, runId: 'run-1' }),
      // No runId at all — must not silently pass a run filter.
      makeResult({ date: today, kspcKeystrokes: 100, kspcChars: 10 }),
    ], { runIdScopes: ['run-1'] })
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      expect(grid!.textContent).toContain('1.50')
    })
  })
})

describe('TypingProfileCard Error mix cell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the char-weighted aggregate across qualifying results, not a plain average of per-run rates', async () => {
    renderCard([], [
      makeResult({ date: today, errorSubstitutions: 2, errorOmissions: 1, errorInsertions: 0, errorTargetChars: 100 }),
      makeResult({ date: today, errorSubstitutions: 1, errorOmissions: 1, errorInsertions: 1, errorTargetChars: 100 }),
    ])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      // Σ substitutions=3 / Σ targetChars=200 -> 1.50%
      expect(grid!.textContent).toContain('1.50')
    })
  })

  it('excludes results outside the 30-day window', async () => {
    const outOfRange = '2025-01-01'
    renderCard([], [
      makeResult({ date: today, errorSubstitutions: 2, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100 }),
      makeResult({ date: outOfRange, errorSubstitutions: 900, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100 }),
    ])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      expect(grid!.textContent).toContain('2.00')
    })
  })

  it('excludes results missing the 4-field group (legacy results)', async () => {
    renderCard([], [
      makeResult({ date: today }), // no error-class fields — legacy
    ])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
    })
    expect(grid!.textContent).toContain('analyze.summary.profile.insufficient')
  })

  it('shows the insufficient-data state when there are no qualifying results at all', async () => {
    renderCard([], [])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
    })
    expect(grid!.textContent).toContain('analyze.summary.profile.insufficient')
  })

  it('excludes romaji-input results from the aggregate (no target/typed difference to classify)', async () => {
    renderCard([], [
      makeResult({ date: today, errorSubstitutions: 2, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100 }),
      // Would wildly skew the pool if pooled in.
      makeResult({ date: today, errorSubstitutions: 900, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100, romajiInput: true }),
    ])
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      expect(grid!.textContent).toContain('2.00')
    })
  })

  it('honors typingTestScopes: only results whose recorded material label matches are included', async () => {
    renderCard([], [
      makeResult({ date: today, errorSubstitutions: 2, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100, mode: 'words', language: 'english' }),
      makeResult({ date: today, errorSubstitutions: 900, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100, mode: 'time', language: 'english' }),
    ], { typingTestScopes: ['words (english)'] })
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      expect(grid!.textContent).toContain('2.00')
    })
  })

  it('honors runIdScopes: a result missing runId drops out when a run filter is active', async () => {
    renderCard([], [
      makeResult({ date: today, errorSubstitutions: 2, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100, runId: 'run-1' }),
      makeResult({ date: today, errorSubstitutions: 900, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100 }),
    ], { runIdScopes: ['run-1'] })
    let grid: HTMLElement
    await waitFor(() => {
      grid = screen.getByTestId('analyze-typing-profile')
      expect(grid!.textContent).toContain('2.00')
    })
  })

  it('includes the description key so a hover tooltip can be rendered', async () => {
    renderCard([], [makeResult({ date: today, errorSubstitutions: 2, errorOmissions: 0, errorInsertions: 0, errorTargetChars: 100 })])
    await waitFor(() => {
      expect(screen.getByTestId('analyze-typing-profile')).toBeInTheDocument()
    })
    expect(screen.getByText('analyze.summary.profile.errorMixLabel')).toBeInTheDocument()
  })
})
