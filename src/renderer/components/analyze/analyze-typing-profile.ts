// SPDX-License-Identifier: GPL-2.0-or-later
// Pure-data compute for the Analyze > Summary > Typing Profile card.
// Bucketises the user's last-30-day data into four labels — Speed,
// Hand balance, SFB pattern, Fatigue risk — without any
// recommendations. Each classifier returns 'unknown' when the
// underlying sample is too thin to read, so the renderer can show a
// dash instead of a confident-but-wrong label.

import { computeWpm, isWpmQualified, buildHourOfDayWpm } from './analyze-wpm'
import { aggregateFingerPairs, type FingerPairTotal } from './analyze-bigram-finger'
import { HAND_OF_FINGER, type FingerType, type HandType } from '../../../shared/kle/kle-ergonomics'
import type {
  TypingBigramTopEntry,
  TypingDailySummary,
  TypingMinuteStatsRow,
} from '../../../shared/types/typing-analytics'
import type { RangeMs } from './analyze-types'

export type SpeedLabel = 'unknown' | 'slow' | 'medium' | 'fast'
export type HandBalanceLabel = 'unknown' | 'leftBias' | 'balanced' | 'rightBias'
export type SfbLabel = 'unknown' | 'low' | 'medium' | 'high'
export type FatigueLabel = 'unknown' | 'low' | 'medium' | 'high'

/** Window length used by every Profile classifier. The card itself
 * pulls the underlying IPCs over this same range so the inputs are
 * consistent. */
export const PROFILE_WINDOW_DAYS = 30
/** Below this aggregated keystroke count over the window we don't
 * trust the speed bucket. Tuned to ~3 WPM-worth of typing per day. */
export const SPEED_MIN_KEYSTROKES = 1000
const SPEED_SLOW_MAX_WPM = 30
const SPEED_FAST_MIN_WPM = 50
/** Bigram aggregate sample floor. Below this we suppress both Hand
 * balance and SFB labels — small samples produce noisy ratios. */
export const BIGRAM_MIN_COUNT = 1000
const HAND_BALANCED_TOLERANCE = 0.05
const SFB_LOW_RATE = 0.04
const SFB_HIGH_RATE = 0.08
/** Minimum number of qualifying hour buckets needed before we report
 * a fatigue trend. Below this the hourly curve is too sparse to read. */
export const FATIGUE_MIN_HOURS = 4
const FATIGUE_LOW_DROP_PCT = 8
const FATIGUE_HIGH_DROP_PCT = 18
/** Hour buckets must clear this much active-typing time to count.
 * Mirrors the WPM tab's default Min-sample so the curves agree. */
const FATIGUE_MIN_HOUR_ACTIVE_MS = 60_000

export interface SpeedResult {
  /** Window-wide WPM (`computeWpm` over total keystrokes / activeMs).
   * `0` when the keystroke floor isn't met. */
  wpm: number
  label: SpeedLabel
}

export interface HandBalanceResult {
  leftCount: number
  rightCount: number
  /** Left-hand share of the (left + right) total. `null` when the
   * sample falls below the bigram floor or no keystrokes mapped to a
   * known finger. */
  leftRatio: number | null
  label: HandBalanceLabel
}

export interface SfbResult {
  /** SFB ÷ total bigrams across mapped pairs. `null` when the sample
   * is below the bigram floor. */
  rate: number | null
  sfbCount: number
  totalCount: number
  label: SfbLabel
}

export interface FatigueResult {
  /** % drop from peak qualifying hour to lowest qualifying hour.
   * `null` when fewer than `FATIGUE_MIN_HOURS` hours qualified. */
  dropPct: number | null
  peakWpm: number
  lowestWpm: number
  label: FatigueLabel
}

export function classifySpeed(daily: ReadonlyArray<TypingDailySummary>): SpeedResult {
  let keystrokes = 0
  let activeMs = 0
  for (const d of daily) {
    keystrokes += d.keystrokes
    activeMs += d.activeMs
  }
  if (keystrokes < SPEED_MIN_KEYSTROKES) {
    return { wpm: 0, label: 'unknown' }
  }
  const wpm = computeWpm(keystrokes, activeMs)
  if (wpm < SPEED_SLOW_MAX_WPM) return { wpm, label: 'slow' }
  if (wpm < SPEED_FAST_MIN_WPM) return { wpm, label: 'medium' }
  return { wpm, label: 'fast' }
}

/** Hand-balance classifier that accepts a pre-aggregated finger-pair
 * map. The renderer aggregates once and passes the result here and to
 * {@link classifySfbFromPairs} so the bigram array is not traversed
 * twice per render. */
export function classifyHandBalanceFromPairs(
  fingerPairs: ReadonlyMap<string, FingerPairTotal>,
): HandBalanceResult {
  let leftCount = 0
  let rightCount = 0
  for (const [pairKey, total] of fingerPairs) {
    const [, secondFinger] = pairKey.split('_') as [FingerType, FingerType]
    const hand: HandType = HAND_OF_FINGER[secondFinger]
    if (hand === 'left') leftCount += total.count
    else rightCount += total.count
  }
  const totalMapped = leftCount + rightCount
  if (totalMapped < BIGRAM_MIN_COUNT) {
    return { leftCount, rightCount, leftRatio: null, label: 'unknown' }
  }
  const ratio = leftCount / totalMapped
  if (ratio < 0.5 - HAND_BALANCED_TOLERANCE) {
    return { leftCount, rightCount, leftRatio: ratio, label: 'rightBias' }
  }
  if (ratio > 0.5 + HAND_BALANCED_TOLERANCE) {
    return { leftCount, rightCount, leftRatio: ratio, label: 'leftBias' }
  }
  return { leftCount, rightCount, leftRatio: ratio, label: 'balanced' }
}

/** Convenience overload that aggregates then classifies. Single-call
 * sites (and the unit tests) keep the simpler signature; the renderer
 * uses the *FromPairs variant so the aggregation happens once. */
export function classifyHandBalance(
  entries: ReadonlyArray<TypingBigramTopEntry>,
  keycodeFinger: ReadonlyMap<number, FingerType>,
): HandBalanceResult {
  return classifyHandBalanceFromPairs(aggregateFingerPairs(entries, keycodeFinger))
}

export function classifySfbFromPairs(
  fingerPairs: ReadonlyMap<string, FingerPairTotal>,
): SfbResult {
  let sfbCount = 0
  let totalCount = 0
  for (const [pairKey, total] of fingerPairs) {
    const [first, second] = pairKey.split('_') as [FingerType, FingerType]
    totalCount += total.count
    if (first === second) sfbCount += total.count
  }
  if (totalCount < BIGRAM_MIN_COUNT) {
    return { rate: null, sfbCount, totalCount, label: 'unknown' }
  }
  const rate = sfbCount / totalCount
  if (rate < SFB_LOW_RATE) return { rate, sfbCount, totalCount, label: 'low' }
  if (rate < SFB_HIGH_RATE) return { rate, sfbCount, totalCount, label: 'medium' }
  return { rate, sfbCount, totalCount, label: 'high' }
}

export function classifySfb(
  entries: ReadonlyArray<TypingBigramTopEntry>,
  keycodeFinger: ReadonlyMap<number, FingerType>,
): SfbResult {
  return classifySfbFromPairs(aggregateFingerPairs(entries, keycodeFinger))
}

export function classifyFatigue(
  rows: ReadonlyArray<TypingMinuteStatsRow>,
  range: RangeMs,
): FatigueResult {
  const result = buildHourOfDayWpm({ rows, range, minActiveMs: FATIGUE_MIN_HOUR_ACTIVE_MS })
  // Filter to hour bins that meet both the activity floor and the
  // qualified WPM gate so a 5-second burst doesn't anchor "peak" or
  // "lowest" for the entire 30-day window.
  const qualified = result.bins.filter((b) =>
    isWpmQualified(b.keystrokes, b.activeMs, b.wpm, FATIGUE_MIN_HOUR_ACTIVE_MS),
  )
  if (qualified.length < FATIGUE_MIN_HOURS) {
    return { dropPct: null, peakWpm: 0, lowestWpm: 0, label: 'unknown' }
  }
  const peakWpm = qualified.reduce((m, b) => (b.wpm > m ? b.wpm : m), 0)
  const lowestWpm = qualified.reduce((m, b) => (m === 0 || b.wpm < m ? b.wpm : m), 0)
  if (peakWpm <= 0) {
    return { dropPct: null, peakWpm, lowestWpm, label: 'unknown' }
  }
  const dropPct = ((peakWpm - lowestWpm) / peakWpm) * 100
  if (dropPct < FATIGUE_LOW_DROP_PCT) return { dropPct, peakWpm, lowestWpm, label: 'low' }
  if (dropPct < FATIGUE_HIGH_DROP_PCT) return { dropPct, peakWpm, lowestWpm, label: 'medium' }
  return { dropPct, peakWpm, lowestWpm, label: 'high' }
}
