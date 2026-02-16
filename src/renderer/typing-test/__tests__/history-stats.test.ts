// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { computeStats, getPersonalBests } from '../history-stats'
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
    language: 'english',
    punctuation: false,
    numbers: false,
    ...overrides,
  }
}

describe('computeStats', () => {
  it('returns zero stats for empty results', () => {
    const stats = computeStats([])
    expect(stats.bestWpm).toBe(0)
    expect(stats.avgWpm).toBe(0)
    expect(stats.last10Avg).toBe(0)
    expect(stats.totalTests).toBe(0)
    expect(stats.avgAccuracy).toBe(0)
  })

  it('computes stats for a single result', () => {
    const stats = computeStats([makeResult({ wpm: 80, accuracy: 97 })])
    expect(stats.bestWpm).toBe(80)
    expect(stats.avgWpm).toBe(80)
    expect(stats.last10Avg).toBe(80)
    expect(stats.totalTests).toBe(1)
    expect(stats.avgAccuracy).toBe(97)
  })

  it('computes stats for multiple results', () => {
    const results = [
      makeResult({ wpm: 100, accuracy: 98 }),
      makeResult({ wpm: 80, accuracy: 96 }),
      makeResult({ wpm: 60, accuracy: 94 }),
    ]
    const stats = computeStats(results)
    expect(stats.bestWpm).toBe(100)
    expect(stats.avgWpm).toBe(80)
    expect(stats.last10Avg).toBe(80)
    expect(stats.totalTests).toBe(3)
    expect(stats.avgAccuracy).toBe(96)
  })

  it('last10Avg uses only last 10 entries', () => {
    const results = Array.from({ length: 15 }, (_, i) =>
      makeResult({ wpm: i < 10 ? 100 : 50 }),
    )
    const stats = computeStats(results)
    // First 10 results have wpm=100, remaining 5 have wpm=50
    expect(stats.last10Avg).toBe(100)
    expect(stats.totalTests).toBe(15)
  })
})

describe('getPersonalBests', () => {
  it('returns empty map for empty results', () => {
    expect(getPersonalBests([]).size).toBe(0)
  })

  it('groups by config key and returns best WPM', () => {
    const results = [
      makeResult({ wpm: 80, mode: 'words', mode2: 30 }),
      makeResult({ wpm: 100, mode: 'words', mode2: 30 }),
      makeResult({ wpm: 90, mode: 'time', mode2: 60 }),
    ]
    const pbs = getPersonalBests(results)
    expect(pbs.size).toBe(2)
    expect(pbs.get('words|30|english|false|false')?.wpm).toBe(100)
    expect(pbs.get('time|60|english|false|false')?.wpm).toBe(90)
  })

  it('distinguishes by mode2', () => {
    const results = [
      makeResult({ wpm: 80, mode: 'words', mode2: 30 }),
      makeResult({ wpm: 90, mode: 'words', mode2: 60 }),
    ]
    const pbs = getPersonalBests(results)
    expect(pbs.size).toBe(2)
    expect(pbs.get('words|30|english|false|false')?.wpm).toBe(80)
    expect(pbs.get('words|60|english|false|false')?.wpm).toBe(90)
  })
})
