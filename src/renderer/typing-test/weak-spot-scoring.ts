// SPDX-License-Identifier: GPL-2.0-or-later

/** Pure statistics for Weak Spot Training's composite per-token weakness
 *  score — median/shrinkage math only, no history scanning or log
 *  fetching (see weak-spot-profile.ts for the orchestration that feeds
 *  this, and weak-spot-timing.ts for the interval extraction that
 *  produces the raw samples this module reduces).
 *
 *  A token is "weak" when ANY of three independent signals crosses its
 *  own threshold (user-approved 2026-08-06 revision, replacing the
 *  original fixed 200-keystroke gate; each threshold below is now
 *  user-tunable via the Weak Spot Settings modal — see
 *  weak-spot-settings.ts — the DEFAULT_* values quoted here are just the
 *  built-in starting point):
 *   - miss: aggregated mistake count >= missThreshold (default 2) — the
 *     existing, always-reliable signal (a miss unambiguously happened; no
 *     sample-size floor, unlike the two timing signals below).
 *   - slowness: this token's own median pre-token interval is at least
 *     slownessRatio (default 1.5) times the user's SCOPE-WIDE median
 *     interval (their own personal baseline, not an absolute number).
 *   - stall: at least stallRate (default 0.2) of this token's own
 *     pre-token intervals exceed stallMultiple (default 2) times the
 *     scope-wide median — a token that frequently produces a long pause,
 *     regardless of its typical speed otherwise.
 *  Median (not mean) for both timing signals: right-skewed latency
 *  distributions make the mean fragile to a handful of slow outliers,
 *  while the median stays anchored to the token's TYPICAL behavior. Both
 *  timing signals additionally require minTimingSamples (default 15)
 *  samples before being trusted at all — 5 was rejected as too noisy for
 *  a latency estimate; 15 was chosen as a firmer default floor. */

// DEFAULT_* — the built-in values every detection function falls back to
// when its caller omits a `WeakSpotScoringSettings` argument, and the
// Weak Spot Settings modal's own defaults (see weak-spot-settings.ts,
// which resolves a possibly-partial persisted config against these same
// values). Renamed from the original fixed constants (MIN_TIMING_
// OBSERVATIONS, SLOWNESS_RATIO_THRESHOLD, STALL_RATE_THRESHOLD,
// STALL_MULTIPLE, MIN_MISS_COUNT) once these became user-tunable —
// callers that still want the stock behaviour simply omit the settings
// argument rather than importing a constant directly.
export const DEFAULT_MIN_TIMING_OBSERVATIONS = 15
export const DEFAULT_SLOWNESS_RATIO_THRESHOLD = 1.5
export const DEFAULT_STALL_RATE_THRESHOLD = 0.2
export const DEFAULT_STALL_MULTIPLE = 2
export const DEFAULT_MIN_MISS_COUNT = 2

/** Every parameter the detection functions below accept, always fully
 *  resolved (no optional fields) — see weak-spot-settings.ts's
 *  `WeakSpotDetectionSettings` (the same shape; not imported directly
 *  from here to keep this module free of any config-persistence
 *  knowledge, matching its "pure statistics" module doc comment above).
 *  `missWindow`/`decayHalfLifeDays` are intentionally absent — those
 *  gate which HISTORY ROWS reach this module at all (weak-spot-profile.ts's
 *  concern), not how a single already-aggregated miss count/timing
 *  sample is scored. */
export interface WeakSpotScoringSettings {
  missThreshold: number
  slownessRatio: number
  stallRate: number
  stallMultiple: number
  minTimingSamples: number
}

export const DEFAULT_WEAK_SPOT_SCORING_SETTINGS: WeakSpotScoringSettings = {
  missThreshold: DEFAULT_MIN_MISS_COUNT,
  slownessRatio: DEFAULT_SLOWNESS_RATIO_THRESHOLD,
  stallRate: DEFAULT_STALL_RATE_THRESHOLD,
  stallMultiple: DEFAULT_STALL_MULTIPLE,
  minTimingSamples: DEFAULT_MIN_TIMING_OBSERVATIONS,
}

/** Caps the miss count's own contribution before log-scaling — mirrors
 *  word-generator/weak-spot-weighting.ts's WEAK_SPOT_SCORE_CAP precedent
 *  (a different cap, applied at a different stage: this one bounds a
 *  single TOKEN's raw miss count before it becomes part of the
 *  composite; that one bounds a whole WORD's summed weight before
 *  sampling). */
const MISS_CAP = 20

/** Scale factors bringing the (already 0..~few range) shrunk slowness/
 *  stall components into a magnitude comparable to the miss component's
 *  log1p(count) range, so neither signal structurally dominates the
 *  composite sum by construction alone. */
const SLOW_COMPONENT_SCALE = 5
const STALL_COMPONENT_SCALE = 5

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/** Empirical-Bayes-style shrinkage toward 0: an estimate backed by few
 *  observations counts for less than one backed by many, so a single
 *  low-n timing outlier can never dominate a composite score the way an
 *  established (unshrunk) mistake count can. `n0` (the pseudo-count) is
 *  the caller's `minTimingSamples` — a token sitting exactly at the
 *  n>=minTimingSamples eligibility floor has its timing contribution cut
 *  roughly in half (`n/(n+n0)` = 15/30 = 0.5 at the built-in default),
 *  rising toward 1 as observations accumulate (n=135 -> 0.9 at the
 *  default). This is what keeps a single barely-eligible noisy estimate
 *  from carrying the same weight as a well-established one. Required
 *  (no default) so every caller states its threshold explicitly — see
 *  this module's own settings-required policy at `evaluateTokenWeakness`. */
export function shrink(value: number, n: number, n0: number): number {
  return value * (n / (n + n0))
}

export interface TokenTimingStats {
  n: number
  medianIntervalMs: number
  stallRate: number
}

/** Reduces one token's raw pre-token interval sample against the
 *  scope-wide median into `{n, medianIntervalMs, stallRate}` — undefined
 *  when `n < settings.minTimingSamples` (not enough data to trust either
 *  statistic at all — the whole point of the floor). `settings` is
 *  required (no default) — every real call site already resolves the
 *  CURRENT config's settings before calling in (see
 *  weak-spot-settings.ts's `resolveWeakSpotDetectionSettings`), so an
 *  implicit fallback here would only ever mask a caller that forgot to
 *  thread the resolved value through; a test that wants the built-in
 *  defaults passes `DEFAULT_WEAK_SPOT_SCORING_SETTINGS` explicitly. */
export function computeTokenTimingStats(
  intervals: readonly number[],
  scopeMedianMs: number,
  settings: WeakSpotScoringSettings,
): TokenTimingStats | undefined {
  if (intervals.length < settings.minTimingSamples) return undefined
  const stallCount = intervals.filter((v) => v > scopeMedianMs * settings.stallMultiple).length
  return {
    n: intervals.length,
    medianIntervalMs: median(intervals),
    stallRate: stallCount / intervals.length,
  }
}

export interface TokenWeaknessVerdict {
  isWeak: boolean
  missWeak: boolean
  slowWeak: boolean
  stallWeak: boolean
  /** Composite weakness score — exactly 0 when `!isWeak` (a non-weak
   *  token never contributes to the sampling weight at all); otherwise a
   *  roughly-linear-scale value summing the miss count's own (unshrunk)
   *  contribution with the timing signals' shrunk contributions (each
   *  only present when `timing` cleared the n>=15 floor). Consumed
   *  directly as `MistakeProfile.weights[token]` — the existing
   *  word-generator/weak-spot-weighting.ts sampling machinery sums
   *  matched per-token weights per word and applies its OWN log1p+cap+
   *  length-normalization on top of that sum, so this value is
   *  deliberately left un-logged/uncapped-per-token (linear, additive
   *  across a word's tokens) rather than pre-compressed here too. */
  score: number
}

/** The composite verdict for one token, given its miss count (from the
 *  existing scope-filtered mistake aggregation) and its timing stats
 *  (undefined when there isn't enough — or any — run-log data for it,
 *  e.g. recording consent was never on). `scopeMedianMs` is the SAME
 *  value passed to `computeTokenTimingStats` for this token — re-read
 *  here only for the slowness ratio, not re-derived. */
export function evaluateTokenWeakness(
  missCount: number,
  timing: TokenTimingStats | undefined,
  scopeMedianMs: number,
  settings: WeakSpotScoringSettings,
): TokenWeaknessVerdict {
  const missWeak = missCount >= settings.missThreshold
  const slowWeak = timing !== undefined && scopeMedianMs > 0
    && timing.medianIntervalMs / scopeMedianMs >= settings.slownessRatio
  const stallWeak = timing !== undefined && timing.stallRate >= settings.stallRate
  const isWeak = missWeak || slowWeak || stallWeak
  if (!isWeak) return { isWeak, missWeak, slowWeak, stallWeak, score: 0 }

  const missComponent = missCount > 0 ? Math.log1p(Math.min(missCount, MISS_CAP)) : 0
  let slowComponent = 0
  let stallComponent = 0
  if (timing !== undefined && scopeMedianMs > 0) {
    const slowExcess = Math.max(0, timing.medianIntervalMs / scopeMedianMs - 1)
    slowComponent = shrink(slowExcess, timing.n, settings.minTimingSamples) * SLOW_COMPONENT_SCALE
    stallComponent = shrink(timing.stallRate, timing.n, settings.minTimingSamples) * STALL_COMPONENT_SCALE
  }
  return { isWeak, missWeak, slowWeak, stallWeak, score: missComponent + slowComponent + stallComponent }
}
