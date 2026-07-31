// SPDX-License-Identifier: GPL-2.0-or-later
// Population reference statistics for the Analyze benchmark overlay.
//
// Source: Dhakal, Feit, Kristensson, Oulasvirta, "Observations on Typing
// from 136 Million Keystrokes", CHI 2018, DOI 10.1145/3173574.3174220 —
// 168,960 participants. Every mean/SD pair below was transcribed from
// Table 3 (p.5) and the Typist Groups definition (p.4) of that paper and
// verified against the PDF.
//
// Two caveats future consumers must not miss:
//
//  1. The four hand-class IKI values (left-hand / right-hand /
//     alternation / letter-repetition) were computed by the paper
//     *after excluding word-initiation bigrams* (a letter following a
//     space). This app's hand-class quadrant does not exclude those, so
//     the two are not directly comparable as-is. A consumer that wants
//     to compare against these four constants must first apply the same
//     exclusion — use
//     `renderer/components/analyze/analyze-bigram-word-position.ts`'s
//     `aggregateInWordBigramClasses`, the canonical helper that folds
//     bigram entries into hand-usage classes restricted to
//     `classifyWordPosition(...) === 'inWord'` pairs. Do not wire these
//     four constants into a chart that skips that filter.
//
//     `inWord` also excludes word-TERMINAL bigrams (a pair whose
//     *current* key is the separator, ending a word) in addition to
//     word-initiation ones — deliberately: `KC_SPACE`/`KC_ENTER` are
//     conventionally mapped to a thumb, so counting word-terminal pairs
//     into left/right would skew whichever hand's thumb reaches the
//     separator. See `aggregateInWordBigramClasses`'s own doc comment
//     for the full rationale.
//
//  2. The study measured transcription typing in English. These are
//     population references for context, not thresholds of "good" or
//     "bad" typing.

/** One reported statistic: population mean and standard deviation. */
export interface BenchmarkStat {
  mean: number
  sd: number
}

/** Population reference from transcription typing (see caveat 2 above),
 * not a threshold of "good" or "bad" typing. */
export const BENCHMARK_WPM: BenchmarkStat = { mean: 51.56, sd: 20.20 }
/** Population reference from transcription typing (see caveat 2 above),
 * not a threshold of "good" or "bad" typing. */
export const BENCHMARK_IKI_MS: BenchmarkStat = { mean: 238.66, sd: 111.60 }
export const BENCHMARK_KEYPRESS_DURATION_MS: BenchmarkStat = { mean: 116.25, sd: 23.88 }
export const BENCHMARK_UNCORRECTED_ERROR_RATE_PCT: BenchmarkStat = { mean: 1.17, sd: 1.43 }
export const BENCHMARK_ERROR_CORRECTION_RATE_PCT: BenchmarkStat = { mean: 6.31, sd: 4.48 }
/** Population reference from transcription typing (see caveat 2 above),
 * not a threshold of "good" or "bad" typing. Keystrokes per confirmed
 * character — the paper's Table 3 reports this pair to three decimal
 * places (1.173/0.094), unlike the two-decimal figures transcribed for
 * the other stats above, so it's kept here at that source precision
 * rather than rounded to match them. */
export const BENCHMARK_KSPC: BenchmarkStat = { mean: 1.173, sd: 0.094 }

// Hand-class IKI values — see caveat 1 above before using these.

/** Excludes word-initiation bigrams (see caveat 1 above) — apply the
 * same `inWord` filter before comparing a measured value against this. */
export const BENCHMARK_LEFT_HAND_IKI_MS: BenchmarkStat = { mean: 215.23, sd: 96.80 }
/** Excludes word-initiation bigrams (see caveat 1 above) — apply the
 * same `inWord` filter before comparing a measured value against this. */
export const BENCHMARK_RIGHT_HAND_IKI_MS: BenchmarkStat = { mean: 203.60, sd: 99.13 }
/** Excludes word-initiation bigrams (see caveat 1 above) — apply the
 * same `inWord` filter before comparing a measured value against this. */
export const BENCHMARK_ALTERNATION_IKI_MS: BenchmarkStat = { mean: 198.26, sd: 103.95 }
/** Excludes word-initiation bigrams (see caveat 1 above) — apply the
 * same `inWord` filter before comparing a measured value against this. */
export const BENCHMARK_LETTER_REPETITION_IKI_MS: BenchmarkStat = { mean: 176.36, sd: 70.26 }

export const BENCHMARK_ROLLOVER_RATIO_PCT: BenchmarkStat = { mean: 25.00, sd: 17.00 }

// Error-class rates (substitution / omission / insertion — see
// `renderer/typing-test/error-classify.ts`) — Table 3 (p.6), the paper's
// * footnote: this mean/SD triple comes from a 783-participant detailed-
// error subsample, not the full 168,960-participant cohort the other
// constants in this file are drawn from.
//
// These three constants carry a real, transcribed SD, but the two
// direct-render consumers (`ErrorMixSection`'s History summary and the
// Analyze Typing Profile card's Error mix cell) still show only the
// plain mean as context text — adding a `benchmarkPosition` label to
// either is a deliberate follow-up, not an oversight. The typist-cluster
// classifier (`renderer/components/analyze/analyze-typist-cluster.ts`)
// is the current SD consumer: it z-scores these three rates against
// `TYPIST_CLUSTER_CENTROIDS`, but that z-score never surfaces as a
// per-row position label anywhere in the UI.
export const BENCHMARK_SUBSTITUTION_RATE_PCT: BenchmarkStat = { mean: 1.65, sd: 1.43 }
export const BENCHMARK_OMISSION_RATE_PCT: BenchmarkStat = { mean: 0.80, sd: 0.57 }
export const BENCHMARK_INSERTION_RATE_PCT: BenchmarkStat = { mean: 0.67, sd: 0.48 }

/** Typist-group thresholds from the paper's Typist Groups definition
 * (p.4): "fast" is faster than ~90% of participants, "slow" is slower
 * than ~90% (i.e. among the slowest ~10%). Plain WPM numbers, not a
 * {@link BenchmarkStat} — the paper defines these as percentile cuts,
 * not a mean/SD pair. */
export const BENCHMARK_FAST_TYPIST_WPM = 78
export const BENCHMARK_SLOW_TYPIST_WPM = 26

/** The 8 typist-cluster ids the paper's Table 4 reports — see
 * `TYPIST_CLUSTER_CENTROIDS` below. A literal union rather than plain
 * `number` so a typo'd or out-of-range id (e.g. a future re-numbering)
 * fails to compile instead of silently classifying nothing. */
export type TypistClusterId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8

/** One row of the paper's Table 4 (p.9) — the summary-measure profile
 * of one of the 8 typist clusters the paper reports from a PAM
 * (partitioning-around-medoids) clustering. See
 * `renderer/components/analyze/analyze-typist-cluster.ts`'s module doc
 * for what a nearest-centroid classifier built against this table is
 * (an application-side approximation of the paper's own clustering) and
 * isn't (a reproduction of it), and for the UI-facing, non-evaluative
 * cluster descriptions actually shown to the user.
 *
 * `rolloverPct` and `uncorrectedErrorPct` are kept below purely as 1:1
 * transcription provenance so this table matches the paper's Table 4
 * exactly — they're deliberately excluded from the classifier's
 * distance computation; see that module's "EXCLUDED DIMENSIONS" doc
 * section for why.
 *
 * The paper's own cluster label (e.g. "SLOW CARELESS HAND ALTERNATORS")
 * and participant count `N` are NOT fields on this interface — they're
 * transcription provenance too, but evaluative label strings like that
 * are exactly the vocabulary `.claude/rules/coding-ui.md` bars from
 * reaching a renderer bundle or any future render path. Keeping them as
 * a `//` comment on each `TYPIST_CLUSTER_CENTROIDS` row preserves the
 * same provenance without shipping the string or giving any future code
 * path something to read and render. */
export interface TypistClusterCentroid {
  id: TypistClusterId
  wpm: number
  rolloverPct: number
  ikiMs: number
  leftIkiMs: number
  rightIkiMs: number
  alternationIkiMs: number
  uncorrectedErrorPct: number
  omissionPct: number
  insertionPct: number
  substitutionPct: number
  kspc: number
}

/** Table 4 (p.9), transcribed verbatim and verified against the PDF —
 * see {@link TypistClusterCentroid}'s doc comment for what this table
 * is (and isn't), and for why each row's paper label/N live only in the
 * trailing comment, before wiring it into anything new. `readonly` so a
 * consumer's "always 8 rows" assumption (e.g.
 * `analyze-typist-cluster.ts`'s `const [best, runnerUp] = ranked`
 * destructure) is structural, not just a comment. */
export const TYPIST_CLUSTER_CENTROIDS: readonly TypistClusterCentroid[] = [
  { id: 1, wpm: 46.5, rolloverPct: 19.98, ikiMs: 245.8, leftIkiMs: 221.9, rightIkiMs: 218.5, alternationIkiMs: 202.1, uncorrectedErrorPct: 1.260, omissionPct: 0.70, insertionPct: 0.59, substitutionPct: 1.7, kspc: 1.177 }, // "SLOW CAREFUL", N=38,012
  { id: 2, wpm: 48.12, rolloverPct: 19.29, ikiMs: 235.3, leftIkiMs: 217.0, rightIkiMs: 216.2, alternationIkiMs: 185.3, uncorrectedErrorPct: 1.313, omissionPct: 0.90, insertionPct: 0.77, substitutionPct: 2.0, kspc: 1.179 }, // "SLOW CARELESS HAND ALTERNATORS", N=12,930
  { id: 3, wpm: 52.36, rolloverPct: 24.44, ikiMs: 214.9, leftIkiMs: 205.3, rightIkiMs: 203.8, alternationIkiMs: 175.4, uncorrectedErrorPct: 1.263, omissionPct: 0.92, insertionPct: 0.81, substitutionPct: 1.7, kspc: 1.186 }, // "AVERAGE-BUT-ERROR-PRONE", N=13,397
  { id: 4, wpm: 53.12, rolloverPct: 26.23, ikiMs: 212.3, leftIkiMs: 204.6, rightIkiMs: 192.7, alternationIkiMs: 174.5, uncorrectedErrorPct: 1.187, omissionPct: 0.80, insertionPct: 0.76, substitutionPct: 1.6, kspc: 1.175 }, // "AVERAGE RIGHT-HAND", N=15,498
  { id: 5, wpm: 53.87, rolloverPct: 21.17, ikiMs: 205.3, leftIkiMs: 205.9, rightIkiMs: 199.9, alternationIkiMs: 159.3, uncorrectedErrorPct: 1.220, omissionPct: 0.90, insertionPct: 0.64, substitutionPct: 1.8, kspc: 1.185 }, // "AVERAGE HAND ALTERNATORS", N=7,731
  { id: 6, wpm: 56.50, rolloverPct: 27.20, ikiMs: 197.8, leftIkiMs: 180.5, rightIkiMs: 179.8, alternationIkiMs: 161.2, uncorrectedErrorPct: 1.147, omissionPct: 0.81, insertionPct: 0.67, substitutionPct: 1.7, kspc: 1.176 }, // "AVERAGE", N=22,980
  { id: 7, wpm: 64.59, rolloverPct: 35.75, ikiMs: 181.9, leftIkiMs: 173.1, rightIkiMs: 163.2, alternationIkiMs: 153.9, uncorrectedErrorPct: 1.094, omissionPct: 0.71, insertionPct: 0.63, substitutionPct: 1.6, kspc: 1.162 }, // "FAST ERROR-PRONE", N=19,757
  { id: 8, wpm: 68.35, rolloverPct: 37.76, ikiMs: 161.9, leftIkiMs: 159.5, rightIkiMs: 150.1, alternationIkiMs: 138.2, uncorrectedErrorPct: 0.969, omissionPct: 0.61, insertionPct: 0.64, substitutionPct: 1.1, kspc: 1.158 }, // "FAST ROLLOVERS", N=35,068
]
