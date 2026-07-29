// @vitest-environment jsdom
// SPDX-License-Identifier: GPL-2.0-or-later
// Coverage for the Rollover column added to TopRanking/SlowRanking:
// percent formatting (incl. "—" for an unobserved pair) and the
// null-sorts-last invariant in both sort directions.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { TopRanking, SlowRanking } from '../BigramsRankingTables'
import type { TypingBigramTopEntry } from '../../../../shared/types/typing-analytics'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'en' },
  }),
}))

function entry(
  ngramId: string,
  overrides: Partial<TypingBigramTopEntry> = {},
): TypingBigramTopEntry {
  return {
    ngramId,
    count: 10,
    hist: [0, 0, 5, 0, 0, 0, 0, 0],
    avgIki: 125,
    sd: 10,
    ...overrides,
  }
}

function rowTexts(testId: string): string[][] {
  const table = screen.getByTestId(testId)
  const rows = within(table).getAllByRole('row').slice(1) // drop header row
  return rows.map((row) => within(row).getAllByRole('cell').map((c) => c.textContent ?? ''))
}

describe('TopRanking rollover column', () => {
  const entries: TypingBigramTopEntry[] = [
    entry('1_2', { count: 30, overlapCount: 3, overlapN: 4 }), // 75%
    entry('2_3', { count: 20, overlapCount: 1, overlapN: 4 }), // 25%
    entry('3_4', { count: 10 }), // no overlap data -> "—"
  ]

  it('renders "—" for a pair with no determined-overlap sample, and a percent otherwise', () => {
    render(<TopRanking entries={entries} listLimit={10} gram={2} />)
    const rows = rowTexts('analyze-bigrams-top-ranking')
    // Default sort is count desc: 1_2 (30), 2_3 (20), 3_4 (10). Rollover
    // is the last cell in each row.
    expect(rows.map((r) => r[r.length - 1])).toEqual(['75.0%', '25.0%', '—'])
  })

  it('sorts nulls last both ascending and descending when the Rollover header is clicked', () => {
    render(<TopRanking entries={entries} listLimit={10} gram={2} />)
    const header = screen.getByText('analyze.bigrams.column.rollover')

    // First click -> desc (default direction on a newly-activated column).
    fireEvent.click(header)
    let rows = rowTexts('analyze-bigrams-top-ranking')
    expect(rows.map((r) => r[r.length - 1])).toEqual(['75.0%', '25.0%', '—'])

    // Second click -> asc. The null entry must still sort last, not first.
    fireEvent.click(header)
    rows = rowTexts('analyze-bigrams-top-ranking')
    expect(rows.map((r) => r[r.length - 1])).toEqual(['25.0%', '75.0%', '—'])
  })

  it('renders an empty quadrant when there are no entries', () => {
    render(<TopRanking entries={[]} listLimit={10} gram={2} />)
    expect(screen.queryByTestId('analyze-bigrams-top-ranking')).toBeNull()
  })

  it('omits the Rollover header and cell entirely at gram === 3 (overlap sampling is bigram-only)', () => {
    render(<TopRanking entries={entries} listLimit={10} gram={3} />)
    expect(screen.queryByText('analyze.bigrams.column.rollover')).toBeNull()
    const rows = rowTexts('analyze-bigrams-top-ranking')
    // Row shape shrinks by exactly one cell (#, pair, count, avgIki, sd)
    // instead of carrying an inert all-"—" column.
    expect(rows[0]).toHaveLength(5)
  })
})

describe('SlowRanking rollover column', () => {
  // avgIkiAtOrAboveThreshold needs a hist whose weighted average clears
  // minAvgIkiMs=0 for every entry to stay eligible.
  const entries: TypingBigramTopEntry[] = [
    entry('1_2', { avgIki: 300, overlapCount: 2, overlapN: 5 }), // 40%
    entry('2_3', { avgIki: 200, overlapCount: 0, overlapN: 5 }), // 0.0% — a real observed zero, not "—"
    entry('3_4', { avgIki: 100 }), // no overlap data -> "—"
  ]

  it('renders 0.0% for a real observed zero, distinct from "—" for no data', () => {
    render(<SlowRanking entries={entries} listLimit={10} minAvgIkiMs={0} gram={2} />)
    const rows = rowTexts('analyze-bigrams-slow-ranking')
    // Default sort is avgIki desc: 300, 200, 100.
    expect(rows.map((r) => r[r.length - 1])).toEqual(['40.0%', '0.0%', '—'])
  })

  it('sorts nulls last both ascending and descending when the Rollover header is clicked', () => {
    render(<SlowRanking entries={entries} listLimit={10} minAvgIkiMs={0} gram={2} />)
    const header = screen.getByText('analyze.bigrams.column.rollover')

    fireEvent.click(header)
    let rows = rowTexts('analyze-bigrams-slow-ranking')
    expect(rows.map((r) => r[r.length - 1])).toEqual(['40.0%', '0.0%', '—'])

    fireEvent.click(header)
    rows = rowTexts('analyze-bigrams-slow-ranking')
    expect(rows.map((r) => r[r.length - 1])).toEqual(['0.0%', '40.0%', '—'])
  })

  it('omits the Rollover header and cell entirely at gram === 3 (overlap sampling is bigram-only)', () => {
    render(<SlowRanking entries={entries} listLimit={10} minAvgIkiMs={0} gram={3} />)
    expect(screen.queryByText('analyze.bigrams.column.rollover')).toBeNull()
    const rows = rowTexts('analyze-bigrams-slow-ranking')
    // Row shape shrinks by exactly one cell (#, pair, count, avgIki, sd, p95).
    expect(rows[0]).toHaveLength(6)
  })
})
