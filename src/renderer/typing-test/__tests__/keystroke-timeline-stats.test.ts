// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { buildTimelineStatItems } from '../keystroke-timeline-stats'
import type { WordTimelineSummary } from '../word-timeline'
import type { TypingTestResult } from '../../../shared/types/pipette-settings'
import type { RunKeystrokeLog } from '../../../shared/types/typing-run-log'
import { EMPTY_STAT_VALUE } from '../../components/analyze/analyze-constants'

const SUMMARY: WordTimelineSummary = {}

function makeLog(overrides: Partial<RunKeystrokeLog> = {}): RunKeystrokeLog {
  return {
    runId: 'run-1',
    uid: 'uid-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 5000,
    mode: 'words',
    language: 'english',
    words: [],
    ...overrides,
  }
}

function makeResult(overrides: Partial<TypingTestResult> = {}): TypingTestResult {
  return {
    date: '2026-01-01T00:00:00.000Z',
    wpm: 42,
    accuracy: 95,
    wordCount: 10,
    correctChars: 50,
    incorrectChars: 2,
    durationSeconds: 10,
    ...overrides,
  }
}

/** The Words/Lines card is always LAST (index 10) in
 *  buildTimelineStatItems' own fixed ordering (WPM, KPM, Accuracy, KSPC,
 *  Substitution, Omission, Insertion, Overlap, Avg Key Hold, Time,
 *  Words/Lines). */
function wordsOrLinesItem(result: TypingTestResult | undefined, log: RunKeystrokeLog) {
  return buildTimelineStatItems(result, SUMMARY, log)[10]
}

describe('buildTimelineStatItems — card order', () => {
  it('renders the fixed related-metric order ending in Time and Words/Lines', () => {
    const items = buildTimelineStatItems(makeResult({}), SUMMARY, makeLog({}))
    expect(items.map((i) => i.labelKey)).toEqual([
      'editor.typingTest.history.timeline.stats.runWpm',
      'editor.typingTest.kpm',
      'editor.typingTest.history.timeline.stats.accuracy',
      'editor.typingTest.kspc',
      'editor.typingTest.history.errorMixLabelSubstitution',
      'editor.typingTest.history.errorMixLabelOmission',
      'editor.typingTest.history.errorMixLabelInsertion',
      'editor.typingTest.history.timeline.stats.overlap',
      'editor.typingTest.history.timeline.stats.avgHold',
      'editor.typingTest.time',
      'editor.typingTest.words',
    ])
  })
})

describe('buildTimelineStatItems — Words/Lines card branch table', () => {
  it('branch 1: log.lineBreaks present -> Lines, value = lineBreaks.length + 1, REGARDLESS of result.mode', () => {
    const log = makeLog({ lineBreaks: [2, 5] }) // 2 breaks -> 3 lines
    const item = wordsOrLinesItem(makeResult({ mode: 'words', wordCount: 999 }), log)
    expect(item.labelKey).toBe('editor.typingTest.lines')
    expect(item.value).toBe(3)
  })

  it('branch 1b: log.lineBreaks present as an empty array ([]) still counts as PRESENT -> Lines, value = 1', () => {
    // Presence, not emptiness, is the signal — see RunKeystrokeLog.lineBreaks's
    // own doc comment (a real single-line source is a legitimate `[]`).
    const log = makeLog({ lineBreaks: [] })
    const item = wordsOrLinesItem(undefined, log)
    expect(item.labelKey).toBe('editor.typingTest.lines')
    expect(item.value).toBe(1)
  })

  it('branch 1c: log.lineBreaks present, no result at all -> still Lines from the log alone', () => {
    const log = makeLog({ lineBreaks: [3] })
    const item = wordsOrLinesItem(undefined, log)
    expect(item.labelKey).toBe('editor.typingTest.lines')
    expect(item.value).toBe(2)
  })

  it('branch 2: log.lineBreaks absent, result.mode === "tatoeba" -> Lines, value = result.wordCount (each unit is one line)', () => {
    const log = makeLog({ mode: 'tatoeba' })
    const item = wordsOrLinesItem(makeResult({ mode: 'tatoeba', wordCount: 10 }), log)
    expect(item.labelKey).toBe('editor.typingTest.lines')
    expect(item.value).toBe(10)
  })

  it('branch 3: log.lineBreaks absent, result.mode === "fileImport" -> keep Words (line count unknowable without the log\'s own lineBreaks)', () => {
    const log = makeLog({ mode: 'fileImport' })
    const item = wordsOrLinesItem(makeResult({ mode: 'fileImport', wordCount: 7 }), log)
    expect(item.labelKey).toBe('editor.typingTest.words')
    expect(item.value).toBe(7)
  })

  it('branch 4: Monkeytype modes (words/time/quote) -> keep Words, unchanged', () => {
    for (const mode of ['words', 'time', 'quote'] as const) {
      const log = makeLog({ mode })
      const item = wordsOrLinesItem(makeResult({ mode, wordCount: 15 }), log)
      expect(item.labelKey).toBe('editor.typingTest.words')
      expect(item.value).toBe(15)
    }
  })

  it('branch 5: no result and no log.lineBreaks -> Words card with EMPTY_STAT_VALUE (unchanged fallback)', () => {
    const log = makeLog()
    const item = wordsOrLinesItem(undefined, log)
    expect(item.labelKey).toBe('editor.typingTest.words')
    expect(item.value).toBe(EMPTY_STAT_VALUE)
  })

  it('branch 6: result present but result.mode undefined (legacy result, no log.lineBreaks) -> keep Words', () => {
    const log = makeLog()
    const item = wordsOrLinesItem(makeResult({ mode: undefined, wordCount: 4 }), log)
    expect(item.labelKey).toBe('editor.typingTest.words')
    expect(item.value).toBe(4)
  })
})

/** The Avg Key Hold card sits at index 8 in buildTimelineStatItems'
 *  fixed ordering (between Overlap and Time). */
function avgHoldItem(result: TypingTestResult | undefined, summary: WordTimelineSummary, log: RunKeystrokeLog) {
  return buildTimelineStatItems(result, summary, log)[8]
}

describe('buildTimelineStatItems — Avg Key Hold card', () => {
  it('prefers the persisted result raw pair over the model summary when both are present', () => {
    const result = makeResult({ holdSumMs: 240, holdSamples: 3 }) // mean 80
    const summary: WordTimelineSummary = { avgHoldMs: 999 }
    const item = avgHoldItem(result, summary, makeLog())
    expect(item.labelKey).toBe('editor.typingTest.history.timeline.stats.avgHold')
    expect(item.value).toBe('80 ms')
    expect(item.descriptionKey).toBe('editor.typingTest.history.timeline.stats.avgHoldTooltip')
  })

  it('falls back to the model summary when no result is available', () => {
    const summary: WordTimelineSummary = { avgHoldMs: 142 }
    const item = avgHoldItem(undefined, summary, makeLog())
    expect(item.value).toBe('142 ms')
  })

  it('falls back to the model summary when a result is present but predates this field (legacy row)', () => {
    const result = makeResult()
    const summary: WordTimelineSummary = { avgHoldMs: 55 }
    const item = avgHoldItem(result, summary, makeLog())
    expect(item.value).toBe('55 ms')
  })

  it('shows the empty placeholder when neither the result nor the model summary has a sample', () => {
    const item = avgHoldItem(makeResult(), SUMMARY, makeLog())
    expect(item.value).toBe(EMPTY_STAT_VALUE)
  })
})
