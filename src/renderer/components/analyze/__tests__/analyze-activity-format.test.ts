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
  it('shows raw keystroke counts in absolute mode', () => {
    const items = toKeystrokesItems(summary, t, 'absolute')
    const dowContext = items[0].context ?? ''
    const peakContext = items[2].context ?? ''
    expect(dowContext).toContain('analyze.activity.summary.keysContext')
    expect(dowContext).toContain('"count":"800"')
    expect(peakContext).toContain('analyze.activity.summary.keysContext')
    expect(peakContext).toContain('"count":"500"')
  })

  it('shows share-of-total percentages in shareOfTotal mode', () => {
    const items = toKeystrokesItems(summary, t, 'shareOfTotal')
    const dowContext = items[0].context ?? ''
    const peakContext = items[2].context ?? ''
    expect(dowContext).toContain('analyze.activity.summary.shareContext')
    // 800 / 2000 = 40.0%
    expect(dowContext).toContain('"share":"40.0"')
    // 500 / 2000 = 25.0%
    expect(peakContext).toContain('analyze.activity.summary.shareContext')
    expect(peakContext).toContain('"share":"25.0"')
  })

  it('keeps the Active cells line untouched across modes (no context swap)', () => {
    const abs = toKeystrokesItems(summary, t, 'absolute')[3]
    const share = toKeystrokesItems(summary, t, 'shareOfTotal')[3]
    expect(abs.value).toBe(share.value)
  })
})
