// SPDX-License-Identifier: GPL-2.0-or-later
// Bigram -> Initiation / In-word word-position classification, the
// sibling of `analyze-bigram-classes.ts`'s hand-usage classes. Kept as
// its own module rather than folded into that file because the two
// classifications depend on fundamentally different inputs: hand usage
// needs the snapshot-derived finger map (it can't resolve without a
// keymap), while word position only needs to compare two recorded
// keycodes against a small separator set — no snapshot, no finger map,
// no per-keyboard state at all. A classification this cheap doesn't
// belong behind the same "needs a snapshot" gate as its sibling.

import {
  deserialize,
  extractBasicKey,
  isLTKeycode,
  isModTapKeycode,
  isSHTKeycode,
} from '../../../shared/keycodes/keycodes'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type { TypingBigramTopEntry } from '../../../shared/types/typing-analytics'
import { aggregateBigramClasses, type BigramClassAggregate } from './analyze-bigram-classes'
import { emptyHistTotal, foldHist, parseBigramId, type HistTotal } from './analyze-bigram-heatmap'
import { withSnapshotProtocol } from './analyze-protocol'

export type WordPosition = 'initiation' | 'inWord' | 'excluded'

/**
 * Unwraps a recorded keycode to the basic key its TAP action produces.
 *
 * PROTOCOL-SENSITIVE. The three range predicates below resolve their
 * base constants through the *current global* protocol, and two of the
 * three move between versions — `QK_MOD_TAP` is 0x6000 under v5 but
 * 0x2000 under v6, and `SH_T(kc)` is 0x999d0 under v5 but 0x5600 under
 * v6. A code recorded under one protocol and tested under the other
 * silently fails to unwrap. Callers must therefore run this inside
 * `withSnapshotProtocol(snapshot.vialProtocol, ...)`; when the
 * recording protocol is unknown, don't call it at all — see
 * `aggregateWordPosition`'s `vialProtocol` parameter. (`QK_LAYER_TAP`
 * happens to be 0x4000 in both, but relying on that would make the
 * behaviour depend on which of the three wrappers a user picked.)
 *
 * KNOWN APPROXIMATION — a hold is counted as a tap. The recorded event
 * carries an `action: 'tap' | 'hold'` for masked keys, but the ngram
 * chain stores only `event.keycode` and drops it (see
 * `minute-buffer.ts`'s `recordNgramChain` call), so by the time a pair
 * reaches this function there is no way to tell the two apart. Holding
 * `LT(1, KC_SPACE)` to reach a layer therefore lands in `initiation`
 * exactly like tapping it for a space would, biasing the initiation
 * bucket by roughly the user's layer-switch rate. Accepted rather than
 * fixed here because the alternative — refusing to classify any
 * dual-role key — leaves anyone who put space on a thumb LT with no
 * word-position data at all. A real fix has to keep `action` on the
 * ngram at record time; existing aggregates can't be repaired.
 *
 * Only Layer-Tap, Mod-Tap and Swap-Hands-Tap are unwrapped: holding any
 * of the three sends a layer switch / modifier / hand swap, but tapping
 * them genuinely emits the bare basic key underneath, so a `LT(1,
 * KC_SPACE)` tap is indistinguishable from a plain `KC_SPACE` tap for
 * word-position purposes.
 *
 * A modifier-mask keycode (`isModMaskKeycode`, e.g. `LCTL(KC_SPACE)`)
 * is deliberately NOT unwrapped: unlike the three tap-actions above, a
 * mod-mask keycode always sends the modifier together with the key —
 * there is no tap/hold distinction that ever emits the bare key alone.
 * `Ctrl+Space` is not a word separator just because its low byte
 * happens to equal `KC_SPACE`.
 *
 * Everything else — including macro and tap-dance keycodes, which live
 * well above the basic-key range — is returned unchanged. Masking
 * unconditionally (`code & 0xff`) would fold any such high keycode down
 * into the basic range and risk a false separator match whenever its
 * low byte happened to coincide with `KC_SPACE` / `KC_ENTER`.
 */
export function tapKeycodeOf(code: number): number {
  if (isLTKeycode(code) || isModTapKeycode(code) || isSHTKeycode(code)) {
    return extractBasicKey(code)
  }
  return code
}

// Lazily resolved so module init doesn't depend on the keycode table
// being ready yet, and cached because `classifyWordPosition` runs once
// per entry. Unlike the tap-range predicates above, these two ARE
// protocol-independent — `KC_SPACE` / `KC_ENTER` are basic keycodes
// with the same numeric value under v5 and v6 — which is what makes the
// no-protocol fallback path below safe rather than merely convenient.
let separatorCodes: Set<number> | null = null

function separatorKeycodes(): Set<number> {
  if (!separatorCodes) {
    separatorCodes = new Set([deserialize('KC_SPACE'), deserialize('KC_ENTER')])
  }
  return separatorCodes
}

/**
 * Classifies a bigram by where it falls relative to a word boundary.
 * Exclusive — checked in this order:
 *
 *   1. `curr`'s tap keycode is a separator -> `excluded`. A pair ending
 *      at a separator is the *end* of a word, a different act from both
 *      starting one and continuing one, so it's dropped rather than
 *      counted as either. Checking this first also correctly drops a
 *      `space->space` (double separator) pair instead of miscounting it
 *      as an initiation.
 *   2. `prev`'s tap keycode is a separator -> `initiation` (the first
 *      pair typed after a separator).
 *   3. otherwise -> `inWord`.
 *
 * Including `KC_ENTER` in the separator set makes this "after a
 * separator" rather than the CHI 2018 paper's strict space-only word
 * initiation — a deliberate, user-approved widening: a line break ends
 * a word exactly like a space does for this purpose.
 *
 * `unwrapTaps` controls whether `LT`/`MT`/`SH_T` keys are resolved to
 * the key they emit when tapped. Pass `true` only from inside a
 * `withSnapshotProtocol` scope — see `tapKeycodeOf`. With `false` only
 * bare `KC_SPACE` / `KC_ENTER` count, which under-counts a user who
 * put space on a dual-role key but never mis-classifies.
 */
export function classifyWordPosition(
  prevCode: number,
  currCode: number,
  unwrapTaps: boolean,
): WordPosition {
  const separators = separatorKeycodes()
  const resolve = (code: number): number => (unwrapTaps ? tapKeycodeOf(code) : code)
  if (separators.has(resolve(currCode))) return 'excluded'
  if (separators.has(resolve(prevCode))) return 'initiation'
  return 'inWord'
}

/** Per-bucket running total — see `HistTotal` (shared with
 * `BigramClassTotal`, the hand-usage sibling) for the shape. */
export type WordPositionTotal = HistTotal

export interface WordPositionAggregate {
  initiation: WordPositionTotal
  inWord: WordPositionTotal
  /** Pair count dropped because the pair ends at a separator. Surfaced
   * as a raw count in the quadrant's footnote so the two buckets aren't
   * read as covering every pair. Deliberately not paired with a grand
   * total: nothing renders a percentage, and carrying a denominator no
   * caller divides by would just be one more field to keep true. */
  excludedCount: number
}

/**
 * Aggregates bigram entries into the `initiation` / `inWord` word-
 * position buckets. Mirrors `aggregateBigramClasses`'s fold-then-
 * average approach: per bucket, `{count, hist}` accumulate and the
 * caller derives the average with `avgIkiFromHist` — never average two
 * buckets' pre-computed averages together.
 *
 * A malformed ngram id (`parseBigramId` returns `null`) is skipped
 * entirely: it's neither folded into `inWord` nor counted as excluded,
 * since it can't be resolved to a (prev, curr) pair at all. Lumping it
 * into `inWord` would be the tempting shortcut and the wrong one — an
 * unparseable pair is not evidence of anything about word position.
 *
 * No SD is produced here (nor should one be approximated from the
 * hist) for the same reason as `analyze-bigram-classes.ts`: the wire
 * entries only carry a per-pair `sd`, and re-combining per-pair SDs
 * into a per-bucket variance needs sum/sumsq, which
 * `TypingBigramTopEntry` doesn't have.
 */
export function aggregateWordPosition(
  entries: readonly TypingBigramTopEntry[],
  vialProtocol?: number,
): WordPositionAggregate {
  // Tap unwrapping only happens when the caller can name the protocol
  // the pairs were recorded under — the tap-range constants move
  // between v5 and v6 (see `tapKeycodeOf`). Without it, fall back to
  // bare separator codes: those are identical across protocols, so the
  // fallback under-counts dual-role space keys rather than guessing.
  const unwrapTaps = vialProtocol !== undefined
  return withSnapshotProtocol(vialProtocol, () => {
    const initiation = emptyHistTotal()
    const inWord = emptyHistTotal()
    let excludedCount = 0
    for (const entry of entries) {
      const pair = parseBigramId(entry.ngramId)
      if (!pair) continue
      const position = classifyWordPosition(pair.prev, pair.curr, unwrapTaps)
      if (position === 'excluded') {
        excludedCount += entry.count
        continue
      }
      const bucket = position === 'initiation' ? initiation : inWord
      bucket.count += entry.count
      foldHist(bucket.hist, entry.hist)
    }
    return { initiation, inWord, excludedCount }
  })
}

/**
 * Hand-usage classes (`aggregateBigramClasses`) restricted to in-word
 * pairs only — the counterpart of `aggregateWordPosition` for callers
 * that need the CHI 2018 Left/Right/Alternation/Repetition split, not
 * the initiation/in-word split itself. Keeps only `classifyWordPosition
 * === 'inWord'` pairs, which drops both ends of `WordPosition`'s other
 * two buckets: `initiation` pairs (the same word-initiation exclusion
 * the paper's own hand-class figures use — see `typing-benchmarks.ts`'s
 * caveat 1) AND `excluded` pairs (a pair whose `curr` key IS the
 * separator, i.e. word-terminal). The terminal exclusion is deliberate,
 * not a side effect: `KC_SPACE`/`KC_ENTER` are conventionally mapped to
 * a thumb, so folding word-terminal pairs into the left/right classes
 * would pollute whichever hand's thumb reaches the separator with a
 * disproportionate share of separator-ending pairs, the same kind of
 * distortion the initiation exclusion already guards against on the
 * other end of a word. The current consumer is the typist-cluster
 * classifier (`analyze-typist-cluster.ts`'s `typistHandIkisFromEntries`),
 * which needs each hand class's IKI comparable against
 * `BENCHMARK_LEFT_HAND_IKI_MS`/`RIGHT`/`ALTERNATION`.
 *
 * Mirrors `aggregateWordPosition`'s own protocol handling exactly:
 * `unwrapTaps` is only enabled when `vialProtocol` is known, and both
 * the word-position check and the hand-class fold run inside the same
 * `withSnapshotProtocol` scope so a dual-role space/enter key unwraps
 * against the snapshot's own protocol rather than the current session's.
 */
export function aggregateInWordBigramClasses(
  entries: readonly TypingBigramTopEntry[],
  keycodeFinger: ReadonlyMap<number, FingerType>,
  vialProtocol?: number,
): BigramClassAggregate {
  const unwrapTaps = vialProtocol !== undefined
  return withSnapshotProtocol(vialProtocol, () => {
    const inWordFilter = (pair: { prev: number; curr: number }): boolean =>
      classifyWordPosition(pair.prev, pair.curr, unwrapTaps) === 'inWord'
    return aggregateBigramClasses(entries, keycodeFinger, inWordFilter)
  })
}
