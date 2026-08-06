// SPDX-License-Identifier: GPL-2.0-or-later

/** Word-scoring/weighted-pick primitives for Weak Spot Training's biased
 *  sampling (see word-generator.ts's `sampleWords`). Deliberately narrow:
 *  this module only knows how to score a CANDIDATE word string against an
 *  already-aggregated weight map — the history-scanning/gating/memoization
 *  that PRODUCES that weight map lives one layer up, in
 *  `../weak-spot-profile.ts`, which this module is never imported by (kept
 *  that way so the word-generator/ layer never has to know about
 *  TypingTestResult/history at all). */

import { toHiragana } from '../kana-script'
import { canonicalRomajiSegments } from '../romaji-engine'

// Structurally identical to `JapaneseInputMethod` (romaji-input.ts) — kept
// as a separate declaration rather than importing that one, since
// romaji-input.ts pulls in the whole TypingTestConfig/run-state layer this
// module deliberately stays free of (see the module doc comment above).
// `JapaneseInputMethod`'s own derivation (`resolveJapaneseInputMethod`) is
// NOT reusable here regardless: it's a capability-UNAWARE read of the
// config's raw choice, whereas Weak Spot Training's scope needs the
// capability-gated ACTIVE state (see weak-spot-profile.ts's
// `effectiveWeakSpotInputMethod`, which composes `isRomajiInputActive`/
// `isKanaInputActive` instead). If a 4th input method is ever added, update
// both.
export type WeakSpotInputMethod = 'direct' | 'romaji' | 'kana'

/** The scope a mistake weight map was aggregated for, plus the weights
 *  themselves — token format depends on `inputMethod` (see
 *  `tokensForWord`): direct/kana key by individual characters (kana
 *  hiragana-normalized), romaji keys by canonical per-segment romaji
 *  tokens (see `canonicalRomajiSegments`). */
export interface WeakSpotBiasProfile {
  inputMethod: WeakSpotInputMethod
  weights: Readonly<Record<string, number>>
}

/** Expected share of draws pulled from the weighted pool rather than
 *  uniformly — a fixed 60/40 mixture (not pure proportional weighting)
 *  so a single very-high-frequency miss can't dominate every drawn word;
 *  the other 40% keeps the run representative of ordinary typing. */
export const WEAK_SPOT_BIAS_RATIO = 0.6

/** Caps a word's raw matched-weight sum before log-scaling, so one
 *  extreme-frequency mistake token can't make its words astronomically
 *  more likely than everything else in the pool. */
const WEAK_SPOT_SCORE_CAP = 50

/** Tokenizes `word` into the same unit shape `mistakes` keys were recorded
 *  under for `inputMethod` — see run-state.ts (`applyWordMistakes`/
 *  `handleBackspace`, direct), kana-input.ts (`handleKanaStroke`, kana:
 *  hiragana-normalized single characters), and romaji-input.ts
 *  (`handleRomajiChar`, romaji: canonical per-segment spelling via
 *  `canonicalRomajiSegments`). Never flat substring matching — a token
 *  must equal a full segment, so e.g. a missed "a" token never matches
 *  inside "ka". */
function tokensForWord(word: string, inputMethod: WeakSpotInputMethod): string[] {
  switch (inputMethod) {
    case 'direct':
      return [...word]
    case 'kana':
      return [...word].map(toHiragana)
    case 'romaji':
      return canonicalRomajiSegments(word)
  }
}

/** A candidate word's weak-spot score: the (capped, log-scaled) sum of its
 *  matched mistake-token weights, normalized by token count so a longer
 *  word doesn't win purely by containing more tokens. 0 when the word
 *  contains no matched tokens at all (never selected for the biased half
 *  of a draw — see `pickWeightedIndex`'s zero-weight handling). */
export function wordWeakSpotScore(word: string, profile: WeakSpotBiasProfile): number {
  const tokens = tokensForWord(word, profile.inputMethod)
  if (tokens.length === 0) return 0
  let sum = 0
  for (const token of tokens) sum += profile.weights[token] ?? 0
  if (sum <= 0) return 0
  return Math.log1p(Math.min(sum, WEAK_SPOT_SCORE_CAP)) / tokens.length
}

/** Weighted-random index into a parallel `weights` array, given its
 *  precomputed sum (`totalWeight` — callers already need it to decide
 *  whether biasing is active at all, so it's threaded in rather than
 *  resummed per draw). Linear scan: word lists here are small (hundreds,
 *  not millions), so this stays cheap without a cumulative-weight
 *  structure. Falls through to the last index only via float rounding at
 *  the tail — every positive-weight index is reachable. */
export function pickWeightedIndex(weights: readonly number[], totalWeight: number): number {
  let r = Math.random() * totalWeight
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i]
    if (r <= 0) return i
  }
  return weights.length - 1
}
