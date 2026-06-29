// SPDX-License-Identifier: GPL-2.0-or-later

import type { TypingTestResult, TypingTestComparisonBaseline } from '../../shared/types/pipette-settings'
import type { TypingTestConfig } from './types'
import { configKey, deriveMode2, resultKpm } from './result-builder'

/** Headline metrics of the chosen baseline, compared against the live run. */
export interface ComparisonStats {
  wpm: number
  kpm: number
  accuracy: number
}

/** Stable key identifying the current test condition, used both to group
 *  same-condition history and to remember the per-condition baseline:
 *  - custom: the imported text id (`custom|textId`)
 *  - normal: mode + params + language + toggles (mirrors `configKey`)
 *  This must agree with {@link matchingResults} so the saved baseline and the
 *  pinnable choices stay in lockstep. */
export function conditionKey(config: TypingTestConfig, language: string): string {
  if (config.mode === 'custom') return `custom|${String(deriveMode2(config) ?? '')}`
  const hasToggles = config.mode === 'words' || config.mode === 'time'
  return configKey({
    mode: config.mode,
    mode2: deriveMode2(config),
    language,
    punctuation: hasToggles ? config.punctuation : undefined,
    numbers: hasToggles ? config.numbers : undefined,
  } as TypingTestResult)
}

/** Results from the pool sharing the current test's condition:
 *  - custom: the same imported text (matched on `mode2` = textId)
 *  - normal: same mode + params + language + punctuation/numbers (`configKey`)
 *  `beforeMs`, when given, drops results at/after that time so the in-flight
 *  run (saved on finish) never compares against itself. */
export function matchingResults<T extends TypingTestResult>(
  pool: T[],
  config: TypingTestConfig,
  language: string,
  beforeMs?: number,
): T[] {
  const isCustom = config.mode === 'custom'
  const currentTextId = String(deriveMode2(config) ?? '')
  const hasToggles = config.mode === 'words' || config.mode === 'time'
  // configKey only reads these 5 fields, so a config-shaped partial is enough.
  const currentKey = configKey({
    mode: config.mode,
    mode2: deriveMode2(config),
    language,
    punctuation: hasToggles ? config.punctuation : undefined,
    numbers: hasToggles ? config.numbers : undefined,
  } as TypingTestResult)

  return pool.filter((r) => {
    if (beforeMs != null && new Date(r.date).getTime() >= beforeMs) return false
    if (isCustom) return r.mode === 'custom' && String(r.mode2 ?? '') === currentTextId
    return configKey(r) === currentKey
  })
}

function statsOf(r: TypingTestResult): ComparisonStats {
  return { wpm: r.wpm, kpm: resultKpm(r), accuracy: r.accuracy }
}

/** The baseline metrics to compare the live run against, or `null` when the
 *  baseline is off / unresolved (no matching history, pinned result gone). */
export function computeComparison(
  pool: TypingTestResult[],
  config: TypingTestConfig,
  language: string,
  baseline: TypingTestComparisonBaseline,
  beforeMs?: number,
): ComparisonStats | null {
  if (baseline.kind === 'off') return null

  // A pinned result is a fixed, condition-independent baseline keyed by `date`.
  if (baseline.kind === 'pinned') {
    if (!baseline.pinnedDate) return null
    const pinned = pool.find((r) => r.date === baseline.pinnedDate)
    return pinned ? statsOf(pinned) : null
  }

  const matches = matchingResults(pool, config, language, beforeMs)
  if (matches.length === 0) return null

  if (baseline.kind === 'average') {
    const n = matches.length
    const sum = matches.reduce(
      (acc, r) => ({ wpm: acc.wpm + r.wpm, kpm: acc.kpm + resultKpm(r), accuracy: acc.accuracy + r.accuracy }),
      { wpm: 0, kpm: 0, accuracy: 0 },
    )
    return { wpm: Math.round(sum.wpm / n), kpm: Math.round(sum.kpm / n), accuracy: Math.round(sum.accuracy / n) }
  }

  // 'previous' = most recent matching run; 'best' = highest WPM.
  const chosen = baseline.kind === 'best'
    ? matches.reduce((a, b) => (b.wpm > a.wpm ? b : a))
    : matches.reduce((a, b) => (new Date(b.date).getTime() > new Date(a.date).getTime() ? b : a))
  return statsOf(chosen)
}
