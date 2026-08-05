// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import {
  KANA_LAYOUT, strokeMatches, strokesForKana, kanaStrokes, kanaUnitsForWord, tryAcceptStroke,
  isKanaCapable, isKanaInputActive, processKanaKeyEvent, buildKanaGuideProgress, buildKanaWordsTable,
  kanaNextExpectedChar, currentKanaMistakeKey, kanaStrokeCorrect, isKanaPhysicalPositionKeycode,
  type KanaStroke,
} from '../kana-input'
import { isRomajiInputActive } from '../romaji-input'
import { freshState, type TypingTestState } from '../run-state'
import type { RomajiDetailSettings, TypingTestConfig } from '../types'
import { deserialize } from '../../../shared/keycodes/keycodes'

describe('KANA_LAYOUT / strokesForKana', () => {
  it('resolves a direct kana with no shift variant', () => {
    expect(strokesForKana('か')).toEqual([{ code: 'KeyT', shift: false }])
  })

  it('resolves the unshifted member of a shift-variant pair', () => {
    expect(strokesForKana('あ')).toEqual([{ code: 'Digit3', shift: false }])
  })

  it('resolves the shifted member of a shift-variant pair', () => {
    expect(strokesForKana('ぁ')).toEqual([{ code: 'Digit3', shift: true }])
  })

  it('resolves を (Shift+Digit0) distinctly from わ (Digit0)', () => {
    expect(strokesForKana('わ')).toEqual([{ code: 'Digit0', shift: false }])
    expect(strokesForKana('を')).toEqual([{ code: 'Digit0', shift: true }])
  })

  it('resolves っ (Shift+KeyZ) distinctly from つ (KeyZ)', () => {
    expect(strokesForKana('つ')).toEqual([{ code: 'KeyZ', shift: false }])
    expect(strokesForKana('っ')).toEqual([{ code: 'KeyZ', shift: true }])
  })

  it('resolves ー (IntlYen) and ろ (IntlRo)', () => {
    expect(strokesForKana('ー')).toEqual([{ code: 'IntlYen', shift: false }])
    expect(strokesForKana('ろ')).toEqual([{ code: 'IntlRo', shift: false }])
  })

  it('resolves a dakuten kana as base stroke + BracketLeft', () => {
    expect(strokesForKana('が')).toEqual([{ code: 'KeyT', shift: false }, { code: 'BracketLeft', shift: false }])
    expect(strokesForKana('ゔ')).toEqual([{ code: 'Digit4', shift: false }, { code: 'BracketLeft', shift: false }])
  })

  it('resolves a handakuten kana as base stroke + BracketRight', () => {
    expect(strokesForKana('ぱ')).toEqual([{ code: 'KeyF', shift: false }, { code: 'BracketRight', shift: false }])
  })

  it('returns null for a character kana mode cannot resolve', () => {
    expect(strokesForKana('。')).toBeNull()
    expect(strokesForKana('X')).toBeNull()
    expect(strokesForKana('漢')).toBeNull()
  })

  it('every KANA_LAYOUT entry round-trips through strokesForKana', () => {
    for (const [code, [plain, shifted]] of Object.entries(KANA_LAYOUT)) {
      expect(strokesForKana(plain)).toEqual([{ code, shift: false }])
      if (shifted !== null) expect(strokesForKana(shifted)).toEqual([{ code, shift: true }])
    }
  })
})

describe('strokeMatches — THE shift-tolerance rule', () => {
  it('ぁ requires Shift: Digit3 unshifted does not satisfy it, Digit3+Shift does', () => {
    const wantSmallA: KanaStroke = { code: 'Digit3', shift: true } // ぁ
    expect(strokeMatches(wantSmallA, 'Digit3', false)).toBe(false)
    expect(strokeMatches(wantSmallA, 'Digit3', true)).toBe(true)
  })

  it('あ (the unshifted half of the same Digit3 pair) requires Shift to be released', () => {
    const wantBigA: KanaStroke = { code: 'Digit3', shift: false } // あ
    expect(strokeMatches(wantBigA, 'Digit3', true)).toBe(false)
    expect(strokeMatches(wantBigA, 'Digit3', false)).toBe(true)
  })

  it('a key with no shift variant of its own ignores the actual shift state — held-shift tolerance, the whole point', () => {
    const wantKa: KanaStroke = { code: 'KeyT', shift: false } // か, no shift variant at all
    expect(strokeMatches(wantKa, 'KeyT', false)).toBe(true)
    // Shift still physically held from a preceding small-kana keystroke —
    // still accepted, because KeyT has no shifted かな to disambiguate.
    expect(strokeMatches(wantKa, 'KeyT', true)).toBe(true)
  })

  it('a realistic held-shift sequence: ゃ (shift) then く (no variant) held-shift stays correct', () => {
    // きゃく: き(KeyG) ゃ(Digit7+Shift) く(KeyH) — after the shifted ゃ
    // keystroke, a user's Shift can still be physically down for く.
    const wantSmallYa: KanaStroke = { code: 'Digit7', shift: true } // ゃ
    expect(strokeMatches(wantSmallYa, 'Digit7', true)).toBe(true)
    const wantKu: KanaStroke = { code: 'KeyH', shift: false } // く, no shift variant
    expect(strokeMatches(wantKu, 'KeyH', true)).toBe(true) // still held — accepted
    expect(strokeMatches(wantKu, 'KeyH', false)).toBe(true) // released — also accepted
  })

  it('っ (Shift+KeyZ) is strict both ways', () => {
    const wantSmallTsu: KanaStroke = { code: 'KeyZ', shift: true } // っ
    expect(strokeMatches(wantSmallTsu, 'KeyZ', true)).toBe(true)
    expect(strokeMatches(wantSmallTsu, 'KeyZ', false)).toBe(false)
    const wantTsu: KanaStroke = { code: 'KeyZ', shift: false } // つ
    expect(strokeMatches(wantTsu, 'KeyZ', false)).toBe(true)
    expect(strokeMatches(wantTsu, 'KeyZ', true)).toBe(false)
  })

  it('を (Shift+Digit0) strict vs わ (Digit0) unshifted', () => {
    const wantWo: KanaStroke = { code: 'Digit0', shift: true } // を
    expect(strokeMatches(wantWo, 'Digit0', true)).toBe(true)
    expect(strokeMatches(wantWo, 'Digit0', false)).toBe(false)
    const wantWa: KanaStroke = { code: 'Digit0', shift: false } // わ
    expect(strokeMatches(wantWa, 'Digit0', false)).toBe(true)
    expect(strokeMatches(wantWa, 'Digit0', true)).toBe(false)
  })

  it('wrong code never matches regardless of shift', () => {
    const wantKa: KanaStroke = { code: 'KeyT', shift: false }
    expect(strokeMatches(wantKa, 'KeyG', false)).toBe(false)
    expect(strokeMatches(wantKa, 'KeyG', true)).toBe(false)
  })
})

describe('kanaStrokes (flattened word -> physical strokes)', () => {
  it('flattens a simple word', () => {
    expect(kanaStrokes('たかい')).toEqual([
      { code: 'KeyQ', shift: false }, // た
      { code: 'KeyT', shift: false }, // か
      { code: 'KeyE', shift: false }, // い
    ])
  })

  it('expands a dakuten kana into two strokes inline', () => {
    expect(kanaStrokes('がっこう')).toEqual([
      { code: 'KeyT', shift: false }, { code: 'BracketLeft', shift: false }, // が
      { code: 'KeyZ', shift: true }, // っ
      { code: 'KeyB', shift: false }, // こ
      { code: 'Digit4', shift: false }, // う
    ])
  })

  it('normalizes katakana to hiragana before resolving strokes', () => {
    expect(kanaStrokes('タカイ')).toEqual(kanaStrokes('たかい'))
  })

  it('drops characters it cannot resolve rather than throwing', () => {
    expect(kanaStrokes('あ。い')).toEqual([{ code: 'Digit3', shift: false }, { code: 'KeyE', shift: false }])
  })
})

describe('kanaUnitsForWord', () => {
  it('marks only single-stroke shift-variant characters as needsShift', () => {
    const units = kanaUnitsForWord('ぁがを')
    expect(units.map((u) => u.needsShift)).toEqual([true, false, true])
  })

  it('unresolved characters fall back to their original (non-normalized) form', () => {
    const units = kanaUnitsForWord('ア。')
    expect(units[0]).toEqual({ char: 'あ', strokes: [{ code: 'Digit3', shift: false }], needsShift: false })
    expect(units[1]).toEqual({ char: '。', strokes: null, needsShift: false })
  })
})

describe('tryAcceptStroke', () => {
  const gaUnit = kanaUnitsForWord('が')[0]
  const kaUnit = kanaUnitsForWord('か')[0]
  const punctUnit = kanaUnitsForWord('。')[0]

  it('single-stroke unit completes on its one correct stroke', () => {
    expect(tryAcceptStroke(kaUnit, false, 'KeyT', false, 'x')).toEqual({ status: 'complete' })
  })

  it('single-stroke unit rejects a wrong stroke', () => {
    expect(tryAcceptStroke(kaUnit, false, 'KeyG', false, 'x')).toEqual({ status: 'reject' })
  })

  it('two-stroke (dakuten) unit accepts its base stroke, then completes on the mark', () => {
    expect(tryAcceptStroke(gaUnit, false, 'KeyT', false, 'x')).toEqual({ status: 'accept' })
    expect(tryAcceptStroke(gaUnit, true, 'BracketLeft', false, 'x')).toEqual({ status: 'complete' })
  })

  it('two-stroke unit rejects a wrong mark stroke while awaiting it', () => {
    expect(tryAcceptStroke(gaUnit, true, 'BracketRight', false, 'x')).toEqual({ status: 'reject' })
  })

  it('unresolved unit falls back to verbatim key matching', () => {
    expect(tryAcceptStroke(punctUnit, false, 'Comma', false, '。')).toEqual({ status: 'complete' })
    expect(tryAcceptStroke(punctUnit, false, 'Comma', false, 'x')).toEqual({ status: 'reject' })
  })
})

describe('isKanaCapable / isKanaInputActive', () => {
  const cfg = (inputMethod?: 'romaji' | 'kana', romajiInput?: boolean): TypingTestConfig => {
    const romaji: RomajiDetailSettings | undefined = inputMethod ? { inputMethod } : undefined
    return { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput, romaji }
  }

  it('shares romaji mode\'s exact capability domain', () => {
    expect(isKanaCapable(cfg(), 'japanese_hiragana', undefined)).toBe(true)
    expect(isKanaCapable(cfg(), 'english', undefined)).toBe(false)
  })

  it('inactive by default (romaji is the default input method)', () => {
    expect(isKanaInputActive(cfg(), 'japanese_hiragana', undefined)).toBe(false)
    expect(isRomajiInputActive(cfg(), 'japanese_hiragana', undefined)).toBe(true)
  })

  it('active only once inputMethod is explicitly kana, and mutually exclusive with romaji', () => {
    expect(isKanaInputActive(cfg('kana'), 'japanese_hiragana', undefined)).toBe(true)
    expect(isRomajiInputActive(cfg('kana'), 'japanese_hiragana', undefined)).toBe(false)
  })

  it('inactive when the master romajiInput switch is off, even with kana selected', () => {
    expect(isKanaInputActive(cfg('kana', false), 'japanese_hiragana', undefined)).toBe(false)
  })

  it('inactive for an incapable language, even with kana selected', () => {
    expect(isKanaInputActive(cfg('kana'), 'english', undefined)).toBe(false)
  })
})

describe('processKanaKeyEvent — single-stroke word', () => {
  const config: TypingTestConfig = { mode: 'words', wordCount: 1, punctuation: false, numbers: false, romaji: { inputMethod: 'kana' } }

  function baseState(words: string[]): TypingTestState {
    return freshState({ words, quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }, 'waiting')
  }

  it('accepts the correct stroke, advances kanaCharIndex, and starts the run from waiting', () => {
    const s = baseState(['かき'])
    const next = processKanaKeyEvent(s, 'x', 'KeyT', false, config, 'japanese_hiragana')
    expect(next.status).toBe('running')
    expect(next.kanaCharIndex).toBe(1)
    expect(next.correctChars).toBe(1)
    expect(next.confirmedChars).toBe(1)
    expect(next.incorrectChars).toBe(0)
  })

  it('rejects a wrong stroke without advancing kanaCharIndex, and counts it as incorrect', () => {
    const s = { ...baseState(['か']), status: 'running' as const }
    const next = processKanaKeyEvent(s, 'x', 'KeyG', false, config, 'japanese_hiragana')
    expect(next.incorrectChars).toBe(1)
    expect(next.kanaCharIndex).toBe(0)
  })

  it('completing the only word finishes the run (words mode)', () => {
    const s = baseState(['か'])
    const next = processKanaKeyEvent(s, 'x', 'KeyT', false, config, 'japanese_hiragana')
    expect(next.status).toBe('finished')
    expect(next.wordResults).toEqual([{ word: 'か', typed: 'か', correct: true }])
  })

  it('a rejected keystroke tallies exactly one mistake once the かな segment eventually completes', () => {
    let s = baseState(['か'])
    s = processKanaKeyEvent(s, 'x', 'KeyG', false, config, 'japanese_hiragana') // reject
    s = processKanaKeyEvent(s, 'x', 'KeyG', false, config, 'japanese_hiragana') // reject again
    s = processKanaKeyEvent(s, 'x', 'KeyT', false, config, 'japanese_hiragana') // complete
    expect(s.mistakes).toEqual({ か: 1 })
  })

  it('Backspace and Space are no-ops', () => {
    const s = { ...baseState(['か']), status: 'running' as const }
    expect(processKanaKeyEvent(s, 'Backspace', undefined, false, config, 'japanese_hiragana')).toBe(s)
    expect(processKanaKeyEvent(s, ' ', undefined, false, config, 'japanese_hiragana')).toBe(s)
  })

  it('multi-character key names (e.g. Shift alone) pass through untouched', () => {
    const s = { ...baseState(['か']), status: 'running' as const }
    expect(processKanaKeyEvent(s, 'Shift', undefined, false, config, 'japanese_hiragana')).toBe(s)
  })
})

describe('processKanaKeyEvent — dakuten (2-stroke) word', () => {
  const config: TypingTestConfig = { mode: 'words', wordCount: 1, punctuation: false, numbers: false, romaji: { inputMethod: 'kana' } }

  it('base stroke accepts (mid-character), mark stroke completes the かな', () => {
    let s = freshState({ words: ['が'], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }, 'waiting')
    s = processKanaKeyEvent(s, 'x', 'KeyT', false, config, 'japanese_hiragana')
    expect(s.kanaAwaitingMark).toBe(true)
    expect(s.kanaCharIndex).toBe(0)
    expect(s.status).toBe('running')

    s = processKanaKeyEvent(s, 'x', 'BracketLeft', false, config, 'japanese_hiragana')
    expect(s.kanaAwaitingMark).toBe(false)
    expect(s.status).toBe('finished')
    expect(s.wordResults).toEqual([{ word: 'が', typed: 'が', correct: true }])
  })

  it('shift held through a small-kana keystroke does not break the following plain kana', () => {
    // きゃく — き(KeyG) then ゃ(Digit7+Shift) then く(KeyH), Shift still down for く.
    let s = freshState({ words: ['きゃく'], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }, 'waiting')
    s = processKanaKeyEvent(s, 'x', 'KeyG', false, config, 'japanese_hiragana')
    s = processKanaKeyEvent(s, 'x', 'Digit7', true, config, 'japanese_hiragana')
    expect(s.kanaCharIndex).toBe(2)
    s = processKanaKeyEvent(s, 'x', 'KeyH', true, config, 'japanese_hiragana') // shift STILL held
    expect(s.status).toBe('finished')
    expect(s.incorrectChars).toBe(0)
  })
})

describe('buildKanaGuideProgress / buildKanaWordsTable', () => {
  const config: TypingTestConfig = { mode: 'words', wordCount: 2, punctuation: false, numbers: false, romaji: { inputMethod: 'kana' } }

  it('returns null when kana mode is not active', () => {
    const inactive: TypingTestConfig = { ...config, romaji: { inputMethod: 'romaji' } }
    const s = freshState({ words: ['か'], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }, 'running')
    expect(buildKanaGuideProgress(inactive, 'japanese_hiragana', s, buildKanaWordsTable(config, 'japanese_hiragana', s))).toBeNull()
    expect(buildKanaWordsTable(inactive, 'japanese_hiragana', s)).toBeNull()
  })

  it('reports remaining units and kanaCompleted for the current word', () => {
    let s = freshState({ words: ['たかい'], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }, 'running')
    s = processKanaKeyEvent(s, 'x', 'KeyQ', false, config, 'japanese_hiragana') // た
    const table = buildKanaWordsTable(config, 'japanese_hiragana', s)
    const guide = buildKanaGuideProgress(config, 'japanese_hiragana', s, table)
    expect(guide?.kanaCompleted).toBe(1)
    expect(guide?.remaining.map((u) => u.char)).toEqual(['か', 'い'])
    expect(guide?.showRow).toBe(true)
  })

  it('showRow is false once guideLineCount is 0', () => {
    const hidden: TypingTestConfig = { ...config, romaji: { inputMethod: 'kana', guideLineCount: 0 } }
    const s = freshState({ words: ['か'], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }, 'running')
    const table = buildKanaWordsTable(hidden, 'japanese_hiragana', s)
    expect(buildKanaGuideProgress(hidden, 'japanese_hiragana', s, table)?.showRow).toBe(false)
  })

  it('returns null when the words table is null (e.g. current word out of range)', () => {
    const s = freshState({ words: ['か'], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }, 'running')
    expect(buildKanaGuideProgress(config, 'japanese_hiragana', s, null)).toBeNull()
  })

  it('words table is index-aligned with state.words', () => {
    const s = freshState({ words: ['か', 'が'], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }, 'running')
    const table = buildKanaWordsTable(config, 'japanese_hiragana', s)
    expect(table?.map((units) => units.map((u) => u.char))).toEqual([['か'], ['が']])
  })
})

describe('kanaNextExpectedChar / currentKanaMistakeKey / kanaStrokeCorrect', () => {
  it('reports the base かな while awaiting the dakuten mark, then the mark itself', () => {
    expect(kanaNextExpectedChar('が', 0, false)).toBe('か')
    expect(kanaNextExpectedChar('が', 0, true)).toBe('゛')
  })

  it('reports the shifted glyph for a pending shifted stroke', () => {
    expect(kanaNextExpectedChar('ぁ', 0, false)).toBe('ぁ')
  })

  it('falls back to the raw character for an unresolved position', () => {
    expect(kanaNextExpectedChar('。', 0, false)).toBe('。')
  })

  it('returns undefined once the word is exhausted', () => {
    expect(kanaNextExpectedChar('か', 1, false)).toBeUndefined()
  })

  it('mistake key is always the target かな character itself', () => {
    expect(currentKanaMistakeKey('が', 0)).toBe('が')
    expect(currentKanaMistakeKey('たかい', 1)).toBe('か')
  })

  it('kanaStrokeCorrect matches processKanaKeyEvent\'s own accept/reject judgment', () => {
    const s = freshState({ words: ['ぁ'], quote: null, lineBreaks: [], lineIndents: [], romajiCapable: false }, 'running')
    expect(kanaStrokeCorrect(s, 'x', 'Digit3', false)).toBe(false) // あ, not ぁ — shift required
    expect(kanaStrokeCorrect(s, 'x', 'Digit3', true)).toBe(true)
    expect(kanaStrokeCorrect(s, 'x', undefined, true)).toBeUndefined()
  })
})

describe('isKanaPhysicalPositionKeycode', () => {
  // The actual bug this task fixes: these JIS-position keycodes declare no
  // `printable` legend in keycodes.ts (see keycode-char-map.test.ts's
  // producesChar coverage), so outside kana mode they correctly never
  // produce a char — but KANA_LAYOUT resolves a real かな through their
  // physical position (IntlRo/IntlYen), so run-log-recorder.ts ORs this
  // predicate into its own char-producing check while kana mode is active,
  // to avoid permanently desyncing the press<->char pairing queue (see
  // run-log-recorder.test.ts's BUG/FIXED pair for the end-to-end proof).
  it.each(['KC_RO', 'KC_JYEN', 'KC_NONUS_HASH', 'KC_NONUS_BSLASH'])('true for %s', (qmkId) => {
    expect(isKanaPhysicalPositionKeycode(deserialize(qmkId))).toBe(true)
  })

  it('false for an ordinary printable keycode', () => {
    expect(isKanaPhysicalPositionKeycode(deserialize('KC_A'))).toBe(false)
  })

  it('false for an unrelated non-printable keycode', () => {
    expect(isKanaPhysicalPositionKeycode(deserialize('MO(1)'))).toBe(false)
    expect(isKanaPhysicalPositionKeycode(deserialize('KC_LSHIFT'))).toBe(false)
  })
})
