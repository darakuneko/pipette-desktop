// SPDX-License-Identifier: GPL-2.0-or-later
//
// Error-class breakdown (substitution / omission / insertion) for a
// finished Typing Test run, computed as a standard unit-cost Levenshtein
// alignment between each finalized word's target text and what was
// actually typed (see `run-state.ts`'s `WordResult`).
//
// TIE-BREAK IS PART OF THE CONTRACT: a Levenshtein alignment is rarely
// unique — several different edit sequences can reach the same minimal
// distance, and they don't always agree on how many of each error class
// they contain (e.g. one path might read a difference as a substitution,
// another as an omission immediately followed by an insertion). Pinning
// one deterministic choice is what makes the substitution/omission/
// insertion split reproducible at all. This module always prefers, in
// order:
//
//   1. match / substitution (diagonal move — consume one target char and
//      one typed char together)
//   2. omission (vertical move — a target char with no typed counterpart)
//   3. insertion (horizontal move — a typed char with no target
//      counterpart)
//
// whenever multiple moves tie for the minimal cost at a given cell. This
// is a deliberate content choice, not an artifact of implementation
// order: it means "read a difference as one substitution" is always
// preferred over "read it as an omission plus an unrelated insertion"
// when both explain the same distance equally well (see
// `error-classify.test.ts`'s tie-break pinning cases for concrete
// examples — different priorities produce different class splits at
// equal distance, so changing this order is a behavior change, not a
// refactor).
//
// CODE-POINT PRECISION, NOT GRAPHEME: both strings are split via
// `Array.from` (not indexed directly), so a surrogate pair (e.g. an
// emoji outside the BMP) is compared as one unit rather than being torn
// in half. This is NOT the same as full grapheme-cluster awareness,
// though: an NFD combining-mark sequence (e.g. "e" + U+0301 combining
// acute accent) is still two `Array.from` units, not one grapheme, so
// `targetChars` and the alignment itself both operate at code-point
// granularity — a documented limitation, not a bug, and the same
// precision the rest of the app's own correctness check already has
// (see `run-state.ts`'s `computeWordCharCounts`, which compares
// `typed[i] === word[i]` at the same granularity). A target/typed pair
// that's actually NFC-normalized (the common case for text typed on a
// keyboard) is unaffected either way.
//
// COMPLEXITY: O(len(target) * len(typed)) time and space per word. The
// reachable pathological direction is a long TARGET, not over-typing: a
// File Import source can hand a single "word" the length of an entire
// line (or, for line-break-free text, an entire file) when there's no
// space to break on, while `typed` is bounded by what a human actually
// typed. `classifyErrors` bails out of the DP for a target/typed pair
// whose product exceeds `MAX_DP_CELLS` — see that guard below — rather
// than ever allocating an unbounded table.
//
// ROMAJI MODE IS DELIBERATELY EXCLUDED FROM THIS CLASSIFICATION. The
// romaji engine (see `romaji-engine.ts`'s `acceptChar`/`tryConsume`, and
// `romaji-input.ts`'s `handleRomajiChar` reject branch) rejects an
// invalid keystroke outright: a rejected char is never
// appended to `romajiKeystrokes` or `currentInput`, only tallied as
// `incorrectChars`/`romajiSegmentErred`. That means the committed romaji
// text is, by construction, always one of the acceptable spellings for
// the target kana — omissions and insertions are structurally zero
// (nothing shorter or longer than a valid spelling can ever be
// committed), and the actual mistake data (which keystrokes got
// rejected) was never recorded anywhere a target/typed comparison could
// recover it. Running this Levenshtein alignment against a romaji run's
// committed text vs. its kana target would therefore not measure typing
// errors at all — it would measure incidental spelling-style differences
// (e.g. "shi" vs "si") that were never mistakes. See
// `buildTypingTestResult` in `result-builder.ts` for where this
// exclusion is actually applied at the storage boundary. A future
// `rejectedKeystrokes` counter (tallying every romaji reject, mirroring
// how `totalKeystrokes` already tallies every physical keystroke) would
// be the honest romaji counterpart to this metric — it is not
// implemented here.

import type { WordResult } from './run-state'
import type { TypingTestResult } from '../../shared/types/pipette-settings'

/** Cap on `m * n` (target length × typed length) the DP table in
 * `classifyErrors` is allowed to grow to before it bails out unclassified
 * (see that function's guard, and the module header's COMPLEXITY note).
 * 250,000 cells comfortably covers anything a human actually types
 * (e.g. a 500-char target against a 500-char typed string) while still
 * bailing out well before a pathological File Import "word" — a
 * multi-thousand-char single line with no space to break on — could
 * otherwise allocate an unbounded table. */
const MAX_DP_CELLS = 250_000

export interface ErrorClassCounts {
  substitutions: number
  omissions: number
  insertions: number
  /** Code-point length of `target` (or, for `classifyWordResults`, the Σ
   * of every finalized word's target length) — the WER/CER-style rate
   * denominator. Already computed by the Levenshtein split below, so
   * callers never need their own `Array.from(word).length`. */
  targetChars: number
}

/** Aligns `target` against `typed` with a standard unit-cost Levenshtein
 * DP (match=0, substitution/omission/insertion=1 each), then backtraces
 * from (target.length, typed.length) to (0, 0) applying the tie-break
 * priority documented above. Both empty strings yield all-zero counts;
 * an empty `typed` (a skipped word) yields `omissions === target.length`
 * with no substitutions/insertions, and vice versa for an empty `target`. */
export function classifyErrors(target: string, typed: string): ErrorClassCounts {
  const t = Array.from(target)
  const p = Array.from(typed)
  const m = t.length
  const n = p.length

  // Bail out before allocating a pathologically large DP table (see
  // MAX_DP_CELLS and the module header's COMPLEXITY note). The honest
  // fallback for an unclassifiable pair is to contribute NOTHING — not
  // just all-zero counts, but `targetChars: 0` too, so this word is
  // excluded from the rate denominator exactly like it is from the
  // numerator, rather than silently inflating `targetChars` with a
  // length nothing was actually computed against.
  if (m * n > MAX_DP_CELLS) {
    return { substitutions: 0, omissions: 0, insertions: 0, targetChars: 0 }
  }

  // dp[i][j] = edit distance between t[0:i] and p[0:j]. Row 0 / column 0
  // are the base cases: transforming into/from an empty string costs one
  // omission/insertion per remaining character.
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const match = t[i - 1] === p[j - 1]
      const diagCost = dp[i - 1][j - 1] + (match ? 0 : 1)
      const omitCost = dp[i - 1][j] + 1
      const insertCost = dp[i][j - 1] + 1
      dp[i][j] = Math.min(diagCost, omitCost, insertCost)
    }
  }

  let i = m
  let j = n
  let substitutions = 0
  let omissions = 0
  let insertions = 0

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const match = t[i - 1] === p[j - 1]
      const diagCost = dp[i - 1][j - 1] + (match ? 0 : 1)
      if (diagCost === dp[i][j]) {
        if (!match) substitutions++
        i--
        j--
        continue
      }
    }
    // Omission before insertion — see the tie-break contract above.
    if (i > 0 && dp[i - 1][j] + 1 === dp[i][j]) {
      omissions++
      i--
      continue
    }
    insertions++
    j--
  }

  return { substitutions, omissions, insertions, targetChars: m }
}

/** Run-level aggregate: sums `classifyErrors` over every finalized word
 * pair (see `WordResult` — `word` is the target, `typed` is what the user
 * actually submitted), including each word's own `targetChars` (no extra
 * `Array.from` needed — `classifyErrors` already computed it). The
 * inter-word separator is never classified — only the word text itself.
 * A skipped word (`typed === ''`) contributes `word.length` omissions and
 * nothing else, matching `classifyErrors`'s own empty-`typed` case. A
 * pathologically long word (see `MAX_DP_CELLS`) contributes nothing at
 * all, target length included — it drops out of this run's denominator
 * the same way a legacy/romaji result drops out of `sumErrorClassGroups`.
 *
 * This is a metric over FINALIZED words only: a time-bounded run's
 * in-flight final word (still sitting in `currentInput` when the clock
 * expires — see `useTypingTest.ts`'s countdown effect, which flips
 * `status` to `'finished'` without ever pushing that word into
 * `wordResults`) is excluded, the same way `wordResults` itself already
 * excludes it. */
export function classifyWordResults(wordResults: readonly WordResult[]): ErrorClassCounts {
  let substitutions = 0
  let omissions = 0
  let insertions = 0
  let targetChars = 0

  for (const { word, typed } of wordResults) {
    const counts = classifyErrors(word, typed)
    substitutions += counts.substitutions
    omissions += counts.omissions
    insertions += counts.insertions
    targetChars += counts.targetChars
  }

  return { substitutions, omissions, insertions, targetChars }
}

/** Read-side counterpart of `sanitizeErrorClassFields`
 * (`typing-test-result-sanitize.ts`): the same all-or-nothing group,
 * read back off an already-sanitized `TypingTestResult`. `null` unless
 * all four raw fields are actually numbers — a result missing any one of
 * them (romaji run, pre-error-class-tracking result, or a run with no
 * finalized words) has nothing to report, and `typeof !== 'number'`
 * (rather than an `=== undefined` check) also catches a `null`/string
 * smuggled through by hand-edited or malformed JSON, which `=== undefined`
 * alone would let through and hand callers a non-number. Every
 * aggregation site (the History Error mix section, the Analyze Typing
 * Profile card, the finish screen's error-class line) folds over this
 * instead of hand-rolling the same four-field check. */
export function errorClassGroup(r: TypingTestResult): ErrorClassCounts | null {
  if (
    typeof r.errorSubstitutions !== 'number'
    || typeof r.errorOmissions !== 'number'
    || typeof r.errorInsertions !== 'number'
    || typeof r.errorTargetChars !== 'number'
  ) return null
  return {
    substitutions: r.errorSubstitutions,
    omissions: r.errorOmissions,
    insertions: r.errorInsertions,
    targetChars: r.errorTargetChars,
  }
}

/** Char-weighted Σ over every result carrying the 4-field group (see
 * `errorClassGroup`) — never a plain average of each run's own rate (a
 * handful of short runs would otherwise skew the figure as much as one
 * long session). Results missing the group are silently excluded, not
 * treated as zero. `null` when nothing in the set qualifies:
 * `targetChars` is always positive for any single qualifying result (see
 * `sanitizeErrorClassFields`'s division-by-zero guard), so a positive Σ
 * `targetChars` is equivalent to "at least one result qualified" — no
 * separate found-anything flag needed. Shared by `ErrorMixSection`
 * (History) and `TypingProfileCard` (Analyze) so the two don't each
 * hand-roll the same fold. */
export function sumErrorClassGroups(results: readonly TypingTestResult[]): ErrorClassCounts | null {
  let substitutions = 0
  let omissions = 0
  let insertions = 0
  let targetChars = 0
  for (const r of results) {
    const group = errorClassGroup(r)
    if (!group) continue
    substitutions += group.substitutions
    omissions += group.omissions
    insertions += group.insertions
    targetChars += group.targetChars
  }
  return targetChars > 0 ? { substitutions, omissions, insertions, targetChars } : null
}
