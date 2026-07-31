// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  classifyTypist,
  typistIkiFromEntries,
  typistHandIkisFromEntries,
  TYPIST_MIN_MARGIN_RMS,
  TYPIST_MAX_MATCH_RMS,
  type TypistDimension,
  type TypistFeatures,
} from '../analyze-typist-cluster'
import { benchmarkZ } from '../analyze-benchmark'
import { BIGRAM_MIN_COUNT } from '../analyze-typing-profile'
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
} from '../../../../shared/typing-benchmarks'
import { deserialize } from '../../../../shared/keycodes/keycodes'
import type { FingerType } from '../../../../shared/kle/kle-ergonomics'
import type { TypingBigramTopEntry } from '../../../../shared/types/typing-analytics'
import english from '../../../i18n/locales/english.json'

function featuresFromCentroid(c: TypistClusterCentroid): TypistFeatures {
  return {
    wpm: c.wpm,
    ikiMs: c.ikiMs,
    leftIkiMs: c.leftIkiMs,
    rightIkiMs: c.rightIkiMs,
    alternationIkiMs: c.alternationIkiMs,
    substitutionPct: c.substitutionPct,
    omissionPct: c.omissionPct,
    insertionPct: c.insertionPct,
    kspc: c.kspc,
  }
}

/** Mirrors `DIMENSION_SPECS` inside `analyze-typist-cluster.ts` — kept as
 * a separate literal here (rather than exported from the module under
 * test) so this file independently re-derives the same z-score/RMS math
 * `classifyTypist` uses internally, instead of trusting its internals. */
const STAT_BY_DIMENSION: Record<TypistDimension, BenchmarkStat> = {
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

const ALL_DIMENSIONS = Object.keys(STAT_BY_DIMENSION) as TypistDimension[]

/** Same per-dimension z-score RMS `classifyTypist` computes, over
 * whichever `keys` the caller restricts to — used below to verify
 * `TYPIST_MIN_MARGIN_RMS`/`TYPIST_MAX_MATCH_RMS` against independently
 * computed distances rather than only through the classifier's own
 * return value. */
function rmsDistance(a: TypistFeatures, b: TypistFeatures, keys: readonly TypistDimension[]): number {
  let sumSq = 0
  for (const key of keys) {
    const av = a[key]
    const bv = b[key]
    if (av === undefined || bv === undefined) throw new Error(`rmsDistance: missing "${key}"`)
    const diff = benchmarkZ(av, STAT_BY_DIMENSION[key]) - benchmarkZ(bv, STAT_BY_DIMENSION[key])
    sumSq += diff * diff
  }
  return Math.sqrt(sumSq / keys.length)
}

/** Every hand-IKI combo the classifier accepts (`hasRequiredCore` needs
 * at least 2 of the 3) — all 3, plus each 2-of-3 pair. */
const HAND_IKI_COMBOS: readonly (readonly TypistDimension[])[] = [
  ['leftIkiMs', 'rightIkiMs', 'alternationIkiMs'],
  ['leftIkiMs', 'rightIkiMs'],
  ['leftIkiMs', 'alternationIkiMs'],
  ['rightIkiMs', 'alternationIkiMs'],
]
const ERROR_TRIO: readonly TypistDimension[] = ['substitutionPct', 'omissionPct', 'insertionPct']

function subsetFeatures(
  centroid: TypistClusterCentroid,
  hand: readonly TypistDimension[],
  includeError: boolean,
  includeKspc: boolean,
): TypistFeatures {
  const features: TypistFeatures = { wpm: centroid.wpm, ikiMs: centroid.ikiMs }
  for (const key of hand) features[key] = centroid[key]
  if (includeError) {
    features.substitutionPct = centroid.substitutionPct
    features.omissionPct = centroid.omissionPct
    features.insertionPct = centroid.insertionPct
  }
  if (includeKspc) features.kspc = centroid.kspc
  return features
}

describe('classifyTypist', () => {
  it('classifies every centroid fed back as itself, at distance 0 with basis "full" — this also enforces that TYPIST_MIN_MARGIN_RMS stays below the minimum pairwise centroid separation', () => {
    for (const centroid of TYPIST_CLUSTER_CENTROIDS) {
      const result = classifyTypist(featuresFromCentroid(centroid))
      expect(result.kind).toBe('matched')
      if (result.kind === 'matched') {
        expect(result.clusterId).toBe(centroid.id)
        expect(result.distance).toBeCloseTo(0, 9)
        expect(result.basis).toBe('full')
      }
    }
  })

  it('still classifies a centroid to itself when an optional dimension is dropped', () => {
    for (const centroid of TYPIST_CLUSTER_CENTROIDS) {
      const features = featuresFromCentroid(centroid)
      delete features.kspc
      const result = classifyTypist(features)
      expect(result.kind).toBe('matched')
      if (result.kind === 'matched') {
        expect(result.clusterId).toBe(centroid.id)
        expect(result.distance).toBeCloseTo(0, 9)
      }
    }
  })

  it('reports basis "rhythmOnly" when any one of the three error dimensions is missing — the trio is all-or-nothing upstream, but the classifier checks all three independently', () => {
    const features = featuresFromCentroid(TYPIST_CLUSTER_CENTROIDS[2])
    delete features.omissionPct
    const result = classifyTypist(features)
    expect(result.kind).toBe('matched')
    if (result.kind === 'matched') {
      expect(result.basis).toBe('rhythmOnly')
    }
  })

  it('classifies a rhythm-only profile (56 WPM, IKI 175/180/180/160, no error/KSPC data) as cluster 6 with a wide margin over its nearest neighbor — the same fixture TypingProfileCard\'s wiring test renders end-to-end via a mocked bigram fetch, but the arithmetic that lands it on cluster 6 belongs here, not in a component test', () => {
    // Cluster 6 ("AVERAGE"): wpm 56.50, ikiMs 197.8, leftIkiMs 180.5,
    // rightIkiMs 179.8, alternationIkiMs 161.2 — these probe values were
    // chosen (via the bucket-center histogram TypingProfileCard's test
    // feeds through avgIkiFromHist) to land close to that centroid.
    const features: TypistFeatures = {
      wpm: 56,
      ikiMs: 175,
      leftIkiMs: 180,
      rightIkiMs: 180,
      alternationIkiMs: 160,
    }
    const result = classifyTypist(features)
    expect(result.kind).toBe('matched')
    if (result.kind === 'matched') {
      expect(result.clusterId).toBe(6)
      expect(result.basis).toBe('rhythmOnly')
    }
  })

  it.each(['wpm', 'ikiMs'] as const)('returns unknown/missingCore when %s is absent', (key) => {
    const features = featuresFromCentroid(TYPIST_CLUSTER_CENTROIDS[0])
    delete features[key]
    expect(classifyTypist(features)).toEqual({ kind: 'unknown', reason: 'missingCore' })
  })

  it('returns unknown/missingCore when fewer than 2 of the 3 hand-class IKIs are present', () => {
    const centroid = TYPIST_CLUSTER_CENTROIDS[0]
    const features: TypistFeatures = {
      wpm: centroid.wpm,
      ikiMs: centroid.ikiMs,
      leftIkiMs: centroid.leftIkiMs,
      // rightIkiMs and alternationIkiMs both absent — only 1 of 3.
    }
    expect(classifyTypist(features)).toEqual({ kind: 'unknown', reason: 'missingCore' })
  })

  it('returns noMatch/ambiguous for an input exactly equidistant from its two nearest clusters', () => {
    // Average clusters 3 and 4's raw values dimension-by-dimension. Since
    // z-scoring is an affine transform sharing the same mean/SD for both
    // centroids and the probe, the raw average lands at the exact
    // midpoint z between the two — an equal RMS distance to both.
    const c3 = TYPIST_CLUSTER_CENTROIDS[2]
    const c4 = TYPIST_CLUSTER_CENTROIDS[3]
    const avg = (a: number, b: number): number => (a + b) / 2
    const features: TypistFeatures = {
      wpm: avg(c3.wpm, c4.wpm),
      ikiMs: avg(c3.ikiMs, c4.ikiMs),
      leftIkiMs: avg(c3.leftIkiMs, c4.leftIkiMs),
      rightIkiMs: avg(c3.rightIkiMs, c4.rightIkiMs),
      alternationIkiMs: avg(c3.alternationIkiMs, c4.alternationIkiMs),
      substitutionPct: avg(c3.substitutionPct, c4.substitutionPct),
      omissionPct: avg(c3.omissionPct, c4.omissionPct),
      insertionPct: avg(c3.insertionPct, c4.insertionPct),
      kspc: avg(c3.kspc, c4.kspc),
    }
    const result = classifyTypist(features)
    expect(result).toEqual({ kind: 'noMatch', reason: 'ambiguous' })
  })

  it('returns noMatch/tooFar for an input far from every cluster', () => {
    // 5 SDs out on every dimension at once — built from the same
    // BenchmarkStat constants the classifier itself z-scores against,
    // so this stays correct if any of those constants is retranscribed.
    const features: TypistFeatures = {
      wpm: BENCHMARK_WPM.mean + 5 * BENCHMARK_WPM.sd,
      ikiMs: BENCHMARK_IKI_MS.mean + 5 * BENCHMARK_IKI_MS.sd,
      leftIkiMs: BENCHMARK_LEFT_HAND_IKI_MS.mean + 5 * BENCHMARK_LEFT_HAND_IKI_MS.sd,
      rightIkiMs: BENCHMARK_RIGHT_HAND_IKI_MS.mean + 5 * BENCHMARK_RIGHT_HAND_IKI_MS.sd,
      alternationIkiMs: BENCHMARK_ALTERNATION_IKI_MS.mean + 5 * BENCHMARK_ALTERNATION_IKI_MS.sd,
      substitutionPct: BENCHMARK_SUBSTITUTION_RATE_PCT.mean + 5 * BENCHMARK_SUBSTITUTION_RATE_PCT.sd,
      omissionPct: BENCHMARK_OMISSION_RATE_PCT.mean + 5 * BENCHMARK_OMISSION_RATE_PCT.sd,
      insertionPct: BENCHMARK_INSERTION_RATE_PCT.mean + 5 * BENCHMARK_INSERTION_RATE_PCT.sd,
      kspc: BENCHMARK_KSPC.mean + 5 * BENCHMARK_KSPC.sd,
    }
    expect(classifyTypist(features)).toEqual({ kind: 'noMatch', reason: 'tooFar' })
    // Confirms the fixture actually exercises the tooFar gate rather than
    // coincidentally landing inside TYPIST_MAX_MATCH_RMS of some centroid.
    const nearest = Math.min(...TYPIST_CLUSTER_CENTROIDS.map(
      (c) => rmsDistance(features, featuresFromCentroid(c), ALL_DIMENSIONS),
    ))
    expect(nearest).toBeGreaterThan(TYPIST_MAX_MATCH_RMS)
  })
})

describe('TYPIST_MIN_MARGIN_RMS safety across every supported dimension subset', () => {
  it('classifies every centroid to itself as matched on every hand-IKI combo x error-trio present/absent x kspc present/absent subset', () => {
    for (const hand of HAND_IKI_COMBOS) {
      for (const includeError of [true, false]) {
        for (const includeKspc of [true, false]) {
          for (const centroid of TYPIST_CLUSTER_CENTROIDS) {
            const features = subsetFeatures(centroid, hand, includeError, includeKspc)
            const result = classifyTypist(features)
            const label = `hand=[${hand.join('+')}] error=${includeError} kspc=${includeKspc} centroid=${centroid.id}`
            expect(result.kind, label).toBe('matched')
            if (result.kind === 'matched') {
              expect(result.clusterId, label).toBe(centroid.id)
              expect(result.distance, label).toBeCloseTo(0, 9)
            }
          }
        }
      }
    }
  })

  it('stays strictly below the minimum pairwise centroid separation found across every one of those subsets', () => {
    let minSeparation = Infinity
    for (const hand of HAND_IKI_COMBOS) {
      for (const includeError of [true, false]) {
        for (const includeKspc of [true, false]) {
          const keys: TypistDimension[] = [
            'wpm', 'ikiMs', ...hand,
            ...(includeError ? ERROR_TRIO : []),
            ...(includeKspc ? (['kspc'] as const) : []),
          ]
          for (let i = 0; i < TYPIST_CLUSTER_CENTROIDS.length; i++) {
            for (let j = i + 1; j < TYPIST_CLUSTER_CENTROIDS.length; j++) {
              const d = rmsDistance(
                featuresFromCentroid(TYPIST_CLUSTER_CENTROIDS[i]),
                featuresFromCentroid(TYPIST_CLUSTER_CENTROIDS[j]),
                keys,
              )
              if (d < minSeparation) minSeparation = d
            }
          }
        }
      }
    }
    // Tightest subset found is wpm+ikiMs+leftIkiMs+alternationIkiMs (no
    // error trio, no kspc) between clusters 3 and 4, ~0.0228 — bounded
    // loosely so a future centroid retranscription doesn't force an edit
    // here, only keeps this test honest against TYPIST_MIN_MARGIN_RMS.
    expect(minSeparation).toBeGreaterThan(0.02)
    expect(minSeparation).toBeLessThan(0.03)
    expect(TYPIST_MIN_MARGIN_RMS).toBeLessThan(minSeparation)
  })
})

describe('i18n coverage for TYPIST_CLUSTER_CENTROIDS', () => {
  it('has a typistCluster.<id>.name and .context entry in english.json for every centroid id', () => {
    const typistCluster = english.analyze.summary.profile.typistCluster as Record<string, { name?: string; context?: string }>
    for (const centroid of TYPIST_CLUSTER_CENTROIDS) {
      const entry = typistCluster[String(centroid.id)]
      expect(entry, `missing typistCluster.${centroid.id} in english.json`).toBeDefined()
      expect(entry.name, `missing typistCluster.${centroid.id}.name in english.json`).toBeTruthy()
      expect(entry.context, `missing typistCluster.${centroid.id}.context in english.json`).toBeTruthy()
    }
  })
})

function bigramEntry(
  ngramId: string,
  count: number,
  hist: number[] = [0, 0, 0, 0, 0, 0, 0, 0],
): TypingBigramTopEntry {
  return { ngramId, count, hist, avgIki: null, sd: null }
}

describe('typistIkiFromEntries', () => {
  it('returns undefined below BIGRAM_MIN_COUNT', () => {
    const entries = [bigramEntry('1_2', BIGRAM_MIN_COUNT - 1, [BIGRAM_MIN_COUNT - 1, 0, 0, 0, 0, 0, 0, 0])]
    expect(typistIkiFromEntries(entries)).toBeUndefined()
  })

  it('folds every entry regardless of position, unlike the hand-class helper', () => {
    const entries = [
      bigramEntry('1_2', BIGRAM_MIN_COUNT, [0, 0, 0, BIGRAM_MIN_COUNT, 0, 0, 0, 0]), // bucket center 175
    ]
    expect(typistIkiFromEntries(entries)).toBe(175)
  })
})

describe('typistHandIkisFromEntries', () => {
  const KC_A = deserialize('KC_A')
  const KC_D = deserialize('KC_D')
  const KC_SPACE = deserialize('KC_SPACE')
  // A and D are both left-hand, different fingers -> a 'left'-class pair
  // (not repetition: different keycodes). SPACE is also mapped to the
  // left hand (thumb) so an un-filtered fold would still land it in the
  // same 'left' class — the only thing that should keep it out is the
  // word-initiation exclusion itself, not a hand mismatch.
  const fingerMap = new Map<number, FingerType>([
    [KC_A, 'left-index'],
    [KC_D, 'left-middle'],
    [KC_SPACE, 'left-thumb'],
  ])

  it('excludes word-initiation pairs from the fold — an included pair would have shifted the class average', () => {
    const inWordEntry = bigramEntry(`${KC_A}_${KC_D}`, BIGRAM_MIN_COUNT, [0, 0, 0, BIGRAM_MIN_COUNT, 0, 0, 0, 0]) // bucket center 175
    // A huge count concentrated in the top bucket (center 1500) — if this
    // word-initiation pair were folded in, the left-class average would
    // move far away from 175.
    const initiationEntry = bigramEntry(`${KC_SPACE}_${KC_D}`, 5000, [0, 0, 0, 0, 0, 0, 0, 5000])
    const result = typistHandIkisFromEntries([inWordEntry, initiationEntry], fingerMap)
    expect(result.leftIkiMs).toBe(175)
  })

  it('returns undefined for a class below BIGRAM_MIN_COUNT in-word samples', () => {
    const sparse = bigramEntry(`${KC_A}_${KC_D}`, BIGRAM_MIN_COUNT - 1, [0, 0, 0, BIGRAM_MIN_COUNT - 1, 0, 0, 0, 0])
    const result = typistHandIkisFromEntries([sparse], fingerMap)
    expect(result.leftIkiMs).toBeUndefined()
  })

  it('returns all-undefined for an empty finger map without doing any work', () => {
    const entries = [bigramEntry(`${KC_A}_${KC_D}`, BIGRAM_MIN_COUNT)]
    const result = typistHandIkisFromEntries(entries, new Map())
    expect(result).toEqual({})
  })
})
