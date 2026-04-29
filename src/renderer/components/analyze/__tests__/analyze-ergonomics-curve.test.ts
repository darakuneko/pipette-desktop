// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { parseKle } from '../../../../shared/kle/kle-parser'
import { buildErgonomicsByPos } from '../../../../shared/kle/kle-ergonomics'
import type { TypingMatrixCellDailyRow } from '../../../../shared/types/typing-analytics'
import {
  buildLearningCurve,
  summarizeLearningCurve,
  LEARNING_SCORE_WEIGHTS,
  DEFAULT_LEARNING_MIN_SAMPLE,
} from '../analyze-ergonomics-curve'

function buildAnsi60() {
  return parseKle([
    [
      '0,0', '0,1', '0,2', '0,3', '0,4', '0,5', '0,6',
      '0,7', '0,8', '0,9', '0,10', '0,11', '0,12',
      { w: 2 }, '0,13',
    ],
    [
      { w: 1.5 }, '1,0',
      '1,1', '1,2', '1,3', '1,4', '1,5', '1,6', '1,7',
      '1,8', '1,9', '1,10', '1,11', '1,12',
      { w: 1.5 }, '1,13',
    ],
    [
      { w: 1.75 }, '2,0',
      '2,1', '2,2', '2,3', '2,4', '2,5', '2,6',
      '2,7', '2,8', '2,9', '2,10', '2,11',
      { w: 2.25 }, '2,12',
    ],
    [
      { w: 2.25 }, '3,0',
      '3,1', '3,2', '3,3', '3,4', '3,5',
      '3,6', '3,7', '3,8', '3,9', '3,10',
      { w: 2.75 }, '3,11',
    ],
    [
      { w: 1.25 }, '4,0',
      { w: 1.25 }, '4,1',
      { w: 1.25 }, '4,2',
      { w: 6.25 }, '4,3',
      { w: 1.25 }, '4,4',
      { w: 1.25 }, '4,5',
      { w: 1.25 }, '4,6',
      { w: 1.25 }, '4,7',
    ],
  ]).keys
}

function row(dayMs: number, rowIdx: number, col: number, count: number): TypingMatrixCellDailyRow {
  return { dayMs, layer: 0, row: rowIdx, col, count, tap: count, hold: 0 }
}

const KEYS = buildAnsi60()
const ERGO_BY_POS = buildErgonomicsByPos(KEYS)

// 2026-04-06 is a Monday → matches the snapBucketStartLocal "Monday
// anchor" semantics so a single weekly bucket starts there.
const WEEK_OF_APR_06 = new Date(2026, 3, 6).getTime()
const RANGE = { fromMs: WEEK_OF_APR_06, toMs: WEEK_OF_APR_06 + 86_400_000 * 30 }

describe('buildLearningCurve', () => {
  it('returns no buckets when given no rows', () => {
    const result = buildLearningCurve({
      rows: [],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
      minSampleKeystrokes: 0,
    })
    expect(result.period).toBe('week')
    expect(result.buckets).toEqual([])
  })

  it('skips rows outside the range', () => {
    const before = WEEK_OF_APR_06 - 86_400_000
    const after = RANGE.toMs + 86_400_000
    const result = buildLearningCurve({
      rows: [row(before, 2, 1, 100), row(after, 2, 1, 100)],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
      minSampleKeystrokes: 0,
    })
    expect(result.buckets).toEqual([])
  })

  it('skips rows with non-positive count', () => {
    const result = buildLearningCurve({
      rows: [row(WEEK_OF_APR_06, 2, 1, 0), row(WEEK_OF_APR_06, 2, 1, -5)],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
      minSampleKeystrokes: 0,
    })
    expect(result.buckets).toEqual([])
  })

  it('routes a single home-row left-pinky press into the right buckets', () => {
    const result = buildLearningCurve({
      rows: [row(WEEK_OF_APR_06, 2, 0, 100)], // ANSI Caps Lock pos → home row, left-pinky on this layout
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
      minSampleKeystrokes: 0,
    })
    expect(result.buckets).toHaveLength(1)
    const b = result.buckets[0]
    expect(b.totalKeystrokes).toBe(100)
    expect(b.handCounts.left).toBe(100)
    expect(b.handCounts.right).toBe(0)
    expect(b.rowCounts.home).toBe(100)
    expect(b.fingerCounts['left-pinky']).toBe(100)
    // 100 % home row → home stay = 1
    expect(b.homeRowStay).toBeCloseTo(1, 5)
    // 100 % on one hand → balance score = 0
    expect(b.handBalance).toBeCloseTo(0, 5)
    // 100 % on one finger → finger-load deviation = 0
    expect(b.fingerLoadDeviation).toBeCloseTo(0, 5)
    // overall = 0.30 * 1 = 0.30
    const expected =
      0 * LEARNING_SCORE_WEIGHTS.fingerLoadDeviation +
      0 * LEARNING_SCORE_WEIGHTS.handBalance +
      1 * LEARNING_SCORE_WEIGHTS.homeRowStay
    expect(b.overall).toBeCloseTo(expected, 5)
  })

  it('hits a perfect hand balance when both hands carry equal counts', () => {
    const result = buildLearningCurve({
      rows: [
        row(WEEK_OF_APR_06, 2, 1, 50), // left
        row(WEEK_OF_APR_06, 2, 7, 50), // right (J)
      ],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
      minSampleKeystrokes: 0,
    })
    expect(result.buckets).toHaveLength(1)
    expect(result.buckets[0].handBalance).toBeCloseTo(1, 5)
  })

  it('flags low-sample buckets as not qualified', () => {
    const result = buildLearningCurve({
      rows: [row(WEEK_OF_APR_06, 2, 1, 10)],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
      // default 1000; 10 keystrokes is well below.
    })
    expect(result.buckets[0].qualified).toBe(false)
  })

  it('marks buckets at or above the threshold as qualified', () => {
    const result = buildLearningCurve({
      rows: [row(WEEK_OF_APR_06, 2, 1, DEFAULT_LEARNING_MIN_SAMPLE)],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
    })
    expect(result.buckets[0].qualified).toBe(true)
  })

  it('groups rows from different days of the same week into one bucket', () => {
    const monday = WEEK_OF_APR_06
    const wednesday = WEEK_OF_APR_06 + 86_400_000 * 2
    const result = buildLearningCurve({
      rows: [row(monday, 2, 1, 100), row(wednesday, 2, 7, 100)],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
      minSampleKeystrokes: 0,
    })
    expect(result.buckets).toHaveLength(1)
    expect(result.buckets[0].totalKeystrokes).toBe(200)
  })

  it('splits rows from different weeks into separate buckets, ordered ascending', () => {
    const week1 = WEEK_OF_APR_06
    const week2 = WEEK_OF_APR_06 + 86_400_000 * 7
    const result = buildLearningCurve({
      rows: [row(week2, 2, 1, 50), row(week1, 2, 7, 80)],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
      minSampleKeystrokes: 0,
    })
    expect(result.buckets).toHaveLength(2)
    expect(result.buckets[0].bucketStartMs).toBeLessThan(result.buckets[1].bucketStartMs)
    expect(result.buckets[0].totalKeystrokes).toBe(80)
    expect(result.buckets[1].totalKeystrokes).toBe(50)
  })

  it('groups rows from the same calendar month when period = month', () => {
    const day1 = new Date(2026, 3, 1).getTime()
    const day2 = new Date(2026, 3, 28).getTime()
    const monthRange = { fromMs: new Date(2026, 3, 1).getTime(), toMs: new Date(2026, 5, 1).getTime() }
    const result = buildLearningCurve({
      rows: [row(day1, 2, 1, 100), row(day2, 2, 7, 100)],
      range: monthRange,
      period: 'month',
      ergonomicsByPos: ERGO_BY_POS,
      minSampleKeystrokes: 0,
    })
    expect(result.buckets).toHaveLength(1)
    expect(result.buckets[0].totalKeystrokes).toBe(200)
  })

  it('skips cells whose (row, col) is unknown to the ergonomics map', () => {
    const result = buildLearningCurve({
      rows: [row(WEEK_OF_APR_06, 99, 99, 500)],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
      minSampleKeystrokes: 0,
    })
    expect(result.buckets).toEqual([])
  })
})

describe('summarizeLearningCurve', () => {
  it('returns null when fewer than two qualified buckets exist', () => {
    expect(summarizeLearningCurve([])).toBeNull()
  })

  it('returns null when only one bucket is qualified', () => {
    const result = buildLearningCurve({
      rows: [
        row(WEEK_OF_APR_06, 2, 1, DEFAULT_LEARNING_MIN_SAMPLE),
        row(WEEK_OF_APR_06 + 86_400_000 * 7, 2, 7, 10),
      ],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
    })
    expect(summarizeLearningCurve(result.buckets)).toBeNull()
  })

  it('compares the latest qualified bucket against the mean of earlier buckets', () => {
    const result = buildLearningCurve({
      rows: [
        // Week 1: 100 % home row, 100 % left → fld 0, hb 0, hrs 1, overall = 0.30
        row(WEEK_OF_APR_06, 2, 0, DEFAULT_LEARNING_MIN_SAMPLE),
        // Week 2: 50/50 split, both home row → fld low, hb 1, hrs 1, overall ≥ 0.65
        row(WEEK_OF_APR_06 + 86_400_000 * 7, 2, 1, DEFAULT_LEARNING_MIN_SAMPLE / 2),
        row(WEEK_OF_APR_06 + 86_400_000 * 7, 2, 7, DEFAULT_LEARNING_MIN_SAMPLE / 2),
      ],
      range: RANGE,
      period: 'week',
      ergonomicsByPos: ERGO_BY_POS,
    })
    const trend = summarizeLearningCurve(result.buckets)
    expect(trend).not.toBeNull()
    expect(trend!.baselineCount).toBe(1)
    expect(trend!.delta).toBeGreaterThan(0)
    expect(trend!.latest.bucketStartMs).toBe(result.buckets[result.buckets.length - 1].bucketStartMs)
  })
})
