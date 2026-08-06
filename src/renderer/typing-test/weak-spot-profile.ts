// SPDX-License-Identifier: GPL-2.0-or-later

/** Composite weakness-profile aggregation for Weak Spot Training (see
 *  word-generator/weak-spot-weighting.ts for the sampling side that
 *  consumes the profile this module produces, weak-spot-timing.ts for
 *  the per-run interval extraction, and weak-spot-scoring.ts for the
 *  pure median/shrinkage/weakness-verdict statistics). Scans
 *  `typingTestHistory` for a given language + effective input method
 *  scope, combines its mistake tallies with whatever per-token timing
 *  data the scope's saved run logs provide, and gates biased sampling on
 *  whether at least one token actually came out weak — replacing the
 *  original fixed-200-keystroke gate (2026-08-06 user-approved revision:
 *  200 keystrokes of fast, accurate typing should never activate the
 *  mode; activation must be driven by an actual detected weakness). */

import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../shared/types/typing-run-log'
import type { TypingTestConfig } from './types'
import { isRomajiInputActive } from './romaji-input'
import { isKanaInputActive } from './kana-input'
import { aggregateMistakeTotals } from './MistakeRankingSection'
import { extractTokenIntervals, mergeTokenIntervals } from './weak-spot-timing'
import { median, computeTokenTimingStats, evaluateTokenWeakness } from './weak-spot-scoring'
import type { WeakSpotInputMethod } from './word-generator/weak-spot-weighting'

export type { WeakSpotInputMethod }

export interface MistakeProfile {
  /** Composite weakness score per token, scoped to one language + input
   *  method and already filtered of synthetic decoration keys — WEAK
   *  tokens only (see `evaluateTokenWeakness`); a token that isn't weak
   *  contributes nothing and is simply absent, exactly like a token with
   *  zero matched weight already behaves in `wordWeakSpotScore`. */
  weights: Record<string, number>
  /** Count of weak tokens in this scope — the gate's own trigger (see
   *  `WeakSpotGateInfo`): `>= 1` means at least one weakness was
   *  detected. Equivalent to `Object.keys(weights).length`, kept as its
   *  own field so callers never have to re-derive it via `Object.keys`. */
  weakTokenCount: number
}

/** Live UI-facing gate status for the Option section's toggle/hint —
 *  recomputed from the CURRENT config/language on every render
 *  (useTypingTest's `weakSpotGate`), independent of any in-progress run's
 *  own immutable `TypingTestState.weakSpotProfile` snapshot. `status`
 *  distinguishes three states the hint text must never conflate:
 *  - `'unavailable'`: history hasn't loaded yet (no `getMistakeProfile`
 *    thunk, or it returned undefined) — nothing is known yet, so no hint
 *    is shown at all (claiming "no weak spots" here would be a guess,
 *    not a fact — the data was simply never examined).
 *  - `'no-weak-spots'`: history IS loaded and the scope is real, but no
 *    token cleared any of the three weakness signals — normal sampling,
 *    with a positive ("nothing to fix!") hint.
 *  - `'active'`: at least one weak token was detected — biased sampling
 *    is (or would be, once the toggle is on) in effect. */
export interface WeakSpotGateInfo {
  /** False for every mode but words/time — the toggle itself doesn't
   *  exist elsewhere (see `isWeakSpotTrainingActive`). */
  applicable: boolean
  status: 'unavailable' | 'no-weak-spots' | 'active'
  /** Top detected weak tokens (score DESC), present only when `status ===
   *  'active'` AND the gate was built from a real `MistakeProfile` (see
   *  useTypingTest's `weakSpotGate` memo) — the non-applicable sentinel
   *  `{ applicable: false, status: 'active' }` returned for non-words/time
   *  modes carries no profile at all, so this stays optional rather than
   *  ever defaulting to an empty array there. */
  topWeakTokens?: string[]
  /** Total weak-token count the profile detected (`MistakeProfile.
   *  weakTokenCount`), independent of how many `topWeakTokens` actually
   *  shows — lets the UI compute an accurate "+N" overflow without
   *  hard-coding the shown-token count. Same optionality as
   *  `topWeakTokens` for the same reason. */
  weakTokenCount?: number
}

/** A mistake key produced by a synthetic decoration (injectNumbers/
 *  injectPunctuation/capitalization — see word-generator.ts's
 *  `applyOptions`) rather than the language's own text, so it's excluded
 *  from the profile: a user's tendency to fumble a decorated digit/
 *  punctuation/capital-letter slot isn't a "weak spot" in the language's
 *  own characters, and biasing toward it would just mean sampling more
 *  words hoping for another decoration draw (which sampleWords doesn't
 *  even control — decoration is applied AFTER sampling). Applied to BOTH
 *  the mistake-count map and the timing-interval map — a decorated
 *  trailing-punctuation or digit-replaced token can accumulate timing
 *  samples too, not just mistakes. A digit-replaced word's mistake key
 *  is the ENTIRE numeric string (verbatim mode tallies per-position, but
 *  a decorated "number word" is typed as a whole token replacing the
 *  sampled word, so every mismatched digit position contributes its own
 *  single-digit key) — the `/^[0-9]+$/` test catches both a single stray
 *  digit and a longer numeric key. */
function isSyntheticDecorationKey(key: string): boolean {
  return /^(?:[0-9]+|[.,?!]|[A-Z])$/.test(key)
}

/** A history row's own recorded input method — read from the flags
 *  `buildTypingTestResult` already stamps on every saved run
 *  (`romajiInput`/`kanaInput`, mutually exclusive by construction), never
 *  re-derived from the row's language/config: a historical row may have
 *  been recorded under a language the CURRENT run isn't even using, so
 *  only its own stored flags are trustworthy for what it was actually
 *  typed as. */
function resultInputMethod(r: TypingTestResult): WeakSpotInputMethod {
  if (r.romajiInput) return 'romaji'
  if (r.kanaInput) return 'kana'
  return 'direct'
}

/** Composite aggregation: scope-filters `history`, sums mistake counts
 *  (reusing `MistakeRankingSection.tsx`'s own summation loop) and merges
 *  whatever timing data the scope's available run logs provide (a row
 *  with no `runId`, or one `runLogs` doesn't have — recording consent
 *  was off, the run predates the log feature, or retention evicted it —
 *  simply contributes no timing data; mistakes-only weakness still
 *  applies for it, per the plan's explicit "log absent -> mistakes-only"
 *  rule). Every token appearing in EITHER source is evaluated once via
 *  `evaluateTokenWeakness`; only weak tokens make it into the returned
 *  `weights`. */
function computeWeaknessProfile(
  history: readonly TypingTestResult[],
  runLogs: ReadonlyMap<string, RunKeystrokeLog>,
  language: string,
  inputMethod: WeakSpotInputMethod,
): MistakeProfile {
  const scoped = history.filter((r) => (r.language ?? '') === language && resultInputMethod(r) === inputMethod)

  const missCounts: Record<string, number> = {}
  for (const [key, count] of Object.entries(aggregateMistakeTotals(scoped))) {
    if (isSyntheticDecorationKey(key)) continue
    missCounts[key] = count
  }

  const perLogIntervals: Map<string, number[]>[] = []
  for (const r of scoped) {
    if (!r.runId) continue
    const log = runLogs.get(r.runId)
    if (!log) continue
    perLogIntervals.push(extractTokenIntervals(log, inputMethod))
  }
  const mergedIntervals = mergeTokenIntervals(perLogIntervals)
  for (const key of [...mergedIntervals.keys()]) {
    if (isSyntheticDecorationKey(key)) mergedIntervals.delete(key)
  }

  const allValidIntervals: number[] = []
  for (const intervals of mergedIntervals.values()) allValidIntervals.push(...intervals)
  const scopeMedianMs = median(allValidIntervals)

  const weights: Record<string, number> = {}
  let weakTokenCount = 0
  const allTokens = new Set([...Object.keys(missCounts), ...mergedIntervals.keys()])
  for (const token of allTokens) {
    const missCount = missCounts[token] ?? 0
    const timing = computeTokenTimingStats(mergedIntervals.get(token) ?? [], scopeMedianMs)
    const verdict = evaluateTokenWeakness(missCount, timing, scopeMedianMs)
    if (!verdict.isWeak) continue
    weakTokenCount++
    weights[token] = verdict.score
  }

  return { weights, weakTokenCount }
}

/** The effective input method a words/time run under `config`/`language`
 *  would actually use — matches `comparison.ts`'s `conditionKey` in
 *  passing `undefined` for `textRomajiCapable` (words/time's own branch
 *  never reads it, only fileImport's does — see isRomajiCapable). Callers
 *  restrict this to words/time modes themselves (Weak Spot Training's own
 *  scope); calling it for another mode isn't meaningful but isn't guarded
 *  here since every caller already checks the mode first. */
export function effectiveWeakSpotInputMethod(config: TypingTestConfig, language: string): WeakSpotInputMethod {
  if (isRomajiInputActive(config, language, undefined)) return 'romaji'
  if (isKanaInputActive(config, language, undefined)) return 'kana'
  return 'direct'
}

/** Memoized profile lookup, keyed by the `history`/`runLogs` references
 *  plus a `language|inputMethod` scope key — a fresh cache instance per
 *  consumer (see useInputModes.ts, which owns one via `useRef`) so repeated
 *  calls against the SAME (unchanged) history/logs never re-scan them
 *  from scratch. Two independent call sites hit the same scope during
 *  ordinary use: `useTypingTest`'s live `weakSpotGate` (recomputed on
 *  config/language changes) and `resolveWeakSpotProfileArg` (at every
 *  run-start decision point) — without this cache each would rescan on
 *  its own. Note this is NOT what makes a single run's sampling
 *  immutable across time-mode refills — `refillTimeModeWords` never
 *  calls back into this cache at all; it reuses the frozen
 *  `TypingTestState.weakSpotProfile` object threaded through since the
 *  run started (see run-state.ts's `freshState`/`advanceAfterWord`).
 *  Invalidated wholesale the moment EITHER `history` or `runLogs`
 *  changes reference (a new result was saved, or another run log
 *  finished fetching), never partially. */
export interface MistakeProfileCache {
  get(
    history: readonly TypingTestResult[],
    runLogs: ReadonlyMap<string, RunKeystrokeLog>,
    language: string,
    inputMethod: WeakSpotInputMethod,
  ): MistakeProfile
}

export function createMistakeProfileCache(): MistakeProfileCache {
  let cachedHistory: readonly TypingTestResult[] | undefined
  let cachedRunLogs: ReadonlyMap<string, RunKeystrokeLog> | undefined
  let cache = new Map<string, MistakeProfile>()
  return {
    get(history, runLogs, language, inputMethod) {
      if (cachedHistory !== history || cachedRunLogs !== runLogs) {
        cachedHistory = history
        cachedRunLogs = runLogs
        cache = new Map()
      }
      const key = `${language}|${inputMethod}`
      const cached = cache.get(key)
      if (cached) return cached
      const result = computeWeaknessProfile(history, runLogs, language, inputMethod)
      cache.set(key, result)
      return result
    },
  }
}
