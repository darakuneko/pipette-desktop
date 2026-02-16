// SPDX-License-Identifier: GPL-2.0-or-later

import type { TypingTestResult } from '../../shared/types/pipette-settings'
import { configKey } from './result-builder'

export interface TypingTestStats {
  bestWpm: number
  avgWpm: number
  last10Avg: number
  totalTests: number
  avgAccuracy: number
}

export function computeStats(results: TypingTestResult[]): TypingTestStats {
  if (results.length === 0) {
    return { bestWpm: 0, avgWpm: 0, last10Avg: 0, totalTests: 0, avgAccuracy: 0 }
  }

  const bestWpm = Math.max(...results.map((r) => r.wpm))
  const avgWpm = Math.round(results.reduce((s, r) => s + r.wpm, 0) / results.length)
  const avgAccuracy = Math.round(results.reduce((s, r) => s + r.accuracy, 0) / results.length)

  const last10 = results.slice(0, 10)
  const last10Avg = Math.round(last10.reduce((s, r) => s + r.wpm, 0) / last10.length)

  return {
    bestWpm,
    avgWpm,
    last10Avg,
    totalTests: results.length,
    avgAccuracy,
  }
}

export function getPersonalBests(results: TypingTestResult[]): Map<string, TypingTestResult> {
  const bests = new Map<string, TypingTestResult>()

  for (const result of results) {
    const key = configKey(result)
    const current = bests.get(key)
    if (!current || result.wpm > current.wpm) {
      bests.set(key, result)
    }
  }

  return bests
}
