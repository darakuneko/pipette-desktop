// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { extractTokenIntervals, mergeTokenIntervals, MAX_VALID_INTERVAL_MS, MIN_VALID_INTERVAL_MS } from '../weak-spot-timing'
import type { RunKeystrokeLog, RunKeystroke, RunWord } from '../../../shared/types/typing-run-log'

let nextRow = 0
function ks(pressMs: number, expectedChar: string | undefined, correct: boolean | undefined, extra: Partial<RunKeystroke> = {}): RunKeystroke {
  nextRow++
  return { pressMs, keycode: 0, row: 0, col: nextRow, expectedChar, correct, ...extra }
}

function word(display: string, typed: string, keystrokes: RunKeystroke[], extra: Partial<RunWord> = {}): RunWord {
  return { index: 0, display, typed, correct: display === typed, keystrokes, ...extra }
}

function log(words: RunWord[], extra: Partial<RunKeystrokeLog> = {}): RunKeystrokeLog {
  return {
    runId: 'r1', uid: 'u1', startedAt: '2026-01-01T00:00:00.000Z', durationMs: 10000,
    mode: 'words', language: 'english', words, ...extra,
  }
}

describe('extractTokenIntervals — direct mode', () => {
  it('extracts one interval per non-word-initial char, keyed by the target char', () => {
    // "cat" typed cleanly, three keystrokes 300ms apart.
    const w = word('cat', 'cat', [
      ks(0, 'c', true),
      ks(300, 'a', true),
      ks(650, 't', true),
    ])
    const result = extractTokenIntervals(log([w]), 'direct')
    // 'c' is word-initial — never measured. 'a' gets interval 300 (300-0),
    // 't' gets interval 350 (650-300).
    expect(result.get('c')).toBeUndefined()
    expect(result.get('a')).toEqual([300])
    expect(result.get('t')).toEqual([350])
  })

  it('never measures the run\'s very first keystroke (word-initial of the first word)', () => {
    const w = word('a', 'a', [ks(0, 'a', true)])
    const result = extractTokenIntervals(log([w]), 'direct')
    expect(result.size).toBe(0)
  })

  it('never measures an interval spanning a word boundary (each word\'s first token stays word-initial)', () => {
    const w1 = word('at', 'at', [ks(0, 'a', true), ks(200, 't', true)])
    const w2 = word('by', 'by', [ks(5000, 'b', true), ks(5100, 'y', true)])
    const result = extractTokenIntervals(log([w1, w2]), 'direct')
    // 'b' (word2's first token) is word-initial -> never measured, even
    // though the raw gap from w1's last keystroke (200) to w2's first
    // (5000) is a real 4800ms gap — it must never surface as 'b''s interval.
    expect(result.get('b')).toBeUndefined()
    expect(result.get('t')).toEqual([200])
    expect(result.get('y')).toEqual([100])
  })

  it('excludes a word containing a Backspace (expectedChar set, correct left undefined)', () => {
    // 'cat' typed with a correction: c, a, x(wrong, backspaced), t.
    // The backspace keystroke has expectedChar set but no correct verdict.
    const w = word('cat', 'cat', [
      ks(0, 'c', true),
      ks(200, 'a', true),
      ks(400, 'a', undefined), // Backspace: expectedChar carried over, no verdict
      ks(600, 't', true),
    ])
    const result = extractTokenIntervals(log([w]), 'direct')
    expect(result.size).toBe(0)
  })

  it('excludes a word whose keystroke count does not match the expected token count', () => {
    const w = word('cat', 'cat', [ks(0, 'c', true), ks(200, 'a', true)]) // missing 't'
    const result = extractTokenIntervals(log([w]), 'direct')
    expect(result.size).toBe(0)
  })

  it('excludes a partial (interrupted, unsubmitted) word', () => {
    const w = word('cat', 'ca', [ks(0, 'c', true), ks(200, 'a', true)], { partial: true, correct: false })
    const result = extractTokenIntervals(log([w]), 'direct')
    expect(result.size).toBe(0)
  })

  it('excludes an interval longer than MAX_VALID_INTERVAL_MS (a genuine pause, not slowness)', () => {
    const w = word('at', 'at', [ks(0, 'a', true), ks(MAX_VALID_INTERVAL_MS + 1, 't', true)])
    const result = extractTokenIntervals(log([w]), 'direct')
    expect(result.get('t')).toBeUndefined()
  })

  it('includes an interval exactly at MAX_VALID_INTERVAL_MS (inclusive boundary)', () => {
    const w = word('at', 'at', [ks(0, 'a', true), ks(MAX_VALID_INTERVAL_MS, 't', true)])
    const result = extractTokenIntervals(log([w]), 'direct')
    expect(result.get('t')).toEqual([MAX_VALID_INTERVAL_MS])
  })

  it('excludes a near-zero interval below MIN_VALID_INTERVAL_MS', () => {
    const w = word('at', 'at', [ks(0, 'a', true), ks(MIN_VALID_INTERVAL_MS - 1, 't', true)])
    const result = extractTokenIntervals(log([w]), 'direct')
    expect(result.get('t')).toBeUndefined()
  })

  it('includes an interval exactly at MIN_VALID_INTERVAL_MS (inclusive boundary)', () => {
    const w = word('at', 'at', [ks(0, 'a', true), ks(MIN_VALID_INTERVAL_MS, 't', true)])
    const result = extractTokenIntervals(log([w]), 'direct')
    expect(result.get('t')).toEqual([MIN_VALID_INTERVAL_MS])
  })

  it('excludes a non-monotonic (zero or negative) interval', () => {
    const w1 = word('at', 'at', [ks(0, 'a', true), ks(0, 't', true)])
    const w2 = word('by', 'by', [ks(1000, 'b', true), ks(900, 'y', true)]) // out of order
    expect(extractTokenIntervals(log([w1]), 'direct').get('t')).toBeUndefined()
    expect(extractTokenIntervals(log([w2]), 'direct').get('y')).toBeUndefined()
  })

  it('accumulates multiple observations of the same char across words/runs into one array', () => {
    const w1 = word('cat', 'cat', [ks(0, 'c', true), ks(100, 'a', true), ks(250, 't', true)])
    const w2 = word('bat', 'bat', [ks(2000, 'b', true), ks(2120, 'a', true), ks(2300, 't', true)])
    const result = extractTokenIntervals(log([w1, w2]), 'direct')
    expect(result.get('a')).toEqual([100, 120]) // 100-0, 2120-2000
    expect(result.get('t')).toEqual([150, 180]) // 250-100, 2300-2120
  })

  it('bails out entirely on a charCorrelationUnavailable log', () => {
    const w = word('at', 'at', [ks(0, 'a', true), ks(300, 't', true)])
    const result = extractTokenIntervals(log([w], { charCorrelationUnavailable: true }), 'direct')
    expect(result.size).toBe(0)
  })
})

describe('extractTokenIntervals — kana mode', () => {
  it('attributes a 2-stroke (dakuten) unit\'s interval to its FIRST physical stroke (segment onset)', () => {
    // が(dakuten, 2 strokes) then き(1 stroke). Word "がき".
    const w = word('がき', 'がき', [
      ks(0, 'か', true),   // が's base stroke (word-initial, not measured)
      ks(150, '゛', true), // が's mark stroke (same unit — still が's onset already passed)
      ks(600, 'き', true), // き's single stroke — onset for き
    ])
    const result = extractTokenIntervals(log([w]), 'kana')
    // が is word-initial -> never measured (its own 2 strokes contribute
    // no interval entries at all). き's interval = 600 - 150 = 450 (from
    // が's LAST stroke, not its first).
    expect(result.get('が')).toBeUndefined()
    expect(result.get('き')).toEqual([450])
  })

  it('keys a dakuten unit by its full (hiragana, marked) char, not the base stroke symbol', () => {
    const w = word('きが', 'きが', [
      ks(0, 'き', true),
      ks(200, 'か', true),
      ks(350, '゛', true),
    ])
    const result = extractTokenIntervals(log([w]), 'kana')
    expect(result.get('が')).toEqual([200])
  })

  it('normalizes a katakana target word to hiragana token keys', () => {
    // "キガ" (katakana) -> き (1 stroke, word-initial) then ガ/が (2-stroke
    // dakuten unit) — token keys must be hiragana even though the target
    // word itself is katakana.
    const w = word('キガ', 'キガ', [
      ks(0, 'き', true),
      ks(200, 'か', true),
      ks(350, '゛', true),
    ])
    const result = extractTokenIntervals(log([w]), 'kana')
    expect(result.has('が')).toBe(true)
    expect(result.has('ガ')).toBe(false)
  })

  it('excludes a word with a rejected stroke (keystroke count exceeds the expected clean count)', () => {
    const w = word('きか', 'きか', [
      ks(0, 'き', true),
      ks(200, 'か', false), // rejected attempt
      ks(350, 'か', true),  // retry, accepted
    ])
    const result = extractTokenIntervals(log([w]), 'kana')
    expect(result.size).toBe(0)
  })
})

describe('extractTokenIntervals — romaji mode', () => {
  it('attributes a multi-keystroke segment\'s interval to its onset (first keystroke of the segment)', () => {
    // "あきゃ" -> segments ["a", "kya"]. "a" is word-initial.
    const w = word('あきゃ', 'あきゃ', [
      ks(0, 'a', true),     // あ (word-initial)
      ks(500, 'k', true),   // きゃ segment onset
      ks(560, 'y', true),
      ks(620, 'a', true),
    ])
    const result = extractTokenIntervals(log([w]), 'romaji')
    expect(result.get('a')).toBeUndefined() // word-initial segment "a" (あ) not measured
    expect(result.get('kya')).toEqual([500])
  })

  it('splits っ (sokuon) doubling into its own fused segment, distinct from the preceding kana', () => {
    // "きって" -> canonicalRomajiSegments gives ["ki", "tte"].
    const w = word('きって', 'きって', [
      ks(0, 'k', true), ks(60, 'i', true),     // き (word-initial)
      ks(400, 't', true), ks(460, 't', true), ks(520, 'e', true), // って segment
    ])
    const result = extractTokenIntervals(log([w]), 'romaji')
    expect(result.get('ki')).toBeUndefined()
    expect(result.get('tte')).toEqual([340]) // 400 - 60
  })

  it('excludes a word whose romaji keystroke count does not match the canonical segmentation length (e.g. a reject)', () => {
    const w = word('あい', 'あい', [
      ks(0, 'a', true),
      ks(200, 'x', false), // rejected keystroke toward い
      ks(260, 'i', true),
    ])
    const result = extractTokenIntervals(log([w]), 'romaji')
    expect(result.size).toBe(0)
  })
})

describe('mergeTokenIntervals', () => {
  it('concatenates interval arrays for the same token across multiple per-log maps', () => {
    const a = new Map([['t', [100, 200]]])
    const b = new Map([['t', [300]], ['a', [50]]])
    const merged = mergeTokenIntervals([a, b])
    expect(merged.get('t')).toEqual([100, 200, 300])
    expect(merged.get('a')).toEqual([50])
  })

  it('returns an empty map for an empty input array', () => {
    expect(mergeTokenIntervals([]).size).toBe(0)
  })
})
