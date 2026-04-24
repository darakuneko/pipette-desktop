// SPDX-License-Identifier: GPL-2.0-or-later
// Unit tests for the helpers that back Activity tab's keystrokes
// summary / share formatting. Rendering paths (Recharts bars, cell
// grid) are covered via the smoke tests in TypingAnalyticsView.

import { describe, it, expect } from 'vitest'
import { toKeystrokesItems } from '../analyze-activity-format'
import { formatSharePercent } from '../analyze-format'
import type { ActivityKeystrokesSummary } from '../analyze-activity'

const summary: ActivityKeystrokesSummary = {
  totalKeystrokes: 2000,
  activeMs: 3_600_000,
  peakCell: {
    dow: 2,
    hour: 9,
    keystrokes: 500,
    activeMs: 600_000,
    wpm: 50,
    qualified: true,
  },
  mostFrequentDow: { dow: 2, keystrokes: 800 },
  mostFrequentHour: { hour: 9, keystrokes: 600 },
  activeCells: 12,
}

const t = (key: string, opts?: Record<string, unknown>): string =>
  opts ? `${key}|${JSON.stringify(opts)}` : key

describe('formatSharePercent', () => {
  it('formats a [0,1] fraction to a one-decimal percent string', () => {
    expect(formatSharePercent(0.25)).toBe('25.0')
    expect(formatSharePercent(1 / 3)).toBe('33.3')
  })

  it('falls back to 0.0 for non-finite inputs (covers k/0 division)', () => {
    expect(formatSharePercent(Number.NaN)).toBe('0.0')
    expect(formatSharePercent(Number.POSITIVE_INFINITY)).toBe('0.0')
  })
})

describe('toKeystrokesItems', () => {
  it('shows both raw count and share-of-total in every summary context', () => {
    const items = toKeystrokesItems(summary, t)
    const dowContext = items[0].context ?? ''
    const hourContext = items[1].context ?? ''
    const peakContext = items[2].context ?? ''
    // Busiest day: 800 / 2000 = 40.0%
    expect(dowContext).toContain('analyze.activity.summary.keysContext')
    expect(dowContext).toContain('"count":"800"')
    expect(dowContext).toContain('"share":"40.0"')
    // Busiest hour: 600 / 2000 = 30.0%
    expect(hourContext).toContain('"count":"600"')
    expect(hourContext).toContain('"share":"30.0"')
    // Peak cell: 500 / 2000 = 25.0%
    expect(peakContext).toContain('"count":"500"')
    expect(peakContext).toContain('"share":"25.0"')
  })

  it('collapses share to 0.0 when the total is empty', () => {
    const zeroed: ActivityKeystrokesSummary = {
      ...summary,
      totalKeystrokes: 0,
      mostFrequentDow: { dow: 2, keystrokes: 0 },
    }
    const ctx = toKeystrokesItems(zeroed, t)[0].context ?? ''
    expect(ctx).toContain('"share":"0.0"')
  })

  it('leaves the Active cells row untouched (no share annotation)', () => {
    const items = toKeystrokesItems(summary, t)
    expect(items[3].value).toBe('12 / 168')
    expect(items[3].context).toBeUndefined()
  })
})
