// SPDX-License-Identifier: GPL-2.0-or-later
// Bigram -> Left / Right / Alternation / Repetition classification,
// the four hand-usage classes from CHI 2018 Table 3 (Dhakal et al.,
// "Observations on Typing from 136 Million Keystrokes"). `repetition`
// is the paper's `letter repetition` (Table 2: ll, cc, aa, nn, ...) —
// the same key struck twice in a row — and is decided from keycode
// equality, not finger equality; two different keys sharing a finger
// (a same-finger bigram) fall through to `left`/`right` like any other
// same-hand pair. The rest of the classification is derived from the
// finger used by each of the bigram's two keys — no fixed key list, no
// independent geometry estimate. Reuses the finger map built by
// `analyze-bigram-finger.ts` so a user's Finger Assignment overrides
// apply here exactly as they do in the Finger IKI quadrant.

import { HAND_OF_FINGER, type FingerType } from '../../../shared/kle/kle-ergonomics'
import type { TypingBigramTopEntry } from '../../../shared/types/typing-analytics'
import { resolvePairFingersFromCodes } from './analyze-bigram-finger'
import { avgIkiFromHist, emptyHistTotal, foldHist, parseBigramId, type HistTotal } from './analyze-bigram-heatmap'
import { BIGRAM_MIN_COUNT } from './analyze-typing-profile'

export type BigramClass = 'left' | 'right' | 'alternation' | 'repetition' | 'unknown'

/** The four classes `classifyBigram` can resolve to — every `BigramClass`
 * value except `unknown`. Exported so renderer callers (the classes
 * table's row order) share the same list instead of re-declaring it. */
export const CLASSIFIED_CLASSES = ['left', 'right', 'alternation', 'repetition'] as const
export type ClassifiedBigramClass = (typeof CLASSIFIED_CLASSES)[number]

/**
 * Classify a bigram from the finger used by its previous and current
 * key, plus whether the two keycodes are the same key. Exclusive —
 * checked in this order so a letter repeat never also gets counted as
 * `left`/`right`, and a same-finger-different-key bigram never gets
 * counted as `repetition`:
 *
 *   1. either finger unresolved -> `unknown`
 *   2. same keycode (the same key struck twice) -> `repetition`
 *   3. the two fingers are on different hands -> `alternation`
 *   4. both left -> `left`, both right -> `right` (this also covers a
 *      same-finger bigram — two different keys sharing one finger,
 *      e.g. a thumb cluster — since it's still a same-hand pair)
 */
export function classifyBigram(
  prevFinger: FingerType | undefined,
  currFinger: FingerType | undefined,
  sameKeycode: boolean,
): BigramClass {
  if (!prevFinger || !currFinger) return 'unknown'
  if (sameKeycode) return 'repetition'
  const prevHand = HAND_OF_FINGER[prevFinger]
  const currHand = HAND_OF_FINGER[currFinger]
  if (prevHand !== currHand) return 'alternation'
  return prevHand === 'left' ? 'left' : 'right'
}

/** Per-class running total — see `HistTotal` (shared with
 * `FingerPairTotal`, the finger-pair sibling) for the shape. */
export type BigramClassTotal = HistTotal

export interface BigramClassAggregate {
  totals: Record<ClassifiedBigramClass, BigramClassTotal>
  /** Keystroke-pair count that couldn't be classified — malformed
   * ngram id or either key's finger unresolved. Kept separate rather
   * than folded into any class so the renderer can show classification
   * coverage instead of silently dropping the gap. */
  unknownCount: number
  /** Sum of every entry's `count`, classified or not — the coverage
   * denominator (`(totalCount - unknownCount) / totalCount`). */
  totalCount: number
}

/**
 * Aggregate bigram entries into the four CHI 2018 hand-usage classes.
 * Mirrors `aggregateFingerPairs`'s fold-then-average approach: per
 * class, `{count, hist}` accumulate and the caller derives the average
 * with `avgIkiFromHist` — never average two classes' pre-computed
 * averages together, since that isn't the same number as folding their
 * histograms first.
 *
 * No SD is produced here (nor should one be approximated from the
 * hist): the wire entries only carry a per-pair `sd`, and re-combining
 * per-pair SDs into a per-class variance needs sum/sumsq, which
 * `TypingBigramTopEntry` doesn't have.
 *
 * `entry.ngramId` is parsed exactly once via `parseBigramId`. A
 * malformed id always lands in `unknownCount` — `pairFilter`, when
 * given, is never consulted for it, since there's no parsed pair to
 * hand it. A pair that *does* parse is offered to `pairFilter` next;
 * a rejection there skips the entry entirely (not even `totalCount`),
 * so a scoped caller — e.g. `aggregateInWordBigramClasses`, which keeps
 * only in-word pairs — gets a coverage ratio over just the pairs it
 * intended to count, not one silently diluted by pairs outside its
 * scope. `pairFilter` only receives the parsed `(prev, curr)` pair, not
 * the source `entry` — every current and anticipated filter (word
 * position) decides purely from the keycodes, and a caller that ever
 * needs the raw entry can close over it instead of this function
 * threading it through.
 */
export function aggregateBigramClasses(
  entries: readonly TypingBigramTopEntry[],
  keycodeFinger: ReadonlyMap<number, FingerType>,
  pairFilter?: (pair: { prev: number; curr: number }) => boolean,
): BigramClassAggregate {
  const totals: Record<ClassifiedBigramClass, BigramClassTotal> = {
    left: emptyHistTotal(),
    right: emptyHistTotal(),
    alternation: emptyHistTotal(),
    repetition: emptyHistTotal(),
  }
  let unknownCount = 0
  let totalCount = 0
  for (const entry of entries) {
    const pair = parseBigramId(entry.ngramId)
    if (!pair) {
      unknownCount += entry.count
      totalCount += entry.count
      continue
    }
    if (pairFilter && !pairFilter(pair)) continue
    totalCount += entry.count
    const { prevFinger, currFinger, sameKeycode } = resolvePairFingersFromCodes(pair.prev, pair.curr, keycodeFinger)
    const cls = classifyBigram(prevFinger, currFinger, sameKeycode)
    if (cls === 'unknown') {
      unknownCount += entry.count
      continue
    }
    const bucket = totals[cls]
    bucket.count += entry.count
    foldHist(bucket.hist, entry.hist)
  }
  return { totals, unknownCount, totalCount }
}

/** Per-class avgIki, `null` (renders "—") whenever the class's sample
 * falls below `BIGRAM_MIN_COUNT` — the same floor the Typing Profile
 * card uses to suppress its Hand balance / SFB labels on thin data.
 * Shared by `BigramsClassesQuadrant` (the hand-usage / word-position
 * table) and `analyze-typist-cluster.ts` (the typist-cluster
 * classifier's IKI features), so the floor can't drift between the two
 * consumers. */
export function classAvgOrNull(total: BigramClassTotal): number | null {
  if (total.count < BIGRAM_MIN_COUNT) return null
  return avgIkiFromHist(total.hist)
}
