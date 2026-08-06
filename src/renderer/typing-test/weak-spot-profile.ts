// SPDX-License-Identifier: GPL-2.0-or-later

/** Mistake-profile aggregation for Weak Spot Training (see
 *  word-generator/weak-spot-weighting.ts for the sampling side that
 *  consumes the profile this module produces). Scans `typingTestHistory`
 *  for a given language + effective input method scope, sums each row's
 *  `mistakes` tally (skipping synthetic decoration keys — digits/
 *  punctuation/capitalization — which are never a "real" character weak
 *  spot), and totals the scope's keystroke count (per-row
 *  `kspcKeystrokes ?? correctChars + incorrectChars`, summed AFTER the
 *  per-row fallback, never the other way around) to gate whether biasing
 *  should engage at all. */

import type { TypingTestResult } from '../../shared/types/pipette-settings'
import type { TypingTestConfig } from './types'
import { isRomajiInputActive } from './romaji-input'
import { isKanaInputActive } from './kana-input'
import { aggregateMistakeTotals } from './MistakeRankingSection'
import type { WeakSpotInputMethod } from './word-generator/weak-spot-weighting'

export type { WeakSpotInputMethod }

/** Cumulative scope keystrokes required before Weak Spot Training's
 *  biased sampling engages — below this, the toggle stays inert (normal
 *  sampling) and the UI shows a "N more keystrokes" hint instead of
 *  silently doing nothing. */
export const WEAK_SPOT_KEYSTROKE_THRESHOLD = 200

export interface MistakeProfile {
  /** Mistake-token -> summed count, scoped to one language + input method
   *  and already filtered of synthetic decoration keys. */
  weights: Record<string, number>
  /** Cumulative keystrokes across every history row in scope — the gate's
   *  numerator (see WEAK_SPOT_KEYSTROKE_THRESHOLD). */
  keystrokes: number
}

export function meetsWeakSpotThreshold(keystrokes: number): boolean {
  return keystrokes >= WEAK_SPOT_KEYSTROKE_THRESHOLD
}

/** Keystrokes still needed to reach the gate — 0 once already met. Only
 *  meaningful when a profile actually exists (history loaded); see
 *  `MistakeProfileCache` callers for the "unavailable" case this doesn't
 *  cover. */
export function weakSpotKeystrokeDeficit(keystrokes: number): number {
  return Math.max(0, WEAK_SPOT_KEYSTROKE_THRESHOLD - keystrokes)
}

/** Live UI-facing gate status for the Option section's toggle/hint —
 *  recomputed from the CURRENT config/language on every render
 *  (useTypingTest's `weakSpotGate`), independent of any in-progress run's
 *  own immutable `TypingTestState.weakSpotProfile` snapshot. `status`
 *  distinguishes three states the hint text must never conflate:
 *  - `'unavailable'`: history hasn't loaded yet (no `getMistakeProfile`
 *    thunk, or it returned undefined) — nothing is known yet, so no hint
 *    is shown (showing "N more keystrokes" here would be a guess, not a
 *    fact).
 *  - `'insufficient'`: history IS loaded and the scope is real, but under
 *    WEAK_SPOT_KEYSTROKE_THRESHOLD — `deficit` is the exact remaining
 *    count for the "N more keystrokes" hint.
 *  - `'met'`: biasing is (or would be, once the toggle is on) active. */
export interface WeakSpotGateInfo {
  /** False for every mode but words/time — the toggle itself doesn't
   *  exist elsewhere (see `isWeakSpotTrainingActive`). */
  applicable: boolean
  status: 'unavailable' | 'insufficient' | 'met'
  /** Only non-null when `status === 'insufficient'`. */
  deficit: number | null
}

/** A mistake key produced by a synthetic decoration (injectNumbers/
 *  injectPunctuation/capitalization — see word-generator.ts's
 *  `applyOptions`) rather than the language's own text, so it's excluded
 *  from the profile: a user's tendency to fumble a decorated digit/
 *  punctuation/capital-letter slot isn't a "weak spot" in the language's
 *  own characters, and biasing toward it would just mean sampling more
 *  words hoping for another decoration draw (which sampleWords doesn't
 *  even control — decoration is applied AFTER sampling). A digit-replaced
 *  word's mistake key is the ENTIRE numeric string (verbatim mode tallies
 *  per-position, but a decorated "number word" is typed as as a whole
 *  token replacing the sampled word, so every mismatched digit position
 *  contributes its own single-digit key) — the `/^[0-9]+$/` test catches
 *  both a single stray digit and a longer numeric key. */
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

/** Same per-result keystroke fallback as KSPC's own display path
 *  (`resultKspc`), but applied per-row BEFORE summing across the scope —
 *  summing first and falling back on the total would let a handful of
 *  legacy rows without `kspcKeystrokes` silently zero out an otherwise
 *  countable scope. */
function resultKeystrokeCount(r: TypingTestResult): number {
  return r.kspcKeystrokes ?? (r.correctChars + r.incorrectChars)
}

function aggregateMistakeProfile(
  history: readonly TypingTestResult[],
  language: string,
  inputMethod: WeakSpotInputMethod,
): MistakeProfile {
  const scoped = history.filter((r) => (r.language ?? '') === language && resultInputMethod(r) === inputMethod)
  let keystrokes = 0
  for (const r of scoped) keystrokes += resultKeystrokeCount(r)
  // Reuses MistakeRankingSection.tsx's own mistakes-summation loop (same
  // shape, already exported for this exact purpose) rather than
  // re-implementing it — this only adds the scope filter above and the
  // synthetic-decoration-key filter below, on top of that shared summation.
  const weights: Record<string, number> = {}
  for (const [key, count] of Object.entries(aggregateMistakeTotals(scoped))) {
    if (isSyntheticDecorationKey(key)) continue
    weights[key] = count
  }
  return { weights, keystrokes }
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

/** Memoized profile lookup, keyed by the `history` array's own identity
 *  plus a `language|inputMethod` scope key — a fresh cache instance per
 *  consumer (see useInputModes.ts, which owns one via `useRef`) so repeated
 *  calls against the SAME (unsaved) history never re-scan it from scratch.
 *  Two independent call sites hit the same scope during ordinary use:
 *  `useTypingTest`'s live `weakSpotGate` (recomputed on config/language
 *  changes) and `resolveWeakSpotProfileArg` (at every run-start decision
 *  point) — without this cache each would rescan `history` on its own. Note
 *  this is NOT what makes a single run's sampling immutable across
 *  time-mode refills — `refillTimeModeWords` never calls back into this
 *  cache at all; it reuses the frozen `TypingTestState.weakSpotProfile`
 *  object threaded through since the run started (see run-state.ts's
 *  `freshState`/`advanceAfterWord`). Invalidated wholesale the moment
 *  `history`'s reference changes (a new result was saved), never
 *  partially. */
export interface MistakeProfileCache {
  get(history: readonly TypingTestResult[], language: string, inputMethod: WeakSpotInputMethod): MistakeProfile
}

export function createMistakeProfileCache(): MistakeProfileCache {
  let cachedHistory: readonly TypingTestResult[] | undefined
  let cache = new Map<string, MistakeProfile>()
  return {
    get(history, language, inputMethod) {
      if (cachedHistory !== history) {
        cachedHistory = history
        cache = new Map()
      }
      const key = `${language}|${inputMethod}`
      const cached = cache.get(key)
      if (cached) return cached
      const result = aggregateMistakeProfile(history, language, inputMethod)
      cache.set(key, result)
      return result
    },
  }
}
