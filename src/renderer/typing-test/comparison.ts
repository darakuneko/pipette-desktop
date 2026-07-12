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

/** Stable key identifying the test condition a saved result was run under,
 *  reconstructed entirely from fields already stored on every history entry
 *  — no dedicated field needed, and it works for legacy rows too. This is
 *  the single source of truth for condition grouping:
 *  - fileImport: the imported text id (`mode2`), language-independent
 *  - tatoeba: the sentence-pack language (`mode2`), word-language-independent
 *  - normal (words/time/quote): mode + params + language + toggles (`configKey`)
 *  Rows missing some of these fields fall back the same way `configKey`
 *  already does for PB grouping, so old history entries group sensibly
 *  without a migration. */
export function resultConditionKey(result: TypingTestResult): string {
  const mode = result.mode ?? 'words'
  if (mode === 'fileImport') return `fileImport|${String(result.mode2 ?? '')}`
  if (mode === 'tatoeba') return `tatoeba|${String(result.mode2 ?? '')}`
  return configKey(result)
}

/** Stable key identifying the current test condition, used both to group
 *  same-condition history and to remember the per-condition baseline.
 *  Builds a result-shaped partial from the live config and delegates to
 *  {@link resultConditionKey}, so the two definitions can never drift.
 *  This must agree with {@link matchingResults} so the saved baseline and the
 *  pinnable choices stay in lockstep. */
export function conditionKey(config: TypingTestConfig, language: string): string {
  const hasToggles = config.mode === 'words' || config.mode === 'time'
  // resultConditionKey only reads these 5 fields, so a config-shaped partial is enough.
  return resultConditionKey({
    mode: config.mode,
    mode2: deriveMode2(config),
    language,
    punctuation: hasToggles ? config.punctuation : undefined,
    numbers: hasToggles ? config.numbers : undefined,
    romajiInput: hasToggles ? config.romajiInput : undefined,
  } as TypingTestResult)
}

/** Results from the pool sharing the current test's condition — same
 *  grouping as {@link resultConditionKey}/{@link conditionKey} (see those for
 *  the exact per-mode rules). `beforeMs`, when given, drops results at/after
 *  that time so the in-flight run (saved on finish) never compares against
 *  itself. */
export function matchingResults<T extends TypingTestResult>(
  pool: T[],
  config: TypingTestConfig,
  language: string,
  beforeMs?: number,
): T[] {
  const currentKey = conditionKey(config, language)
  return pool.filter((r) => {
    if (beforeMs != null && new Date(r.date).getTime() >= beforeMs) return false
    return resultConditionKey(r) === currentKey
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
