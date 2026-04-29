// SPDX-License-Identifier: GPL-2.0-or-later
// Pure-logic coverage for the Typing Profile classifiers. Each
// classifier owns one bucket-table; the suite asserts the boundary
// transitions and the "unknown" fallback so a regression in any
// threshold or sample-size guard fails locally.

import { describe, it, expect } from 'vitest'
import {
  classifyFatigue,
  classifyHandBalance,
  classifySfb,
  classifySpeed,
  BIGRAM_MIN_COUNT,
  SPEED_MIN_KEYSTROKES,
} from '../analyze-typing-profile'
import type { FingerType } from '../../../../shared/kle/kle-ergonomics'
import type {
  TypingBigramTopEntry,
  TypingDailySummary,
  TypingMinuteStatsRow,
} from '../../../../shared/types/typing-analytics'

function bigram(prev: number, curr: number, count: number): TypingBigramTopEntry {
  return { bigramId: `${prev}_${curr}`, count, hist: new Array(8).fill(0), avgIki: null }
}

function minute(minuteMs: number, keystrokes: number, activeMs: number): TypingMinuteStatsRow {
  return {
    minuteMs,
    keystrokes,
    activeMs,
    intervalMinMs: null,
    intervalP25Ms: null,
    intervalP50Ms: null,
    intervalP75Ms: null,
    intervalMaxMs: null,
  }
}

describe('classifySpeed', () => {
  it('returns unknown for an empty daily array', () => {
    expect(classifySpeed([]).label).toBe('unknown')
  })

  it('returns unknown when below the min keystroke floor', () => {
    const daily: TypingDailySummary[] = [{ date: '2026-04-27', keystrokes: SPEED_MIN_KEYSTROKES - 1, activeMs: 60_000 }]
    expect(classifySpeed(daily).label).toBe('unknown')
  })

  it('classifies slow / medium / fast at the documented boundaries', () => {
    // 1500 keystrokes / 5 / minutes = 300 wpm * minutes ratio. Use big
    // active windows so WPM lands deterministically.
    // 1500 keys / 5 = 300 words. activeMs = 1_500_000ms = 25min →
    // 300/25 = 12 WPM (slow).
    const slow: TypingDailySummary[] = [{ date: '2026-04-27', keystrokes: 1500, activeMs: 1_500_000 }]
    expect(classifySpeed(slow).label).toBe('slow')
    // 1500 keys, activeMs = 450_000ms (7.5min) → 1500/5/7.5 = 40 WPM (medium).
    const medium: TypingDailySummary[] = [{ date: '2026-04-27', keystrokes: 1500, activeMs: 450_000 }]
    expect(classifySpeed(medium).label).toBe('medium')
    // 1500 keys, activeMs = 300_000ms (5min) → 1500/5/5 = 60 WPM (fast).
    const fast: TypingDailySummary[] = [{ date: '2026-04-27', keystrokes: 1500, activeMs: 300_000 }]
    expect(classifySpeed(fast).label).toBe('fast')
  })

  it('treats wpm at the slow / medium boundary as medium (>=30)', () => {
    // 1500 keys / 5 = 300 words; activeMs = 600_000 (10 min) → 30 WPM.
    // Slow boundary is `< 30`, so exactly 30 belongs to medium.
    const daily: TypingDailySummary[] = [{ date: '2026-04-27', keystrokes: 1500, activeMs: 600_000 }]
    expect(classifySpeed(daily).label).toBe('medium')
  })

  it('treats wpm at the medium / fast boundary as fast (>=50)', () => {
    // 1500 keys / 5 = 300 words; activeMs = 360_000 (6 min) → 50 WPM.
    // Medium boundary is `< 50`, so exactly 50 belongs to fast.
    const daily: TypingDailySummary[] = [{ date: '2026-04-27', keystrokes: 1500, activeMs: 360_000 }]
    expect(classifySpeed(daily).label).toBe('fast')
  })
})

describe('classifyHandBalance', () => {
  // Keycode → finger fixture: even codes map left-index, odd map right-index.
  const fingerMap = new Map<number, FingerType>()
  for (let i = 0; i < 30; i += 1) {
    fingerMap.set(i, i % 2 === 0 ? 'left-index' : 'right-index')
  }

  it('returns unknown when the bigram count is below the floor', () => {
    const entries = [bigram(0, 1, BIGRAM_MIN_COUNT - 1)]
    expect(classifyHandBalance(entries, fingerMap).label).toBe('unknown')
  })

  it('classifies leftBias / balanced / rightBias by left-share of mapped pairs', () => {
    // Hand balance counts the SECOND keycode of each bigram (the most
    // recent keystroke). Drive 70/30 → leftBias by mostly mapping the
    // second keycode to a left finger.
    const lefty: TypingBigramTopEntry[] = [
      // (any → 0): 0 is even → left-index. 700 left.
      bigram(1, 0, 700),
      // (any → 1): 1 is odd → right-index. 300 right.
      bigram(0, 1, 300),
    ]
    expect(classifyHandBalance(lefty, fingerMap).label).toBe('leftBias')

    const even: TypingBigramTopEntry[] = [
      bigram(1, 0, 500),
      bigram(0, 1, 500),
    ]
    expect(classifyHandBalance(even, fingerMap).label).toBe('balanced')

    const righty: TypingBigramTopEntry[] = [
      bigram(1, 0, 300),
      bigram(0, 1, 700),
    ]
    expect(classifyHandBalance(righty, fingerMap).label).toBe('rightBias')
  })

  it('returns unknown for an empty entries array', () => {
    expect(classifyHandBalance([], fingerMap).label).toBe('unknown')
  })
})

describe('classifySfb', () => {
  // All keycodes map to left-index; every bigram is therefore SFB.
  const allLeftIndex = new Map<number, FingerType>()
  for (let i = 0; i < 10; i += 1) allLeftIndex.set(i, 'left-index')
  // Mixed: even = left-index, odd = right-index. Cross-finger bigrams
  // (different fingers) drive the rate down.
  const mixed = new Map<number, FingerType>()
  for (let i = 0; i < 10; i += 1) {
    mixed.set(i, i % 2 === 0 ? 'left-index' : 'right-index')
  }

  it('returns unknown when below the bigram floor', () => {
    expect(classifySfb([bigram(0, 1, BIGRAM_MIN_COUNT - 1)], mixed).label).toBe('unknown')
  })

  it('classifies high when nearly all bigrams are same-finger', () => {
    // 100% same-finger.
    const entries = [bigram(0, 0, BIGRAM_MIN_COUNT * 2)]
    expect(classifySfb(entries, allLeftIndex).label).toBe('high')
  })

  it('classifies low when no bigrams are same-finger', () => {
    // 0% same-finger (every pair crosses hands).
    const entries: TypingBigramTopEntry[] = []
    for (let i = 0; i < BIGRAM_MIN_COUNT * 2; i += 1) entries.push(bigram(0, 1, 1))
    expect(classifySfb(entries, mixed).label).toBe('low')
  })

  it('classifies medium when SFB rate is in 4–8% range', () => {
    // 5% same-finger of total bigrams. Need totalCount >= BIGRAM_MIN_COUNT.
    // Use 50 same-finger + 950 cross-finger entries → 5% rate → medium.
    const entries: TypingBigramTopEntry[] = [
      bigram(0, 0, 50),  // SFB
      bigram(0, 1, 950), // cross-finger
    ]
    expect(classifySfb(entries, mixed).label).toBe('medium')
  })

  it('returns unknown for an empty entries array', () => {
    expect(classifySfb([], mixed).label).toBe('unknown')
  })
})

describe('classifyFatigue', () => {
  it('returns unknown when fewer than the minimum hour buckets qualify', () => {
    // One hour with traffic, below the FATIGUE_MIN_HOURS floor.
    const rows = [minute(new Date('2026-04-27T10:00:00Z').getTime(), 200, 120_000)]
    const range = { fromMs: 0, toMs: Date.now() + 86_400_000 }
    expect(classifyFatigue(rows, range).label).toBe('unknown')
  })

  it('classifies low / high by drop percentage between peak and lowest hour', () => {
    // 4 hours all at the same WPM → 0% drop → low.
    const flatRows: TypingMinuteStatsRow[] = []
    for (let h = 0; h < 4; h += 1) {
      // 200 keystrokes per minute over a single 60_000 ms qualifying
      // bucket → consistent WPM across hours.
      flatRows.push(minute(new Date(2026, 3, 27, h, 0, 0).getTime(), 200, 120_000))
    }
    const range = { fromMs: 0, toMs: Date.now() + 86_400_000 }
    expect(classifyFatigue(flatRows, range).label).toBe('low')

    // Peak hour double the lowest → ~50% drop → high.
    const dropRows: TypingMinuteStatsRow[] = [
      minute(new Date(2026, 3, 27, 9, 0, 0).getTime(), 800, 120_000), // peak
      minute(new Date(2026, 3, 27, 12, 0, 0).getTime(), 600, 120_000),
      minute(new Date(2026, 3, 27, 18, 0, 0).getTime(), 500, 120_000),
      minute(new Date(2026, 3, 27, 21, 0, 0).getTime(), 400, 120_000), // lowest
    ]
    expect(classifyFatigue(dropRows, range).label).toBe('high')
  })

  it('classifies medium when drop is between low and high thresholds (~12%)', () => {
    // peak 800 vs lowest 700 → 12.5% drop → medium (8 ≤ pct < 18).
    const range = { fromMs: 0, toMs: Date.now() + 86_400_000 }
    const rows: TypingMinuteStatsRow[] = [
      minute(new Date(2026, 3, 27, 9, 0, 0).getTime(), 800, 120_000),
      minute(new Date(2026, 3, 27, 12, 0, 0).getTime(), 750, 120_000),
      minute(new Date(2026, 3, 27, 18, 0, 0).getTime(), 720, 120_000),
      minute(new Date(2026, 3, 27, 21, 0, 0).getTime(), 700, 120_000),
    ]
    expect(classifyFatigue(rows, range).label).toBe('medium')
  })

  it('returns unknown for an empty rows array', () => {
    const range = { fromMs: 0, toMs: Date.now() + 86_400_000 }
    expect(classifyFatigue([], range).label).toBe('unknown')
  })
})
