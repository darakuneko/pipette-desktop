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
//     the two are not directly comparable. Any future overlay onto that
//     quadrant must resolve this definition gap first — do not wire
//     these four constants into a chart without addressing it.
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
export const BENCHMARK_KSPC: BenchmarkStat = { mean: 1.17, sd: 0.09 }

// Hand-class IKI values — see caveat 1 above before using these.

/** Excludes word-initiation bigrams (see caveat 1 above) — do not wire
 * into a chart that doesn't exclude them without resolving that gap. */
export const BENCHMARK_LEFT_HAND_IKI_MS: BenchmarkStat = { mean: 215.23, sd: 96.80 }
/** Excludes word-initiation bigrams (see caveat 1 above) — do not wire
 * into a chart that doesn't exclude them without resolving that gap. */
export const BENCHMARK_RIGHT_HAND_IKI_MS: BenchmarkStat = { mean: 203.60, sd: 99.13 }
/** Excludes word-initiation bigrams (see caveat 1 above) — do not wire
 * into a chart that doesn't exclude them without resolving that gap. */
export const BENCHMARK_ALTERNATION_IKI_MS: BenchmarkStat = { mean: 198.26, sd: 103.95 }
/** Excludes word-initiation bigrams (see caveat 1 above) — do not wire
 * into a chart that doesn't exclude them without resolving that gap. */
export const BENCHMARK_LETTER_REPETITION_IKI_MS: BenchmarkStat = { mean: 176.36, sd: 70.26 }

export const BENCHMARK_ROLLOVER_RATIO_PCT: BenchmarkStat = { mean: 25.00, sd: 17.00 }

/** Typist-group thresholds from the paper's Typist Groups definition
 * (p.4): "fast" is faster than ~90% of participants, "slow" is slower
 * than ~90% (i.e. among the slowest ~10%). Plain WPM numbers, not a
 * {@link BenchmarkStat} — the paper defines these as percentile cuts,
 * not a mean/SD pair. */
export const BENCHMARK_FAST_TYPIST_WPM = 78
export const BENCHMARK_SLOW_TYPIST_WPM = 26
