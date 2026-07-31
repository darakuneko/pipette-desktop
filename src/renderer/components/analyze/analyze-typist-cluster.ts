// SPDX-License-Identifier: GPL-2.0-or-later
// Analyze > Summary > Typing Profile — "Typing style" cell. Classifies
// a user's recent typing against the 8 typist-cluster profiles in
// `shared/typing-benchmarks.ts` (`TYPIST_CLUSTER_CENTROIDS`) by nearest
// centroid over a handful of z-scored summary measures.
//
// THIS IS AN APPROXIMATION, not a reproduction of the paper's own
// clustering. The paper's 8 clusters were produced by PAM clustering
// over 38 frequent bigrams' per-participant *mean-normalized* IKIs (each
// bigram's IKI divided by that participant's own mean IKI) — a 38-
// dimensional fingerprint of relative typing rhythm. Performance
// measures (WPM, error rate, ...) were deliberately excluded from that
// feature space. What this module does instead is nearest-centroid
// matching against Table 4's *summary statistics* for each of those
// resulting clusters (WPM / IKI / hand-class IKI / error rates / KSPC) —
// a much lower-dimensional, much coarser comparison than the paper's
// own. It answers "which cluster's typical profile does this look most
// like", not "which of the paper's 38-dimensional rhythm fingerprints is
// this closest to".
//
// EXCLUDED DIMENSIONS. `rolloverPct` and `uncorrectedErrorPct` exist on
// `TypistClusterCentroid` (mirroring Table 4 1:1 — see that interface's
// doc comment in `typing-benchmarks.ts` for the transcription
// provenance) but never enter the distance computation here:
//  - `rolloverPct`: this app's own observed rollover rate is
//    structurally lower than the paper's true rate (sampling-rate
//    ceiling — see the rollover UI's own caveat), so comparing it
//    against Table 4's rollover column would systematically pull every
//    user toward the low-rollover clusters regardless of their actual
//    typing style.
//  - `uncorrectedErrorPct`: double-counts information already carried
//    by the three error-class dimensions (it's the union of
//    substitution/omission/insertion incidents, not a fourth
//    independent measure), and the paper computes it with a different
//    estimator than the per-class rates use — folding both into one
//    RMS distance would overweight the error dimension twice with two
//    different, not-quite-comparable numbers.
//
// NO COVARIANCE MODELING. Distance is a plain per-dimension z-score RMS
// (root-mean-square), not a Mahalanobis distance against Table 4's own
// (unreported) covariance structure. Concretely, this means the four
// IKI-family dimensions (overall IKI + left/right/alternation hand-class
// IKI) are highly correlated in real typing data — a fast typist's
// overall IKI and their three hand-class IKIs will almost always move
// together — but each is still weighted as an independent dimension in
// the RMS. That's a deliberate simplification, not an oversight: those
// four dimensions collectively (and intentionally) pull the match toward
// "does this user's rhythm look like this cluster's rhythm" more than
// KSPC or any single error-class rate would on its own, which lines up
// with rhythm being the paper's actual clustering axis (see above).
//
// FILTER ASYMMETRY. The WPM/IKI/hand-class-IKI dimensions are built from
// the bigram aggregate and daily-summary IPCs, which honor the caller's
// Device/App scope filters exactly like every other Analyze chart. The
// error-rate and KSPC dimensions come from saved Typing Test History
// (`sumErrorClassGroups`, `computeKspc`), which — like the rest of the
// Typing Profile card's KSPC and Error mix cells — has no per-device or
// per-app breakdown to filter against and always reflects the full
// window regardless of scope. A classification can therefore mix a
// device-scoped rhythm reading with an unscoped error/KSPC reading.
//
// BUCKET-CENTER IKI. `ikiMs` and the three hand-class IKIs are derived
// from `avgIkiFromHist`, which estimates an average from 8 coarse
// histogram buckets rather than raw per-pair samples (see
// `analyze-bigram-heatmap.ts`) — the same approximation every other IKI
// figure on this card and the Bigrams charts already carries.
//
// COPY VS TABLE. The i18n context lines for clusters 2 and 3
// (`typistCluster.2.context` / `.3.context`) describe cluster 2 as having
// "pronounced" hand alternation and cluster 3 as merely "typical" —
// that distinction follows the source paper's own qualitative cluster
// labels ("SLOW CARELESS HAND ALTERNATORS" vs "AVERAGE-BUT-ERROR-PRONE"
// — see the `//` comments on `TYPIST_CLUSTER_CENTROIDS`'s rows), not a
// numeric difference in Table 4's alternation figures: computed as
// alternationIkiMs / avg(leftIkiMs, rightIkiMs), clusters 2 and 3 land
// at ~0.855 and ~0.858 respectively — numerically indistinguishable. Do
// not "fix" that copy to match the ratio; it's already matching the
// paper's own characterization instead.

import { classAvgOrNull } from './analyze-bigram-classes'
import { emptyHistTotal, foldHist } from './analyze-bigram-heatmap'
import { aggregateInWordBigramClasses } from './analyze-bigram-word-position'
import { benchmarkZ } from './analyze-benchmark'
import type { FingerType } from '../../../shared/kle/kle-ergonomics'
import type { TypingBigramTopEntry } from '../../../shared/types/typing-analytics'
import {
  BENCHMARK_WPM,
  BENCHMARK_IKI_MS,
  BENCHMARK_LEFT_HAND_IKI_MS,
  BENCHMARK_RIGHT_HAND_IKI_MS,
  BENCHMARK_ALTERNATION_IKI_MS,
  BENCHMARK_SUBSTITUTION_RATE_PCT,
  BENCHMARK_OMISSION_RATE_PCT,
  BENCHMARK_INSERTION_RATE_PCT,
  BENCHMARK_KSPC,
  TYPIST_CLUSTER_CENTROIDS,
  type BenchmarkStat,
  type TypistClusterCentroid,
  type TypistClusterId,
} from '../../../shared/typing-benchmarks'

export type TypistDimension =
  | 'wpm'
  | 'ikiMs'
  | 'leftIkiMs'
  | 'rightIkiMs'
  | 'alternationIkiMs'
  | 'substitutionPct'
  | 'omissionPct'
  | 'insertionPct'
  | 'kspc'

/** Inputs the classifier can use, one optional field per
 * {@link TypistDimension} — derived from `TypistClusterCentroid` itself
 * so a feature name can never drift from the centroid column it's
 * compared against. `undefined` means the dimension is missing (not
 * enough sample, no finger map, no qualifying History results, ...)
 * rather than a real zero — every dimension here is a rate or a
 * duration where 0 would be a meaningful, very different value. The
 * error trio (substitutionPct/omissionPct/insertionPct) is all-or-
 * nothing by construction upstream — they're read off one
 * `sumErrorClassGroups` result, which is itself null unless all four
 * raw fields are present — so in practice a caller either has all three
 * or none. This type still declares each independently optional because
 * the classifier itself has no reason to assume that upstream
 * invariant; it treats each dimension exactly like any other optional
 * one. */
export type TypistFeatures = Partial<Pick<TypistClusterCentroid, TypistDimension>>

/** Above this RMS z-distance, the nearest centroid is still too far to
 * call a match — the user's profile doesn't resemble any of the 8
 * clusters closely enough to be worth naming. */
export const TYPIST_MAX_MATCH_RMS = 2

/** Minimum RMS z-distance gap required between the best and second-best
 * centroid before a match is reported; below this the two are treated as
 * indistinguishable ('ambiguous'). This exists to catch genuinely-
 * equidistant inputs (see the "returns noMatch/ambiguous for an input
 * exactly equidistant..." test) — it is NOT meant to make "ambiguous" a
 * common outcome for ordinary users.
 *
 * MUST stay below the minimum pairwise centroid separation over EVERY
 * supported dimension subset a caller can present (a subset is
 * `wpm` + `ikiMs` + 2-or-3 of the hand-IKI trio, optionally plus the
 * error trio and/or `kspc` — see `hasRequiredCore`). That minimum is
 * dimension-subset dependent, not a single fixed number: fewer
 * dimensions in the RMS means fewer chances for the centroids to
 * diverge, so the tightest separation shows up on the smallest legal
 * subsets. The tightest of all is ~0.0228, between clusters 3 and 4 on
 * `wpm` + `ikiMs` + `leftIkiMs` + `alternationIkiMs` (no error trio, no
 * kspc) — the left+alternation hand-pair core. Set this constant any
 * higher than that and a real user whose rhythm sits between clusters 3
 * and 4 would be classified 'ambiguous' even when they match one of the
 * two almost exactly, and every 2-of-3 hand-IKI subset without the error
 * trio would be liable to the same failure. The self-classification test
 * in this module's test file iterates every supported subset, asserts
 * every centroid still classifies to itself as 'matched' on each one,
 * and independently computes the minimum pairwise separation across all
 * of them to assert this constant stays strictly below it — so a future
 * change to `TYPIST_CLUSTER_CENTROIDS` or this constant that breaks the
 * invariant fails the test outright rather than silently degrading. */
export const TYPIST_MIN_MARGIN_RMS = 0.01

export type TypistClassification =
  | { kind: 'unknown'; reason: 'missingCore' }
  | { kind: 'noMatch'; reason: 'tooFar' | 'ambiguous' }
  | {
    kind: 'matched'
    clusterId: TypistClusterId
    distance: number
    /** 'full' when all three error-rate dimensions (substitution /
     * omission / insertion) were present on the input `TypistFeatures`,
     * 'rhythmOnly' otherwise. Lets the card pick between
     * `typistClusterDesc` and `typistClusterDescNoError` without
     * re-deriving the same all-or-nothing check the module doc already
     * describes for the error trio. */
    basis: 'full' | 'rhythmOnly'
  }

/** The population `BenchmarkStat` each {@link TypistDimension} is
 * z-scored against before comparison — one entry per dimension.
 * `rolloverPct`/`uncorrectedErrorPct` are deliberately absent (see the
 * module doc) because they aren't `TypistDimension` members at all.
 * Typed as `Record<TypistDimension, BenchmarkStat>` rather than an
 * array of `{key, stat}` pairs on purpose: adding a member to
 * `TypistDimension` without adding its stat here fails to compile
 * instead of silently classifying with one fewer dimension than the
 * type promises. */
const DIMENSION_STATS: Readonly<Record<TypistDimension, BenchmarkStat>> = {
  wpm: BENCHMARK_WPM,
  ikiMs: BENCHMARK_IKI_MS,
  leftIkiMs: BENCHMARK_LEFT_HAND_IKI_MS,
  rightIkiMs: BENCHMARK_RIGHT_HAND_IKI_MS,
  alternationIkiMs: BENCHMARK_ALTERNATION_IKI_MS,
  substitutionPct: BENCHMARK_SUBSTITUTION_RATE_PCT,
  omissionPct: BENCHMARK_OMISSION_RATE_PCT,
  insertionPct: BENCHMARK_INSERTION_RATE_PCT,
  kspc: BENCHMARK_KSPC,
}

/** Iteration order doesn't matter to the RMS math below (it's a sum of
 * squares), so a plain `Object.keys` cast is fine here — the
 * compile-time exhaustiveness guarantee comes from `DIMENSION_STATS`'s
 * `Record` type above, not from this list. */
const ALL_TYPIST_DIMENSIONS = Object.keys(DIMENSION_STATS) as TypistDimension[]

/** Required-core gate: `wpm` and `ikiMs` must both be present, plus at
 * least 2 of the 3 hand-class IKIs. Below this floor there isn't enough
 * of a rhythm-and-pace reading to name a cluster at all — see the
 * module doc's "NO COVARIANCE MODELING" note on why the IKI family
 * carries most of the signal here. */
function hasRequiredCore(features: TypistFeatures): boolean {
  if (features.wpm === undefined || features.ikiMs === undefined) return false
  const handIkiCount = [features.leftIkiMs, features.rightIkiMs, features.alternationIkiMs]
    .filter((v) => v !== undefined).length
  return handIkiCount >= 2
}

/**
 * Nearest-centroid classification against `TYPIST_CLUSTER_CENTROIDS`
 * (see the module doc for what this comparison is and isn't). Every
 * dimension present on `features` is z-scored against its population
 * `BenchmarkStat` and compared to the same centroid's z-scored value;
 * the distance to a given centroid is the RMS (root-mean-square) of
 * those per-dimension differences over however many dimensions are
 * available — RMS rather than a plain sum so the distance scale stays
 * comparable regardless of how many optional dimensions a given caller
 * happened to supply. Centroid spread is not used to rescale distance
 * (that would inflate near-invariant dimensions like KSPC, whose
 * centroids barely differ from each other, into outsized influence).
 */
export function classifyTypist(features: TypistFeatures): TypistClassification {
  if (!hasRequiredCore(features)) {
    return { kind: 'unknown', reason: 'missingCore' }
  }

  // Single pass over every known dimension: only the ones actually
  // present on `features` enter `used`, each carrying its own stat
  // (needed to z-score every centroid below) alongside the user's own
  // z-score, computed once rather than re-derived per centroid.
  const used: { key: TypistDimension; stat: BenchmarkStat; z: number }[] = []
  for (const key of ALL_TYPIST_DIMENSIONS) {
    const value = features[key]
    if (value === undefined) continue
    const stat = DIMENSION_STATS[key]
    used.push({ key, stat, z: benchmarkZ(value, stat) })
  }

  const ranked = TYPIST_CLUSTER_CENTROIDS
    .map((centroid) => {
      let sumSq = 0
      for (const { key, stat, z } of used) {
        const diff = z - benchmarkZ(centroid[key], stat)
        sumSq += diff * diff
      }
      return { centroid, distance: Math.sqrt(sumSq / used.length) }
    })
    .sort((a, b) => a.distance - b.distance)

  // TYPIST_CLUSTER_CENTROIDS always has 8 rows, so `ranked` always has
  // at least a best and a runner-up — no undefined guard needed.
  const [best, runnerUp] = ranked

  if (best.distance > TYPIST_MAX_MATCH_RMS) {
    return { kind: 'noMatch', reason: 'tooFar' }
  }
  if (runnerUp.distance - best.distance < TYPIST_MIN_MARGIN_RMS) {
    return { kind: 'noMatch', reason: 'ambiguous' }
  }
  return {
    kind: 'matched',
    clusterId: best.centroid.id,
    distance: best.distance,
    basis: features.substitutionPct !== undefined
      && features.omissionPct !== undefined
      && features.insertionPct !== undefined
      ? 'full'
      : 'rhythmOnly',
  }
}

/** Overall avg IKI across every recorded bigram, no word-position
 * filter — the counterpart of `BENCHMARK_IKI_MS`, which is also an
 * all-pairs figure (unlike the hand-class constants). `undefined` below
 * `BIGRAM_MIN_COUNT` samples (the floor `classAvgOrNull` applies),
 * matching the sample floor every other Typing Profile classifier
 * uses. */
export function typistIkiFromEntries(entries: readonly TypingBigramTopEntry[]): number | undefined {
  const total = emptyHistTotal()
  for (const entry of entries) {
    total.count += entry.count
    foldHist(total.hist, entry.hist)
  }
  return classAvgOrNull(total) ?? undefined
}

export interface TypistHandIkis {
  leftIkiMs?: number
  rightIkiMs?: number
  alternationIkiMs?: number
}

/** Hand-class avg IKIs (left / right / alternation — repetition isn't a
 * dimension Table 4 exposes) restricted to in-word pairs, the same
 * word-initiation exclusion the paper's own hand-class figures apply
 * (see `typing-benchmarks.ts`'s caveat 1) — the counterpart of
 * `BENCHMARK_LEFT_HAND_IKI_MS`/`RIGHT`/`ALTERNATION`. Delegates the
 * word-position filtering, protocol scoping, and per-class fold entirely
 * to `aggregateInWordBigramClasses`; this function only applies the
 * `BIGRAM_MIN_COUNT` sample floor (via `classAvgOrNull`) to each
 * resulting class. An empty `keycodeFinger` map (no snapshot/keymap
 * available) returns all three as `undefined` without doing any work. */
export function typistHandIkisFromEntries(
  entries: readonly TypingBigramTopEntry[],
  keycodeFinger: ReadonlyMap<number, FingerType>,
  vialProtocol?: number,
): TypistHandIkis {
  if (keycodeFinger.size === 0) return {}

  const { totals } = aggregateInWordBigramClasses(entries, keycodeFinger, vialProtocol)
  return {
    leftIkiMs: classAvgOrNull(totals.left) ?? undefined,
    rightIkiMs: classAvgOrNull(totals.right) ?? undefined,
    alternationIkiMs: classAvgOrNull(totals.alternation) ?? undefined,
  }
}
