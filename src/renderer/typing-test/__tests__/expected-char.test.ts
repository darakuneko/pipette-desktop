// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect } from 'vitest'
import { deriveExpectedChar, deriveMistakeKey } from '../expected-char'
import type { TypingTestState } from '../run-state'
import { createInitialState } from '../run-state'
import { DEFAULT_CONFIG, DEFAULT_LANGUAGE, type TypingTestConfig } from '../types'

describe('deriveExpectedChar', () => {
  it('returns the next unconfirmed character of the current word in verbatim mode', () => {
    const state: TypingTestState = { ...createInitialState(DEFAULT_CONFIG, DEFAULT_LANGUAGE), words: ['hello'], currentInput: 'he' }
    expect(deriveExpectedChar(state, DEFAULT_CONFIG, DEFAULT_LANGUAGE)).toBe('l')
  })

  it('returns undefined once past the last word', () => {
    const state: TypingTestState = { ...createInitialState(DEFAULT_CONFIG, DEFAULT_LANGUAGE), words: ['hi'], currentWordIndex: 1 }
    expect(deriveExpectedChar(state, DEFAULT_CONFIG, DEFAULT_LANGUAGE)).toBeUndefined()
  })
})

// Real kana pack id (see ROMAJI_INPUT_LANGUAGES) — `romajiInput: true` alone
// isn't enough for `isRomajiInputActive` without the language also being a
// kana pack.
const KANA_LANGUAGE = 'japanese_hiragana'
const ROMAJI_CONFIG: TypingTestConfig = { mode: 'words', wordCount: 30, punctuation: false, numbers: false, romajiInput: true }

describe('deriveMistakeKey', () => {
  it('returns undefined once past the last word', () => {
    const state: TypingTestState = { ...createInitialState(DEFAULT_CONFIG, DEFAULT_LANGUAGE), words: ['hi'], currentWordIndex: 1 }
    expect(deriveMistakeKey(state, DEFAULT_CONFIG, DEFAULT_LANGUAGE)).toBeUndefined()
  })

  describe('verbatim mode', () => {
    it('equals deriveExpectedChar — the position\'s own target char is its own mistake key', () => {
      const state: TypingTestState = { ...createInitialState(DEFAULT_CONFIG, DEFAULT_LANGUAGE), words: ['hello'], currentInput: 'he' }
      expect(deriveMistakeKey(state, DEFAULT_CONFIG, DEFAULT_LANGUAGE)).toBe('l')
      expect(deriveMistakeKey(state, DEFAULT_CONFIG, DEFAULT_LANGUAGE)).toBe(deriveExpectedChar(state, DEFAULT_CONFIG, DEFAULT_LANGUAGE))
    })
  })

  describe('romaji mode', () => {
    it('returns the current kana segment\'s canonical spelling, not the single next romaji char', () => {
      const state: TypingTestState = {
        ...createInitialState(ROMAJI_CONFIG, KANA_LANGUAGE),
        words: ['あい'],
        romajiCapable: true,
        romajiKeystrokes: '',
      }
      // deriveExpectedChar's romaji branch is the single next guide char
      // ("a"); the mistake key is the whole segment's canonical spelling
      // — identical here (single-kana "あ" segment spells "a" too), so
      // this case alone wouldn't distinguish the two. See the digraph
      // case below for where they actually diverge.
      expect(deriveMistakeKey(state, ROMAJI_CONFIG, KANA_LANGUAGE)).toBe('a')
    })

    it('diverges from deriveExpectedChar mid-digraph: the segment key is the whole spelling, not the next char', () => {
      const state: TypingTestState = {
        ...createInitialState(ROMAJI_CONFIG, KANA_LANGUAGE),
        words: ['でぃなーにいく'],
        romajiCapable: true,
        romajiKeystrokes: 'd',
      }
      expect(deriveExpectedChar(state, ROMAJI_CONFIG, KANA_LANGUAGE)).toBe('h')
      expect(deriveMistakeKey(state, ROMAJI_CONFIG, KANA_LANGUAGE)).toBe('dhi')
    })

    it('returns undefined once the word is fully matched', () => {
      const state: TypingTestState = {
        ...createInitialState(ROMAJI_CONFIG, KANA_LANGUAGE),
        words: ['あ'],
        romajiCapable: true,
        romajiKeystrokes: 'a',
      }
      expect(deriveMistakeKey(state, ROMAJI_CONFIG, KANA_LANGUAGE)).toBeUndefined()
    })
  })
})
