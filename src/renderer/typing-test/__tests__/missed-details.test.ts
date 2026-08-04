// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { buildMissedDetails } from '../missed-details'
import type { RunKeystrokeLog, RunKeystroke, RunWord } from '../../../shared/types/typing-run-log'

function makeKeystroke(overrides: Partial<RunKeystroke> = {}): RunKeystroke {
  return { pressMs: 0, keycode: 1, row: 0, col: 0, ...overrides }
}

function makeWord(overrides: Partial<RunWord> = {}): RunWord {
  return { index: 0, display: 'hello', typed: 'hello', correct: true, keystrokes: [], ...overrides }
}

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

describe('buildMissedDetails', () => {
  it('bails out to an empty map when charCorrelationUnavailable', () => {
    const log = makeLog({
      charCorrelationUnavailable: true,
      words: [makeWord({
        display: 'hi', typed: 'xi', correct: false,
        keystrokes: [makeKeystroke({ correct: false, expectedChar: 'h', typedChar: 'x', mistakeKey: 'h' })],
      })],
    })
    expect(buildMissedDetails(log).size).toBe(0)
  })

  it('groups typedChar of incorrect keystrokes by mistakeKey (typedCounts)', () => {
    const log = makeLog({
      words: [makeWord({
        display: 'hello', typed: 'hello', correct: true,
        keystrokes: [
          makeKeystroke({ correct: false, expectedChar: 'h', typedChar: 'm', mistakeKey: 'h' }),
          makeKeystroke({ correct: false, expectedChar: 'h', typedChar: 'm', mistakeKey: 'h' }),
          makeKeystroke({ correct: false, expectedChar: 'h', typedChar: 'b', mistakeKey: 'h' }),
          makeKeystroke({ correct: true, expectedChar: 'e' }),
        ],
      })],
    })
    const details = buildMissedDetails(log)
    expect(details.get('h')?.typedCounts).toEqual({ m: 2, b: 1 })
  })

  it('includes incorrect keystrokes from an interrupted (partial) word in typedCounts', () => {
    const log = makeLog({
      words: [makeWord({
        display: 'wo', typed: 'x', correct: false, partial: true,
        keystrokes: [makeKeystroke({ correct: false, expectedChar: 'w', typedChar: 'x', mistakeKey: 'w' })],
      })],
    })
    expect(buildMissedDetails(log).get('w')?.typedCounts).toEqual({ x: 1 })
  })

  it('ignores an incorrect keystroke missing typedChar/mistakeKey (legacy log), independent of movedOn', () => {
    // display === typed (a corrected mistake, fixed via Backspace before
    // submit) isolates this to ONLY the per-keystroke signal — no
    // movedOn contribution to conflate with the assertion below.
    const log = makeLog({
      words: [makeWord({
        display: 'hi', typed: 'hi', correct: true,
        keystrokes: [makeKeystroke({ correct: false, expectedChar: 'h' })],
      })],
    })
    expect(buildMissedDetails(log).size).toBe(0)
  })

  it('a fully legacy log (no keystroke ever carries typedChar/mistakeKey) still surfaces movedOnCount alone — typedCounts stays empty, not the whole entry', () => {
    // Deliberate: movedOnCount is derived purely from RunWord.display/typed
    // (always present, even pre-dating this feature), independent of the
    // per-keystroke fields — see buildMissedDetails' own doc comment. A
    // legacy log therefore still gets a partial detail (moved-on line
    // only, no "typed instead" line), not full absence.
    const log = makeLog({
      words: [makeWord({
        display: 'hi', typed: 'ho', correct: false,
        keystrokes: [makeKeystroke({ correct: false, expectedChar: 'i' })],
      })],
    })
    const entry = buildMissedDetails(log).get('i')
    expect(entry?.typedCounts).toEqual({})
    expect(entry?.movedOnCount).toBe(1)
  })

  describe('movedOnCount (verbatim mode)', () => {
    it('counts a position whose final typed char differs from display, keyed by the expected char', () => {
      const log = makeLog({
        words: [makeWord({ display: 'hello', typed: 'hbllo', correct: false, keystrokes: [] })],
      })
      const details = buildMissedDetails(log)
      expect(details.get('e')?.movedOnCount).toBe(1)
    })

    it('counts an absent trailing char (typed shorter than display) as moved-on', () => {
      const log = makeLog({
        words: [makeWord({ display: 'hi', typed: 'h', correct: false, keystrokes: [] })],
      })
      expect(buildMissedDetails(log).get('i')?.movedOnCount).toBe(1)
    })

    it('counts nothing for a word typed exactly correct', () => {
      const log = makeLog({
        words: [makeWord({ display: 'hi', typed: 'hi', correct: true, keystrokes: [] })],
      })
      expect(buildMissedDetails(log).size).toBe(0)
    })

    it('excludes an interrupted (partial) word from movedOnCount', () => {
      const log = makeLog({
        words: [makeWord({ display: 'hello', typed: 'x', correct: false, partial: true, keystrokes: [] })],
      })
      expect(buildMissedDetails(log).size).toBe(0)
    })

    it('combines with typedCounts under the same key when both signals apply', () => {
      const log = makeLog({
        words: [makeWord({
          display: 'hi', typed: 'xi', correct: false,
          keystrokes: [makeKeystroke({ correct: false, expectedChar: 'h', typedChar: 'x', mistakeKey: 'h' })],
        })],
      })
      const entry = buildMissedDetails(log).get('h')
      expect(entry?.typedCounts).toEqual({ x: 1 })
      expect(entry?.movedOnCount).toBe(1)
    })
  })

  describe('romaji mode', () => {
    it('is always 0 — never derives movedOnCount even when display/typed differ positionally', () => {
      const log = makeLog({
        romajiInput: true,
        words: [makeWord({ display: 'あい', typed: 'ab', correct: false, keystrokes: [] })],
      })
      expect(buildMissedDetails(log).size).toBe(0)
    })

    it('still groups typedCounts from incorrect keystrokes normally', () => {
      const log = makeLog({
        romajiInput: true,
        words: [makeWord({
          display: 'あい', typed: 'ai', correct: true,
          keystrokes: [makeKeystroke({ correct: false, expectedChar: 'a', typedChar: 'z', mistakeKey: 'a' })],
        })],
      })
      const details = buildMissedDetails(log)
      expect(details.get('a')?.typedCounts).toEqual({ z: 1 })
      expect(details.get('a')?.movedOnCount).toBe(0)
    })
  })
})
