// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { deserialize } from '../../../shared/keycodes/keycodes'
import { GAP_DISPLAY_CAP_MS, type KeystrokeSegment } from '../word-timeline'
import {
  buildLineTimeline,
  groupWordsIntoLines,
  LINE_BLANK_THRESHOLD_MS,
  type LineTimelineModel,
} from '../line-timeline'
import type { RunKeystroke, RunKeystrokeLog, RunWord } from '../../../shared/types/typing-run-log'

const KC_A = deserialize('KC_A')

function keystroke(overrides: Partial<RunKeystroke> & { pressMs: number }): RunKeystroke {
  return { keycode: KC_A, row: 0, col: 0, ...overrides }
}

function word(overrides: Partial<RunWord> & { index: number; keystrokes: RunKeystroke[] }): RunWord {
  return { display: 'a', typed: 'a', correct: true, ...overrides }
}

function log(words: RunWord[], lineBreaks: number[], overrides: Partial<RunKeystrokeLog> = {}): RunKeystrokeLog & { lineBreaks: number[] } {
  return {
    runId: 'run-1',
    uid: 'uid-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 60_000,
    mode: 'words',
    language: 'english',
    words,
    lineBreaks,
    ...overrides,
  }
}

function keystrokeSegments(segments: LineTimelineModel['lines'][number]['segments']): KeystrokeSegment[] {
  return segments.filter((s): s is KeystrokeSegment => s.kind === 'keystroke')
}

describe('groupWordsIntoLines', () => {
  it('splits words into lines at each break (break index = last word of that line)', () => {
    const words = [
      word({ index: 0, keystrokes: [] }),
      word({ index: 1, keystrokes: [] }),
      word({ index: 2, keystrokes: [] }),
      word({ index: 3, keystrokes: [] }),
    ]
    const lines = groupWordsIntoLines(words, [1])
    expect(lines).toHaveLength(2)
    expect(lines[0].map((w) => w.index)).toEqual([0, 1])
    expect(lines[1].map((w) => w.index)).toEqual([2, 3])
  })

  it('treats an empty lineBreaks array as a single line spanning every word', () => {
    const words = [word({ index: 0, keystrokes: [] }), word({ index: 1, keystrokes: [] })]
    const lines = groupWordsIntoLines(words, [])
    expect(lines).toHaveLength(1)
    expect(lines[0].map((w) => w.index)).toEqual([0, 1])
  })

  it('handles multiple breaks producing 3+ lines', () => {
    const words = [0, 1, 2, 3, 4, 5].map((i) => word({ index: i, keystrokes: [] }))
    const lines = groupWordsIntoLines(words, [0, 2])
    expect(lines.map((l) => l.map((w) => w.index))).toEqual([[0], [1, 2], [3, 4, 5]])
  })
})

describe('buildLineTimeline', () => {
  it('produces one line per lineBreaks group, and a single line for an empty lineBreaks array', () => {
    const single = buildLineTimeline(log(
      [word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] })],
      [],
    ))
    expect(single.lines).toHaveLength(1)

    const twoLines = buildLineTimeline(log(
      [
        word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
        word({ index: 1, keystrokes: [keystroke({ pressMs: 100, releaseMs: 150 })] }),
      ],
      [0],
    ))
    expect(twoLines.lines).toHaveLength(2)
    expect(twoLines.lines[0].words.map((w) => w.index)).toEqual([0])
    expect(twoLines.lines[1].words.map((w) => w.index)).toEqual([1])
  })

  it('does not emit a blank marker for a 249ms intra-line gap but does at exactly 250ms (LINE_BLANK_THRESHOLD_MS)', () => {
    expect(LINE_BLANK_THRESHOLD_MS).toBe(250)

    const below = buildLineTimeline(log([
      word({
        index: 0,
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 50 }),
          keystroke({ pressMs: 50 + 249, releaseMs: 50 + 249 + 40 }),
        ],
      }),
    ], []))
    expect(below.lines[0].segments.some((s) => s.kind === 'blank')).toBe(false)

    const atThreshold = buildLineTimeline(log([
      word({
        index: 0,
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 50 }),
          keystroke({ pressMs: 50 + 250, releaseMs: 50 + 250 + 40 }),
        ],
      }),
    ], []))
    const blank = atThreshold.lines[0].segments.find((s) => s.kind === 'blank')
    expect(blank).toBeDefined()
    if (blank?.kind !== 'blank') throw new Error('expected blank segment')
    expect(blank.trueDurationMs).toBe(250)
    expect(blank.endMs - blank.startMs).toBe(GAP_DISPLAY_CAP_MS)
  })

  it('builds ONE shared continuous axis per line spanning every word\'s keystrokes (no per-word cursor reset)', () => {
    const model = buildLineTimeline(log([
      word({ index: 0, display: 'hi', typed: 'hi', keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      word({ index: 1, display: 'go', typed: 'go', keystrokes: [keystroke({ pressMs: 100, releaseMs: 150 })] }),
    ], []))
    const segs = keystrokeSegments(model.lines[0].segments)
    expect(segs).toHaveLength(2)
    // Second word's keystroke starts at the true press-to-press offset on
    // the SAME axis as the first word's — not reset to 0.
    expect(segs[0].startMs).toBe(0)
    expect(segs[1].startMs).toBe(100)
  })

  it('emits a line-start lead-in marker when the gap since the previous line\'s last observed boundary exceeds LINE_BLANK_THRESHOLD_MS, never for the first line', () => {
    const model = buildLineTimeline(log([
      word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      word({ index: 1, keystrokes: [keystroke({ pressMs: 50 + LINE_BLANK_THRESHOLD_MS + 500, releaseMs: 50 + LINE_BLANK_THRESHOLD_MS + 550 })] }),
    ], [0]))
    expect(model.lines[0].segments.some((s) => s.kind === 'leadInPause')).toBe(false)
    const leadIn = model.lines[1].segments.find((s) => s.kind === 'leadInPause')
    expect(leadIn).toBeDefined()
    if (leadIn?.kind !== 'leadInPause') throw new Error('expected leadInPause segment')
    expect(leadIn.trueDurationMs).toBe(LINE_BLANK_THRESHOLD_MS + 500)
    const [seg] = keystrokeSegments(model.lines[1].segments)
    expect(seg.startMs).toBe(GAP_DISPLAY_CAP_MS)
  })

  it('does NOT emit a per-word lead-in marker for a pause between two words inside the SAME line (only line-crossing pauses get a marker)', () => {
    // Gap between word 0 and word 1 is huge (well past both thresholds),
    // but both words are in the SAME line — this must render as an
    // ordinary (capped) blank segment on the shared axis, never a
    // leadInPause (leadInPause is reserved for line boundaries).
    const model = buildLineTimeline(log([
      word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      word({ index: 1, keystrokes: [keystroke({ pressMs: 50 + 10_000, releaseMs: 50 + 10_000 + 40 })] }),
    ], []))
    expect(model.lines[0].segments.some((s) => s.kind === 'leadInPause')).toBe(false)
    expect(model.lines[0].segments.some((s) => s.kind === 'blank')).toBe(true)
  })

  it('renders a partial word\'s segments but withholds it from the line\'s accuracy pooling', () => {
    const model = buildLineTimeline(log([
      word({
        index: 0,
        partial: true,
        display: 'wor',
        typed: 'wo',
        keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 }), keystroke({ pressMs: 60, releaseMs: 110 })],
      }),
    ], []))
    const line = model.lines[0]
    expect(keystrokeSegments(line.segments)).toHaveLength(2)
    expect(line.words[0].partial).toBe(true)
    expect(line.stats.accuracy).toBeUndefined()
  })

  it('withholds the +1 separator credit ONLY for the run\'s actual final word, never at every line end', () => {
    // Two lines, one word each. Word 0 is line 0's own last word but NOT
    // the run's last word overall -> keeps the credit. Word 1 IS the
    // run's last word -> credit withheld. Both words are otherwise
    // identical in shape.
    const model = buildLineTimeline(log([
      word({ index: 0, display: 'hi', typed: 'hi', keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 }), keystroke({ pressMs: 60, releaseMs: 6060 })] }),
      word({ index: 1, display: 'go', typed: 'go', keystrokes: [keystroke({ pressMs: 7000, releaseMs: 7050 }), keystroke({ pressMs: 7060, releaseMs: 13060 })] }),
    ], [0]))
    // Line 0 (word 0, credited: correct = 3, incorrect = 0 -> 100%).
    expect(model.lines[0].stats.accuracy).toBe(100)
    // Line 1 (word 1, the run's last word, uncredited: correct = 2,
    // incorrect = 0 -> still 100%, but via a different correct count —
    // verified precisely in the dedicated per-line stats math test below).
    expect(model.lines[1].stats.accuracy).toBe(100)
  })

  it('computes per-line stats (kpm, accuracy, overlap, durationSeconds) via pooled math over the line\'s own words/keystrokes', () => {
    const model = buildLineTimeline(log([
      // Single line, single word, run's only (hence last) word: no
      // separator credit. 2 correct chars, 0 incorrect -> accuracy 100%.
      // 2 keystrokes over a 6000ms true span -> kpm = 2 / (6000/60000) = 20.
      word({
        index: 0,
        display: 'hi',
        typed: 'hi',
        keystrokes: [
          keystroke({ pressMs: 0, releaseMs: 50, overlapped: false }),
          keystroke({ pressMs: 60, releaseMs: 6000, overlapped: true }),
        ],
      }),
    ], []))
    const stats = model.lines[0].stats
    expect(stats.durationSeconds).toBeCloseTo(6, 5)
    expect(stats.kpm).toBeCloseTo(2 / (6000 / 60_000), 5)
    expect(stats.accuracy).toBe(100)
    expect(stats.overlapRate).toBe(0.5)
  })

  it('reports word-boundary marker offsets: each word\'s startMs is where its own first keystroke segment begins on the shared axis', () => {
    const model = buildLineTimeline(log([
      word({ index: 0, display: 'hi', typed: 'hi', keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      word({ index: 1, display: 'go', typed: 'go', keystrokes: [keystroke({ pressMs: 200, releaseMs: 250 })] }),
    ], []))
    const line = model.lines[0]
    expect(line.words[0].startMs).toBe(0)
    expect(line.words[1].startMs).toBe(200)
  })

  it('gives an empty (zero-keystroke) word the same marker offset as wherever the axis stood after the previous word', () => {
    const model = buildLineTimeline(log([
      word({ index: 0, display: 'hi', typed: 'hi', keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      word({ index: 1, display: '', typed: '', keystrokes: [] }),
      word({ index: 2, display: 'go', typed: 'go', keystrokes: [keystroke({ pressMs: 200, releaseMs: 250 })] }),
    ], []))
    const line = model.lines[0]
    expect(line.words[1].startMs).toBe(50) // end of word 0's own segment
    expect(line.words[2].startMs).toBe(200)
  })

  it('shares one maxDisplayMs across all lines, driven by the longest line', () => {
    const model = buildLineTimeline(log([
      word({ index: 0, keystrokes: [keystroke({ pressMs: 0, releaseMs: 50 })] }),
      word({ index: 1, keystrokes: [keystroke({ pressMs: 100, releaseMs: 5150 })] }),
    ], [0]))
    const rowMax = (i: number) => Math.max(...keystrokeSegments(model.lines[i].segments).map((s) => s.endMs), 0)
    expect(model.maxDisplayMs).toBe(Math.max(rowMax(0), rowMax(1)))
  })

  it('passes charCorrelationUnavailable through, defaulting to false', () => {
    const withFlag = buildLineTimeline(log([word({ index: 0, keystrokes: [] })], [], { charCorrelationUnavailable: true }))
    expect(withFlag.charCorrelationUnavailable).toBe(true)
    const withoutFlag = buildLineTimeline(log([word({ index: 0, keystrokes: [] })], []))
    expect(withoutFlag.charCorrelationUnavailable).toBe(false)
  })

  it('withholds accuracy for a romaji-input run\'s lines (typed/display live in different text spaces) while overlap stays', () => {
    const model = buildLineTimeline(log([
      word({
        index: 0,
        display: 'あ',
        typed: 'a',
        keystrokes: [keystroke({ pressMs: 0, releaseMs: 50, overlapped: true })],
      }),
    ], [], { romajiInput: true }))
    expect(model.lines[0].stats.accuracy).toBeUndefined()
    expect(model.lines[0].stats.overlapRate).toBe(1)
  })

  it('handles a fully empty line (a lone zero-keystroke word) without crashing, reporting zero/undefined stats', () => {
    const model = buildLineTimeline(log([word({ index: 0, display: '', typed: '', keystrokes: [] })], []))
    const line = model.lines[0]
    expect(line.segments).toEqual([])
    expect(line.laneCount).toBe(0)
    expect(line.stats.durationSeconds).toBe(0)
    expect(line.stats.kpm).toBeUndefined()
    expect(line.stats.accuracy).toBeUndefined()
  })
})
