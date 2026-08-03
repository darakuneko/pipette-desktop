// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { deserialize } from '../../../shared/keycodes/keycodes'
import {
  buildWordTimeline,
  buildWordTimelineSummary,
  WORD_BLANK_THRESHOLD_MS as BLANK_THRESHOLD_MS,
  GAP_DISPLAY_CAP_MS,
  MIN_BAR_MS,
  type KeystrokeSegment,
} from '../word-timeline'
import type { RunKeystroke, RunKeystrokeLog, RunWord } from '../../../shared/types/typing-run-log'

const KC_A = deserialize('KC_A')

function keystroke(overrides: Partial<RunKeystroke> & { pressMs: number }): RunKeystroke {
  return { keycode: KC_A, row: 0, col: 0, ...overrides }
}

function word(overrides: Partial<RunWord> & { index: number; keystrokes: RunKeystroke[] }): RunWord {
  return { display: 'a', typed: 'a', correct: true, ...overrides }
}

function log(words: RunWord[], overrides: Partial<RunKeystrokeLog> = {}): RunKeystrokeLog {
  return {
    runId: 'run-1',
    uid: 'uid-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 60_000,
    mode: 'words',
    language: 'english',
    words,
    ...overrides,
  }
}

function keystrokeSegments(segments: ReturnType<typeof buildWordTimeline>['words'][number]['segments']): KeystrokeSegment[] {
  return segments.filter((s): s is KeystrokeSegment => s.kind === 'keystroke')
}

describe('buildWordTimeline', () => {
  it('renders an empty word with zero lanes and no scored stats', () => {
    const model = buildWordTimeline(log([word({ index: 0, keystrokes: [] })]))
    const w = model.words[0]
    expect(w.segments).toEqual([])
    expect(w.laneCount).toBe(0)
    expect(w.stats.durationMs).toBe(0)
    expect(w.stats.accuracy).toBeUndefined()
    expect(w.stats.wordPace).toBeUndefined()
    expect(w.stats.overlapRate).toBeUndefined()
  })

  it('renders a single keystroke with an observed release, carrying its true press ms verbatim', () => {
    const model = buildWordTimeline(log([
      word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 80, correct: true, expectedChar: 'a' })] }),
    ]))
    const w = model.words[0]
    expect(w.laneCount).toBe(1)
    const [seg] = keystrokeSegments(w.segments)
    expect(seg.startMs).toBe(0)
    expect(seg.endMs).toBe(80)
    expect(seg.trueStartMs).toBe(0)
    expect(seg.openEnded).toBeUndefined()
    expect(seg.lane).toBe(0)
    expect(w.stats.durationMs).toBe(80)
  })

  it('falls back to MIN_BAR_MS with openEnded when the release was never observed', () => {
    const model = buildWordTimeline(log([
      word({ index: 0, keystrokes: [keystroke({ pressMs: 0 })] }),
    ]))
    const [seg] = keystrokeSegments(model.words[0].segments)
    expect(seg.endMs).toBe(MIN_BAR_MS)
    expect(seg.openEnded).toBe(true)
  })

  it('corrects display-cursor drift after an openEnded bar: the next bar starts at the true press-to-press offset, not that offset plus the fabricated sliver width', () => {
    // k0 has no observed release, so its bar is a MIN_BAR_MS fallback
    // sliver (display end = 30) that does not reflect a real duration.
    // k1's true press-to-press offset from k0 is 500ms; the display
    // cursor must land exactly there, not at 30 + 500 = 530 (which is
    // what a naive "gap = raw press delta" carry-forward would produce,
    // double-counting the sliver's own fabricated width).
    const model = buildWordTimeline(log([
      word({
        index: 0,
        keystrokes: [
          keystroke({ pressMs: 0 }),
          keystroke({ pressMs: 500 }),
        ],
      }),
    ]))
    const segs = keystrokeSegments(model.words[0].segments)
    expect(segs).toHaveLength(2)
    expect(segs[0].endMs).toBe(MIN_BAR_MS)
    // No blank segment: an unobserved release is never eligible for gap
    // measurement, even though the raw press-to-press delta is sizeable.
    expect(model.words[0].segments.some((s) => s.kind === 'blank')).toBe(false)
    expect(segs[1].startMs).toBe(500)
    expect(segs[1].openEnded).toBe(true)
  })

  it('emits a blank segment and caps its axis contribution at GAP_DISPLAY_CAP_MS regardless of true length', () => {
    const hugeGap = BLANK_THRESHOLD_MS * 50
    const model = buildWordTimeline(log([
      word({
        index: 0,
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 50 }),
          keystroke({ pressMs: 50 + hugeGap, releaseMs: 50 + hugeGap + 40 }),
        ],
      }),
    ]))
    const w = model.words[0]
    const blank = w.segments.find((s) => s.kind === 'blank')
    expect(blank).toBeDefined()
    if (blank?.kind !== 'blank') throw new Error('expected blank segment')
    expect(blank.trueDurationMs).toBe(hugeGap)
    expect(blank.startMs).toBe(50)
    expect(blank.endMs).toBe(50 + GAP_DISPLAY_CAP_MS)
    const segs = keystrokeSegments(w.segments)
    // Second bar starts exactly GAP_DISPLAY_CAP_MS after the first bar's
    // end, never the true (much larger) gap.
    expect(segs[1].startMs).toBe(segs[0].endMs + GAP_DISPLAY_CAP_MS)
    // The word's own true duration still reflects the real elapsed time.
    expect(w.stats.durationMs).toBe(50 + hugeGap + 40)
  })

  it('does not compress a gap well below the cap', () => {
    const model = buildWordTimeline(log([
      word({
        index: 0,
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 50 }),
          keystroke({ pressMs: 250, releaseMs: 300 }),
        ],
      }),
    ]))
    const segs = keystrokeSegments(model.words[0].segments)
    expect(segs[1].startMs).toBe(250)
    expect(model.words[0].segments.some((s) => s.kind === 'blank')).toBe(false)
  })

  it('caps a sub-BLANK_THRESHOLD_MS gap at GAP_DISPLAY_CAP_MS without emitting a blank marker (monotonicity: no gap ever contributes more axis width than the cap)', () => {
    const model = buildWordTimeline(log([
      word({
        index: 0,
        keystrokes: [
          // True gap = 500ms — well below BLANK_THRESHOLD_MS (1000) so no
          // blank marker, but above GAP_DISPLAY_CAP_MS (250) so its axis
          // contribution is still capped, unlike the old scheme where
          // only >=BLANK_THRESHOLD_MS gaps were ever compressed.
          keystroke({ pressMs: 0, releaseMs: 50 }),
          keystroke({ pressMs: 550, releaseMs: 600 }),
        ],
      }),
    ]))
    const segs = keystrokeSegments(model.words[0].segments)
    expect(model.words[0].segments.some((s) => s.kind === 'blank')).toBe(false)
    expect(segs[1].startMs).toBe(50 + GAP_DISPLAY_CAP_MS)
    // The word's own true duration still reflects the real elapsed time.
    expect(model.words[0].stats.durationMs).toBe(600)
  })

  it('assigns nested 3-deep overlapping keystrokes to 3 distinct lanes (hand-computed)', () => {
    // k0: [0,200], k1: [50,150] nested inside k0, k2: [80,100] nested
    // inside both. All gaps are negative (real overlap), so display
    // positions pass through uncompressed and equal the true ms exactly.
    const model = buildWordTimeline(log([
      word({
        index: 0,
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 200 }),
          keystroke({ pressMs: 50, releaseMs: 150, overlapped: true }),
          keystroke({ pressMs: 80, releaseMs: 100, overlapped: true }),
        ],
      }),
    ]))
    const segs = keystrokeSegments(model.words[0].segments)
    expect(segs).toEqual([
      expect.objectContaining({ startMs: 0, endMs: 200, lane: 0 }),
      expect.objectContaining({ startMs: 50, endMs: 150, lane: 1 }),
      expect.objectContaining({ startMs: 80, endMs: 100, lane: 2 }),
    ])
    expect(model.words[0].laneCount).toBe(3)
  })

  it('reuses a freed lane once its occupant has ended', () => {
    // k0 [0,100], k1 overlaps k0 -> lane 1, k2 starts at 150 (after both
    // k0 and k1 have ended) -> should reuse lane 0, not open a 3rd lane.
    const model = buildWordTimeline(log([
      word({
        index: 0,
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 100 }),
          keystroke({ pressMs: 50, releaseMs: 120 }),
          keystroke({ pressMs: 150, releaseMs: 200 }),
        ],
      }),
    ]))
    const segs = keystrokeSegments(model.words[0].segments)
    expect(segs.map((s) => s.lane)).toEqual([0, 1, 0])
    expect(model.words[0].laneCount).toBe(2)
  })

  it('preserves overlapped tri-state: undefined denominator entries are excluded, not counted as non-overlap', () => {
    const model = buildWordTimeline(log([
      word({
        index: 0,
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 50, overlapped: undefined }),
          keystroke({ pressMs: 60, releaseMs: 100, overlapped: true }),
          keystroke({ pressMs: 110, releaseMs: 150, overlapped: false }),
        ],
      }),
    ]))
    // Only 2 of 3 keystrokes have an observed overlap verdict; 1/2 = 0.5.
    expect(model.words[0].stats.overlapRate).toBe(0.5)
  })

  it('reports overlapRate as undefined (not 0) when no keystroke has an observed verdict', () => {
    const model = buildWordTimeline(log([
      word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
    ]))
    expect(model.words[0].stats.overlapRate).toBeUndefined()
  })

  it('leaves a partial word unscored (no wordPace/accuracy) while still rendering its segments', () => {
    const model = buildWordTimeline(log([
      word({
        index: 0,
        partial: true,
        display: 'wor',
        typed: 'wo',
        keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 }), keystroke({ pressMs: 60, releaseMs: 110 })],
      }),
    ]))
    const w = model.words[0]
    expect(w.partial).toBe(true)
    expect(w.stats.accuracy).toBeUndefined()
    expect(w.stats.wordPace).toBeUndefined()
    expect(keystrokeSegments(w.segments)).toHaveLength(2)
  })

  it('computes wordPace and accuracy for a fully-scored word, withholding the separator credit since it is the run\'s (only, hence last) word', () => {
    const model = buildWordTimeline(log([
      word({
        index: 0,
        display: 'hi',
        typed: 'hi',
        keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 }), keystroke({ pressMs: 60, releaseMs: 6060 })],
      }),
    ]))
    const w = model.words[0]
    // correct = 2 chars (no separator credit — this is the run's only,
    // therefore last, word: see the `isRunLastWord` rule); span =
    // 6060ms = 0.101 min.
    expect(w.stats.accuracy).toBe(100)
    expect(w.stats.wordPace).toBeCloseTo((2 / 5) / (6060 / 60_000), 5)
  })

  it('credits the separator for every word except the run\'s actual last one (matches History\'s handleSpace vs tryFinishLastWord accounting)', () => {
    const model = buildWordTimeline(log([
      word({ index: 0, display: 'hi', typed: 'hi', keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 }), keystroke({ pressMs: 60, releaseMs: 6060 })] }),
      word({ index: 1, display: 'go', typed: 'go', keystrokes: [keystroke({ pressMs: 7000, releaseMs: 7050 }), keystroke({ pressMs: 7060, releaseMs: 13060 })] }),
    ]))
    // Word 0 is not the run's last word — it keeps the +1 separator
    // credit (correct = 3). Word 1 IS the run's last word — no credit
    // (correct = 2). Both words are otherwise identical in shape, so any
    // difference in wordPace is attributable entirely to the credit.
    expect(model.words[0].stats.wordPace).toBeCloseTo((3 / 5) / (6060 / 60_000), 5)
    expect(model.words[1].stats.wordPace).toBeCloseTo((2 / 5) / (6060 / 60_000), 5)
  })

  it('emits a leadInPause marker when the gap since the previous word exceeds the threshold, and nothing for the very first word', () => {
    const model = buildWordTimeline(log([
      word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      word({ index: 1, keystrokes: [keystroke({ pressMs: 50 + BLANK_THRESHOLD_MS + 500, releaseMs: 50 + BLANK_THRESHOLD_MS + 550 })] }),
    ]))
    expect(model.words[0].segments.some((s) => s.kind === 'leadInPause')).toBe(false)
    const leadIn = model.words[1].segments.find((s) => s.kind === 'leadInPause')
    expect(leadIn).toBeDefined()
    if (leadIn?.kind !== 'leadInPause') throw new Error('expected leadInPause segment')
    expect(leadIn.trueDurationMs).toBe(BLANK_THRESHOLD_MS + 500)
    expect(leadIn.startMs).toBe(0)
    expect(leadIn.endMs).toBe(GAP_DISPLAY_CAP_MS)
    // The keystroke after the marker starts GAP_DISPLAY_CAP_MS into the row.
    const [seg] = keystrokeSegments(model.words[1].segments)
    expect(seg.startMs).toBe(GAP_DISPLAY_CAP_MS)
  })

  it('skips an empty word for cross-word lead-in accounting (carries the last real word forward)', () => {
    const model = buildWordTimeline(log([
      word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      word({ index: 1, keystrokes: [] }),
      word({ index: 2, keystrokes: [keystroke({ pressMs: 50 + BLANK_THRESHOLD_MS + 100, releaseMs: 50 + BLANK_THRESHOLD_MS + 140 })] }),
    ]))
    expect(model.words[2].segments.some((s) => s.kind === 'leadInPause')).toBe(true)
  })

  it('uses the MAX observed boundary across all keystrokes for duration/lead-in, not the last press-ordered one\'s own end (a long hold released after a later keystroke must still count)', () => {
    // Shift pressed at 0, held/released at 2000 — well after Space
    // (pressed 100, released 150), which sorts AFTER Shift by press order
    // but ends far earlier. The word's true duration is 2000, not 150.
    const model = buildWordTimeline(log([
      word({
        index: 0,
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 2000 }),
          keystroke({ pressMs: 100, releaseMs: 150 }),
        ],
      }),
      // Pressed at 1600 — BEFORE the (wrongly-computed) 150+1000
      // threshold would trip, but well within 1000ms of the CORRECT last
      // observed boundary (2000), so no lead-in marker should appear.
      word({ index: 1, keystrokes: [keystroke({ pressMs: 1600, releaseMs: 1650 })] }),
    ]))
    expect(model.words[0].stats.durationMs).toBe(2000)
    expect(model.words[1].segments.some((s) => s.kind === 'leadInPause')).toBe(false)
  })

  it('passes charCorrelationUnavailable through to the model, defaulting to false', () => {
    const withFlag = buildWordTimeline(log([word({ index: 0, keystrokes: [] })], { charCorrelationUnavailable: true }))
    expect(withFlag.charCorrelationUnavailable).toBe(true)
    const withoutFlag = buildWordTimeline(log([word({ index: 0, keystrokes: [] })]))
    expect(withoutFlag.charCorrelationUnavailable).toBe(false)
  })

  it('shares one maxDisplayMs across all words, driven by the longest row', () => {
    const model = buildWordTimeline(log([
      word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      word({
        index: 1,
        keystrokes: [
          keystroke({ pressMs: 50 + BLANK_THRESHOLD_MS + 100, releaseMs: 50 + BLANK_THRESHOLD_MS + 140 }),
          keystroke({ pressMs: 50 + BLANK_THRESHOLD_MS + 5000, releaseMs: 50 + BLANK_THRESHOLD_MS + 5040 }),
        ],
      }),
    ]))
    expect(model.maxDisplayMs).toBeGreaterThan(0)
    const rowMax = (i: number) => Math.max(...keystrokeSegments(model.words[i].segments).map((s) => s.endMs), 0)
    expect(model.maxDisplayMs).toBe(Math.max(rowMax(0), rowMax(1)))
  })

  it('resolves a tooltip label from expectedChar first, falling back to the keycode, and carries each keystroke\'s true press ms verbatim', () => {
    const model = buildWordTimeline(log([
      word({
        index: 0,
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 10, expectedChar: 'a' }),
          keystroke({ pressMs: 20, releaseMs: 30, keycode: deserialize('KC_B') }),
        ],
      }),
    ]))
    const segs = keystrokeSegments(model.words[0].segments)
    expect(segs[0].label).toBe('a')
    expect(segs[1].label).toBe('b')
    expect(segs[0].trueStartMs).toBe(0)
    expect(segs[1].trueStartMs).toBe(20)
  })

  it('withholds accuracy/wordPace for every word in a romaji-input run (typed/display live in different text spaces), while overlap/duration stay', () => {
    const model = buildWordTimeline(log([
      word({
        index: 0,
        display: 'あ',
        typed: 'a',
        keystrokes: [keystroke({ pressMs: 0, releaseMs: 50, overlapped: true }), keystroke({ pressMs: 60, releaseMs: 110, overlapped: false })],
      }),
    ], { romajiInput: true }))
    const w = model.words[0]
    expect(w.stats.accuracy).toBeUndefined()
    expect(w.stats.wordPace).toBeUndefined()
    expect(w.stats.durationMs).toBe(110)
    expect(w.stats.overlapRate).toBe(0.5)
    expect(keystrokeSegments(w.segments)).toHaveLength(2)
  })

  it('treats an absent romajiInput flag (pre-flag log) as non-romaji, scoring normally', () => {
    const model = buildWordTimeline(log([
      word({ index: 0, display: 'hi', typed: 'hi', keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
    ]))
    expect(model.words[0].stats.accuracy).toBe(100)
  })
})

describe('buildWordTimelineSummary', () => {
  it('returns all-undefined averages for an empty model (no words)', () => {
    const model = buildWordTimeline(log([]))
    const summary = buildWordTimelineSummary(model)
    expect(summary.avgPace).toBeUndefined()
    expect(summary.avgAccuracy).toBeUndefined()
    expect(summary.avgOverlap).toBeUndefined()
  })

  it('returns all-undefined averages when every word is partial (nothing scored)', () => {
    const model = buildWordTimeline(log([
      word({ index: 0, partial: true, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      word({ index: 1, partial: true, keystrokes: [keystroke({ pressMs: 60, releaseMs: 110 })] }),
    ]))
    const summary = buildWordTimelineSummary(model)
    expect(summary.avgPace).toBeUndefined()
    expect(summary.avgAccuracy).toBeUndefined()
  })

  it('pools accuracy/pace across scored words only, skipping a partial word', () => {
    const model = buildWordTimeline(log([
      word({ index: 0, display: 'hi', typed: 'hi', keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 }), keystroke({ pressMs: 60, releaseMs: 6060 })] }),
      word({ index: 1, partial: true, display: 'wor', typed: 'wo', keystrokes: [keystroke({ pressMs: 7000, releaseMs: 7050 })] }),
    ]))
    const summary = buildWordTimelineSummary(model)
    expect(summary.avgAccuracy).toBe(100)
    expect(summary.avgPace).toBe(model.words[0].stats.wordPace)
  })

  it('pools accuracy by char count (not a mean of per-word ratios): a 100%-accuracy 10-char word and a 0%-accuracy 1-char word average to 91.7%, not 50%', () => {
    const model = buildWordTimeline(log([
      // Word 0 (not the run's last word — keeps its separator credit):
      // 10 chars, all correct. correctChars = 10 + 1 (credit) = 11,
      // incorrectChars = 0 — its own accuracy is 100%.
      word({ index: 0, display: 'abcdefghij', typed: 'abcdefghij', keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      // Word 1 (the run's LAST word — separator credit withheld, see
      // the isRunLastWord rule): 1 mismatched char. counts.correct = 0
      // (no match) + 1 (credit) = 1, then the credit is removed since
      // this is the last word -> correctChars = 0, incorrectChars = 1 —
      // its own accuracy is 0%.
      word({ index: 1, display: 'a', typed: 'b', keystrokes: [keystroke({ pressMs: 100, releaseMs: 150 })] }),
    ]))
    const summary = buildWordTimelineSummary(model)
    // Naive mean of the two words' own accuracy would be (100 + 0) / 2 =
    // 50%. Pooled by char count instead: (11 + 0) / (11 + 0 + 0 + 1) =
    // 11/12 ≈ 91.7% — the 10-char word correctly dominates a 1-char word.
    expect(model.words[0].stats.accuracy).toBe(100)
    expect(model.words[1].stats.accuracy).toBe(0)
    expect(summary.avgAccuracy).toBeCloseTo((11 / 12) * 100, 5)
  })

  it('pools overlap by keystroke count (not a mean of per-word ratios): 1 true out of 6 observed keystrokes averages to 16.7%, not 50%', () => {
    const model = buildWordTimeline(log([
      // Word 0: a single keystroke, truly overlapped — its own ratio is
      // 1/1 = 100%.
      word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50, overlapped: true })] }),
      // Word 1: 5 keystrokes, none overlapped — its own ratio is 0/5 = 0%.
      word({
        index: 1,
        keystrokes: [
          keystroke({ pressMs: 200, releaseMs: 210, overlapped: false }),
          keystroke({ pressMs: 220, releaseMs: 230, overlapped: false }),
          keystroke({ pressMs: 240, releaseMs: 250, overlapped: false }),
          keystroke({ pressMs: 260, releaseMs: 270, overlapped: false }),
          keystroke({ pressMs: 280, releaseMs: 290, overlapped: false }),
        ],
      }),
    ]))
    // A naive mean of the two words' own ratios would give (1.0 + 0.0) /
    // 2 = 50% — exactly the kind of shipped-screenshot bug (a 1-keystroke
    // word's 100% ratio distorting the run-wide figure) this pooling
    // exists to fix. Pooled across all 6 observed keystrokes: 1/6 ≈ 16.7%.
    expect(buildWordTimelineSummary(model).avgOverlap).toBeCloseTo(1 / 6, 5)
    expect(buildWordTimelineSummary(model).avgOverlap).toBeCloseTo(0.167, 2)
  })

  it('averages overlapRate across ALL words (partial included), independent of scoring', () => {
    const model = buildWordTimeline(log([
      word({
        index: 0,
        partial: true,
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 50, overlapped: true }),
          keystroke({ pressMs: 60, releaseMs: 110, overlapped: false }),
        ],
      }),
      word({ index: 1, keystrokes: [keystroke({ pressMs: 200, releaseMs: 250, overlapped: true })] }),
    ]))
    // word 0: 1/2, word 1: 1/1 — pooled across keystrokes: (1+1)/(2+1) = 2/3.
    expect(buildWordTimelineSummary(model).avgOverlap).toBeCloseTo(2 / 3, 5)
  })

  it('span-weights pace (Σ correct chars / 5 over Σ true span minutes), not a mean of per-word rates', () => {
    const model = buildWordTimeline(log([
      // Word 0: 2 correct chars (+1 credit, not the run's last word),
      // true span 60,000ms = 1 minute — pace 0.6 wpm on its own.
      word({ index: 0, display: 'hi', typed: 'hi', keystrokes: [keystroke({ pressMs: 0, releaseMs: 60_000 })] }),
      // Word 1 (run's last word, no credit): 2 correct chars, true span
      // 6000ms = 0.1 minute — pace 4 wpm on its own.
      word({ index: 1, display: 'go', typed: 'go', keystrokes: [keystroke({ pressMs: 70_000, releaseMs: 76_000 })] }),
    ]))
    const summary = buildWordTimelineSummary(model)
    // correctSum = 3 (word0, credited) + 2 (word1, uncredited) = 5.
    // spanMinutesSum = 1 + 0.1 = 1.1.
    // avgPace = (5/5) / 1.1 = 1/1.1.
    expect(summary.avgPace).toBeCloseTo(1 / 1.1, 5)
    // Confirm this differs from a naive per-word mean, which would be
    // ((3/5)/1 + (2/5)/0.1) / 2 = (0.6 + 4) / 2 = 2.3.
    expect(summary.avgPace).not.toBeCloseTo(2.3, 1)
  })

  it('excludes a zero-span scored word from avgPace (its chars would inflate the numerator with nothing added to the denominator) while avgAccuracy still pools it', () => {
    const model = buildWordTimeline(log([
      // Word 0 (not the run's last word — keeps its separator credit):
      // 3 matched chars + 1 credit = 4 correct chars, true span 300ms.
      word({ index: 0, display: 'abc', typed: 'abc', keystrokes: [keystroke({ pressMs: 0, releaseMs: 300 })] }),
      // Word 1 (the run's last word — credit withheld): a single
      // open-ended keystroke (no releaseMs), so its true span is
      // pressMs - pressMs = 0. Still fully scored — accuracy is defined
      // (2 matched chars, 0 incorrect) — but wordPace is withheld since
      // there is no measurable span to derive a rate from.
      word({ index: 1, display: 'de', typed: 'de', keystrokes: [keystroke({ pressMs: 1000 })] }),
    ]))
    const summary = buildWordTimelineSummary(model)
    expect(model.words[0].stats.wordPace).toBeCloseTo(160, 5)
    expect(model.words[1].stats.wordPace).toBeUndefined()
    expect(model.words[1].stats.accuracy).toBe(100)
    // avgPace derives from word 0 alone: (4/5) / (300/60_000) = 0.8/0.005 = 160.
    // A pre-fix pooling of correctSum (4+2=6) over spanMinutesSum (0.005+0=0.005)
    // would have inflated this to 6/5/0.005 = 240.
    expect(summary.avgPace).toBe(model.words[0].stats.wordPace)
    expect(summary.avgPace).toBeCloseTo(160, 5)
    // avgAccuracy still pools both words: (4+2)/(4+2) = 100%.
    expect(summary.avgAccuracy).toBe(100)
  })

  it('excludes romaji-input words from avgPace/avgAccuracy but keeps avgOverlap', () => {
    const model = buildWordTimeline(log([
      word({
        index: 0,
        display: 'あ',
        typed: 'a',
        keystrokes: [keystroke({ pressMs: 0, releaseMs: 50, overlapped: true })],
      }),
    ], { romajiInput: true }))
    const summary = buildWordTimelineSummary(model)
    expect(summary.avgPace).toBeUndefined()
    expect(summary.avgAccuracy).toBeUndefined()
    expect(summary.avgOverlap).toBe(1)
  })
})
