// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Interval > TAPPING_TERM advisor — Pipette-only diagnosis
// that checks whether a keyboard's configured TAPPING_TERM (the QMK
// tap/hold decision window) fits the user's own measured keypress
// durations on its tap-hold keys (LT / MT / SH_T).
//
// Observation-structure facts that drive every decision below:
//
// 1. The 8-bucket duration histogram (shared/duration-buckets.ts)
//    records physical hold time — press-to-release — independent of
//    however the capture layer classified a given press as tap or
//    hold at record time. That means splitting the *blended*
//    histogram at the CURRENT TAPPING_TERM (call it T) is well
//    defined: every bucket fully below T is genuinely tap-side data,
//    every bucket fully at/above T is genuinely hold-side data, and
//    at most one bucket straddles T itself (its bounds don't align to
//    the fixed grid) and cannot be assigned to either side.
//
// 2. The tap/hold COUNTS the analytics pipeline already recorded per
//    cell were classified against whatever TAPPING_TERM was live at
//    record time, not the term in effect now — and the term the user
//    had at any given moment isn't recoverable from the stored data.
//    Those counts are therefore supporting context only (the UI shows
//    them next to this card) and never feed the verdict here.
//
// 3. Right-censoring: an intended tap that was physically held past T
//    lands on the hold side of whatever was recorded. `tapP95` (the
//    95th percentile of the sub-T mass) is therefore a lower-biased
//    estimate of the true tap-duration p95 — the genuinely slow taps
//    that got censored into "hold" are invisible to it. The guard
//    against relying on that bias is structural, not statistical: if
//    the buckets between the observed tap p95 and T carry essentially
//    no mass, there's nothing sizeable for T to be censoring in the
//    first place.
//
// Every sample-floor and mass-share guard below denominates against
// TAP-SIDE (+ straddle) mass, never the blended total: a hold-heavy
// key (most presses genuinely long, tap-hold used almost only to
// reach a layer) can easily clear a *blended* sample floor on hold
// mass alone while its actual tap-side evidence is a handful of
// presses, and the same hold mass sitting in the denominator dilutes
// the censoring-guard share arbitrarily low. Denominating against
// tap-side(+straddle) mass instead means the floor and both share
// guards only ever look at the population the verdict is actually
// making a claim about.
//
// Because a histogram bucket is the finest resolution this data has,
// a percentile can only ever be pinned to the bucket it falls in, not
// to a single ms value — so every percentile here is reported as a
// {lo, hi} RANGE (lo = as if all of that bucket's mass sat at its
// lower edge, hi = as if it all sat at its upper edge; the open top
// bucket uses the same synthetic span DURATION_BUCKET_CENTERS_MS
// assumes: centered on 600ms, so [400, 800)).
//
// Verdicts are deliberately merged down from the original task spec's
// four-way split (ok / tooLong / tooShort / overlapping). A follow-up
// statistical-honesty review found `tooShort` and `overlapping` to be
// causally indistinguishable from this data — both describe "mass
// sits close to T on either side", which is exactly the one ambiguous
// bucket fact #1 above describes — so they're one verdict, `nearTerm`,
// here. `tooLong` survives as `canLower`, reframed as a candidate
// derived from observed data rather than a safety guarantee: nothing
// about a histogram can prove a specific new TAPPING_TERM is safe, so
// this only ever suggests a value strictly below both the observed
// tap ceiling and the observed hold floor, AND still at least a full
// margin above the observed tap p95 (a suggestion clamping has eaten
// into isn't a candidate worth showing — see `analyzeTappingTerm`'s
// `preservesMargin` check), and the caller must never wire it to an
// auto-apply path.
//
// `unknown` itself has three causally distinct roots — too little
// tap-side data to say anything, no tap-side data to diagnose at all,
// and a p95 that falls in the one bucket bucket resolution can't
// resolve against the margin — each surfaced via `unknownReason` so
// the copy can name the actual cause instead of a generic "not enough
// data" that would be false for two of the three.

import {
  DURATION_BUCKET_SYNTHETIC_TOP_UPPER_MS,
  DURATION_BUCKET_UPPER_BOUNDS_MS,
  durationBucketLowerBoundMs,
} from '../../../shared/duration-buckets'

export type TappingTermVerdict = 'unknown' | 'ok' | 'canLower' | 'nearTerm'

export type TappingTermUnknownReason = 'insufficientSamples' | 'noTapMass' | 'bucketResolution'

export interface PercentileRangeMs {
  lo: number
  hi: number
}

export interface TappingTermAdvice {
  verdict: TappingTermVerdict
  /** Non-null exactly when `verdict === 'unknown'` — see the module
   * header on why one generic "unknown" copy would misstate two of the
   * three causes. */
  unknownReason: TappingTermUnknownReason | null
  /** 95th percentile of the sub-T ("tap side") mass, as a bucket
   * range. `null` when there's no sub-T mass to compute from (either
   * the sample floor wasn't met, or literally every recorded duration
   * for these cells sits at or above the current term). */
  tapP95Range: PercentileRangeMs | null
  /** 5th percentile of the at/above-T ("hold side") mass, as a bucket
   * range. `null` when there's no hold-side mass — a keyboard where
   * every tap-hold press so far has resolved as a tap has nothing to
   * report here, and `canLower` treats that as "hold side absent"
   * rather than blocking the suggestion. */
  holdP5Range: PercentileRangeMs | null
  currentMs: number
  /** Candidate new TAPPING_TERM, only ever populated for `canLower`.
   * Always strictly below both `currentMs` and `holdP5Range.lo` (when
   * present), and never less than a full margin above `tapP95Range.hi`
   * — see the module header on why this is a candidate, not a
   * guarantee. */
  suggestedMs: number | null
}

/** Below this many aggregated duration samples on the TAP side (the
 * sub-T mass, plus the one bucket straddling T if any — never the
 * blended tap+hold total), every bucket count is too thin to split
 * into a tap-side percentile without the estimate being dominated by
 * noise. Mirrors the floor style of `analyze-typing-profile.ts`
 * (`SPEED_MIN_KEYSTROKES`, `BIGRAM_MIN_COUNT`): picked so a handful of
 * stray presses can't produce a confident-looking verdict — including
 * when a hold-heavy key's hold-side volume alone would otherwise clear
 * a floor denominated against the blended total. */
export const TAPPING_TERM_MIN_SAMPLES = 200

/** Safety margin (ms) subtracted from the current TAPPING_TERM before
 * comparing it to the observed tap p95, and added to the observed tap
 * p95 when proposing a new term. Bucket-width scale: below the width
 * of every closed bucket (30-70ms) so a bucket that fully clears the
 * margin is unambiguous, yet large enough that a suggested term isn't
 * proposed flush against the very edge of the observed data. */
const TAPPING_TERM_MARGIN_MS = 30

/** Share of tap-side(+straddle) mass that must sit in the single
 * bucket straddling the current term before that mass counts as
 * "significant" evidence of tap/hold overlap (`nearTerm`), rather than
 * noise. */
const TAPPING_TERM_NEAR_TERM_SHARE = 0.05

/** Share of tap-side(+straddle) mass allowed in the gap between the
 * observed tap p95 and the current term before that gap no longer
 * counts as "near-zero" for the `canLower` censoring guard. Strictly
 * below `TAPPING_TERM_NEAR_TERM_SHARE` on purpose: a gap can fail this
 * stricter bar (blocking a numeric suggestion) well before it's thick
 * enough to call `nearTerm` outright — see the "mass just below T"
 * scenario in the test file. */
const TAPPING_TERM_CLEAN_GAP_SHARE = 0.01

/** Suggested terms are rounded to this many ms so the card never
 * proposes an oddly specific value like "173ms". */
const TAPPING_TERM_SUGGESTION_ROUND_MS = 5

/** Displayable upper bound for a percentile range — the shared
 * synthetic span for the open top bucket, the true bound otherwise.
 * Never use this to classify a bucket against the current term (see
 * `splitAtTerm`); the true upper bound of the open bucket is
 * unbounded. */
function rangeUpperBoundMs(bucketIndex: number): number {
  const upper = DURATION_BUCKET_UPPER_BOUNDS_MS[bucketIndex]
  return Number.isFinite(upper) ? upper : DURATION_BUCKET_SYNTHETIC_TOP_UPPER_MS
}

interface TermSplit {
  /** Index of the first bucket not fully below the term — buckets
   * `[0, firstAtOrAboveIdx)` are unambiguously tap-side (fact #1). */
  firstAtOrAboveIdx: number
  /** Index of the bucket straddling the term, or `null` when the term
   * lands exactly on a bucket boundary and nothing straddles. Bucket
   * bounds are monotonic and non-overlapping, so at most one bucket
   * can straddle a given term. */
  straddleIdx: number | null
}

/** Finds where the current term falls in the fixed bucket grid. A
 * single pass: bucket bounds only increase with index, so the first
 * bucket whose upper bound clears the term is also the only candidate
 * for straddling it (or the first fully-at-or-above bucket, if the
 * term lands exactly on a boundary). */
function splitAtTerm(currentMs: number): TermSplit {
  const bucketCount = DURATION_BUCKET_UPPER_BOUNDS_MS.length
  for (let i = 0; i < bucketCount; i += 1) {
    const upper = DURATION_BUCKET_UPPER_BOUNDS_MS[i]
    if (upper <= currentMs) continue
    const straddles = durationBucketLowerBoundMs(i) < currentMs
    return { firstAtOrAboveIdx: i, straddleIdx: straddles ? i : null }
  }
  return { firstAtOrAboveIdx: bucketCount, straddleIdx: null }
}

function sumRange(hist: readonly number[], startIdx: number, endIdx: number): number {
  let total = 0
  for (let i = startIdx; i < endIdx; i += 1) total += hist[i] ?? 0
  return total
}

interface PercentileResult {
  range: PercentileRangeMs
  bucketIndex: number
}

/** Finds the bucket a percentile falls in among the half-open bucket
 * range `[startIdx, endIdx)` and returns that bucket's range. `null`
 * when the range carries no mass at all — there is nothing to report
 * a percentile of. */
function percentileInRange(
  hist: readonly number[],
  startIdx: number,
  endIdx: number,
  fraction: number,
): PercentileResult | null {
  const total = sumRange(hist, startIdx, endIdx)
  if (total <= 0) return null

  const target = fraction * total
  const toResult = (i: number): PercentileResult =>
    ({ range: { lo: durationBucketLowerBoundMs(i), hi: rangeUpperBoundMs(i) }, bucketIndex: i })

  let cumulative = 0
  // Stop one short of the last bucket in range: the remaining mass
  // (total - cumulative so far) is guaranteed >= target once every
  // earlier bucket has failed the check, since `target <= total` by
  // construction — the last bucket always qualifies, so there is no
  // "not found" case left for a fallback to handle.
  for (let i = startIdx; i < endIdx - 1; i += 1) {
    cumulative += hist[i] ?? 0
    if (cumulative >= target) return toResult(i)
  }
  return toResult(endIdx - 1)
}

function roundToStep(value: number, step: number): number {
  return Math.round(value / step) * step
}

/** Pulls `value` strictly below `boundExclusive`, floored to the
 * largest multiple of `step` that still clears it — not just
 * `boundExclusive - step`, which only happens to be a `step` multiple
 * when `boundExclusive` itself is one (e.g. `boundExclusive=173,
 * step=5` must floor to 170, not the non-multiple 168). */
export function clampBelowStrict(value: number, boundExclusive: number, step: number): number {
  if (value < boundExclusive) return value
  const floored = Math.floor(boundExclusive / step) * step
  return floored < boundExclusive ? floored : floored - step
}

/**
 * Diagnoses a keyboard's TAPPING_TERM against its own measured
 * keypress durations on tap-hold keys.
 *
 * @param hist Aggregated duration histogram (shared 8-bucket grid)
 *   across every tap-hold cell (LT/MT/SH_T) in the selected range —
 *   the caller identifies which cells qualify (see
 *   `analyze-tapping-term-cells.ts`) and sums their `TypingDurationCell.hist`.
 * @param currentMs The TAPPING_TERM currently in effect (or the
 *   assumed QMK default when the keyboard doesn't report it).
 *
 * Deliberately does NOT take tap/hold press counts — see the module
 * header fact #2 on why those can never inform a verdict; the caller
 * fetches and displays them as separate, unrelated context. Also does
 * NOT take a separate blended total: every guard below denominates
 * against tap-side(+straddle) mass, derived from `hist` itself — a
 * blended total would only invite denominating against the wrong
 * population again (see the module header).
 */
export function analyzeTappingTerm(
  hist: readonly number[],
  currentMs: number,
): TappingTermAdvice {
  const { firstAtOrAboveIdx, straddleIdx } = splitAtTerm(currentMs)
  const bucketCount = DURATION_BUCKET_UPPER_BOUNDS_MS.length
  const holdStartIdx = straddleIdx !== null ? firstAtOrAboveIdx + 1 : firstAtOrAboveIdx

  const belowMass = sumRange(hist, 0, firstAtOrAboveIdx)
  const straddleMass = straddleIdx !== null ? (hist[straddleIdx] ?? 0) : 0
  const tapSideMass = belowMass + straddleMass

  if (tapSideMass < TAPPING_TERM_MIN_SAMPLES) {
    return {
      verdict: 'unknown',
      unknownReason: 'insufficientSamples',
      tapP95Range: null,
      holdP5Range: null,
      currentMs,
      suggestedMs: null,
    }
  }

  const tapP95 = percentileInRange(hist, 0, firstAtOrAboveIdx, 0.95)
  const holdP5 = percentileInRange(hist, holdStartIdx, bucketCount, 0.05)
  const holdP5Range = holdP5?.range ?? null

  if (tapP95 === null) {
    // No sub-T mass at all — every recorded duration for these cells
    // already sits at or above the current term (or in the straddle
    // bucket, whose mass alone was enough to clear the floor above).
    // Nothing to diagnose the tap side from.
    return {
      verdict: 'unknown',
      unknownReason: 'noTapMass',
      tapP95Range: null,
      holdP5Range,
      currentMs,
      suggestedMs: null,
    }
  }
  const tapP95Range = tapP95.range

  const done = (
    verdict: TappingTermVerdict,
    suggestedMs: number | null = null,
    unknownReason: TappingTermUnknownReason | null = null,
  ): TappingTermAdvice => ({ verdict, unknownReason, tapP95Range, holdP5Range, currentMs, suggestedMs })

  if (straddleMass / tapSideMass >= TAPPING_TERM_NEAR_TERM_SHARE) {
    // Significant mass sits in the one bucket that straddles the
    // term itself — by fact #1, this mass can't be told apart as
    // "long taps" vs "fast holds". That ambiguity is the finding.
    return done('nearTerm')
  }

  const thresholdMs = currentMs - TAPPING_TERM_MARGIN_MS
  if (tapP95Range.hi > thresholdMs) {
    // Does not clear the margin. Whether that's confident (`nearTerm`)
    // or ambiguous (`unknown`) depends on where the range's optimistic
    // (lo) edge falls: if it's already past the threshold too, the
    // true p95 can't clear the margin either way; if not, the bucket
    // holding the true p95 straddles the ok/nearTerm boundary itself,
    // and bucket resolution can't say which side it's really on.
    return tapP95Range.lo >= thresholdMs ? done('nearTerm') : done('unknown', null, 'bucketResolution')
  }

  // Clears the margin. Whether that's a `canLower` candidate depends
  // on the censoring guard: the gap between where tap mass effectively
  // ended and the term itself must be close to empty, or a lowered
  // term would just start right-censoring those in-between presses.
  let gapMass = straddleMass
  for (let i = tapP95.bucketIndex + 1; i < firstAtOrAboveIdx; i += 1) gapMass += hist[i] ?? 0
  const gapShare = gapMass / tapSideMass

  if (gapShare < TAPPING_TERM_CLEAN_GAP_SHARE) {
    const rawSuggestion = tapP95Range.hi + TAPPING_TERM_MARGIN_MS
    const rounded = roundToStep(rawSuggestion, TAPPING_TERM_SUGGESTION_ROUND_MS)
    const suggestedMs = clampBelowStrict(rounded, currentMs, TAPPING_TERM_SUGGESTION_ROUND_MS)
    // Clamping only ever pulls the suggestion down — if it pulled it
    // down far enough to eat into the very margin the `clears`
    // decision above relied on, this is no longer a candidate worth
    // showing: it would contradict the safety margin the verdict
    // itself is built on. Fall through to `ok` rather than round the
    // margin away.
    const preservesMargin = suggestedMs >= tapP95Range.hi + TAPPING_TERM_MARGIN_MS
    const holdOk = holdP5Range === null || holdP5Range.lo - suggestedMs >= TAPPING_TERM_MARGIN_MS
    if (preservesMargin && holdOk) return done('canLower', suggestedMs)
  }

  return done('ok')
}
